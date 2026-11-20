/**
 * Services → Consultant: the internal record, documents, brand links and
 * portal logins.
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 node test/consultants.test.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import mongoose from "mongoose";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URI = `${(process.env.MONGO_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/$/, "")}/consultants_${Date.now().toString(36)}`;
const PORT = 4900 + Math.floor(Math.random() * 100), API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, url, body) {
  const r = await fetch(`${API}${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json ?? text, headers: r.headers, raw: text };
}

await mongoose.connect(URI);
const db = mongoose.connection.db;
await db.collection("clients").insertMany([{ _id: "glow", name: "Glow Co" }, { _id: "fb", name: "FreshBite" }]);
const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: URI, PORT: String(PORT), DISABLE_SCHEDULER: "1" }, stdio: "ignore" });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {} await sleep(150); }
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "\n   ", e.message); process.exitCode = 1; } };

const full = {
  name: "Kapoor Consulting", email: "Hello@Kapoor.in",
  billing: { gstNumber: "27aapfu0939f1zv", address: "12 MG Road, Pune", gst: "27AAPFU0939F1ZV", email: "accounts@kapoor.in" },
  hq: { address: "Bandra, Mumbai", gst: "27AAPFU0939F1ZV" },
  tax: { tin: "27123456789", pan: "abcde1234f" },
  primaryContact: { name: "Rohan Kapoor", designation: "Founder", email: "rohan@kapoor.in" },
  pocs: [{ name: "Isha", designation: "Account lead", email: "isha@kapoor.in", phone: "+91 98200 00000" }, { name: "" }],
  brandIds: ["glow"],
  ugcCreators: [{ name: "Tara", handle: "@tara.ugc", platform: "Instagram", rate: 4500 }, { creatorId: "@mira", name: "Mira", handle: "@mira", status: "paused" }],
};
let id;

await test("add a consultant with every section; codes are tidied, empty POCs dropped, ids assigned", async () => {
  const r = await call("POST", "/api/consultants", full);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  id = r.body.id;
  assert.equal(id, "cs1");
  assert.equal(r.body.email, "hello@kapoor.in");
  assert.equal(r.body.billing.gstNumber, "27AAPFU0939F1ZV");
  assert.equal(r.body.tax.pan, "ABCDE1234F");
  assert.equal(r.body.pocs.length, 1);
  assert.ok(r.body.pocs[0]._id && r.body.primaryContact._id);
  assert.deepEqual(r.body.brandIds, ["glow"]);
  assert.equal(r.body.ugcCreators.length, 2);
  assert.equal(r.body.ugcCreators[1].status, "paused");
  const second = await call("POST", "/api/consultants", { name: "Second" });
  assert.equal(second.body.id, "cs2");
});

await test("bad PAN, GSTIN, email, unknown brand and missing name are refused in plain words", async () => {
  for (const [body, words] of [
    [{ name: "X", tax: { pan: "12345" } }, /PAN/],
    [{ name: "X", billing: { gst: "NOTAGST" } }, /Billing GST/],
    [{ name: "X", email: "nope" }, /email/i],
    [{ name: "X", brandIds: ["ghost"] }, /Unknown brand/],
    [{ name: "" }, /Name is required/],
    [{ name: "X", ugcCreators: [{ name: "A", rate: -5 }] }, /Rate/],
  ]) {
    const r = await call("POST", "/api/consultants", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, words);
  }
  assert.equal((await call("POST", "/api/consultants", { name: "Dup", email: "hello@kapoor.in" })).status, 409);
});

await test("edit one section at a time; the others stay", async () => {
  const r = await call("PATCH", `/api/consultants/${id}`, { brandIds: ["glow", "fb"], actor: "Arbeel" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.brandIds, ["glow", "fb"]);
  assert.equal(r.body.tax.pan, "ABCDE1234F");
  assert.equal(r.body.updatedBy, "Arbeel");
  const p = await call("PATCH", `/api/consultants/${id}`, { pocs: [...r.body.pocs, { name: "Dev", email: "dev@kapoor.in" }] });
  assert.equal(p.body.pocs.length, 2);
  assert.equal(p.body.pocs[0]._id, r.body.pocs[0]._id, "existing POC keeps its id");
  assert.equal((await call("PATCH", `/api/consultants/${id}`, {})).status, 400);
  assert.equal((await call("PATCH", `/api/consultants/nope`, { name: "x" })).status, 404);
});

await test("documents: upload with a name, list without bytes, open, refuse bad types and big files, delete", async () => {
  const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 test").toString("base64")}`;
  const up = await call("POST", `/api/consultants/${id}/documents`, { name: "Signed agreement", filename: "agreement.pdf", file: pdf });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.type, "PDF");
  const img = await call("POST", `/api/consultants/${id}/documents`, { name: "PAN card", filename: "pan.png", file: `data:image/png;base64,${Buffer.from("png").toString("base64")}` });
  assert.equal(img.status, 201);
  assert.equal((await call("POST", `/api/consultants/${id}/documents`, { name: "", file: pdf })).status, 400);
  assert.match((await call("POST", `/api/consultants/${id}/documents`, { name: "x", file: "data:application/zip;base64,AAAA" })).body.error, /isn't supported/);
  const big = `data:application/pdf;base64,${Buffer.alloc(3 * 1024 * 1024 + 10).toString("base64")}`;
  const tooBig = await call("POST", `/api/consultants/${id}/documents`, { name: "big", file: big });
  assert.ok([400, 413].includes(tooBig.status), `big file → ${tooBig.status}`);
  const list = await call("GET", `/api/consultants/${id}/documents`);
  assert.equal(list.body.length, 2);
  assert.ok(!("file" in list.body[0]));
  const f = await fetch(`${API}/api/consultants/${id}/documents/${up.body.id}/file`);
  assert.equal(f.headers.get("content-type"), "application/pdf");
  assert.match(f.headers.get("content-disposition"), /inline; filename="agreement.pdf"/);
  assert.equal(await f.text(), "%PDF-1.4 test");
  // scoped: another consultant can't reach it
  assert.equal((await fetch(`${API}/api/consultants/cs2/documents/${up.body.id}/file`)).status, 404);
  assert.equal((await call("DELETE", `/api/consultants/${id}/documents/${img.body.id}`)).status, 204);
  const all = await call("GET", "/api/consultants");
  assert.equal(all.body.find((c) => c.id === id).documentCount, 1);
});

await test("portal logins: create for a consultant, reveal, sign in with brands; inactive consultant can't sign in", async () => {
  const cr = await call("POST", "/api/consultant-credentials", { username: "Rohan@Kapoor.in", password: "s3cret-Pass", name: "Rohan Kapoor", consultantId: id });
  assert.equal(cr.status, 201, JSON.stringify(cr.body));
  assert.equal(cr.body.id, "cc1");
  assert.ok(!("hashKey" in cr.body) && !("passKey" in cr.body));
  assert.equal((await call("GET", `/api/consultant-credentials/${cr.body.id}/password`)).body.password, "s3cret-Pass");
  const ok = await call("POST", "/api/auth/consultant-login", { email: "rohan@kapoor.in", password: "s3cret-Pass" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.consultantName, "Kapoor Consulting");
  assert.deepEqual(ok.body.user.brandIds, ["glow", "fb"]);
  assert.equal(ok.body.user.firstLogin, true);
  assert.equal((await call("POST", "/api/auth/consultant-login", { email: "rohan@kapoor.in", password: "wrong" })).status, 401);
  // a consultant login is not a brand-portal or internal login
  assert.equal((await call("POST", "/api/auth/portal-login", { email: "rohan@kapoor.in", password: "s3cret-Pass" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { email: "rohan@kapoor.in", password: "s3cret-Pass" })).status, 401);
  await call("PATCH", `/api/consultants/${id}`, { status: "inactive" });
  const off = await call("POST", "/api/auth/consultant-login", { email: "rohan@kapoor.in", password: "s3cret-Pass" });
  assert.equal(off.status, 401);
  assert.match(off.body.error, /active consultant/);
  await call("PATCH", `/api/consultants/${id}`, { status: "active" });
  assert.equal((await call("GET", "/api/consultants")).body.find((c) => c.id === id).loginCount, 1);
});

const PNG = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64")}`;
let token, portalDocId;

await test("profile picture: set internally, served, never in JSON; cleared with null", async () => {
  const r = await call("PATCH", `/api/consultants/${id}`, { avatarImage: PNG, actor: "Arbeel" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hasAvatar, true);
  assert.equal(r.body.avatarSource, "internal");
  assert.ok(!("avatarImage" in r.body));
  const img = await fetch(`${API}/api/consultants/${id}/avatar`);
  assert.equal(img.headers.get("content-type"), "image/png");
  const list = await call("GET", "/api/consultants");
  assert.ok(!list.raw.includes("avatarImage"), "no bytes in the list");
  assert.equal((await call("PATCH", `/api/consultants/${id}`, { avatarImage: "data:image/gif;base64,AAAA" })).status, 400);
  const cleared = await call("PATCH", `/api/consultants/${id}`, { avatarImage: null });
  assert.equal(cleared.body.hasAvatar, false);
  assert.equal((await fetch(`${API}/api/consultants/${id}/avatar`)).status, 404);
  assert.equal((await call("PATCH", `/api/consultants/${id}`, { avatarImage: PNG })).body.hasAvatar, true);
});

await test("portal: login gives a token; the token reads only its own consultant, without internal notes", async () => {
  await call("PATCH", `/api/consultants/${id}`, { notes: "Secret terms" });
  const ok = await call("POST", "/api/auth/consultant-login", { email: "rohan@kapoor.in", password: "s3cret-Pass" });
  token = ok.body.user.token;
  assert.ok(token && ok.body.user.consultantHasAvatar);
  assert.equal((await call("GET", "/api/consultant-portal/me")).status, 401, "no token → 401");
  const bad = await fetch(`${API}/api/consultant-portal/me`, { headers: { authorization: `Bearer ${token.slice(0, -2)}xx` } });
  assert.equal(bad.status, 401, "tampered token → 401");
  const me = await (await fetch(`${API}/api/consultant-portal/me`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(me.id, id);
  assert.equal(me.name, "Kapoor Consulting");
  assert.equal(me.notes, undefined, "internal notes stay internal");
  assert.equal(me.updatedBy, undefined);
  assert.deepEqual(me.brands.map((b) => b.name).sort(), ["FreshBite", "Glow Co"]);
  assert.equal(me.signedInAs.email, "rohan@kapoor.in");
  assert.equal(me.pocs.length, 2);
});

await test("portal: the consultant's picture and uploads show up internally; they can't delete the team's files", async () => {
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const pic = await fetch(`${API}/api/consultant-portal/avatar`, { method: "PUT", headers: auth, body: JSON.stringify({ avatarImage: PNG }) });
  assert.equal(pic.status, 200);
  const internal = (await call("GET", `/api/consultants/${id}`)).body;
  assert.equal(internal.avatarSource, "portal");
  assert.match(internal.avatarUpdatedBy, /Rohan Kapoor \(consultant\)/);
  const up = await fetch(`${API}/api/consultant-portal/documents`, { method: "POST", headers: auth,
    body: JSON.stringify({ name: "GST certificate", filename: "gst.pdf", file: `data:application/pdf;base64,${Buffer.from("%PDF gst").toString("base64")}` }) });
  assert.equal(up.status, 201);
  portalDocId = (await up.json()).id;
  const seen = (await call("GET", `/api/consultants/${id}/documents`)).body;
  const mine = seen.find((d) => d.id === portalDocId);
  assert.equal(mine.source, "portal");
  assert.equal(mine.uploadedBy, "Rohan Kapoor");
  // opening a file from a link carries the token as ?t=
  const f = await fetch(`${API}/api/consultant-portal/documents/${portalDocId}/file?t=${encodeURIComponent(token)}`);
  assert.equal(await f.text(), "%PDF gst");
  const teamDoc = seen.find((d) => d.source !== "portal");
  assert.equal((await fetch(`${API}/api/consultant-portal/documents/${teamDoc.id}`, { method: "DELETE", headers: auth })).status, 403);
  assert.equal((await fetch(`${API}/api/consultant-portal/documents/${portalDocId}`, { method: "DELETE", headers: auth })).status, 204);
  // another consultant's file is out of reach
  const other = await call("POST", "/api/consultants/cs2/documents", { name: "x", file: `data:application/pdf;base64,${Buffer.from("x").toString("base64")}` });
  assert.equal((await fetch(`${API}/api/consultant-portal/documents/${other.body.id}/file?t=${encodeURIComponent(token)}`)).status, 404);
});

await test("portal: setting the consultant inactive or removing the login ends the session at once", async () => {
  const auth = { authorization: `Bearer ${token}` };
  await call("PATCH", `/api/consultants/${id}`, { status: "inactive" });
  assert.equal((await fetch(`${API}/api/consultant-portal/me`, { headers: auth })).status, 401);
  await call("PATCH", `/api/consultants/${id}`, { status: "active" });
  assert.equal((await fetch(`${API}/api/consultant-portal/me`, { headers: auth })).status, 200);
  const creds = (await call("GET", "/api/consultant-credentials")).body;
  const extra = await call("POST", "/api/consultant-credentials", { username: "temp@kapoor.in", password: "Temp-1234", name: "Temp", consultantId: id });
  const t2 = (await call("POST", "/api/auth/consultant-login", { email: "temp@kapoor.in", password: "Temp-1234" })).body.user.token;
  await call("DELETE", `/api/consultant-credentials/${extra.body.id}`);
  assert.equal((await fetch(`${API}/api/consultant-portal/me`, { headers: { authorization: `Bearer ${t2}` } })).status, 401);
  assert.equal(creds.length, 1);
});

await test("deleting a brand takes it off consultants; deleting a consultant removes its files and logins", async () => {
  assert.ok([200, 204].includes((await call("DELETE", "/api/clients/fb")).status));
  assert.deepEqual((await call("GET", `/api/consultants/${id}`)).body.brandIds, ["glow"]);
  const d = await call("DELETE", `/api/consultants/${id}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual([d.body.documents, d.body.logins], [1, 1]);
  assert.equal(await db.collection("consultant_documents").countDocuments({ consultantId: id }), 0);
  assert.equal((await call("POST", "/api/auth/consultant-login", { email: "rohan@kapoor.in", password: "s3cret-Pass" })).status, 401);
});

await test("brand details (Settings → Brand Settings) are cleaned like a consultant's; the logo and other fields stay", async () => {
  await db.collection("clients").insertOne({ _id: "dets", name: "Details Co", website: "details.co", avatarUpdatedAt: new Date() });
  const r = await call("PATCH", "/api/clients/dets", {
    billing: { gstNumber: "27aapfu0939f1zv", address: " 1 Linking Rd ", gst: "", email: "Bills@Details.co", junk: "x" },
    hq: { address: "Andheri", gst: "27AAPFU0939F1ZV" }, tax: { tin: "27123456789", pan: "abcde1234f" },
    primaryContact: { name: "Asha", designation: "CMO", email: "asha@details.co", phone: "+91 90000 00000" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.billing, { gstNumber: "27AAPFU0939F1ZV", address: "1 Linking Rd", gst: "", email: "bills@details.co" });
  assert.equal(r.body.tax.pan, "ABCDE1234F");
  assert.ok(r.body.primaryContact._id);
  assert.equal(r.body.website, "details.co");
  assert.equal(r.body.hasAvatar, true);
  for (const [body, words] of [[{ tax: { pan: "nope" } }, /PAN/], [{ hq: { gst: "BAD" } }, /HQ GST/], [{ primaryContact: { email: "x" } }, /email/i]]) {
    const bad = await call("PATCH", "/api/clients/dets", body);
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.match(bad.body.error, words);
  }
  const plain = await call("PATCH", "/api/clients/dets", { name: "Details & Co" });
  assert.equal(plain.body.tax.pan, "ABCDE1234F");
  assert.equal(plain.body.name, "Details & Co");
});

server.kill();
await db.dropDatabase(); await mongoose.disconnect();
console.log(`\n${passed} passed`);
