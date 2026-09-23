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
// REAL Client + Campaign from the draft's fields, migrates ONLY the
// client-approved candidates into real PitchProfile docs already marked
// approved — so they land exactly where a normal pitch round leaves off,
// ready for the team's ordinary "Ship to Creators" click on the new
// campaign. briefSections and suggestedContent deliberately do NOT copy
// onto the real campaign; the draft is archived (status: "promoted"), not
// deleted, since it stays their only home.
import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import PitchDraft from "../models/PitchDraft.js";
import Client from "../models/Client.js";
import Campaign from "../models/Campaign.js";
import Creator from "../models/Creator.js";
import PitchProfile from "../models/PitchProfile.js";
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

function pubDraft(doc) {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

// The shape a client is allowed to see for one candidate — same allowlist
// spirit as publicShape() in pitch.js (leaves out profileUrl, addedBy,
// creatorId — internal notes on sourcing, not evaluation material).
function publicProfile(p) {
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
    status: p.status,
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
    const draft = await PitchDraft.findById(req.params.id).lean();
    if (!draft) return res.status(404).json({ error: "not found" });
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
    const draft = await PitchDraft.findById(req.params.id, { status: 1 }).lean();
    if (!draft) return res.status(404).json({ error: "not found" });
    if (draft.status === "promoted") {
      return res.status(409).json({ error: "This prospect has already been promoted to a real campaign — it's read-only now." });
    }
    const patch = {};
    for (const k of EDITABLE_FIELDS) if (k in (req.body || {})) patch[k] = req.body[k];
    const updated = await PitchDraft.findByIdAndUpdate(
      req.params.id, { $set: patch }, { new: true },
    ).lean();
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
    await PitchDraft.deleteOne({ _id: req.params.id });
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
    if (draft.status === "promoted") {
      return res.status(409).json({ error: "This prospect has already been promoted — its brief is read-only now." });
    }
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
    if (draft.status === "promoted") {
      return res.status(409).json({ error: "This prospect has already been promoted — suggested content is read-only now." });
    }

    let media;
    if (IG_POST_URL.test(url)) {
      const snap = await fetchReelSnapshot(url);
      if (snap.ok) {
        const { ok, ...rest } = snap;
        media = rest;
      }
    }

    const entry = {
      id: `sc_${Date.now()}_${randomUUID().slice(0, 6)}`,
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
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pitch-drafts/:id/code/regenerate — invalidate the old client
// link, same "compromised / start a fresh round" use case as pitch.js's
// version, scoped to this one draft since a draft's code isn't brand-wide.
router.post("/api/pitch-drafts/:id/code/regenerate", async (req, res) => {
  try {
    const pitchCode = genCode();
    const updated = await PitchDraft.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { pitchCode } },
      { new: true, fields: { pitchCode: 1 } },
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json({ pitchCode: updated.pitchCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pitch-drafts/:id/promote — body { createdBy }. "Create actual
// campaign" — the button that sits where Ship to Creators would sit on a
// real pitch, because a draft has nothing to literally ship until this runs.
//
// Creates a REAL Client (from brandName) and a REAL Campaign (from the
// campaign-lite fields), then migrates ONLY the profiles the client
// approved on the draft into real PitchProfile docs already marked
// "approved" — so the team's very next step on the new campaign is the
// same ordinary "Ship to Creators" click any other approved pitch gets, not
// a re-run of the whole pitch round. Pending/rejected candidates, the
// brief, and the suggested-content links stay behind on the archived draft
// (status: "promoted") — never copied, per how this was scoped.
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

    // Only the client-approved candidates carry over — each becomes a real
    // PitchProfile, already approved, exactly as if a normal pitch round on
    // this campaign had just gotten that decision back from the client.
    const approved = draft.profiles.filter((p) => p.status === "approved");
    if (approved.length) {
      const rows = approved.map((p) => ({
        _id: `pp_${Date.now()}_${randomUUID().slice(0, 6)}_${Math.floor(Math.random() * 1e4)}`,
        campaignId,
        brandId: clientId,
        profileUrl: p.profileUrl || null,
        addedBy: p.addedBy || null,
        status: "approved",
        decision: p.decision || { at: new Date(), by: "Client" },
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
      }));
      await PitchProfile.insertMany(rows);
    }

    // Drop the fetched HikerAPI snapshots (thumbnail, caption, counts) on
    // whatever was suggested — the plain url/note stay on the archived
    // draft as the historical record, but the snapshot is a signed CDN
    // thumbnail with no refresh cycle here (see PitchDraft.js's own note on
    // this field): it goes stale in days, and once the deal is real there's
    // no one left who needs to look at it. Same "save until real, then
    // delete" as the brief/candidates staying behind rather than copying —
    // this is the one piece that doesn't even stay, since it was only ever
    // useful while pitching.
    // null, not undefined — a Mixed path only reliably unsets in Mongo when
    // explicitly nulled; leaving it undefined risks the stale value simply
    // never being written over.
    for (const c of draft.suggestedContent) c.media = null;

    draft.status = "promoted";
    draft.promotedClientId = clientId;
    draft.promotedCampaignId = campaignId;
    draft.promotedAt = new Date();
    await draft.save();

    res.json({
      clientId, campaignId,
      approvedCarried: approved.length,
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

    const draft = await PitchDraft.findById(req.params.id, {
      brandName: 1, campaignName: 1, briefSections: 1, suggestedContent: 1, profiles: 1, status: 1,
    }).lean();

    res.json({
      brand: { name: draft.brandName || null },
      campaignName: draft.campaignName || null,
      brief: (draft.briefSections || []).map((s) => ({ id: s.id, heading: s.heading, body: s.body })),
      // `media` is the same one-time HikerAPI snapshot the internal editor
      // shows (thumbnail, caption, counts) — nothing here is more private
      // than the public Instagram post it was fetched from, so it travels
      // to the client link as-is. null once promoted (see the promote
      // route's own note on why it's stripped there).
      suggestedContent: (draft.suggestedContent || []).map((c) => ({ id: c.id, url: c.url, note: c.note || null, media: c.media || null })),
      profiles: (draft.profiles || []).map(publicProfile),
      decidable: draft.status === "draft",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pitch-drafts/public/:id/profiles/:profileId?code=... —
// body { status, by }. The client's approve/reject on a candidate.
// Reversible right up until the internal team promotes the draft — mirrors
// the real pitch link's "reversible until shipped" rule (pitch.js), with
// promotion standing in for ship here.
router.patch("/api/pitch-drafts/public/:id/profiles/:profileId", async (req, res) => {
  try {
    const checked = await verifyCode(req.params.id, req.query.code);
    if (checked.error) return res.status(checked.error).json({ error: checked.message });
    if (checked.draft.status !== "draft") {
      return res.status(409).json({ error: "This has already moved forward — talk to your team." });
    }

    const status = String(req.body?.status || "").trim();
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be approved or rejected" });
    }

    const draft = await PitchDraft.findById(req.params.id);
    const profile = draft.profiles.find((p) => p.id === req.params.profileId);
    if (!profile) return res.status(404).json({ error: "not found" });

    profile.status = status;
    profile.decision = { at: new Date(), by: String(req.body?.by || "").trim() || "Client" };
    await draft.save();

    res.json(publicProfile(profile));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
