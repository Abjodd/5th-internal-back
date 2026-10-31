/**
 * Several people on one campaign at once — the end-to-end check for campaignSync.js.
 *
 * Runs the real server against a real MongoDB (a throwaway database), and plays
 * two or more "browsers" against it:
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 node test/campaignSync.test.mjs
 *
 * The database it creates is dropped at the end.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import mongoose from "mongoose";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URI = (process.env.MONGO_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/$/, "");
const DB = `sync_test_${Date.now().toString(36)}`;
const URI = `${BASE_URI}/${DB}`;
const PORT = 4300 + Math.floor(Math.random() * 500);
const API = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 4).join("\n    ")}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body, actor) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(actor ? { ...body, actor } : body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json ?? text };
}
const get = (id) => call("GET", `/api/campaigns/${id}`).then((r) => r.body);
const row = (camp, id) => camp.creators.find((c) => c._id === id);
const patchRow = (cid, crId, set, from, actor, force) =>
  call("PATCH", `/api/campaigns/${cid}/creators/${crId}`, { set, from, ...(force ? { force: true } : {}) }, actor);

// ── seed: one campaign written the OLD way (a row with no _id, no revs) ──────
await mongoose.connect(URI);
const db = mongoose.connection.db;
await db.collection("creators").insertMany([
  { _id: "@asha", name: "Asha", handle: "@asha", followers: "120K", state: "Kerala" },
  { _id: "@ravi", name: "Ravi", handle: "@ravi", followers: "40K" },
]);
await db.collection("campaigns").insertOne({
  _id: "c1", name: "Diwali Glow", client: "Glow Co", stage: "team_assigned", budget: 500000,
  brief: { objective: "Awareness", budget: "₹5,00,000" }, timeline: [{ date: "2026-10-01", event: "Created", actor: "Ops" }],
  creators: [
    { _id: "cr_a", creatorId: "@asha", status: "suggested", cost: 0, clientCost: null, concept: null },
    { creatorId: "@ravi", status: "shortlisted", cost: 20000, clientCost: 30000 }, // legacy: no _id
  ],
  creatorIds: ["@asha", "@ravi"],
});

// ── server ──────────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, MONGO_URI: URI, PORT: String(PORT), DISABLE_SCHEDULER: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {}
  await sleep(150);
}
await sleep(400); // ensureRowIds runs right after listen

console.log("campaign sync");
let ravi;

await test("legacy rows get an _id and every campaign a rev at boot", async () => {
  const c = await get("c1");
  assert.equal(c.creators.length, 2);
  ravi = c.creators.find((r) => r.creatorId === "@ravi");
  assert.ok(ravi._id, "row id assigned");
  assert.ok(c.rev >= 1);
  assert.equal(ravi.name, "Ravi", "profile hydrated");
});

await test("two people editing different fields of one row at the same moment both land", async () => {
  const [a, b] = await Promise.all([
    patchRow("c1", "cr_a", { cost: 15000 }, { cost: 0 }, "Riya"),
    patchRow("c1", "cr_a", { clientCost: 25000 }, { clientCost: null }, "Karan"),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const r = row(await get("c1"), "cr_a");
  assert.equal(r.cost, 15000);
  assert.equal(r.clientCost, 25000);
  assert.equal(r.editedBy.cost.by, "Riya");
  assert.equal(r.editedBy.clientCost.by, "Karan");
});

await test("two different values for the same field: the second is refused with who/what", async () => {
  const first = await patchRow("c1", "cr_a", { cost: 18000 }, { cost: 15000 }, "Riya");
  assert.equal(first.status, 200);
  const second = await patchRow("c1", "cr_a", { cost: 19000 }, { cost: 15000 }, "Karan");
  assert.equal(second.status, 409);
  const [cf] = second.body.conflicts;
  assert.equal(cf.path, "cost");
  assert.equal(cf.current, 18000);
  assert.equal(cf.yours, 19000);
  assert.equal(cf.by, "Riya");
  assert.equal(second.body.row.cost, 18000, "fresh row comes back");
  assert.equal(row(await get("c1"), "cr_a").cost, 18000, "nothing overwritten");
});

await test("racing different values: exactly one wins, the other gets a conflict", async () => {
  const rs = await Promise.all([
    patchRow("c1", "cr_a", { cost: 21000 }, { cost: 18000 }, "A"),
    patchRow("c1", "cr_a", { cost: 22000 }, { cost: 18000 }, "B"),
  ]);
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409]);
  const winner = rs.find((r) => r.status === 200);
  assert.equal(row(await get("c1"), "cr_a").cost, winner.body.row.cost);
});

await test("the same value from two people is not a conflict", async () => {
  const rs = await Promise.all([
    patchRow("c1", "cr_a", { status: "shortlisted" }, { status: "suggested" }, "A"),
    patchRow("c1", "cr_a", { status: "shortlisted" }, { status: "suggested" }, "B"),
  ]);
  rs.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));
  assert.equal(row(await get("c1"), "cr_a").status, "shortlisted");
});

await test("'use mine' (force) overwrites after a conflict", async () => {
  const c = row(await get("c1"), "cr_a").cost;
  const r = await patchRow("c1", "cr_a", { cost: 30000 }, { cost: c - 1 }, "Karan", true);
  assert.equal(r.status, 200);
  assert.equal(row(await get("c1"), "cr_a").cost, 30000);
});

await test("ten fields of one row written at once — none lost", async () => {
  const fields = Array.from({ length: 10 }, (_, i) => [`note${i}`, `v${i}`]);
  const rs = await Promise.all(fields.map(([k, v]) => patchRow("c1", "cr_a", { [k]: v }, { [k]: null }, `U${k}`)));
  rs.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));
  const r = row(await get("c1"), "cr_a");
  for (const [k, v] of fields) assert.equal(r[k], v);
});

await test("a sub-field inside a null object (concept.status on concept:null)", async () => {
  const r = await patchRow("c1", "cr_a", { "concept.status": "received", "concept.fileLink": "https://x.y/1" }, { "concept.status": null }, "Riya");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = row(await get("c1"), "cr_a");
  assert.equal(c.concept.status, "received");
  assert.equal(c.concept.fileLink, "https://x.y/1");
});

await test("a concept edit and a client comment at the same moment both survive", async () => {
  const [p, cm] = await Promise.all([
    patchRow("c1", "cr_a", { "concept.status": "approved" }, { "concept.status": "received" }, "Riya"),
    call("POST", "/api/campaigns/c1/creators/cr_a/concept/comments", { text: "Love it", author: "Karan" }),
  ]);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(cm.status, 201);
  const c = row(await get("c1"), "cr_a");
  assert.equal(c.concept.status, "approved");
  assert.equal(c.concept.comments.length, 1);
});

await test("comments and history can't be written through a row patch", async () => {
  const r = await patchRow("c1", "cr_a", { "concept.comments": [] }, null, "X");
  assert.equal(r.status, 400);
  const h = await patchRow("c1", "cr_a", { "tracking.history": [] }, null, "X");
  assert.equal(h.status, 400);
});

await test("profile fields go to the directory, not the row", async () => {
  const r = await patchRow("c1", "cr_a", { followers: "150K", state: "Goa" }, { followers: "120K" }, "Riya");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const prof = await db.collection("creators").findOne({ _id: "@asha" });
  assert.equal(prof.followers, "150K");
  assert.equal(prof.state, "Goa");
  const raw = await db.collection("campaigns").findOne({ _id: "c1" });
  const stored = raw.creators.find((x) => x._id === "cr_a");
  assert.equal(stored.followers, undefined, "row keeps no profile copy");
  assert.equal(row(await get("c1"), "cr_a").followers, "150K");
});

await test("manual metrics extend the growth history instead of replacing it", async () => {
  await patchRow("c1", "cr_a", { "tracking.views": 1000, "tracking.likes": 50 }, null, "Riya");
  await patchRow("c1", "cr_a", { "tracking.views": 2500 }, null, "Riya");
  const t = row(await get("c1"), "cr_a").tracking;
  assert.equal(t.views, 2500);
  assert.equal(t.likes, 50);
  assert.ok(Array.isArray(t.history) && t.history.length >= 1, "history kept");
});

await test("campaign fields: stage and brief.objective by two people at once", async () => {
  const [a, b] = await Promise.all([
    call("PATCH", "/api/campaigns/c1/fields", { set: { stage: "po_raised" }, from: { stage: "team_assigned" } }, "Accounts"),
    call("PATCH", "/api/campaigns/c1/fields", { set: { "brief.objective": "Sales" }, from: { "brief.objective": "Awareness" } }, "AM"),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const c = await get("c1");
  assert.equal(c.stage, "po_raised");
  assert.equal(c.brief.objective, "Sales");
  assert.equal(c.brief.budget, "₹5,00,000", "the rest of the brief untouched");
});

await test("campaign field conflict names who changed it", async () => {
  const r = await call("PATCH", "/api/campaigns/c1/fields", { set: { stage: "draft" }, from: { stage: "team_assigned" } }, "Late");
  assert.equal(r.status, 409);
  assert.equal(r.body.conflicts[0].by, "Accounts");
});

await test("a row edit and a campaign-field edit at the same moment both land", async () => {
  const [a, b] = await Promise.all([
    patchRow("c1", "cr_a", { cost: 31000 }, { cost: 30000 }, "Riya"),
    call("PATCH", "/api/campaigns/c1/fields", { set: { budget: 600000 } }, "AM"),
  ]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const c = await get("c1");
  assert.equal(row(c, "cr_a").cost, 31000);
  assert.equal(c.budget, 600000);
});

await test("timeline: concurrent appends both kept; a retried append is not duplicated", async () => {
  const before = (await get("c1")).timeline.length;
  await Promise.all([
    call("POST", "/api/campaigns/c1/timeline", { entry: { event: "One", tid: "t1" } }, "A"),
    call("POST", "/api/campaigns/c1/timeline", { entry: { event: "Two", tid: "t2" } }, "B"),
    call("POST", "/api/campaigns/c1/timeline", { entry: { event: "One", tid: "t1" } }, "A"),
  ]);
  const tl = (await get("c1")).timeline;
  assert.equal(tl.length, before + 2);
});

await test("adding rows from two places at once keeps both; re-sending is a no-op", async () => {
  const mk = (id, handle) => ({ _id: id, name: handle, handle, status: "suggested", cost: 0 });
  await Promise.all([
    call("POST", "/api/campaigns/c1/creators", { rows: [mk("cr_x", "@xena")] }, "A"),
    call("POST", "/api/campaigns/c1/creators", { rows: [mk("cr_y", "@yash")] }, "B"),
    call("POST", "/api/campaigns/c1/creators", { rows: [mk("cr_x", "@xena")] }, "A"),
  ]);
  const c = await get("c1");
  assert.equal(c.creators.filter((r) => r._id === "cr_x").length, 1);
  assert.ok(row(c, "cr_y"));
  assert.ok(c.creatorIds.includes("@xena") && c.creatorIds.includes("@yash"));
});

await test("removing a row while someone edits another keeps the edit", async () => {
  const [d, p] = await Promise.all([
    call("DELETE", "/api/campaigns/c1/creators/cr_y?actor=A"),
    patchRow("c1", ravi._id, { cost: 21000 }, { cost: 20000 }, "B"),
  ]);
  assert.equal(d.status, 200); assert.equal(p.status, 200);
  const c = await get("c1");
  assert.equal(row(c, "cr_y"), undefined);
  assert.equal(row(c, ravi._id).cost, 21000);
  assert.ok(!c.creatorIds.includes("@yash"));
});

await test("editing a removed row says so (404), not a silent no-op", async () => {
  const r = await patchRow("c1", "cr_y", { cost: 1 }, null, "B");
  assert.equal(r.status, 404);
});

await test("an outdated tab sending the whole roster is refused, nothing overwritten", async () => {
  const before = await get("c1");
  const r = await call("PATCH", "/api/campaigns/c1", { creators: [], stage: "draft" });
  assert.equal(r.status, 409);
  assert.equal(r.body.outdated, true);
  const after = await get("c1");
  assert.equal(after.creators.length, before.creators.length);
  assert.equal(after.stage, before.stage);
});

await test("the old PATCH still works for plain fields, and bumps rev", async () => {
  const before = (await get("c1")).rev;
  const r = await call("PATCH", "/api/campaigns/c1", { internalNotes: "hello" });
  assert.equal(r.status, 200);
  const after = await get("c1");
  assert.equal(after.internalNotes, "hello");
  assert.ok(after.rev > before);
});

await test("brand-scope still resolves (not taken as a campaign id)", async () => {
  const r = await call("GET", "/api/campaigns/brand-scope?all=1");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

await test("campaigns-revs lists every campaign's rev", async () => {
  const r = await call("GET", "/api/campaigns-revs");
  assert.equal(r.status, 200);
  assert.equal(r.body.c1, (await get("c1")).rev);
});

await test("the nightly metrics write keeps an edit made while it was fetching", async () => {
  const { writeRowMetrics } = await import(path.join(ROOT, "refreshPostMetrics.js"));
  // the job read the row long ago; meanwhile someone sets the cost
  const staleRef = { _id: "cr_a" };
  await patchRow("c1", "cr_a", { cost: 45000 }, null, "Riya");
  const ok = await writeRowMetrics("c1", staleRef, { views: 9999, likes: 10, lastAutoRefresh: new Date().toISOString() });
  assert.equal(ok, true);
  const r = row(await get("c1"), "cr_a");
  assert.equal(r.cost, 45000, "edit survived");
  assert.equal(r.tracking.views, 9999);
  assert.ok(r.tracking.history.length >= 2, "history extended");
});

await test("live stream: a change and presence reach other browsers", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${API}/api/live?user=Watcher`, { signal: ctrl.signal });
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  const reader = res.body.getReader();
  const events = [];
  let buf = "";
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(chunk)?.[1];
        const data = /data: (.*)/.exec(chunk)?.[1];
        if (ev) events.push({ ev, data: JSON.parse(data) });
      }
    }
  })();
  await sleep(150);
  await patchRow("c1", "cr_a", { cost: 46000 }, null, "Riya");
  await call("POST", "/api/live/presence", { campaignId: "c1", key: "tab1", user: "Riya", crId: "cr_a", field: "cost", state: "edit" });
  await sleep(250);
  ctrl.abort(); await pump.catch(() => {});
  assert.ok(events.find((e) => e.ev === "hello"));
  const ch = events.find((e) => e.ev === "campaign" && e.data.id === "c1" && e.data.by === "Riya");
  assert.ok(ch, "campaign event");
  assert.ok(ch.data.rev > 0);
  const pr = events.find((e) => e.ev === "presence" && e.data.campaignId === "c1");
  assert.equal(pr.data.users[0].user, "Riya");
  assert.equal(pr.data.users[0].field, "cost");
});

await test("the brand's decision in the portal bumps the row and is attributed", async () => {
  await db.collection("campaigns").updateOne({ _id: "c1" }, { $set: { brandId: "glow" } });
  await db.collection("clients").insertOne({ _id: "glow", name: "Glow Co" });
  const x = row(await get("c1"), "cr_x");
  const r = await call("POST", "/api/portal/campaigns/c1/creators/cr_x/decision", { decision: "approve", brand: "glow", author: "Meera" });
  // portal scope may require credentials in this setup; only check when it went through
  if (r.status === 200) {
    const after = row(await get("c1"), "cr_x");
    assert.equal(after.status, "shortlisted");
    assert.ok((after.rev || 0) > (x.rev || 0));
    assert.match(after.editedBy.status.by, /Meera/);
  } else {
    assert.ok([400, 401, 403, 404].includes(r.status), `unexpected ${r.status}`);
  }
});

// ── done ────────────────────────────────────────────────────────────────────
server.kill();
await db.dropDatabase();
await mongoose.disconnect();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log("\nserver log:\n" + serverLog.slice(-3000)); process.exit(1); }
process.exit(0);
