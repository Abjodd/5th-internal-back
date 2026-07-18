import express from "express";
import cors from "cors";
import { connectDB } from "./db.js";
import Campaign from "./models/Campaign.js";
import Invoice from "./models/Invoice.js";
import invoicePdfRoutes from "./routes/invoicePdf.js";
import authRoutes from "./routes/auth.js";
import influencerRoutes from "./routes/influencers.js";
import Expense from "./models/Expense.js";
import PurchaseOrder from "./models/PurchaseOrder.js";
import ClientPO from "./models/ClientPO.js";
import Quote from "./models/Quote.js";
import RegistryEntry from "./models/RegistryEntry.js";
import { fetchInstagramProfile } from "./instagramfetchhiker.js";
const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));

// ── Feature route modules (see routes/) ─────────────────────────────────────
// invoicePdf: POST/GET /api/invoices/:invoiceNo/pdf — pdfkit render + GridFS storage
// auth:       /api/auth/login, /api/auth/portal-login, /api/users, /api/brand-credentials
// influencers:/api/influencers — creator directory aggregated across campaigns
// NOTE: mounted before registerCrudRoutes("/api/invoices") below so the more
// specific /pdf routes win over the generic /api/invoices/:id matchers.
app.use(invoicePdfRoutes);
app.use(authRoutes);
app.use(influencerRoutes);

// Generic CRUD route factory for the simple Billing collections — they're
// all "list everything / create / patch by id", optionally filtered by
// ?brandId=, so one factory avoids repeating the same 4 routes 6 times.
function registerCrudRoutes(basePath, Model) {
  app.get(basePath, async (req, res) => {
    try {
      const q = {};
      if (req.query.brandId) q.brandId = req.query.brandId;
      const docs = await Model.find(q).lean();
      res.json(docs.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(basePath, async (req, res) => {
    const body = req.body;
    if (!body.id) return res.status(400).json({ error: "id is required" });
    const doc = await Model.create({ ...body, _id: body.id });
    const { _id, ...rest } = doc.toObject();
    res.status(201).json({ id: _id, ...rest });
  });

  app.patch(`${basePath}/:id`, async (req, res) => {
    try {
      const updated = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: req.body },
        { new: true }
      ).lean();
      if (!updated) return res.status(404).json({ error: "not found" });
      const { _id, ...rest } = updated;
      res.json({ id: _id, ...rest });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(`${basePath}/:id`, async (req, res) => {
    await Model.findByIdAndDelete(req.params.id);
    res.status(204).end();
  });
}

registerCrudRoutes("/api/invoices", Invoice);
registerCrudRoutes("/api/expenses", Expense);
registerCrudRoutes("/api/purchase-orders", PurchaseOrder);
registerCrudRoutes("/api/client-pos", ClientPO);
registerCrudRoutes("/api/quotes", Quote);
registerCrudRoutes("/api/registry", RegistryEntry);

// ── Campaigns ────────────────────────────────────────────────────────────────

// GET /api/campaigns — list all campaigns
app.get("/api/campaigns", async (req, res) => {
  try {
    const q = { deleted: { $ne: true } };
    if (req.query.client)  q.client  = req.query.client;
    if (req.query.stage)   q.stage   = req.query.stage;
    if (req.query.brandId) q.brandId = req.query.brandId;
    const campaigns = await Campaign.find(q).lean();
    res.json(campaigns.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns — create a new campaign
// Body is the full campaign object (id, name, client, ... as built in onCreate)
app.post("/api/campaigns", async (req, res) => {
  const c = req.body;
  if (!c.id) return res.status(400).json({ error: "id is required" });
  const doc = await Campaign.create({ ...c, _id: c.id });
  const { _id, ...rest } = doc.toObject();
  res.status(201).json({ id: _id, ...rest });
});

// PATCH /api/campaigns/:id — partial update (brief, creators, stage, etc.)
app.patch("/api/campaigns/:id", async (req, res) => {
  try {
    const updated = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    const { _id, ...rest } = updated;
    res.json({ id: _id, ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id?actor=NAME — soft delete: the doc stays in Mongo
// with deleted:true so it can be restored by hand, but every list query hides
// it. The deletion is appended to the campaign's timeline as the audit trail.
app.delete("/api/campaigns/:id", async (req, res) => {
  const actor = req.query.actor || "Unknown";
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  await Campaign.findByIdAndUpdate(req.params.id, {
    $set: { deleted: true, deletedAt: new Date() },
    $push: { timeline: { date, event: "Campaign deleted", actor } },
  });
  res.status(204).end();
});

// ── Client Portal (read-only) ────────────────────────────────────────────────
// GET /api/portal/campaigns?client=NAME — one client's campaigns with
// internal-only fields stripped before they leave the building: money the
// client shouldn't see (creator fees, creator budget), staff assignments and
// notes, and payment identifiers.
const CAMPAIGN_PRIVATE = [
  "creatorBudget", "amId", "bmId", "cmId", "eaId", "brandId",
  "internalNotes", "amNote", "bmNote", "cmNote",
  "genRounds", "sentToClient", "timeline",
];
const CREATOR_PRIVATE = ["fee", "phone", "payType", "payId", "dbId"];

app.get("/api/portal/campaigns", async (req, res) => {
  try {
    const client = req.query.client;
    if (!client) return res.status(400).json({ error: "client query param is required" });
    const campaigns = await Campaign.find({ client, deleted: { $ne: true } }).lean();
    res.json(
      campaigns.map(({ _id, ...c }) => {
        for (const k of CAMPAIGN_PRIVATE) delete c[k];
        c.creators = (c.creators || []).map((cr) => {
          const safe = { ...cr };
          for (const k of CREATOR_PRIVATE) delete safe[k];
          return safe;
        });
        return { id: _id, ...c };
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

import Client from "./models/Client.js";

// ── Clients (Company Overview) ─────────────────────────────────────────────

// GET /api/clients — list all clients
app.get("/api/clients", async (req, res) => {
  const clients = await Client.find().lean();
  res.json(clients.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
});

// POST /api/clients — create a new client
app.post("/api/clients", async (req, res) => {
  const c = req.body;
  if (!c.id) return res.status(400).json({ error: "id is required" });
  const doc = await Client.create({ ...c, _id: c.id });
  const { _id, ...rest } = doc.toObject();
  res.status(201).json({ id: _id, ...rest });
});

// PATCH /api/clients/:id — partial update
app.patch("/api/clients/:id", async (req, res) => {
  try {
    const updated = await Client.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    const { _id, ...rest } = updated;
    res.json({ id: _id, ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

import Finding from "./models/Finding.js";

// ── Findings (Audit Centre) ──────────────────────────────────────────────────

// GET /api/findings?clientId=fb — list findings, optionally filtered by client
app.get("/api/findings", async (req, res) => {
  const q = {};
  if (req.query.clientId) q.clientId = req.query.clientId;
  const findings = await Finding.find(q).lean();
  res.json(findings.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
});

// PATCH /api/findings/:id — update status (open/develop/task/monitor/ignored)
app.patch("/api/findings/:id", async (req, res) => {
  try {
    const updated = await Finding.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    const { _id, ...rest } = updated;
    res.json({ id: _id, ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Instagram lookup (Add Creator auto-fetch) ───────────────────────────────
// GET /api/instagram?handle=https://www.instagram.com/someuser/
app.get("/api/instagram", async (req, res) => {
  const handle = req.query.handle;
  if (!handle) return res.status(400).json({ error: "handle query param is required" });
  const result = await fetchInstagramProfile(handle);
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

// ── Client Portal Analytics ─────────────────────────────────────────────────
// GET /api/portal/analytics?client=NAME&from=ISO&to=ISO
// Returns one dated event per campaign in the period (spend/reach/engagement
// metrics, dated by campaign start) plus a spend-by-service split. The portal
// buckets events into daily/weekly/monthly series client-side (see
// 5th-avenue-client-front src/lib/dates.js bucketSeries), so switching
// granularity never needs a refetch.
// Reach  = sum of creator followers (audience reach potential per campaign)
// Engagements = reach × avgER across creators
// Impressions = reach × 0.12 (estimated: 12% of follower base sees each post)
// Clicks = engagements × 0.08 (estimated: 8% click-through on engaged audience)
// All estimates are clearly labelled in the API response.
app.get("/api/portal/analytics", async (req, res) => {
  try {
    const client = req.query.client;
    if (!client) return res.status(400).json({ error: "client query param is required" });

    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), 0, 1);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    const campaigns = await Campaign.find({ client, deleted: { $ne: true } }).lean();

    // Campaign.start/end are stored as ISO ("YYYY-MM-DD"). Legacy rows that
    // predated this (month-first "Mar 1", day-first "3 Jul") were normalized
    // to ISO via a one-time migration.
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    function parseISO(s) {
      if (!s || !ISO_DATE.test(s)) return null;
      const d = new Date(`${s}T00:00:00`);
      return isNaN(d) ? null : d;
    }

    const events = [];
    const spendByService = {};

    campaigns.forEach(c => {
      const startDate = parseISO(c.start);
      if (!startDate || startDate < from || startDate > to) return;

      // Compute aggregate reach + ER across creators
      const creators = c.creators || [];
      let totalFollowers = 0, weightedER = 0, erCount = 0;
      creators.forEach(cr => {
        const raw = cr.followers;
        let f = typeof raw === "number" ? raw : 0;
        if (typeof raw === "string") {
          const up = raw.trim().toUpperCase().replace(/,/g,"");
          const mp = up.match(/^([\d.]+)\s*([KM])?$/);
          if (mp) f = parseFloat(mp[1]) * (mp[2]==="M" ? 1e6 : mp[2]==="K" ? 1e3 : 1);
        }
        totalFollowers += f;
        if (cr.avgER > 0) { weightedER += cr.avgER * f; erCount += f; }
      });
      const avgER = erCount > 0 ? weightedER / erCount : 0;
      const reach = totalFollowers;
      const engagements = Math.round(reach * (avgER / 100));
      const impressions = Math.round(reach * 0.12);
      const clicks      = Math.round(engagements * 0.08);
      const spend       = Number(c.budget) || 0;

      events.push({
        date: c.start, campaign: c.name,
        spend, reach, engagements, impressions, clicks,
      });

      // Spend split by service — same period filter as the events above, so
      // "Spend Split · selected period" actually reflects the period.
      const svc = (c.service || "Other").trim();
      spendByService[svc] = (spendByService[svc] || 0) + spend;
    });

    res.json({
      events,
      spendByService,
      note: "reach=followers sum; engagements=reach×avgER; impressions≈reach×0.12; clicks≈engagements×0.08",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
});


// const cors = require("cors");

// app.use(cors({
//   origin: [
//     "http://localhost:5173",
//     "https://your-frontend.vercel.app"
//   ],
//   credentials: true
// }));