/**
 * "Add to directory" from Find Creators keeps everything that was found.
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 node test/creatorSocials.test.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import mongoose from "mongoose";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const URI = `${(process.env.MONGO_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/$/, "")}/socials_${Date.now().toString(36)}`;
const PORT = 4800 + Math.floor(Math.random() * 100), API = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (body) => { const r = await fetch(`${API}/api/creators`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

await mongoose.connect(URI);
const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: URI, PORT: String(PORT), DISABLE_SCHEDULER: "1" }, stdio: "ignore" });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${API}/api/health`)).ok) break; } catch {} await sleep(150); }
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "\n   ", e.message); process.exitCode = 1; } };

const yt = { platform: "youtube", platformId: "yt:UC1", username: "riyavlogs", profileUrl: "https://www.youtube.com/@riyavlogs", bio: "Mom vlogs | riya@x.in",
  followers: 120000, posts: 300, verified: true, email: "riya@x.in", website: "https://riya.in", extra: { banner: "b" }, niche: "mom", foundVia: "search: mom" };

await test("a new creator keeps every finder field under socials.<platform>", async () => {
  const r = await post({ name: "Riya", handle: "@riyavlogs", platform: "YouTube", followers: "120K", discovery: yt });
  assert.equal(r.status, 201);
  const list = await (await fetch(`${API}/api/creators`)).json();
  const c = list.find((x) => x.id === "@riyavlogs");
  assert.equal(c.platform, "YouTube");
  assert.deepEqual({ ...c.socials.youtube, savedAt: undefined }, { ...yt, savedAt: undefined });
  assert.ok(c.socials.youtube.savedAt);
});

await test("same handle from another platform: linked onto the existing creator, profile untouched", async () => {
  const r = await post({ name: "Riya T", handle: "@riyavlogs", platform: "Twitter / X", discovery: { platform: "x", username: "riyavlogs", followers: 5000, extra: { joinedAt: "2015" } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.linked, true);
  assert.equal(r.body.existing.platform, "YouTube");
  const c = (await (await fetch(`${API}/api/creators`)).json()).find((x) => x.id === "@riyavlogs");
  assert.equal(c.name, "Riya"); assert.equal(c.platform, "YouTube");
  assert.deepEqual(Object.keys(c.socials).sort(), ["x", "youtube"]);
  assert.equal(c.socials.x.extra.joinedAt, "2015");
});

await test("without finder data the old 409 stays", async () => {
  const r = await post({ name: "Riya", handle: "@riyavlogs" });
  assert.equal(r.status, 409);
});

await test("unknown platform or oversized data isn't stored", async () => {
  const r = await post({ name: "Z", handle: "@zz", discovery: { platform: "myspace", x: 1 } });
  assert.equal(r.status, 201);
  const c = (await (await fetch(`${API}/api/creators`)).json()).find((x) => x.id === "@zz");
  assert.equal(c.socials, undefined);
});

server.kill();
await mongoose.connection.db.dropDatabase(); await mongoose.disconnect();
console.log(`\n${passed} passed`);
