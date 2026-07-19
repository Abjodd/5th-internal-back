// Influencers directory (founder view).
// GET /api/influencers?brandId= — aggregates every creator across all
// non-deleted campaigns into one deduped directory row: profile + billing
// details, the campaigns they appear in, and any generated invoices (the
// GridFS-backed Invoice docs from routes/invoicePdf.js). All aggregation
// happens here so the frontend Influencers page is a pure view over this
// endpoint — the backend stays the single source of truth.
import { Router } from "express";
import Campaign from "../models/Campaign.js";
import Invoice from "../models/Invoice.js";

const router = Router();

router.get("/api/influencers", async (req, res) => {
  try {
    const campQ = { deleted: { $ne: true } };
    if (req.query.brandId) campQ.brandId = req.query.brandId;
    const [campaigns, invoices] = await Promise.all([
      Campaign.find(campQ).lean(),
      Invoice.find({ kind: "creator" }).lean(),
    ]);

    // Dedup key: handle when present (stable across campaigns), else name.
    const keyOf = (cr) => String(cr.handle || cr.name || "").toLowerCase().trim();
    const map = new Map();

    campaigns.forEach((camp) => {
      (camp.creators || []).forEach((cr) => {
        const key = keyOf(cr);
        if (!key) return;
        if (!map.has(key)) {
          map.set(key, {
            id: key,
            name: cr.name || "",
            handle: cr.handle || null,
            platform: cr.platform || null,
            followers: cr.followers ?? null,
            avgER: cr.avgER ?? null,
            niche: cr.niche || null,
            state: cr.state || null,
            phone: cr.phone || null,
            payType: cr.payType || null,
            payId: cr.payId || null,
            personalDetails: cr.personalDetails || {},
            campaigns: [],
            invoices: [],
          });
        }
        const inf = map.get(key);
        // Later campaigns fill gaps — the richest snapshot of the creator wins.
        inf.name      = inf.name || cr.name || "";
        inf.platform  = inf.platform || cr.platform || null;
        inf.followers = inf.followers ?? cr.followers ?? null;
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
      });
    });

    // Attach generated invoices by handle (preferred) or name fallback.
    invoices.forEach(({ _id, ...inv }) => {
      const key = String(inv.creatorHandle || inv.creatorName || "").toLowerCase().trim();
      const inf = map.get(key) ||
        [...map.values()].find((i) => i.name.toLowerCase() === String(inv.creatorName || "").toLowerCase());
      if (inf) inf.invoices.push({ id: _id, ...inv });
    });

    res.json([...map.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/influencers/:id — founder edit from the directory.
// The directory has no collection of its own (rows are aggregated from
// campaign.creators above), so the patch is propagated to the creator's entry
// in every non-deleted campaign, matched by the same dedupe key the GET uses.
// Only profile/billing fields propagate — per-campaign fields (fee, status,
// concept/demo/live, tracking, invoiceNo) belong to each campaign and are
// deliberately not editable from the directory.
const EDITABLE = [
  "name", "handle", "platform", "igUrl", "followers", "avgLikes", "avgER",
  "niche", "state", "phone", "payType", "payId", "personalDetails",
];

router.patch("/api/influencers/:id", async (req, res) => {
  try {
    const key = String(req.params.id).toLowerCase().trim();
    const patch = {};
    for (const k of EDITABLE) if (k in req.body) patch[k] = req.body[k];
    if (!Object.keys(patch).length) return res.status(400).json({ error: "no editable fields in body" });

    const campaigns = await Campaign.find({ deleted: { $ne: true } });
    let touched = 0;
    for (const camp of campaigns) {
      let hit = false;
      camp.creators = (camp.creators || []).map((cr) => {
        if (String(cr.handle || cr.name || "").toLowerCase().trim() !== key) return cr;
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
    if (!touched) return res.status(404).json({ error: "influencer not found on any campaign" });
    res.json({ id: key, updatedCampaigns: touched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
