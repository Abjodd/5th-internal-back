/**
 * Campaign sync — safe multi-user editing + live updates.
 * ─────────────────────────────────────────────────────────────────
 * Why this exists: campaigns used to be saved by sending the WHOLE creators
 * list (or the whole campaign) from whichever browser saved last. Two people
 * on one campaign — or one person whose two quick saves arrived out of order,
 * or the nightly metrics job holding a minutes-old copy — silently erased each
 * other's work.
 *
 * Every write here touches only the fields that actually changed:
 *
 *   PATCH  /api/campaigns/:id/creators/:crId   one roster row, field by field
 *   POST   /api/campaigns/:id/creators         add rows
 *   DELETE /api/campaigns/:id/creators/:crId   remove a row
 *   PATCH  /api/campaigns/:id/fields           campaign fields (stage, budget, brief.objective, …)
 *   POST   /api/campaigns/:id/timeline         append one timeline entry
 *   GET    /api/campaigns/:id                  one campaign (hydrated)
 *   GET    /api/campaigns-revs                 { id: rev } for every campaign (cheap change check)
 *
 * Conflicts: a write may say what value it started from (`from`). If someone
 * else changed that field in the meantime — to something different from what
 * this write wants — nothing is written and the reply is 409 with who changed
 * it, to what, and when. The same value from two people is not a conflict.
 * `force: true` is the "use mine" answer to that.
 *
 * Atomicity: each campaign carries `rev`, each roster row its own `rev`. A
 * write is applied with the rev it read as a condition; if another write got
 * in between, it re-reads and re-checks (field by field, so unrelated changes
 * never block it) and tries again.
 *
 * Live updates (server-sent events — plain HTTP, no extra library):
 *
 *   GET  /api/live                 event stream: campaign changes + who's here
 *   POST /api/live/presence        "I'm viewing / editing this cell / gone"
 */
import Campaign from "./models/Campaign.js";
import Creator from "./models/Creator.js";
import { PROFILE_FIELDS, keyOf, splitCreatorsForStorage, hydrateCampaignCreators } from "./creatorSync.js";
import { withHistory } from "./trackingHistory.js";
import { OMIT_AVATAR } from "./avatarStore.js";

// ── tiny helpers ────────────────────────────────────────────────────────────
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
const norm = (v) => (v === undefined ? null : v);
export function deepEqual(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}
const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const metaKey = (path) => path.replace(/\./g, "__");

// Paths a client may write on a roster row: a field, or one level into an
// object field ("concept.status", "tracking.views"). Never ids, revs, the
// comment threads (their own route appends to them) or the metrics history.
const ROW_BLOCK = /(^|\.)(_id|rev|creatorId|editedBy|comments|history)(\.|$)|\$/;
const ROW_PATH = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)?$/;
// …except the post's comment COUNT. "tracking.comments" is a number that
// Refresh writes next to views/likes/forwards — not a thread — and blocking it
// with the threads meant it never saved: it showed for the person who pressed
// Refresh and was "—" after a reload or for anyone else. Numbers only, so a
// thread can't be smuggled in under this name.
const ROW_NUMBER_OK = new Set(["tracking.comments"]);
// Campaign-level paths. Arrays and identity that have their own routes are out.
const FIELD_BLOCK = /^(_id|id|rev|creators|creatorIds|timeline|deleted|editedBy)(\.|$)|\$/;
const FIELD_PATH = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*){0,2}$/;

class HttpError extends Error { constructor(status, body) { super(body?.error || "error"); this.status = status; this.body = body; } }

function cleanSet(set, allowPath, block, numberOk = null) {
  if (!isObj(set) || !Object.keys(set).length) throw new HttpError(400, { error: "Nothing to save." });
  for (const p of Object.keys(set)) {
    if (numberOk?.has(p)) {
      const v = set[p];
      if (v === null || (typeof v === "number" && Number.isFinite(v))) continue;
      throw new HttpError(400, { error: `Field "${p}" must be a number.` });
    }
    if (!allowPath.test(p) || block.test(p)) throw new HttpError(400, { error: `Field "${p}" can't be changed here.` });
  }
  return set;
}

/** Fields where someone else's change got in first. */
function conflictsOf(current, set, from, editedBy) {
  if (!isObj(from)) return [];
  const out = [];
  for (const p of Object.keys(set)) {
    if (!(p in from)) continue;
    const cur = getPath(current, p);
    if (deepEqual(cur, from[p]) || deepEqual(cur, set[p])) continue;
    const meta = editedBy?.[metaKey(p)] || editedBy?.[metaKey(p.split(".")[0])] || null;
    out.push({ path: p, current: norm(cur), yours: set[p], from: from[p], by: meta?.by || null, at: meta?.at || null });
  }
  return out;
}

const actorOf = (req) => String(req.body?.actor || req.query?.actor || "").trim().slice(0, 80) || "Someone";
const MAX_TRIES = 10;
// Small, growing, jittered pause between retries so writers racing for one row spread out.
const backoff = (attempt) => new Promise((r) => setTimeout(r, attempt ? 4 + Math.random() * 15 * attempt : 0));

// ── live hub (SSE) ──────────────────────────────────────────────────────────
const clients = new Set();          // { res, user, id }
const presence = new Map();         // campaignId → Map(clientKey → { user, crId, field, state, at })
const PRESENCE_TTL = 45_000;

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}
function broadcast(event, data) {
  for (const c of clients) send(c.res, event, data);
}

/** Tell every open app that a campaign changed. Cheap; safe to call often. */
export function notifyCampaign(id, info = {}) {
  broadcast("campaign", { id: String(id), at: new Date().toISOString(), ...info });
}

/** Bump a campaign's rev after a write made outside this module, and announce it. */
export async function touchCampaign(id, info = {}) {
  const doc = await Campaign.findOneAndUpdate({ _id: id }, { $inc: { rev: 1 } }, { new: true, projection: { rev: 1 } }).lean();
  notifyCampaign(id, { rev: doc?.rev, ...info });
  return doc?.rev;
}

function presenceList(campaignId) {
  const m = presence.get(campaignId);
  if (!m) return [];
  const now = Date.now();
  for (const [k, v] of m) if (now - v.at > PRESENCE_TTL) m.delete(k);
  return [...m.entries()].map(([key, v]) => ({ key, user: v.user, crId: v.crId || null, field: v.field || null, state: v.state, at: new Date(v.at).toISOString() }));
}
function announcePresence(campaignId) {
  broadcast("presence", { campaignId, users: presenceList(campaignId) });
}
setInterval(() => {
  // expire quiet viewers and keep proxies from closing idle streams
  for (const id of presence.keys()) {
    const before = presence.get(id).size;
    const list = presenceList(id);
    if (list.length !== before) announcePresence(id);
    if (!list.length) presence.delete(id);
  }
  for (const c of clients) { try { c.res.write(`: ping ${Date.now()}\n\n`); } catch { /* closed */ } }
}, 20_000).unref?.();

// ── reads ───────────────────────────────────────────────────────────────────
async function loadCampaign(id, projection) {
  const doc = await Campaign.findOne({ _id: id, deleted: { $ne: true } }, projection).lean();
  if (!doc) throw new HttpError(404, { error: "Campaign not found — it may have been archived." });
  return doc;
}
async function hydratedRow(campaignId, crId) {
  const doc = await Campaign.findOne({ _id: campaignId }, { creators: { $elemMatch: { _id: crId } }, rev: 1 }).lean();
  if (!doc?.creators?.length) return { row: null, rev: doc?.rev };
  const [h] = await hydrateCampaignCreators([{ creators: doc.creators }]);
  return { row: h.creators[0], rev: doc.rev };
}
export async function publicCampaign(id) {
  const doc = await Campaign.findOne({ _id: id, deleted: { $ne: true } }).lean();
  if (!doc) return null;
  const [h] = await hydrateCampaignCreators([doc]);
  const { _id, ...rest } = h;
  return { id: _id, ...rest };
}

// ── writes ──────────────────────────────────────────────────────────────────

/** One roster row, field by field. */
export async function patchCreatorRow(campaignId, crId, { set, from, force, actor }) {
  cleanSet(set, ROW_PATH, ROW_BLOCK, ROW_NUMBER_OK);
  const profilePaths = Object.keys(set).filter((p) => PROFILE_FIELDS.includes(p.split(".")[0]));
  const rowPaths = Object.keys(set).filter((p) => !profilePaths.includes(p));
  const now = new Date();

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    await backoff(attempt);
    const camp = await loadCampaign(campaignId, { creators: { $elemMatch: { _id: crId } }, rev: 1, name: 1 });
    const stored = camp.creators?.[0];
    if (!stored) throw new HttpError(404, { error: "That creator is no longer on this campaign — someone may have removed them." });
    const key = stored.creatorId || keyOf(stored);
    const profile = key ? (await Creator.findById(key, OMIT_AVATAR).lean()) || {} : {};
    const current = { ...pickProfile(profile), ...stored };

    if (!force) {
      const conflicts = conflictsOf(current, set, from, stored.editedBy);
      if (conflicts.length) {
        const [h] = await hydrateCampaignCreators([{ creators: [stored] }]);
        throw new HttpError(409, { error: "Someone else changed this first.", conflicts, row: h.creators[0], rev: camp.rev });
      }
    }

    // Already exactly as requested — nothing to write (e.g. both typed the same value).
    if (Object.keys(set).every((p) => deepEqual(getPath(current, p), set[p]))) {
      const { row, rev } = await hydratedRow(campaignId, crId);
      return { row, rev, unchanged: true };
    }

    // Campaign-side part, guarded by the row's rev.
    const rowSet = Object.fromEntries(rowPaths.map((p) => [p, set[p]]));
    // Metrics written by hand (Deliverables refresh) extend the growth series
    // exactly like the nightly job does.
    if (rowPaths.some((p) => p.startsWith("tracking.") || p === "tracking")) {
      const nextTracking = { ...(isObj(stored.tracking) ? stored.tracking : {}) };
      if ("tracking" in set && isObj(set.tracking)) Object.assign(nextTracking, set.tracking);
      for (const p of rowPaths) if (p.startsWith("tracking.")) nextTracking[p.slice(9)] = set[p];
      const history = withHistory(stored.tracking?.history, nextTracking, now, stored.tracking);
      if ("tracking" in rowSet) rowSet.tracking = { ...(isObj(rowSet.tracking) ? rowSet.tracking : {}), history };
      else rowSet["tracking.history"] = history;
    }
    const $set = {};
    for (const [p, v] of Object.entries(collapseIntoNull(stored, Object.keys(rowSet), rowSet))) $set[`creators.$[c].${p}`] = v;
    for (const p of Object.keys(set)) $set[`creators.$[c].editedBy.${metaKey(p)}`] = { by: actor, at: now.toISOString() };
    const rowRev = stored.rev;
    $set["creators.$[c].rev"] = (rowRev || 0) + 1;
    $set["creators.$[c].updatedAt"] = now.toISOString();
    $set["creators.$[c].updatedBy"] = actor;
    // The rev guard has to sit in the QUERY: the campaign-level $inc below
    // would otherwise count as "modified" even when the array filter matched
    // no row, and a lost write would report success.
    const rowMatch = rowRev == null ? { _id: crId, rev: { $exists: false } } : { _id: crId, rev: rowRev };
    const filter = { "c._id": crId };

    // A legacy row that still carries its own copy of a profile field would
    // keep showing that copy (row values win on read), so drop it as the
    // directory takes the edit.
    const $unset = {};
    for (const top of new Set(profilePaths.map((p) => p.split(".")[0]))) if (top in stored) $unset[`creators.$[c].${top}`] = "";

    const res = await Campaign.updateOne(
      { _id: campaignId, deleted: { $ne: true }, creators: { $elemMatch: rowMatch } },
      { $set: { ...$set, updatedAt: now }, $inc: { rev: 1 }, ...(Object.keys($unset).length ? { $unset } : {}) },
      { arrayFilters: [filter] },
    );
    if (!res.modifiedCount) continue; // someone else wrote this row in between (or it's gone) — re-read and re-check

    // Directory-side part (name, followers, state, personal details, …):
    // only the fields this edit touched.
    if (profilePaths.length && key) {
      const dset = collapseIntoNull(current, profilePaths, set);
      const nextKey = keyOf({ ...current, ...flatToNested(dset) });
      if (nextKey && nextKey !== key) {
        // handle/name changed → the directory key moves with it
        const { _id, ...prof } = profile;
        await Creator.updateOne({ _id: nextKey }, { $set: { ...prof, ...dset } }, { upsert: true });
        await Campaign.updateOne({ _id: campaignId }, { $set: { "creators.$[c].creatorId": nextKey } }, { arrayFilters: [{ "c._id": crId }] });
        await Campaign.updateOne({ _id: campaignId, creatorIds: key }, { $set: { "creatorIds.$": nextKey } });
      } else {
        await Creator.updateOne({ _id: key }, { $set: dset }, { upsert: true });
      }
    }

    const { row, rev } = await hydratedRow(campaignId, crId);
    notifyCampaign(campaignId, { rev, by: actor, kind: "creator", crId, paths: Object.keys(set) });
    return { row, rev, campaignName: camp.name };
  }
  throw new HttpError(409, { error: "This creator is being edited very quickly by several people — try again.", busy: true });
}
/**
 * `{ "concept.status": "approved" }` as a $set. Mongo can't create a field
 * inside a value that is null (or a string), so when the parent isn't an
 * object yet the sub-fields are folded into one whole-object write instead.
 */
function collapseIntoNull(base, paths, set) {
  const out = {};
  for (const p of paths) {
    const dot = p.indexOf(".");
    if (dot < 0) { out[p] = set[p]; continue; }
    const top = p.slice(0, dot);
    const parent = base?.[top];
    if (parent === undefined || isObj(parent)) { out[p] = set[p]; continue; }
    const whole = isObj(out[top]) ? out[top] : {};
    whole[p.slice(dot + 1)] = set[p];
    out[top] = whole;
  }
  // a whole-object write and a dotted write under it can't share one update
  for (const k of Object.keys(out)) if (k.includes(".") && isObj(out[k.split(".")[0]])) {
    out[k.split(".")[0]][k.split(".").slice(1).join(".")] = out[k]; delete out[k];
  }
  return out;
}
const pickProfile = (p) => Object.fromEntries(PROFILE_FIELDS.filter((k) => k in (p || {})).map((k) => [k, p[k]]));
function flatToNested(flat) {
  const out = {};
  for (const [p, v] of Object.entries(flat)) {
    const parts = p.split(".");
    let o = out;
    parts.slice(0, -1).forEach((k) => { o[k] = isObj(o[k]) ? o[k] : {}; o = o[k]; });
    o[parts[parts.length - 1]] = v;
  }
  return out;
}

/** Add roster rows (idempotent: a row whose _id is already there is skipped). */
export async function addCreatorRows(campaignId, rows, actor) {
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, { error: "No creators to add." });
  const camp = await loadCampaign(campaignId, { "creators._id": 1 });
  const have = new Set((camp.creators || []).map((c) => String(c._id)));
  const fresh = rows.filter((r) => r && r._id && !have.has(String(r._id)));
  if (fresh.length) {
    const now = new Date().toISOString();
    const stored = (await splitCreatorsForStorage(fresh)).map((r) => ({ ...r, rev: 1, updatedAt: now, updatedBy: actor }));
    // One conditional push per row, so a retried or doubled request can never
    // put the same row on the roster twice.
    for (const r of stored) {
      await Campaign.updateOne(
        { _id: campaignId, "creators._id": { $ne: r._id } },
        { $push: { creators: r }, ...(r.creatorId ? { $addToSet: { creatorIds: r.creatorId } } : {}), $inc: { rev: 1 }, $set: { updatedAt: new Date() } },
      );
    }
  }
  const doc = await publicCampaign(campaignId);
  const added = (doc?.creators || []).filter((c) => rows.some((r) => String(r?._id) === String(c._id)));
  notifyCampaign(campaignId, { rev: doc?.rev, by: actor, kind: "creators-added", crIds: added.map((c) => c._id) });
  return { rows: added, rev: doc?.rev, campaign: doc };
}

/** Remove one roster row. */
export async function removeCreatorRow(campaignId, crId, actor) {
  const camp = await loadCampaign(campaignId, { creators: { $elemMatch: { _id: crId } } });
  const row = camp.creators?.[0];
  if (!row) return { removed: false };
  const key = row.creatorId;
  await Campaign.updateOne({ _id: campaignId }, { $pull: { creators: { _id: crId } }, $inc: { rev: 1 }, $set: { updatedAt: new Date() } });
  // keep creatorIds in step: drop the key only if no other row still uses it
  if (key) {
    const still = await Campaign.exists({ _id: campaignId, "creators.creatorId": key });
    if (!still) await Campaign.updateOne({ _id: campaignId }, { $pull: { creatorIds: key } });
  }
  const doc = await Campaign.findById(campaignId, { rev: 1 }).lean();
  notifyCampaign(campaignId, { rev: doc?.rev, by: actor, kind: "creator-removed", crId });
  return { removed: true, rev: doc?.rev };
}

/** Campaign-level fields (stage, budget, sentToClient, brief.objective, insights.reach, …). */
export async function patchCampaignFields(campaignId, { set, from, force, actor }) {
  cleanSet(set, FIELD_PATH, FIELD_BLOCK);
  const now = new Date();
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    await backoff(attempt);
    const camp = await loadCampaign(campaignId, { creators: 0 });
    if (!force) {
      const conflicts = conflictsOf(camp, set, from, camp.editedBy);
      if (conflicts.length) throw new HttpError(409, { error: "Someone else changed this first.", conflicts, rev: camp.rev });
    }
    if (Object.keys(set).every((p) => deepEqual(getPath(camp, p), set[p]))) return { rev: camp.rev, unchanged: true };
    const $set = { updatedAt: now };
    for (const [p, v] of Object.entries(set)) {
      $set[p] = v;
      $set[`editedBy.${metaKey(p)}`] = { by: actor, at: now.toISOString() };
    }
    const guard = camp.rev == null ? { rev: { $exists: false } } : { rev: camp.rev };
    const res = await Campaign.updateOne({ _id: campaignId, deleted: { $ne: true }, ...guard }, { $set, $inc: { rev: 1 } });
    if (!res.modifiedCount) continue;
    const rev = (camp.rev || 0) + 1;
    notifyCampaign(campaignId, { rev, by: actor, kind: "fields", paths: Object.keys(set) });
    return { rev };
  }
  throw new HttpError(409, { error: "This campaign is being edited very quickly by several people — try again.", busy: true });
}

/** Append a timeline entry (idempotent on entry.tid). */
export async function appendTimeline(campaignId, entry, actor) {
  if (!isObj(entry) || !String(entry.event || "").trim()) throw new HttpError(400, { error: "Timeline entry needs an event." });
  const clean = {
    date: String(entry.date || new Date().toISOString().slice(0, 10)),
    event: String(entry.event).slice(0, 2000),
    actor: String(entry.actor || actor || "").slice(0, 80),
    tid: String(entry.tid || `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    at: new Date().toISOString(),
  };
  await loadCampaign(campaignId, { _id: 1 });
  const res = await Campaign.updateOne(
    { _id: campaignId, "timeline.tid": { $ne: clean.tid } },
    { $push: { timeline: clean }, $inc: { rev: 1 }, $set: { updatedAt: new Date() } },
  );
  const doc = await Campaign.findById(campaignId, { rev: 1 }).lean();
  if (res.modifiedCount) notifyCampaign(campaignId, { rev: doc?.rev, by: clean.actor || actor, kind: "timeline" });
  return { entry: clean, rev: doc?.rev, duplicate: !res.modifiedCount };
}

/**
 * Gives every roster row saved before row ids existed an `_id` (and every
 * campaign a `rev`), so each row can be written on its own. Idempotent; runs
 * at boot and touches nothing once the data is clean.
 */
export async function ensureRowIds() {
  const docs = await Campaign.find(
    { $or: [{ creators: { $elemMatch: { _id: { $exists: false } } } }, { rev: { $exists: false } }] },
    { creators: 1, rev: 1 },
  ).lean();
  let fixed = 0;
  for (const d of docs) {
    const rows = d.creators || [];
    const missing = rows.some((r) => r && r._id == null);
    if (!missing) {
      await Campaign.updateOne({ _id: d._id, rev: { $exists: false } }, { $set: { rev: 1 } });
      continue;
    }
    const next = rows.map((r, i) => (r && r._id == null
      ? { ...r, _id: `cr_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}` }
      : r));
    const guard = d.rev == null ? { rev: { $exists: false } } : { rev: d.rev };
    const res = await Campaign.updateOne({ _id: d._id, ...guard }, { $set: { creators: next }, $inc: { rev: 1 } });
    if (res.modifiedCount) fixed++;
  }
  if (fixed) console.log(`[campaignSync] gave row ids to ${fixed} campaign(s)`);
  return fixed;
}

// ── routes ──────────────────────────────────────────────────────────────────
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error("[campaignSync]", err);
    res.status(500).json({ error: err.message });
  }
};

export function registerCampaignSyncRoutes(app) {
  // cheap "what changed?" for the polling fallback
  app.get("/api/campaigns-revs", wrap(async (_req, res) => {
    const docs = await Campaign.find({ deleted: { $ne: true } }, { rev: 1 }).lean();
    res.json(Object.fromEntries(docs.map((d) => [d._id, d.rev || 0])));
  }));

  // One campaign, hydrated — what an open app re-reads when told it changed.
  // Reserved words that are their own routes further down fall through.
  const RESERVED = new Set(["brand-scope"]);
  app.get("/api/campaigns/:id", (req, res, next) => {
    if (RESERVED.has(req.params.id)) return next();
    return wrap(async () => {
      const doc = await publicCampaign(req.params.id);
      if (!doc) return res.status(404).json({ error: "not found" });
      res.json(doc);
    })(req, res);
  });

  app.patch("/api/campaigns/:id/creators/:crId", wrap(async (req, res) => {
    const { set, from, force } = req.body || {};
    res.json(await patchCreatorRow(req.params.id, String(req.params.crId), { set, from, force: !!force, actor: actorOf(req) }));
  }));

  app.post("/api/campaigns/:id/creators", wrap(async (req, res) => {
    res.status(201).json(await addCreatorRows(req.params.id, req.body?.rows, actorOf(req)));
  }));

  app.delete("/api/campaigns/:id/creators/:crId", wrap(async (req, res) => {
    res.json(await removeCreatorRow(req.params.id, String(req.params.crId), actorOf(req)));
  }));

  app.patch("/api/campaigns/:id/fields", wrap(async (req, res) => {
    const { set, from, force } = req.body || {};
    res.json(await patchCampaignFields(req.params.id, { set, from, force: !!force, actor: actorOf(req) }));
  }));

  app.post("/api/campaigns/:id/timeline", wrap(async (req, res) => {
    res.status(201).json(await appendTimeline(req.params.id, req.body?.entry, actorOf(req)));
  }));

  // ── live stream ──
  app.get("/api/live", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write("retry: 4000\n\n");
    const client = { res, user: String(req.query.user || "").slice(0, 80), id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}` };
    clients.add(client);
    send(res, "hello", { id: client.id });
    // current presence everywhere, so a fresh tab shows who's around at once
    for (const id of presence.keys()) send(res, "presence", { campaignId: id, users: presenceList(id) });
    req.on("close", () => clients.delete(client));
  });

  app.post("/api/live/presence", (req, res) => {
    const { campaignId, key, user, crId, field, state } = req.body || {};
    if (!campaignId || !key) return res.status(400).json({ error: "campaignId and key are required" });
    const id = String(campaignId);
    if (!presence.has(id)) presence.set(id, new Map());
    const m = presence.get(id);
    if (state === "leave") m.delete(String(key));
    else m.set(String(key), { user: String(user || "Someone").slice(0, 80), crId: crId || null, field: field || null, state: state === "edit" ? "edit" : "view", at: Date.now() });
    // a viewer leaving one campaign for another
    if (state !== "leave") for (const [other, om] of presence) if (other !== id && om.delete(String(key))) announcePresence(other);
    announcePresence(id);
    res.json({ ok: true, users: presenceList(id) });
  });
}

export { HttpError };
