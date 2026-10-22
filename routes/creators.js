// Creators directory (founder view).
// Backed by its own persistent `creators` collection (models/Creator.js) —
// the single source of truth for a creator's profile (name, handle,
// platform, followers, niche, personalDetails, ...). Campaigns stay the
// operational record (per-campaign fee, status, concept/demo) and only hold
// a `creatorId` reference — see creatorSync.js for the split-on-write /
// hydrate-on-read logic that keeps the two in step.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import Campaign from "../models/Campaign.js";
import Invoice from "../models/Invoice.js";
import Creator from "../models/Creator.js";
import CreatorDocument from "../models/CreatorDocument.js";
import { keyOf, PROFILE_FIELDS } from "../creatorSync.js";
import { withAvatar, serveAvatar, OMIT_AVATAR } from "../avatarStore.js";
import { parsePdfUpload, sendPdf, OMIT_FILE } from "../pdfUpload.js";
import { applyRemoteAvatar } from "../remoteAvatar.js";
import Project from "../models/Project.js";
import { fetchReelSnapshot } from "../portalReels.js";
import { engagementRate } from "../engagement.js";
import { parseFollowers } from "../followers.js";

// `hasAvatar` is derived from `avatarUpdatedAt`, not from the bytes — the list
// query projects the bytes away, so the timestamp is the only witness left that
// a photo exists. Same contract as pub() in routes/auth.js and the client rows
// in server.js; the frontend builds the image URL from these two alone.
const pubAvatar = ({ avatarImage, avatarUpdatedAt, ...rest }) => ({
  ...rest,
  hasAvatar: !!avatarUpdatedAt,
  avatarUpdatedAt: avatarUpdatedAt || null,
});

const router = Router();

router.get("/api/creators", async (req, res) => {
  try {
    // The creators collection is the source of truth for a creator's profile,
    // and this endpoint no longer prunes it.
    //
    // It used to run `Creator.deleteMany({ _id: { $nin: activeKeys } })` here:
    // soft-deleting a campaign dropped its creators out of activeKeys, so the
    // next person to open this page hard-deleted them — permanently, taking
    // personalDetails (PAN, bank account, IFSC, UPI) with them, while the
    // campaign itself stayed restorable. A read endpoint should not destroy
    // records, and campaign membership should not govern a creator's
    // existence: the link runs Campaign.creatorIds -> Creator._id, one way,
    // so a creator outlives any campaign that references them.
    //
    // activeKeys is still what "currently on a live campaign" means, and it
    // still drives the campaign/brand joins below — it just no longer decides
    // who gets to exist.
    const activeKeys = await Campaign.distinct("creatorIds", { deleted: { $ne: true } });

    const [creators, campaigns, invoices] = await Promise.all([
      Creator.find({}, OMIT_AVATAR).sort({ name: 1 }).lean(),
      Campaign.find({ creatorIds: { $in: activeKeys }, deleted: { $ne: true } })
        .select("name client brandId stage creators")
        .lean(),
      Invoice.find({ kind: "creator" }).lean(),
    ]);

    // "Where they've worked" summary — derived from the campaigns that
    // currently reference each creator, not stored on the Creator doc itself.
    const campaignsByKey = new Map();
    for (const camp of campaigns) {
      for (const cr of camp.creators || []) {
        const key = cr.creatorId || keyOf(cr);
        if (!key) continue;
        const list = campaignsByKey.get(key) || [];
        list.push({
          id: camp._id, name: camp.name, client: camp.client, brandId: camp.brandId || null,
          stage: camp.stage || null, cost: cr.cost ?? cr.fee ?? null, status: cr.status || null,
          concept: cr.concept || null, demo: cr.demo || null,
        });
        campaignsByKey.set(key, list);
      }
    }

    let rows = creators.map(({ _id, ...rest }) => pubAvatar({
      id: _id, ...rest,
      campaigns: campaignsByKey.get(_id) || [],
      invoices: [],
    }));
    // Brand filter narrows to creators who've worked with that brand, and
    // their visible campaign appearances to just that brand. A creator with
    // no campaigns at all (e.g. just promoted from an application, not yet
    // booked on anything) hasn't worked with *any* brand, so they're kept
    // regardless of the filter rather than read as "not this brand" — only
    // creators who are exclusively on OTHER brands' campaigns get dropped.
    if (req.query.brandId) {
      rows = rows
        .map((r) => ({
          ...r,
          _hadCampaigns: r.campaigns.length > 0,
          campaigns: r.campaigns.filter((c) => c.brandId === req.query.brandId),
        }))
        .filter((r) => r.campaigns.length || !r._hadCampaigns)
        .map(({ _hadCampaigns, ...r }) => r);
    }

    const byId = new Map(rows.map((r) => [r.id, r]));
    const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));

    // Attach generated invoices by handle (preferred) or name fallback.
    invoices.forEach(({ _id, ...inv }) => {
      const key = String(inv.creatorHandle || inv.creatorName || "").toLowerCase().trim();
      const row = byId.get(key) || byName.get(String(inv.creatorName || "").toLowerCase());
      if (row) row.invoices.push({ id: _id, ...inv });
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/creators — a creator added straight to the directory, with no
// campaign booking behind them yet. Until now a creator could only come to
// exist here by being added to some campaign's roster (creatorSync.js) or
// promoted from a creator application (routes/creatorRequests.js) — see the
// frontend's Managed page (pages/Managed), which needed a way to add someone
// a founder manages directly, before any campaign puts them on a roster.
//
// Accepts the same PROFILE_FIELDS shape the PATCH below edits, so the two
// routes can never disagree about what a creator record holds.
router.post("/api/creators", async (req, res) => {
  try {
    const key = keyOf(req.body);
    if (!key) return res.status(400).json({ error: "name or handle is required" });
    if (await Creator.exists({ _id: key }))
      return res.status(409).json({ error: "A creator with this name/handle already exists." });

    const patch = {};
    for (const k of PROFILE_FIELDS) if (k in req.body) patch[k] = req.body[k];

    try { withAvatar(patch, req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!("avatarImage" in patch) && req.body.avatarSourceUrl)
      await applyRemoteAvatar(patch, req.body.avatarSourceUrl);

    const created = await Creator.create({ _id: key, ...patch });
    res.status(201).json(pubAvatar({ id: key, ...created.toObject() }));
  } catch (err) {
    // A value the schema rejects (e.g. managedBy outside its enum) is the
    // caller's mistake, not ours — 500 would have the frontend report an outage.
    if (err.name === "ValidationError") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/creators/:id — founder edit from the directory. Persists to the
// creators collection only — campaigns hold nothing but a creatorId
// reference now, so every campaign this creator appears on picks up the edit
// automatically the next time it's read (see hydrateCampaignCreators). Per-
// campaign fields (fee, status, concept/demo/live, tracking, invoiceNo)
// belong to each campaign and are deliberately not editable here.
router.patch("/api/creators/:id", async (req, res) => {
  try {
    const key = String(req.params.id).toLowerCase().trim();
    const patch = {};
    for (const k of PROFILE_FIELDS) if (k in req.body) patch[k] = req.body[k];

    // A photo the founder picked in the Edit modal. Three-way as everywhere
    // else: absent leaves it alone, null clears it, a data URI replaces it.
    try { withAvatar(patch, req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // `avatarSourceUrl` is the platform's own picture, captured into bytes we
    // keep — this is the path a re-run of Fetch takes, and so also the way a
    // creator who has changed their Instagram photo gets the new one. Ignored
    // when the body also carried an explicit upload, which is the more
    // deliberate of the two. Silent on failure by design: a CDN that will not
    // answer must not cost the founder the rest of their edit.
    if (!("avatarImage" in patch) && req.body.avatarSourceUrl)
      await applyRemoteAvatar(patch, req.body.avatarSourceUrl);

    if (!Object.keys(patch).length) return res.status(400).json({ error: "no editable fields in body" });

    const inf = await Creator.findById(key);
    if (!inf) return res.status(404).json({ error: "creator not found" });
    inf.set({
      ...patch,
      ...(patch.personalDetails ? { personalDetails: { ...(inf.personalDetails || {}), ...patch.personalDetails } } : {}),
    });
    await inf.save();
    res.json(pubAvatar({ id: key, ...inf.toObject() }));
  } catch (err) {
    // A value the schema rejects (e.g. managedBy outside its enum) is the
    // caller's mistake, not ours — 500 would have the frontend report an outage.
    if (err.name === "ValidationError") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Cached immutably and read through ?v=<avatarUpdatedAt>, so a replaced photo
// busts the cache the instant it changes. See serveAvatar.
router.get("/api/creators/:id/avatar", serveAvatar(Creator));

// ── AGREEMENTS ───────────────────────────────────────────────────────────────
// Signed PDFs held against one creator (models/CreatorDocument.js). Scoped by
// BOTH ids, so a document is only reachable through the creator that owns it.
const creatorKey = (req) => String(req.params.id).toLowerCase().trim();
const docScope = (req) => ({ _id: req.params.docId, creatorId: creatorKey(req) });

router.get("/api/creators/:id/documents", async (req, res) => {
  try {
    const docs = await CreatorDocument.find({ creatorId: creatorKey(req) }, OMIT_FILE)
      .sort({ uploadedAt: -1 })
      .lean();
    res.json(docs.map(({ _id, creatorId, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/creators/:id/documents", async (req, res) => {
  try {
    const creatorId = creatorKey(req);
    // An upload filed under a key nobody owns would be invisible and unrecoverable.
    if (!(await Creator.exists({ _id: creatorId }))) return res.status(404).json({ error: "creator not found" });

    let file;
    try { file = parsePdfUpload(req.body?.file, "Agreement"); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const created = await CreatorDocument.create({
      _id: randomUUID(),
      creatorId,
      title: String(req.body.title || "").trim() || "Agreement.pdf",
      file,
      uploadedBy: req.body.uploadedBy || null,
      uploadedAt: new Date(),
    });
    const { _id, file: _f, creatorId: _c, ...rest } = created.toObject();
    res.status(201).json({ id: _id, ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/creators/:id/documents/:docId/file", async (req, res) => {
  try {
    sendPdf(res, await CreatorDocument.findOne(docScope(req)).lean());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/creators/:id/documents/:docId", async (req, res) => {
  try {
    const { deletedCount } = await CreatorDocument.deleteOne(docScope(req));
    if (!deletedCount) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROJECTS ──────────────────────────────────────────────────────────────────
// A standalone paid deal for a creator we manage directly — see
// models/Project.js. Scoped by both ids, same discipline as the agreements
// above: a project is only reachable through the creator that owns it.
const projectScope = (req) => ({ _id: req.params.projectId, creatorId: creatorKey(req) });

// ER is computed here, not stored — it is a ratio against the creator's
// CURRENT follower count, which moves independently of when the project's
// media was last fetched. Freezing it at fetch time would make an old
// project's ER silently wrong the moment the creator's own numbers update.
function withER(project, creator) {
  const m = project.media;
  if (!m?.ok) return project;
  const followers = parseFollowers(creator?.followers);
  return {
    ...project,
    media: { ...m, er: engagementRate({ avgLikes: m.likes, avgComments: m.comments, followers }) },
  };
}

router.get("/api/creators/:id/projects", async (req, res) => {
  try {
    const creatorId = creatorKey(req);
    const creator = await Creator.findById(creatorId, { followers: 1 }).lean();
    const rows = await Project.find({ creatorId }).sort({ createdAt: -1 }).lean();
    res.json(rows.map(({ _id, creatorId: _c, ...rest }) => withER({ id: _id, ...rest }, creator)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/creators/:id/projects", async (req, res) => {
  try {
    const creatorId = creatorKey(req);
    const creator = await Creator.findById(creatorId, { followers: 1 });
    if (!creator) return res.status(404).json({ error: "creator not found" });

    // One HikerAPI credit, spent here and only here for a brand-new project —
    // same one-fetch-at-save-time contract as POST /api/trending in
    // server.js. The nightly job in trendingReels.js takes it from here.
    const url = String(req.body.url || "").trim() || null;
    const media = url ? await fetchReelSnapshot(url) : undefined;
    const now = new Date();

    const brand = String(req.body.brand || "").trim() || null;
    const brandWebsite = String(req.body.brandWebsite || "").trim() || null;
    const created = await Project.create({
      _id: randomUUID(),
      creatorId,
      // No separate "project name" field any more — the brand IS the name a
      // deal is known by; see pages/Managed/CampaignsTab.jsx. Kept on the
      // document (not dropped from the schema) so older per-creator views
      // and the Assets tab still have something to print as a caption.
      name: String(req.body.name || "").trim() || brand || "Deal",
      brand,
      brandWebsite,
      budget: Number(req.body.budget) || 0,
      internalCost: Number(req.body.internalCost) || 0,
      url,
      ...(media ? { media, fetchedAt: media.ok ? now : null, attemptedAt: now } : {}),
    });
    const { _id, creatorId: _c, ...rest } = created.toObject();
    res.status(201).json(withER({ id: _id, ...rest }, creator));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/api/creators/:id/projects/:projectId", async (req, res) => {
  try {
    const project = await Project.findOne(projectScope(req));
    if (!project) return res.status(404).json({ error: "not found" });

    const patch = {};
    if ("name" in req.body) patch.name = String(req.body.name || "").trim() || "Deal";
    if ("brand" in req.body) patch.brand = String(req.body.brand || "").trim() || null;
    if ("brandWebsite" in req.body) patch.brandWebsite = String(req.body.brandWebsite || "").trim() || null;
    if ("budget" in req.body) patch.budget = Number(req.body.budget) || 0;
    if ("internalCost" in req.body) patch.internalCost = Number(req.body.internalCost) || 0;

    // A changed link points at a different post — the old snapshot belongs
    // to the link that's being replaced, so it's re-fetched rather than left
    // sitting under a url it no longer describes.
    if ("url" in req.body) {
      const url = String(req.body.url || "").trim() || null;
      patch.url = url;
      if (url && url !== project.url) {
        const media = await fetchReelSnapshot(url);
        patch.media = media;
        patch.fetchedAt = media.ok ? new Date() : null;
        patch.attemptedAt = new Date();
      }
    }

    project.set(patch);
    await project.save();
    const creator = await Creator.findById(project.creatorId, { followers: 1 }).lean();
    const { _id, creatorId: _c, ...rest } = project.toObject();
    res.json(withER({ id: _id, ...rest }, creator));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/creators/:id/projects/:projectId", async (req, res) => {
  try {
    const { deletedCount } = await Project.deleteOne(projectScope(req));
    if (!deletedCount) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects — every project across every creator, unscoped and
// joined with just enough of each creator's own record (name, handle,
// platform, current followers → ER) to stand alone. Billing's revenue-by-
// source chart only ever needed {name,budget,creatorId,createdAt}; the
// Managed Creators ecosystem (Summary/Campaigns/Assets tabs) is the reason
// this now carries brand, the reel snapshot and the creator identity too —
// one well-structured feed instead of three narrower ones that would each
// need their own creator lookup repeated in the frontend.
router.get("/api/projects", async (req, res) => {
  try {
    const rows = await Project.find({}).sort({ createdAt: -1 }).lean();
    const creatorIds = [...new Set(rows.map(r => r.creatorId).filter(Boolean))];
    const creators = await Creator
      .find({ _id: { $in: creatorIds } }, { name: 1, handle: 1, platform: 1, followers: 1 })
      .lean();
    const creatorById = new Map(creators.map(c => [c._id, c]));

    res.json(rows.map(({ _id, creatorId, ...rest }) => {
      const creator = creatorById.get(creatorId);
      const { media, ...fields } = withER(rest, creator);
      return {
        id: _id,
        creatorId,
        creatorName: creator?.name || null,
        creatorHandle: creator?.handle || null,
        creatorPlatform: creator?.platform || null,
        ...fields,
        media,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
