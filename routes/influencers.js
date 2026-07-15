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

export default router;
