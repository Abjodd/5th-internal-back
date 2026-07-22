// Influencers directory (founder view).
// Backed by its own persistent `influencers` collection (models/Influencer.js)
// — the standalone, queryable record of every creator assigned to a campaign.
// Campaigns stay the operational record (per-campaign fee, status,
// concept/demo); this collection is the deduped profile + "where they've
// worked" directory.
//
// The collection is kept in step with campaign data by
// rebuildDirectoryFromCampaigns(), run at the start of the GET. It reads the
// live campaigns, upserts every current creator and prunes anyone no longer on
// a campaign.
import { Router } from "express";
import Campaign from "../models/Campaign.js";
import Invoice from "../models/Invoice.js";
import Influencer from "../models/Influencer.js";

const router = Router();

// Dedup key: handle when present (stable across campaigns), else name.
const keyOf = (cr) => String(cr.handle || cr.name || "").toLowerCase().trim();

// Profile fields owned by the directory. Only these are overwritten on a
// rebuild — any extra influencer-only fields (added later, e.g. notes) are
// left untouched, so the collection stays safely extensible.
const PROFILE = [
  "name", "handle", "platform", "igUrl", "followers", "avgLikes", "avgER",
  "niche", "state", "phone", "payType", "payId", "personalDetails",
];

// Rebuild the directory from live campaign data: aggregate every creator across
// non-deleted campaigns into one deduped row (first non-blank value wins for
// shared profile fields), then upsert the set and drop rows for creators no
// longer on any campaign. Idempotent — safe to run on every read.
async function rebuildDirectoryFromCampaigns() {
  const campaigns = await Campaign.find({ deleted: { $ne: true } }).lean();
  const map = new Map();

  for (const camp of campaigns) {
    for (const cr of camp.creators || []) {
      const key = keyOf(cr);
      if (!key) continue;
      let inf = map.get(key);
      if (!inf) {
        inf = {
          _id: key, name: "", handle: null, platform: null, igUrl: null,
          followers: null, avgLikes: null, avgER: null, niche: null,
          state: null, phone: null, payType: null, payId: null,
          personalDetails: {}, campaigns: [],
        };
        map.set(key, inf);
      }
      // Fill gaps — the richest snapshot of the creator across campaigns wins.
      inf.name      = inf.name || cr.name || "";
      inf.handle    = inf.handle || cr.handle || null;
      inf.platform  = inf.platform || cr.platform || null;
      inf.igUrl     = inf.igUrl || cr.igUrl || null;
      inf.followers = inf.followers ?? cr.followers ?? null;
      inf.avgLikes  = inf.avgLikes ?? cr.avgLikes ?? null;
      inf.avgER     = inf.avgER ?? cr.avgER ?? null;
      inf.niche     = inf.niche || cr.niche || null;
      inf.state     = inf.state || cr.state || null;
      inf.phone     = inf.phone || cr.phone || null;
      inf.payType   = inf.payType || cr.payType || null;
      inf.payId     = inf.payId || cr.payId || null;
      inf.personalDetails = { ...(cr.personalDetails || {}), ...inf.personalDetails };
      inf.campaigns.push({
        id: camp._id,
        name: camp.name,
        client: camp.client,
        brandId: camp.brandId || null,
        stage: camp.stage || null,
        fee: cr.fee ?? null,
        status: cr.status || null,
        concept: cr.concept || null,
        demo: cr.demo || null,
      });
    }
  }

  const keys = [...map.keys()];
  const ops = [...map.values()].map((inf) => {
    const { _id, ...set } = inf;
    return { updateOne: { filter: { _id }, update: { $set: set }, upsert: true } };
  });
  if (ops.length) await Influencer.bulkWrite(ops);
  // Prune creators removed from every campaign so the directory only ever
  // lists influencers currently assigned to a campaign.
  await Influencer.deleteMany({ _id: { $nin: keys } });
}

router.get("/api/influencers", async (req, res) => {
  try {
    await rebuildDirectoryFromCampaigns();
    const q = {};
    if (req.query.brandId) q["campaigns.brandId"] = req.query.brandId;
    const [influencers, invoices] = await Promise.all([
      Influencer.find(q).sort({ name: 1 }).lean(),
      Invoice.find({ kind: "creator" }).lean(),
    ]);

    const rows = influencers.map(({ _id, campaigns, ...rest }) => ({
      id: _id,
      ...rest,
      // Brand filter narrows the visible campaign appearances too.
      campaigns: req.query.brandId ? campaigns.filter((c) => c.brandId === req.query.brandId) : campaigns,
      invoices: [],
    }));
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

// PATCH /api/influencers/:id — founder edit from the directory. Persists to the
// influencers collection AND propagates the same patch into every non-deleted
// campaign's embedded creator (the Campaigns UI reads creator profile fields
// straight off the campaign document, and the rebuild re-derives the directory
// from those, so both must move together). Per-campaign fields (fee, status,
// concept/demo/live, tracking, invoiceNo) belong to each campaign and are
// deliberately not editable here.
router.patch("/api/influencers/:id", async (req, res) => {
  try {
    const key = String(req.params.id).toLowerCase().trim();
    const patch = {};
    for (const k of PROFILE) if (k in req.body) patch[k] = req.body[k];
    if (!Object.keys(patch).length) return res.status(400).json({ error: "no editable fields in body" });

    const inf = await Influencer.findById(key);
    if (!inf) return res.status(404).json({ error: "influencer not found" });
    inf.set({
      ...patch,
      ...(patch.personalDetails ? { personalDetails: { ...(inf.personalDetails || {}), ...patch.personalDetails } } : {}),
    });
    await inf.save();

    const campaigns = await Campaign.find({ deleted: { $ne: true } });
    let touched = 0;
    for (const camp of campaigns) {
      let hit = false;
      camp.creators = (camp.creators || []).map((cr) => {
        if (keyOf(cr) !== key) return cr;
        hit = true;
        return {
          ...cr,
          ...patch,
          personalDetails: { ...(cr.personalDetails || {}), ...(patch.personalDetails || {}) },
        };
      });
      if (hit) {
        camp.markModified("creators"); // Mixed array — Mongoose can't detect the mutation
        await camp.save();
        touched++;
      }
    }
    res.json({ id: key, updatedCampaigns: touched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
