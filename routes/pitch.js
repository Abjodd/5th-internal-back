// Pitch Client — routes/pitch.js
//
// A pitch is the pre-sale step before a creator is committed to a campaign's
// roster (see models/PitchProfile.js for why it's its own collection rather
// than a Campaign.creators[] row). Two audiences, two halves of this file:
//
//   INTERNAL  /api/campaigns/:id/pitch..., /api/clients/:id/pitch...
//             Same trust model as every other /api/campaigns|clients/...
//             route in server.js (no auth middleware here either; the
//             internal app is the only thing that calls these).
//
//   PUBLIC    /api/pitch/:brandId...      — no login at all. Scoped purely by
//             a per-CLIENT access code (Client.pitchCode), the same
//             lightweight "know the id/code, see the data" model the client
//             portal itself already uses for brandId (see resolveBrandScope
//             in server.js) — this isn't a new security posture, just the
//             same one applied to a code instead of a brand id.
//
//             The link is brand-wide rather than per campaign on purpose: a
//             client should see everything ever pitched to them in one place,
//             not a separate link per campaign — see the code comment on
//             GET /api/pitch/:brandId below for how that's assembled.
import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import Campaign from "../models/Campaign.js";
import Client from "../models/Client.js";
import Creator from "../models/Creator.js";
import PitchProfile from "../models/PitchProfile.js";
import { fetchInstagramProfile } from "../instagramfetchhiker.js";
import { keyOf, upsertCreatorFromFetch } from "../creatorSync.js";

const router = Router();

// Same "@handle or full URL" normalisation instagramfetchhiker.js does
// internally (its own extractUsername isn't exported) — needed here too so
// the Creator-directory lookup checks the same key Hiker would end up using.
function extractUsername(input) {
  if (!input) return null;
  const s = String(input).trim().replace(/^@/, "");
  const m = s.match(/instagram\.com\/([^/?#]+)/i);
  return (m ? m[1] : s).toLowerCase() || null;
}

const genCode = () => randomBytes(4).toString("hex").toUpperCase(); // e.g. "A1B2C3D4"

// Fields owned by the creators directory that a Creator doc may already
// carry from a previous fetch — selected on the "already known" lookup path
// in POST .../pitch, and also the set widened onto the directory at ship
// time (see directorySetFromPitch below).
const DIRECTORY_SELECT = {
  name: 1, handle: 1, platform: 1, igUrl: 1, followers: 1, following: 1, posts: 1,
  avgLikes: 1, avgComments: 1, avgViews: 1, avgER: 1, bio: 1, externalUrl: 1,
  isVerified: 1, isPrivate: 1, isBusiness: 1, avatarUpdatedAt: 1,
};

// The shape a client is allowed to see. Deliberately leaves out profileUrl
// (an internal note on how the profile was sourced), addedBy, creatorId,
// shippedCreatorRef (internal linkage) — and, unlike the internal shape,
// leaves out publicEmail/contactPhone too: those are for the ops team to
// reach the creator, not for a client evaluating candidates. Same allowlist
// spirit as CREATOR_PUBLIC/CLIENT_PUBLIC in server.js.
function publicShape(p, campaignName) {
  return {
    id: p._id,
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
    campaignId: p.campaignId || null,
    campaignName: campaignName ?? p.campaignName ?? null,
    status: p.status,
    shipped: !!p.shipped,
  };
}

// Every field a stored pitch doc can hand back to the creators directory —
// used both when a fresh Hiker fetch upserts the directory (upsertCreatorFromFetch,
// in creatorSync.js) and again here at ship time, from whatever the pitch
// itself ended up snapshotting (which may since have been hand-edited, or may
// be the directory's own numbers echoed back — either way, ship time is a
// good moment to make sure the directory has the fullest picture).
function directorySetFromPitch(pitch) {
  const set = {
    name: pitch.name || undefined,
    handle: pitch.handle || undefined,
    platform: pitch.platform || undefined,
    followers: pitch.followers ?? undefined,
    following: pitch.following ?? undefined,
    posts: pitch.posts ?? undefined,
    avgLikes: pitch.avgLikes ?? undefined,
    avgComments: pitch.avgComments ?? undefined,
    avgViews: pitch.avgViews ?? undefined,
    avgER: pitch.avgER ?? undefined,
    bio: pitch.bio ?? undefined,
    externalUrl: pitch.externalUrl ?? undefined,
    isVerified: pitch.isVerified ?? undefined,
    isPrivate: pitch.isPrivate ?? undefined,
    isBusiness: pitch.isBusiness ?? undefined,
  };
  for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k];
  return set;
}

/** Loads the client (brand) and checks `code` against its stored pitchCode. */
async function verifyCode(brandId, code) {
  const client = await Client.findOne({ _id: brandId }, { name: 1, pitchCode: 1 }).lean();
  if (!client) return { error: 404, message: "That link isn't valid." };
  if (!client.pitchCode || String(code || "") !== client.pitchCode) {
    return { error: 403, message: "That link's access code is missing or incorrect." };
  }
  return { client };
}

// Names every campaign referenced by a batch of pitch docs, for labelling
// cards on an aggregate (brand-wide) list — cheap, one query, only run when
// there's more than one campaign in play in practice.
async function campaignNamesFor(profiles) {
  const ids = [...new Set(profiles.map((p) => p.campaignId).filter(Boolean))];
  if (!ids.length) return new Map();
  const campaigns = await Campaign.find({ _id: { $in: ids } }, { name: 1 }).lean();
  return new Map(campaigns.map((c) => [c._id, c.name]));
}

// Everything a pitch's existing campaign needs to show its own brief on the
// public link, alongside what's been pitched for it — see the "IN PITCH for
// an existing campaign I want the brief shown too" ask. Raw fields only
// (brief/budget/stage/briefStatus): the shaping into the six-field view
// (objective/targetAudience/keyMessages/deliverables/budget/timeline, locked
// vs. pending) is campaignBriefView() in client-front's mapping.js — the
// same function the real campaign detail page's Brief tab runs — so a brief
// can't read differently on the two surfaces.
async function campaignBriefsFor(profiles) {
  const ids = [...new Set(profiles.map((p) => p.campaignId).filter(Boolean))];
  if (!ids.length) return new Map();
  const campaigns = await Campaign.find(
    { _id: { $in: ids } },
    { name: 1, brief: 1, budget: 1, stage: 1, briefStatus: 1 },
  ).lean();
  return new Map(campaigns.map((c) => [
    c._id,
    { id: c._id, name: c.name, brief: c.brief ?? null, budget: c.budget ?? null, stage: c.stage ?? null, briefStatus: c.briefStatus ?? null },
  ]));
}

/** Reads a brand's current pitchCode, minting one if it doesn't have one yet. */
async function ensurePitchCode(brandId) {
  if (!brandId) return null;
  const client = await Client.findById(brandId, { pitchCode: 1 });
  if (!client) return null;
  if (!client.pitchCode) {
    client.pitchCode = genCode();
    await client.save();
  }
  return client.pitchCode;
}

// ── INTERNAL ─────────────────────────────────────────────────────────────

// GET /api/campaigns/:id/pitch — everything pitched for this ONE campaign
// (the composer view a team member is working in), plus the client's current
// access code — the same code used on every other campaign for this brand,
// since the link the client eventually gets is brand-wide, not per campaign.
router.get("/api/campaigns/:id/pitch", async (req, res) => {
  try {
    const campaign = await Campaign.findOne(
      { _id: req.params.id, deleted: { $ne: true } },
      { brandId: 1 },
    ).lean();
    if (!campaign) return res.status(404).json({ error: "campaign not found" });

    const [client, profiles] = await Promise.all([
      campaign.brandId ? Client.findById(campaign.brandId, { pitchCode: 1 }).lean() : null,
      PitchProfile.find({ campaignId: req.params.id }).sort({ createdAt: 1 }).lean(),
    ]);

    res.json({
      pitchCode: client?.pitchCode || null,
      brandId: campaign.brandId || null,
      profiles: profiles.map(({ _id, ...p }) => ({ id: _id, ...p })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/pitch — everything pitched to this CLIENT across every
// one of their campaigns, in one list — exactly what the client's own link
// shows them (see the public GET below), so the internal side can preview
// the same thing without needing the code.
router.get("/api/clients/:id/pitch", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id, { pitchCode: 1 }).lean();
    if (!client) return res.status(404).json({ error: "client not found" });

    const profiles = await PitchProfile.find({ brandId: req.params.id })
      .sort({ createdAt: 1 })
      .lean();
    const nameById = await campaignNamesFor(profiles);

    res.json({
      pitchCode: client.pitchCode || null,
      profiles: profiles.map(({ _id, ...p }) => ({
        id: _id, ...p, campaignName: nameById.get(p.campaignId) || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pitch — body { profileUrl, addedBy }.
// Checks the Creator directory first (no HikerAPI credit spent for anyone
// already known — same cost-consciousness as the rest of this backend's
// Hiker calls, see server.js's own comments on that); falls back to a live
// Hiker fetch, capturing everything the fetch can supply (bio, following,
// post count, avg views, verified/private/business flags, ...) — and, when
// this influencer wasn't already in the directory, upserting them into it
// (upsertCreatorFromFetch) so pitching someone new also makes them a
// first-class, searchable directory entry, not just a snapshot on this pitch.
//
// Also mints the client's pitchCode on the very first profile pitched to
// that brand (any campaign), so a code always exists once there's something
// worth sending a link for.
router.post("/api/campaigns/:id/pitch", async (req, res) => {
  try {
    const campaign = await Campaign.findOne(
      { _id: req.params.id, deleted: { $ne: true } },
      { _id: 1, brandId: 1 },
    ).lean();
    if (!campaign) return res.status(404).json({ error: "campaign not found" });

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
        // The directory stores its photo as inline bytes served from its own
        // route (avatarStore.js), not a plain URL — a relative path here,
        // resolved against the API base by the frontend, same contract as
        // CreatorsAPI.avatarUrl.
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

      // Best-effort: a directory-write hiccup shouldn't block the pitch
      // itself from being saved — the profile still gets pitched either way.
      try {
        await upsertCreatorFromFetch(key, fetched);
        snapshot.creatorId = key;
      } catch (err) {
        console.warn("[pitch] directory upsert failed:", err.message);
      }
    }

    const doc = await PitchProfile.create({
      _id: `pp_${Date.now()}_${randomUUID().slice(0, 6)}`,
      campaignId: req.params.id,
      brandId: campaign.brandId || null,
      profileUrl,
      addedBy: String(req.body?.addedBy || "").trim() || null,
      status: "pending",
      ...snapshot,
    });

    const pitchCode = await ensurePitchCode(campaign.brandId);

    const { _id, ...rest } = doc.toObject();
    res.status(201).json({ profile: { id: _id, ...rest }, pitchCode, brandId: campaign.brandId || null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id/pitch/:pitchId — retract a pitched profile
// (typo, wrong account, decided not to send it after all). Always allowed;
// a shipped one has already become its own creators[] row and removing the
// draft here has no effect on that.
router.delete("/api/campaigns/:id/pitch/:pitchId", async (req, res) => {
  try {
    const deleted = await PitchProfile.findOneAndDelete({
      _id: req.params.pitchId,
      campaignId: req.params.id,
    }).lean();
    if (!deleted) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pitch/code/regenerate — convenience wrapper: looks
// up which brand this campaign belongs to and regenerates THAT brand's code
// (see the canonical, brand-scoped version below) — invalidates the old
// client link across every one of that brand's campaigns, not just this one,
// since it's one link for the whole client.
router.post("/api/campaigns/:id/pitch/code/regenerate", async (req, res) => {
  try {
    const campaign = await Campaign.findOne(
      { _id: req.params.id, deleted: { $ne: true } },
      { brandId: 1 },
    ).lean();
    if (!campaign) return res.status(404).json({ error: "campaign not found" });
    if (!campaign.brandId) return res.status(400).json({ error: "This campaign has no brand to link to." });

    const pitchCode = genCode();
    await Client.updateOne({ _id: campaign.brandId }, { $set: { pitchCode } });
    res.json({ pitchCode, brandId: campaign.brandId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/pitch/code/regenerate — the canonical, brand-scoped
// version of the above ("the old link is compromised / start a fresh round"),
// for callers that already have the brand id in hand.
router.post("/api/clients/:id/pitch/code/regenerate", async (req, res) => {
  try {
    const pitchCode = genCode();
    const updated = await Client.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { pitchCode } },
      { new: true, fields: { pitchCode: 1 } },
    ).lean();
    if (!updated) return res.status(404).json({ error: "client not found" });
    res.json({ pitchCode: updated.pitchCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/pitch/:pitchId/ship — promote an approved pitch
// into the campaign's real roster (Campaign.creators[]), one at a time, only
// on the internal team's own click (see models/PitchProfile.js for why this
// is a deliberate manual step rather than automatic on client approval).
// Also widens the directory entry with everything this pitch captured — see
// directorySetFromPitch above.
//
// $push against the matched document, never a read-modify-write of the whole
// creators[] array — the campaign PATCH route rewrites that array wholesale,
// and a save landing here in between would silently drop it (same reasoning
// as appendAssetComment's own note on this, above in server.js).
router.post("/api/campaigns/:id/pitch/:pitchId/ship", async (req, res) => {
  try {
    const pitch = await PitchProfile.findOne({ _id: req.params.pitchId, campaignId: req.params.id });
    if (!pitch) return res.status(404).json({ error: "not found" });
    if (pitch.status !== "approved") {
      return res.status(409).json({ error: "Only a client-approved pitch can be shipped to the roster." });
    }
    if (pitch.shipped) return res.status(409).json({ error: "Already shipped." });

    const key = pitch.creatorId || keyOf({ handle: pitch.handle, name: pitch.name });
    if (key) {
      await Creator.updateOne(
        { _id: key },
        { $set: directorySetFromPitch(pitch) },
        { upsert: true },
      );
    }

    const rowId = `cr_${Date.now()}_${randomUUID().slice(0, 6)}`;
    const row = {
      _id: rowId,
      creatorId: key || null,
      // Already vetted by the client at the pitch stage, so this lands past
      // "suggested" — the same landing status BRAND_DECISION's own "approve"
      // sets on the ordinary roster-decision route in server.js.
      status: "shortlisted",
      brandDecision: {
        decision: "approve",
        at: pitch.decision?.at || new Date().toISOString(),
        by: pitch.decision?.by || "Client",
      },
      pitchId: pitch._id,
    };

    await Campaign.updateOne(
      { _id: req.params.id },
      { $push: { creators: row }, $addToSet: { creatorIds: key } },
    );

    pitch.shipped = true;
    pitch.shippedAt = new Date();
    pitch.shippedCreatorRef = rowId;
    if (key) pitch.creatorId = key;
    await pitch.save();

    res.json({ shippedCreatorRef: rowId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUBLIC (access-code gated, no login) ────────────────────────────────────

// GET /api/pitch/:brandId?code=... — what the client's link opens to: every
// profile ever pitched to them, across every one of their campaigns, in one
// list (not split into a separate link per campaign) — each card labelled
// with which campaign it was pitched for, for context when a client has more
// than one campaign running.
router.get("/api/pitch/:brandId", async (req, res) => {
  try {
    const checked = await verifyCode(req.params.brandId, req.query.code);
    if (checked.error) return res.status(checked.error).json({ error: checked.message });

    const profiles = await PitchProfile.find({ brandId: req.params.brandId })
      .sort({ createdAt: 1 })
      .lean();
    const [nameById, briefById] = await Promise.all([
      campaignNamesFor(profiles),
      campaignBriefsFor(profiles),
    ]);

    res.json({
      client: { id: req.params.brandId, name: checked.client.name || null },
      profiles: profiles.map((p) => publicShape(p, nameById.get(p.campaignId) || null)),
      // Keyed by campaign id, not inlined per profile — several profiles
      // share one campaign and its brief, so this stays one copy rather than
      // repeating the same brief object on every card pitched under it.
      campaigns: Object.fromEntries(briefById),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pitch/:brandId/:pitchId?code=... — body { status, by }.
// The client's approve/reject. Reversible right up until the internal team
// ships it (see POST .../ship above) — mirrors DECIDABLE's own "still
// reversible until acted on" rule for the main roster-decision route.
router.patch("/api/pitch/:brandId/:pitchId", async (req, res) => {
  try {
    const checked = await verifyCode(req.params.brandId, req.query.code);
    if (checked.error) return res.status(checked.error).json({ error: checked.message });

    const status = String(req.body?.status || "").trim();
    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be approved or rejected" });
    }

    const pitch = await PitchProfile.findOne({ _id: req.params.pitchId, brandId: req.params.brandId });
    if (!pitch) return res.status(404).json({ error: "not found" });
    if (pitch.shipped) {
      return res.status(409).json({ error: "This one's already moved on — talk to your team." });
    }

    pitch.status = status;
    pitch.decision = { at: new Date(), by: String(req.body?.by || "").trim() || "Client" };
    await pitch.save();

    res.json(publicShape(pitch.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
