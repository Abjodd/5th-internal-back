// Creators directory (founder view).
// Backed by its own persistent `creators` collection (models/Creator.js) —
// the single source of truth for a creator's profile (name, handle,
// platform, followers, niche, personalDetails, ...). Campaigns stay the
// operational record (per-campaign fee, status, concept/demo) and only hold
// a `creatorId` reference — see creatorSync.js for the split-on-write /
// hydrate-on-read logic that keeps the two in step.
import { Router } from "express";
import Campaign from "../models/Campaign.js";
import Invoice from "../models/Invoice.js";
import Creator from "../models/Creator.js";
import { keyOf, PROFILE_FIELDS } from "../creatorSync.js";

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
      Creator.find({}).sort({ name: 1 }).lean(),
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
          stage: camp.stage || null, fee: cr.fee ?? null, status: cr.status || null,
          concept: cr.concept || null, demo: cr.demo || null,
        });
        campaignsByKey.set(key, list);
      }
    }

    let rows = creators.map(({ _id, ...rest }) => ({
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
    if (!Object.keys(patch).length) return res.status(400).json({ error: "no editable fields in body" });

    const inf = await Creator.findById(key);
    if (!inf) return res.status(404).json({ error: "creator not found" });
    inf.set({
      ...patch,
      ...(patch.personalDetails ? { personalDetails: { ...(inf.personalDetails || {}), ...patch.personalDetails } } : {}),
    });
    await inf.save();
    res.json({ id: key, ...inf.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
