// Pitch Draft — routes/pitchDrafts.js
//
// The normal Pitch Client flow (routes/pitch.js) always needs an existing
// Client + Campaign to hang a pitch off. This is the other case: a brand
// that isn't in the system yet, being put together as a prospect — a
// combined brand+campaign form, a freeform written brief, some suggested
// reel links, and a set of candidate creators — before anyone here has
// decided this is a real deal. See models/PitchDraft.js for the full
// rationale on why it's a separate collection rather than an early,
// incomplete Client/Campaign pair.
//
// Same two-audience split as pitch.js:
//
//   INTERNAL  /api/pitch-drafts...      Same trust model as every other
//             internal route in server.js — no auth middleware here either.
//
//   PUBLIC    /api/pitch-drafts/public/:id?code=...   No login. Scoped by
//             a per-DRAFT access code (PitchDraft.pitchCode), same
//             lightweight model as the real pitch link's Client.pitchCode —
//             except here the code is per-draft (a draft has no brand
//             record yet to hang a code off), not per-brand.
//
// Promotion (POST /api/pitch-drafts/:id/promote) is the hinge: it creates a
// REAL Client + Campaign from the draft's fields and carries EVERY candidate
// over as a real PitchProfile with the decision it currently has (pending,
// approved or rejected), linked one-to-one (profile.pitchProfileId). The
// client's link does NOT close: decisions made on it after promotion are
// written to that PitchProfile — exactly where the team works and ships from
// — and a candidate only locks once it's shipped, the same rule as an
// ordinary pitch. (It used to carry only approved candidates and freeze the
// link, which showed every undecided candidate as "Moved forward" if the
// team promoted before the client had answered.) briefSections and
// suggestedContent stay on the archived draft (status: "promoted").
//
// One link, for life: the access code is minted once and never rotated —
// the link only stops working when the draft is deleted. Images the link
// shows (reel posters, creator photos) are copied into PitchAsset at add
// time, because Instagram's signed CDN URLs die within days.
import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import PitchDraft from "../models/PitchDraft.js";
import Client from "../models/Client.js";
import Campaign from "../models/Campaign.js";
import Creator from "../models/Creator.js";
import PitchProfile from "../models/PitchProfile.js";
import PitchAsset from "../models/PitchAsset.js";
import { fetchRemoteImage } from "../remoteAvatar.js";
import { toBuffer } from "../avatarStore.js";
import { imageSize } from "../imageSize.js";
import { fetchInstagramProfile } from "../instagramfetchhiker.js";
import { keyOf, upsertCreatorFromFetch } from "../creatorSync.js";
import { fetchReelSnapshot } from "../portalReels.js";

const router = Router();

// Same normalisation pitch.js uses — needed here too so the directory
// lookup checks the same key Hiker would end up using.
function extractUsername(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/^@/, "");
  const m = s.match(/instagram\.com\/([^/?#]+)/i);
  return (m ? m[1] : s).toLowerCase() || null;
}

const genCode = () => randomBytes(4).toString("hex").toUpperCase(); // e.g. "A1B2C3D4"
// Short, URL-safe, and IS the client link's path segment — same role
// Client._id plays for a real brand's pitch link.
const genDraftId = () => `pd_${randomBytes(6).toString("hex")}`;

const DIRECTORY_SELECT = {
  name: 1, handle: 1, platform: 1, igUrl: 1, followers: 1, following: 1, posts: 1,
  avgLikes: 1, avgComments: 1, avgViews: 1, avgER: 1, bio: 1, externalUrl: 1,
  isVerified: 1, isPrivate: 1, isBusiness: 1, avatarUpdatedAt: 1,
};

// Only the fields the internal team edits directly on a draft's top half —
// whitelisted so a PATCH body can't smuggle in status/promotedClientId/etc.
const EDITABLE_FIELDS = [
  "brandName", "campaignName", "service", "region",
  "objective", "audience", "messages",
];
// What a pitch still SAYS to the client, editable after promotion too — the
// link stays live, so its brief must stay fixable. Brand and campaign name are
// not: by then they're real Client/Campaign records.
const PITCH_CONTENT_FIELDS = ["service", "region", "objective", "audience", "messages"];
// Draft field → the real Campaign's brief field it seeded at promotion.
const CAMPAIGN_BRIEF_SYNC = { objective: "objective", audience: "audience", messages: "messages" };

function pubDraft(doc) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

// The shape a client is allowed to see for one candidate — same allowlist
// spirit as publicShape() in pitch.js (leaves out profileUrl, addedBy,
// creatorId — internal notes on sourcing, not evaluation material).
function publicProfile(p, live = {}) {
  return {
    id: p.id,
    handle: p.handle,
    platform: p.platform,
    name: p.name,
    bio: p.bio || null,
    avatar: p.avatar || null,
    externalUrl: p.externalUrl || null,
    followers: p.followers ?? null,
    following: p.following ?? null,
    posts: p.posts ?? null,
    avgLikes: p.avgLikes ?? null,
    avgComments: p.avgComments ?? null,
    avgViews: p.avgViews ?? null,
    avgER: p.avgER ?? null,
    isVerified: !!p.isVerified,
    status: live.status ?? p.status,
    // true once the team has shipped this candidate (or its campaign entry is
    // gone) — the client sees the final call instead of buttons.
    locked: !!live.locked,
  };
}

/** Loads the draft and checks `code` against its stored pitchCode. */
async function verifyCode(draftId, code) {
  const draft = await PitchDraft.findOne({ _id: draftId }, { brandName: 1, campaignName: 1, pitchCode: 1, status: 1 }).lean();
  if (!draft) return { error: 404, message: "That link isn't valid." };
  if (!draft.pitchCode || String(code || "") !== draft.pitchCode) {
    return { error: 403, message: "That link's access code is missing or incorrect." };
  }
  return { draft };
}

// ── durable images ──────────────────────────────────────────────────────
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const isRemoteUrl = (s) => /^https?:\/\//i.test(String(s || ""));
const assetPath = (key, at) => `/api/pitch-drafts/asset/${encodeURIComponent(key)}?v=${at.getTime()}`;
const profileAssetKey = (draftId, profileId) => `pf_${draftId}_${profileId}`;

// A profile photo narrower than this is Instagram's 150px thumbnail (or
// close) — blurry on a pitch card's full-width portrait. HD is 320–1080px.
const HD_MIN_PX = 300;

/** Copy one CDN image into PitchAsset under `key`. Returns { path, width,
 *  img } — `path` is our own relative URL — or null when it can't be had
 *  (expired, not a CDN we fetch). */
async function storeAssetFull(key, url) {
  if (!isRemoteUrl(url)) return null;
  const img = await fetchRemoteImage(url, { maxBytes: MAX_IMAGE_BYTES });
  if (!img) return null;
  const at = new Date();
  await PitchAsset.updateOne(
    { _id: key },
    { $set: { data: img.data, contentType: img.contentType, updatedAt: at } },
    { upsert: true },
  );
  return { path: assetPath(key, at), width: imageSize(img.data)?.width ?? null, img };
}
const storeAsset = async (key, url) => (await storeAssetFull(key, url))?.path ?? null;

/** Pixel width of the photo a candidate currently shows, read from the
 *  stored bytes (ours or the creator directory's). null if unknown. */
async function currentAvatarWidth(draftId, p) {
  const a = String(p.avatar || "");
  let bytes = null;
  if (a.startsWith("/api/pitch-drafts/asset/")) {
    const doc = await PitchAsset.findById(profileAssetKey(draftId, p.id), { data: 1 }).lean();
    bytes = toBuffer(doc?.data);
  } else if (a.startsWith("/api/creators/") && p.creatorId) {
    const doc = await Creator.findById(p.creatorId, { avatarImage: 1 }).lean();
    bytes = toBuffer(doc?.avatarImage?.data);
  }
  return bytes ? imageSize(bytes)?.width ?? null : null;
}

// ── promotion linkage ───────────────────────────────────────────────────
const newPitchProfileId = () => `pp_${Date.now()}_${randomUUID().slice(0, 6)}_${Math.floor(Math.random() * 1e4)}`;

/** A real PitchProfile row for one draft candidate, keeping its decision. */
function pitchProfileRow(p, campaignId, brandId) {
  return {
    _id: newPitchProfileId(),
    campaignId,
    brandId,
    profileUrl: p.profileUrl || null,
    addedBy: p.addedBy || null,
    status: ["approved", "rejected"].includes(p.status) ? p.status : "pending",
    decision: p.decision?.at ? p.decision : undefined,
    creatorId: p.creatorId || null,
    source: p.source || null,
    name: p.name || null,
    handle: p.handle || null,
    platform: p.platform || null,
    avatar: p.avatar || null,
    bio: p.bio || null,
    externalUrl: p.externalUrl || null,
    followers: p.followers ?? null,
    following: p.following ?? null,
    posts: p.posts ?? null,
    avgLikes: p.avgLikes ?? null,
    avgComments: p.avgComments ?? null,
    avgViews: p.avgViews ?? null,
    avgER: p.avgER ?? null,
    isVerified: !!p.isVerified,
    isPrivate: !!p.isPrivate,
    isBusiness: !!p.isBusiness,
  };
}

/**
 * For a promoted draft (a hydrated doc): make sure every candidate has a real
 * PitchProfile on the campaign it became. New promotions link at promote
 * time; this repairs drafts promoted before that existed, which carried only
 * approved candidates over and left the client's link with nowhere to send
 * a decision. Idempotent — a PitchProfile already on that campaign with the
 * same handle is linked, never duplicated. A no-op once everything's linked.
 */
async function linkPromotedProfiles(draft) {
  if (draft.status !== "promoted" || !draft.promotedCampaignId) return;
  const missing = draft.profiles.filter((p) => !p.pitchProfileId);
  if (!missing.length) return;
  if (!(await Campaign.exists({ _id: draft.promotedCampaignId }))) return;

  const existing = await PitchProfile.find({ campaignId: draft.promotedCampaignId }, { handle: 1 }).lean();
  const byHandle = new Map(existing.map((e) => [String(e.handle || "").toLowerCase(), e._id]));
  const rows = [];
  for (const p of missing) {
    const h = String(p.handle || "").toLowerCase();
    if (h && byHandle.has(h)) { p.pitchProfileId = byHandle.get(h); continue; }
    const row = pitchProfileRow(p, draft.promotedCampaignId, draft.promotedClientId);
    rows.push(row);
    p.pitchProfileId = row._id;
    if (h) byHandle.set(h, row._id);
  }
  if (rows.length) await PitchProfile.insertMany(rows);
  draft.markModified("profiles");
  await draft.save();
}

/**
 * Each candidate's live decision. Before promotion the draft is the record;
 * after, the linked PitchProfile is (that's where decisions land and where
 * the team ships from), so its status wins. No linked row — the campaign or
 * its pitch entry was deleted — means nowhere for a decision to go: locked.
 */
async function liveProfiles(draft) {
  const list = draft.profiles || [];
  if (draft.status !== "promoted") {
    return list.map((p) => ({ p, status: p.status || "pending", locked: false }));
  }
  const ids = list.map((p) => p.pitchProfileId).filter(Boolean);
  const rows = ids.length
    ? await PitchProfile.find({ _id: { $in: ids } }, { status: 1, decision: 1, shipped: 1 }).lean()
    : [];
  const byId = new Map(rows.map((r) => [r._id, r]));
  return list.map((p) => {
    const r = p.pitchProfileId ? byId.get(p.pitchProfileId) : null;
    if (!r) return { p, status: p.status || "pending", locked: true };
    return { p, status: r.status || "pending", decision: r.decision, locked: !!r.shipped };
  });
}

// GET /api/pitch-drafts/asset/:key — a stored poster frame or creator photo.
// Immutable for a year: the ?v= in every URL changes if the bytes ever do.
router.get("/api/pitch-drafts/asset/:key", async (req, res) => {
  try {
    const doc = await PitchAsset.findById(req.params.key).lean();
    const bytes = toBuffer(doc?.data);
    if (!bytes) return res.status(404).json({ error: "no image stored" });
    res.set("Content-Type", doc.contentType || "image/jpeg");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INTERNAL ─────────────────────────────────────────────────────────────

// GET /api/pitch-drafts — every open prospect (list view: resume a draft in
// progress, or see what's already been promoted). ?status=draft|promoted to
// narrow; unfiltered returns both, newest first.
router.get("/api/pitch-drafts", async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    const drafts = await PitchDraft.find(q, {
      brandName: 1, campaignName: 1, service: 1, region: 1, status: 1,
      promotedClientId: 1, promotedCampaignId: 1, promotedAt: 1,
      createdBy: 1, createdAt: 1, updatedAt: 1,
      profiles: 1, briefSections: 1, suggestedContent: 1,
    }).sort({ createdAt: -1 }).lean();
    res.json(drafts.map((d) => ({
      id: d._id,
      brandName: d.brandName, campaignName: d.campaignName,
      service: d.service, region: d.region, status: d.status,
      promotedClientId: d.promotedClientId || null,
      promotedCampaignId: d.promotedCampaignId || null,
      promotedAt: d.promotedAt || null,
      createdBy: d.createdBy || null,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      profileCount: (d.profiles || []).length,
      approvedCount: (d.profiles || []).filter((p) => p.status === "approved").length,
      briefSectionCount: (d.briefSections || []).length,
      suggestedContentCount: (d.suggestedContent || []).length,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pitch-drafts/:id — one draft, full detail (the internal editor).
router.get("/api/pitch-drafts/:id", async (req, res) => {
  try {
    const doc = await PitchDraft.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "not found" });
    await linkPromotedProfiles(doc);
    const draft = doc.toObject();
    const live = await liveProfiles(draft);
    draft.profiles = live.map(({ p, status, decision, locked }) => ({ ...p, status, decision: decision ?? p.decision, locked }));
    res.json(pubDraft(draft));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pitch-drafts — start a new prospect. Body is the combined
// brand+campaign-lite form (brandName, campaignName, service, region,
// objective, audience, messages, createdBy). No id from the caller — this
// mints its own short id, since it's about to double as the public link's
// path segment.
router.post("/api/pitch-drafts", async (req, res) => {
  try {
    const brandName = String(req.body?.brandName || "").trim();
    if (!brandName) return res.status(400).json({ error: "brandName is required" });

    let id = genDraftId();
    // Vanishingly unlikely to collide, but cheap to guard rather than assume.
    for (let i = 0; i < 5 && (await PitchDraft.exists({ _id: id })); i++) id = genDraftId();

    const doc = await PitchDraft.create({
      _id: id,
      brandName,
      campaignName: String(req.body?.campaignName || "").trim() || null,
      service: req.body?.service || null,
      region: req.body?.region || null,
      objective: req.body?.objective || null,
      audience: req.body?.audience || null,
      messages: req.body?.messages || null,
      createdBy: String(req.body?.createdBy || "").trim() || null,
      status: "draft",
    });
    res.status(201).json(pubDraft(doc.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pitch-drafts/:id — edit the combined form's own fields. Blocked
// once promoted — the draft is archived at that point, and editing it would
// disagree with the real campaign it already became.
router.patch("/api/pitch-drafts/:id", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id).lean();
    if (!draft) return res.status(404).json({ error: "not found" });
    const promoted = draft.status === "promoted";
    const allowed = promoted ? PITCH_CONTENT_FIELDS : EDITABLE_FIELDS;
    const body = req.body || {};
    if (promoted && ["brandName", "campaignName"].some((k) => k in body)) {
      return res.status(409).json({ error: "The brand and campaign are real records now — rename them on the campaign itself." });
    }
    const patch = {};
    for (const k of allowed) if (k in body) patch[k] = typeof body[k] === "string" ? body[k] : body[k] ?? null;
    const updated = await PitchDraft.findByIdAndUpdate(
      req.params.id, { $set: patch }, { new: true },
    ).lean();

    // After promotion, carry brief edits onto the real campaign too — but only
    // where the campaign still holds what this draft gave it, so an edit made
    // on the campaign side is never overwritten from here.
    if (promoted && draft.promotedCampaignId) {
      for (const [k, campKey] of Object.entries(CAMPAIGN_BRIEF_SYNC)) {
        if (!(k in patch) || patch[k] === draft[k]) continue;
        await Campaign.updateOne(
          { _id: draft.promotedCampaignId, [`brief.${campKey}`]: draft[k] ?? null },
          { $set: { [`brief.${campKey}`]: patch[k] || null } },
        ).catch(() => {});
      }
    }
    res.json(pubDraft(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pitch-drafts/:id — abandon a prospect that never went
// anywhere. Only while still a draft — once promoted this is the archived
// record of a real campaign's brief/suggested-content and must not vanish.
router.delete("/api/pitch-drafts/:id", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id, { status: 1 }).lean();
    if (!draft) return res.status(404).json({ error: "not found" });
    if (draft.status === "promoted") {
      return res.status(409).json({ error: "Already promoted — can't delete an archived draft." });
    }
    const full = await PitchDraft.findById(req.params.id, { suggestedContent: 1, profiles: 1 }).lean();
    await PitchDraft.deleteOne({ _id: req.params.id });
    const keys = [
      ...(full?.suggestedContent || []).map((c) => c.id),
      ...(full?.profiles || []).map((p) => profileAssetKey(req.params.id, p.id)),
    ];
    if (keys.length) await PitchAsset.deleteMany({ _id: { $in: keys } }).catch(() => {});
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/pitch-drafts/:id/brief — body { sections: [{id?, heading, body}] }.
// Replaces the whole list in one call — the editor works on the list as a
// whole (add/remove/reorder a heading+body pair), so read-modify-write
// against the full array is simpler and safer here than a per-section
// endpoint, same reasoning as models/PitchDraft.js's own note on embedding.
router.put("/api/pitch-drafts/:id/brief", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id, { status: 1 });
    if (!draft) return res.status(404).json({ error: "not found" });
    // Editable after promotion too: the client's link stays live, and this is
    // what it shows them.
    const sections = Array.isArray(req.body?.sections) ? req.body.sections : [];
    draft.briefSections = sections.map((s) => ({
      id: s.id || `bs_${Date.now()}_${randomUUID().slice(0, 6)}`,
      heading: String(s.heading || "").trim(),
      body: String(s.body || ""),
    }));
    await draft.save();
    res.json({ sections: draft.briefSections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A suggested-content link worth spending a HikerAPI credit on — the same
// /p/, /reel/, /reels/ permalink shapes Instagram itself hands out.
// Anything else (a TikTok link, a Google Doc, plain text) is still saved as
// a bare link, just without a fetched preview.
const IG_POST_URL = /instagram\.com\/(?:p|reel|reels)\//i;

// POST /api/pitch-drafts/:id/content — body { url, note, addedBy }. Adds one
// suggested reel link. When the link is a fetchable Instagram post, spends
// ONE HikerAPI credit here to snapshot it (thumbnail, caption, counts) and
// stores that snapshot as `media` — exactly the same one-time,
// never-refetched pattern POST /api/trending and POST /api/market-watch use
// (see fetchReelSnapshot in portalReels.js) — so the team sees a real
// preview card instead of a bare link, without the ongoing cost of keeping
// it fresh. A private/deleted/unreadable post, or a non-Instagram link,
// just saves with no `media` and the composer falls back to a plain link.
router.post("/api/pitch-drafts/:id/content", async (req, res) => {
  try {
    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ error: "url is required" });
    const draft = await PitchDraft.findById(req.params.id, { status: 1, suggestedContent: 1 });
    if (!draft) return res.status(404).json({ error: "not found" });
    // Allowed after promotion too — the client's link is still live.

    const id = `sc_${Date.now()}_${randomUUID().slice(0, 6)}`;
    let media;
    if (IG_POST_URL.test(url)) {
      const snap = await fetchReelSnapshot(url);
      if (snap.ok) {
        const { ok, ...rest } = snap;
        media = rest;
        // Keep the poster frame as bytes we own — the signed thumbnail URL
        // dies in days, the link is meant to last as long as the pitch.
        const poster = await storeAsset(id, media.thumbnail);
        if (poster) media.poster = poster;
      }
    }

    const entry = {
      id,
      url,
      note: String(req.body?.note || "").trim() || null,
      media: media || null,
      addedBy: String(req.body?.addedBy || "").trim() || null,
      addedAt: new Date(),
    };
    draft.suggestedContent.push(entry);
    await draft.save();
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pitch-drafts/:id/content/:linkId — remove one suggested link.
router.delete("/api/pitch-drafts/:id/content/:linkId", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id, { suggestedContent: 1, status: 1 });
    if (!draft) return res.status(404).json({ error: "not found" });
    const before = draft.suggestedContent.length;
    draft.suggestedContent = draft.suggestedContent.filter((c) => c.id !== req.params.linkId);
    if (draft.suggestedContent.length === before) return res.status(404).json({ error: "not found" });
    await draft.save();
    await PitchAsset.deleteOne({ _id: req.params.linkId }).catch(() => {});
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pitch-drafts/:id/profiles — body { profileUrl, addedBy }. Exact
// same directory-first/Hiker-fallback snapshot logic as POST
// /api/campaigns/:id/pitch in pitch.js — see that file's own comment on why
// (no HikerAPI credit spent for anyone already known, and a newly-fetched
// creator gets upserted into the directory either way). Also mints this
// draft's OWN pitchCode on the first profile added, same "mint lazily, once
// there's something to send a link for" rule as ensurePitchCode.
router.post("/api/pitch-drafts/:id/profiles", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id);
    if (!draft) return res.status(404).json({ error: "not found" });
    if (draft.status === "promoted") {
      return res.status(409).json({ error: "This prospect has already been promoted — its candidate list is read-only now." });
    }

    const profileUrl = String(req.body?.profileUrl || "").trim();
    const key = extractUsername(profileUrl);
    if (!key) return res.status(400).json({ error: "Paste a profile URL or @handle." });

    let snapshot;
    const directoryDoc = await Creator.findOne({ _id: key }, DIRECTORY_SELECT).lean();

    if (directoryDoc) {
      snapshot = {
        creatorId: key,
        source: "directory",
        name: directoryDoc.name || null,
        handle: directoryDoc.handle || key,
        platform: directoryDoc.platform || "Instagram",
        avatar: directoryDoc.avatarUpdatedAt
          ? `/api/creators/${encodeURIComponent(key)}/avatar?v=${encodeURIComponent(directoryDoc.avatarUpdatedAt)}`
          : null,
        bio: directoryDoc.bio ?? null,
        externalUrl: directoryDoc.externalUrl ?? null,
        followers: directoryDoc.followers ?? null,
        following: directoryDoc.following ?? null,
        posts: directoryDoc.posts ?? null,
        avgLikes: directoryDoc.avgLikes ?? null,
        avgComments: directoryDoc.avgComments ?? null,
        avgViews: directoryDoc.avgViews ?? null,
        avgER: directoryDoc.avgER ?? null,
        isVerified: !!directoryDoc.isVerified,
        isPrivate: !!directoryDoc.isPrivate,
        isBusiness: !!directoryDoc.isBusiness,
      };
    } else {
      const fetched = await fetchInstagramProfile(profileUrl || key);
      if (fetched.error) return res.status(502).json({ error: fetched.error });
      snapshot = {
        creatorId: null,
        source: "hiker",
        name: fetched.fullName || null,
        handle: fetched.username || key,
        platform: "Instagram",
        avatar: fetched.profilePic || null,
        bio: fetched.bio ?? null,
        externalUrl: fetched.externalUrl ?? null,
        followers: fetched.followers ?? null,
        following: fetched.following ?? null,
        posts: fetched.posts ?? null,
        avgLikes: fetched.avgLikes ?? null,
        avgComments: fetched.avgComments ?? null,
        avgViews: fetched.avgViews ?? null,
        avgER: fetched.engagementRate ?? null,
        isVerified: !!fetched.isVerified,
        isPrivate: !!fetched.isPrivate,
        isBusiness: !!fetched.isBusiness,
      };
      try {
        await upsertCreatorFromFetch(key, fetched);
        snapshot.creatorId = key;
      } catch (err) {
        console.warn("[pitchDrafts] directory upsert failed:", err.message);
      }
    }

    const entry = {
      id: `pdp_${Date.now()}_${randomUUID().slice(0, 6)}`,
      profileUrl,
      addedBy: String(req.body?.addedBy || "").trim() || null,
      status: "pending",
      ...snapshot,
    };
    // A Hiker-fetched photo is a signed CDN URL that dies in days — keep the
    // bytes. (A directory photo is already served from our own route.)
    if (isRemoteUrl(entry.avatar)) {
      const own = await storeAssetFull(profileAssetKey(draft._id, entry.id), entry.avatar);
      if (own) { entry.avatar = own.path; entry.avatarWidth = own.width; }
    } else if (entry.avatar) {
      entry.avatarWidth = await currentAvatarWidth(draft._id, entry);
    }
    draft.profiles.push(entry);
    if (!draft.pitchCode) draft.pitchCode = genCode();
    await draft.save();

    res.status(201).json({ profile: entry, pitchCode: draft.pitchCode });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// DELETE /api/pitch-drafts/:id/profiles/:profileId — retract a candidate.
router.delete("/api/pitch-drafts/:id/profiles/:profileId", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id, { profiles: 1 });
    if (!draft) return res.status(404).json({ error: "not found" });
    const before = draft.profiles.length;
    draft.profiles = draft.profiles.filter((p) => p.id !== req.params.profileId);
    if (draft.profiles.length === before) return res.status(404).json({ error: "not found" });
    await draft.save();
    await PitchAsset.deleteOne({ _id: profileAssetKey(req.params.id, req.params.profileId) }).catch(() => {});
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (No code/regenerate route: a draft's link is minted once and stays the
// same until the draft is deleted — see the header note.)

// POST /api/pitch-drafts/:id/content/refresh — bring previews back where
// they're missing, and make every image this pitch shows permanent:
//   · a suggested link with no snapshot (never fetched, or wiped by the old
//     promote route) is re-fetched — ONE HikerAPI credit per such link;
//   · any snapshot without a stored poster gets its poster copied;
//   · any candidate photo still pointing at Instagram's CDN gets copied, or,
//     if that URL has already expired, pointed at the creator directory's
//     own stored photo when there is one;
//   · body { hd: true }: any candidate whose photo is under 300px (the 150px
//     thumbnail every older fetch stored) is re-fetched from HikerAPI for
//     its HD photo — ONE credit per such candidate — and the sharper copy
//     also replaces the creator directory's photo, so every page gains it.
// Allowed after promotion too: it only restores what the link displays.
router.post("/api/pitch-drafts/:id/content/refresh", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id);
    if (!draft) return res.status(404).json({ error: "not found" });
    let fetched = 0, posters = 0, photos = 0, failed = 0;

    for (const c of draft.suggestedContent) {
      if (!c.media && IG_POST_URL.test(c.url || "")) {
        const snap = await fetchReelSnapshot(c.url);
        if (snap.ok) { const { ok, ...rest } = snap; c.media = rest; fetched++; } else failed++;
      }
      if (c.media?.thumbnail && !c.media.poster) {
        const poster = await storeAsset(c.id, c.media.thumbnail);
        if (poster) { c.media = { ...c.media, poster }; posters++; }
      }
    }

    let hd = 0, hdFailed = 0;
    const wantHd = !!req.body?.hd;
    for (const p of draft.profiles) {
      if (isRemoteUrl(p.avatar)) {
        const stored = await storeAssetFull(profileAssetKey(draft._id, p.id), p.avatar);
        let own = stored?.path || null;
        if (!own && p.creatorId) {
          const dir = await Creator.findById(p.creatorId, { avatarUpdatedAt: 1 }).lean();
          if (dir?.avatarUpdatedAt) own = `/api/creators/${encodeURIComponent(p.creatorId)}/avatar?v=${encodeURIComponent(dir.avatarUpdatedAt)}`;
        }
        if (own) {
          p.avatar = own;
          p.avatarWidth = stored?.width ?? null;
          photos++;
          if (p.pitchProfileId) await PitchProfile.updateOne({ _id: p.pitchProfileId }, { $set: { avatar: own } }).catch(() => {});
        }
      }
      // Learn the width of older photos once, so the editor can say which
      // are low-resolution without guessing.
      if (p.avatarWidth == null && p.avatar && !isRemoteUrl(p.avatar)) p.avatarWidth = await currentAvatarWidth(draft._id, p);

      if (wantHd && p.handle && !(p.avatarWidth >= HD_MIN_PX)) {
        const fetched = await fetchInstagramProfile(p.handle);
        const got = !fetched.error && fetched.profilePic
          ? await storeAssetFull(profileAssetKey(draft._id, p.id), fetched.profilePic)
          : null;
        if (got && (got.width ?? 0) > (p.avatarWidth ?? 0)) {
          p.avatar = got.path;
          p.avatarWidth = got.width;
          hd++;
          if (p.pitchProfileId) await PitchProfile.updateOne({ _id: p.pitchProfileId }, { $set: { avatar: got.path } }).catch(() => {});
          // The directory keeps whichever photo is sharper — this one, now.
          if (p.creatorId) {
            const dirWidth = await (async () => {
              const d = await Creator.findById(p.creatorId, { avatarImage: 1 }).lean();
              const b = toBuffer(d?.avatarImage?.data);
              return b ? imageSize(b)?.width ?? 0 : 0;
            })();
            if ((got.width ?? 0) > dirWidth) {
              await Creator.updateOne(
                { _id: p.creatorId },
                { $set: { avatarImage: { data: got.img.data, contentType: got.img.contentType }, avatarUpdatedAt: new Date() } },
              ).catch(() => {});
            }
          }
        } else {
          hdFailed++;
        }
      }
    }

    draft.markModified("suggestedContent");
    draft.markModified("profiles");
    await draft.save();
    res.json({ fetched, posters, photos, failed, hd, hdFailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pitch-drafts/:id/promote — body { createdBy }. "Create actual
// campaign" — the button that sits where Ship to Creators would sit on a
// real pitch, because a draft has nothing to literally ship until this runs.
//
// Creates a REAL Client (from brandName) and a REAL Campaign (from the
// campaign-lite fields), then carries EVERY candidate over as a real
// PitchProfile keeping its current decision, linked back to the draft
// (pitchProfileId). Approved ones are ready to ship straight away; pending
// ones stay open — the client keeps deciding from the same link, and those
// decisions land on these PitchProfiles. The brief and suggested content
// stay on the archived draft (status: "promoted"), previews intact.
router.post("/api/pitch-drafts/:id/promote", async (req, res) => {
  try {
    const draft = await PitchDraft.findById(req.params.id);
    if (!draft) return res.status(404).json({ error: "not found" });
    if (draft.status === "promoted") {
      return res.status(409).json({ error: "Already promoted.", clientId: draft.promotedClientId, campaignId: draft.promotedCampaignId });
    }
    if (!draft.brandName) return res.status(400).json({ error: "This prospect needs a brand name before it can become a real campaign." });

    const createdBy = String(req.body?.createdBy || draft.createdBy || "").trim() || null;

    // Brand id: same slugify-the-name rule the internal "new brand" form
    // uses (onCreateBrand, Campaigns/index.jsx) — collision-checked since,
    // unlike that flow, nothing here has already confirmed the id is free.
    const brandSlug = draft.brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "brand";
    let clientId = brandSlug;
    for (let i = 2; await Client.exists({ _id: clientId }); i++) clientId = `${brandSlug}-${i}`;
    const client = await Client.create({ _id: clientId, name: draft.brandName });

    // Campaign id: same `camp_<slug>_<ts36>` shape onCreate builds client-side.
    const campSlug = (draft.campaignName || draft.brandName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "campaign";
    const campaignId = `camp_${campSlug}_${Date.now().toString(36)}`;
    const today = new Date().toISOString().slice(0, 10);

    const campaign = await Campaign.create({
      _id: campaignId,
      name: draft.campaignName || draft.brandName,
      client: draft.brandName,
      brandId: clientId,
      service: draft.service || null,
      region: draft.region || "TBD",
      stage: "draft",
      // Not agreed yet at pitch stage, same as a campaign raised through the
      // ordinary wizard with the budget step deferred — see onCreate's own
      // note on why this is null, never 0.
      budget: null,
      creatorBudget: null,
      numReq: null,
      deliverablesPerCreator: 1,
      start: today,
      end: "TBD",
      createdBy,
      brief: {
        objective: draft.objective || null,
        audience: draft.audience || null,
        messages: draft.messages || null,
        deliverables: null,
        budget: null,
        timeline: null,
      },
      briefStatus: "draft",
      creators: [],
      creatorIds: [],
      genRounds: 0,
      sentToClient: false,
      internalNotes: `Promoted from pitch draft ${draft._id}.`,
      timeline: [
        { date: today, event: "Campaign created from a pitch draft", actor: createdBy || "System" },
      ],
    });

    // Every candidate carries over with the decision it has right now, and
    // is linked back so the client's link keeps working after this.
    const rows = draft.profiles.map((p) => {
      const row = pitchProfileRow(p, campaignId, clientId);
      p.pitchProfileId = row._id;
      return row;
    });
    if (rows.length) await PitchProfile.insertMany(rows);
    draft.markModified("profiles");
    const approved = draft.profiles.filter((p) => p.status === "approved");

    draft.status = "promoted";
    draft.promotedClientId = clientId;
    draft.promotedCampaignId = campaignId;
    draft.promotedAt = new Date();
    await draft.save();

    res.json({
      clientId, campaignId,
      approvedCarried: approved.length,
      carried: rows.length,
      client: { id: client._id, name: client.name },
      campaign: { id: campaign._id, name: campaign.name },
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A client or campaign with this id already exists — try again." });
    res.status(500).json({ error: err.message });
  }
});

// ── PUBLIC (access-code gated, no login) ────────────────────────────────────

// GET /api/pitch-drafts/public/:id?code=... — what the client's link opens
// to. Client-facing display order is Brief → Creators suggested →
// Suggested Content (a different order than the internal editor, which
// builds Brief → Suggested Content → Profiles) — this endpoint just returns
// all three; the client-front page is what orders them for display.
// Still readable after promotion (a client who still has the old link
// shouldn't hit a dead page) — only the PATCH decision route below is
// frozen once promoted.
router.get("/api/pitch-drafts/public/:id", async (req, res) => {
  try {
    const checked = await verifyCode(req.params.id, req.query.code);
    if (checked.error) return res.status(checked.error).json({ error: checked.message });

    const doc = await PitchDraft.findById(req.params.id);
    await linkPromotedProfiles(doc);
    const draft = doc.toObject();
    const live = await liveProfiles(draft);

    res.json({
      brand: { name: draft.brandName || null },
      campaignName: draft.campaignName || null,
      // The campaign brief proper — what the team fills in at the top of the
      // editor. (These used to stay internal, so a pitch with no freeform
      // sections showed the client no brief at all.)
      details: {
        service: draft.service || null,
        region: draft.region || null,
        objective: draft.objective || null,
        audience: draft.audience || null,
        messages: draft.messages || null,
      },
      brief: (draft.briefSections || [])
        .filter((s) => (s.heading || "").trim() || (s.body || "").trim())
        .map((s) => ({ id: s.id, heading: s.heading, body: s.body })),
      // `media` is the same HikerAPI snapshot the internal editor shows
      // (thumbnail, caption, counts, and `poster` — our own stored copy of
      // the frame, which outlives the signed thumbnail URL). Nothing here is
      // more private than the public Instagram post it came from.
      suggestedContent: (draft.suggestedContent || []).map((c) => ({ id: c.id, url: c.url, note: c.note || null, media: c.media || null })),
      profiles: live.map(({ p, status, locked }) => publicProfile(p, { status, locked })),
      // Page-level: is there anything left for the client to decide? Stays
      // true after promotion until every candidate is shipped (or gone).
      decidable: live.length ? live.some((x) => !x.locked) : draft.status === "draft",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pitch-drafts/public/:id/profiles/:profileId?code=... —
// body { status, by }. The client's approve/reject on a candidate.
// Reversible until the team ships that candidate — before promotion it's
// stored on the draft; after, on the linked PitchProfile (and mirrored here).
router.patch("/api/pitch-drafts/public/:id/profiles/:profileId", async (req, res) => {
  try {
    const checked = await verifyCode(req.params.id, req.query.code);
    if (checked.error) return res.status(checked.error).json({ error: checked.message });

    const status = String(req.body?.status || "").trim();
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be approved or rejected" });
    }

    const draft = await PitchDraft.findById(req.params.id);
    const profile = draft.profiles.find((p) => p.id === req.params.profileId);
    if (!profile) return res.status(404).json({ error: "not found" });
    const decision = { at: new Date(), by: String(req.body?.by || "").trim() || "Client" };

    // After promotion the decision belongs to the real campaign's
    // PitchProfile — where the team works and ships from. Reversible until
    // shipped, the same rule as an ordinary pitch link (pitch.js).
    if (draft.status === "promoted") {
      await linkPromotedProfiles(draft);
      const row = profile.pitchProfileId ? await PitchProfile.findById(profile.pitchProfileId) : null;
      if (!row) return res.status(409).json({ error: "This pitch is closed — talk to your Fifth Avenue team." });
      if (row.shipped) return res.status(409).json({ error: "This one's already moved on — talk to your team." });
      row.status = status;
      row.decision = decision;
      await row.save();
    }

    profile.status = status;
    profile.decision = decision;
    draft.markModified("profiles");
    await draft.save();

    res.json(publicProfile(profile, { status, locked: false }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
