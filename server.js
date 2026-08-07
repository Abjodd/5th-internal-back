import express from "express";
import cors from "cors";
import { connectDB } from "./db.js";
import Campaign from "./models/Campaign.js";
import Invoice from "./models/Invoice.js";
import invoicePdfRoutes from "./routes/invoicePdf.js";
import authRoutes from "./routes/auth.js";
import creatorRoutes from "./routes/creators.js";
import { keyOf, splitCreatorsForStorage, hydrateCampaignCreators } from "./creatorSync.js";
import clientRequestRoutes from "./routes/clientRequests.js";
import creatorRequestRoutes from "./routes/creatorRequests.js";
import Expense from "./models/Expense.js";
import PurchaseOrder from "./models/PurchaseOrder.js";
import ClientPO from "./models/ClientPO.js";
import Quote from "./models/Quote.js";
import RegistryEntry from "./models/RegistryEntry.js";
import { fetchInstagramProfile } from "./instagramfetchhiker.js";
import { fetchYouTubeChannel } from "./youtubeFetch.js";
import { fetchPostMetrics } from "./postMetrics.js";
import { startScheduler } from "./scheduler.js";
import { refreshAllPostMetrics } from "./refreshPostMetrics.js";
const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
    // Cache the CORS preflight for 24h. Without this the `cors` package sends
    // no Access-Control-Max-Age, so Chrome falls back to its 5-second default
    // and re-preflights almost every call — the frontends were paying two
    // round trips per request (an OPTIONS beside every GET/POST) on a link
    // where each trip costs ~150-250ms. 86400 is the ceiling Chrome honours.
    maxAge: 86400,
  })
);

app.use(express.json({ limit: "5mb" }));

// ── Feature route modules (see routes/) ─────────────────────────────────────
// invoicePdf: POST/GET /api/invoices/:invoiceNo/pdf — pdfkit render + GridFS storage
// auth:       /api/auth/login, /api/auth/portal-login, /api/users, /api/brand-credentials
// creators:   /api/creators — creator directory aggregated across campaigns
// clientReqs: /api/client-requests — brand landing-page signups (founder inbox)
// creatorReqs:/api/creator-requests — creator applications (founder inbox)
// NOTE: mounted before registerCrudRoutes("/api/invoices") below so the more
// specific /pdf routes win over the generic /api/invoices/:id matchers.
app.use(invoicePdfRoutes);
app.use(authRoutes);
app.use(creatorRoutes);
app.use(clientRequestRoutes);
app.use(creatorRequestRoutes);

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
    try {
      const body = req.body;
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const doc = await Model.create({ ...body, _id: body.id });
      const { _id, ...rest } = doc.toObject();
      res.status(201).json({ id: _id, ...rest });
    } catch (err) {
      // This catch is what the whole route was missing. Express 4 does not
      // catch a rejected promise from an async handler, so a duplicate _id
      // escaped as an unhandledRejection and Node killed the process — one bad
      // request took the API down for everyone. 11000 is Mongo's duplicate-key
      // code; the unique index on _id stays the single source of truth.
      if (err.code === 11000) return res.status(409).json({ error: "A record with this id already exists." });
      res.status(500).json({ error: err.message });
    }
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
    try {
      await Model.findByIdAndDelete(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
    await hydrateCampaignCreators(campaigns);
    res.json(campaigns.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Denormalized creator_ids on a campaign — the same dedupe key the creators
// directory keys on (keyOf, from creatorSync.js), so the mapping stays a
// queryable index into the creators collection without ever drifting.
const creatorIdsOf = (creators) =>
  [...new Set((creators || []).map((cr) => cr.creatorId || keyOf(cr)).filter(Boolean))];

// POST /api/campaigns — create a new campaign
// Body is the full campaign object (id, name, client, ... as built in onCreate)
app.post("/api/campaigns", async (req, res) => {
  try {
    const c = req.body;
    if (!c.id) return res.status(400).json({ error: "id is required" });
    const creators = await splitCreatorsForStorage(c.creators);
    const doc = await Campaign.create({ ...c, _id: c.id, creators, creatorIds: creatorIdsOf(creators) });
    const [hydrated] = await hydrateCampaignCreators([doc.toObject()]);
    const { _id, ...rest } = hydrated;
    res.status(201).json({ id: _id, ...rest });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A campaign with this id already exists." });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id — partial update (brief, creators, stage, etc.)
// When `creators` is touched, profile fields (name, handle, followers, ...)
// are split out to the creators directory before saving — see creatorSync.js.
app.patch("/api/campaigns/:id", async (req, res) => {
  try {
    const patch = { ...req.body };
    if ("creators" in patch) {
      patch.creators = await splitCreatorsForStorage(patch.creators);
      patch.creatorIds = creatorIdsOf(patch.creators);
    }
    const updated = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: patch },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    const [hydrated] = await hydrateCampaignCreators([updated]);
    const { _id, ...rest } = hydrated;
    res.json({ id: _id, ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id?actor=NAME — soft delete: the doc stays in Mongo
// with deleted:true so it can be restored by hand, but every list query hides
// it. The deletion is appended to the campaign's timeline as the audit trail.
app.delete("/api/campaigns/:id", async (req, res) => {
  try {
    const actor = req.query.actor || "Unknown";
    const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    await Campaign.findByIdAndUpdate(req.params.id, {
      $set: { deleted: true, deletedAt: new Date() },
      $push: { timeline: { date, event: "Campaign deleted", actor } },
    });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Client Portal (read-only) ────────────────────────────────────────────────
// GET /api/portal/campaigns?client=NAME — one client's campaigns, with
// everything internal stripped before it leaves the building.
//
// Campaign fields are a denylist: money the client shouldn't see (creator
// fees, creator budget), staff assignments and notes, and internal bookkeeping.
const CAMPAIGN_PRIVATE = [
  "creatorBudget", "amId", "bmId", "cmId", "eaId", "brandId",
  "internalNotes", "amNote", "bmNote", "cmNote",
  "genRounds", "sentToClient", "timeline",
  // Internal identifiers with no meaning to a client: who created the campaign
  // (a staff teamId), the denormalized creator index, and the soft-delete
  // bookkeeping that every query already filters on.
  "createdBy", "creatorIds", "deleted", "deletedAt",
];

// Creator fields are an ALLOWLIST, deliberately — the opposite of the campaign
// rule above, and the difference matters.
//
// Campaign and Creator are both `strict: false`, so a denylist here would make
// every field anyone ever adds public by default. That is not hypothetical:
// once creator profiles moved into their own collection, hydrateCampaignCreators
// began merging the full profile — including `personalDetails` (PAN, bank
// account number, IFSC, UPI id) — onto each campaign's creators[] on read. The
// old denylist named `fee, phone, payType, payId, dbId` but not
// `personalDetails`, so every client with a portal login was being served their
// creators' bank and tax details in the JSON payload. The portal UI never
// rendered them (see mapping.js toViewCreator), which is exactly why it went
// unnoticed — the data was one devtools Network tab away the whole time.
//
// Add to this list only after checking the field is safe for a brand to read.
const CREATOR_PUBLIC = [
  // identity / audience — what the brand is buying
  "name", "handle", "platform", "igUrl", "followers", "avgLikes", "avgER",
  "niche", "state", "languages",
  // campaign-specific workflow the portal renders
  // `numDeliverables` is how many posts this creator owes — the brand is
  // buying it, so it belongs in the client's view of the roster. `live` now
  // carries a postUrls[] array alongside the postUrl the portal reads today;
  // both travel under the one key.
  "status", "concept", "demo", "live", "tracking", "deliverables", "numDeliverables",
];

app.get("/api/portal/campaigns", async (req, res) => {
  try {
    const client = req.query.client;
    if (!client) return res.status(400).json({ error: "client query param is required" });
    const campaigns = await Campaign.find({ client, deleted: { $ne: true } }).lean();
    await hydrateCampaignCreators(campaigns);
    res.json(
      campaigns.map(({ _id, ...c }) => {
        for (const k of CAMPAIGN_PRIVATE) delete c[k];
        c.creators = (c.creators || []).map((cr) =>
          CREATOR_PUBLIC.reduce((safe, k) => (k in cr ? { ...safe, [k]: cr[k] } : safe), {})
        );
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
  try {
    const clients = await Client.find().lean();
    res.json(clients.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients — create a new client
app.post("/api/clients", async (req, res) => {
  try {
    const c = req.body;
    if (!c.id) return res.status(400).json({ error: "id is required" });
    const doc = await Client.create({ ...c, _id: c.id });
    const { _id, ...rest } = doc.toObject();
    res.status(201).json({ id: _id, ...rest });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A client with this id already exists." });
    res.status(500).json({ error: err.message });
  }
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
  try {
    const q = {};
    if (req.query.clientId) q.clientId = req.query.clientId;
    const findings = await Finding.find(q).lean();
    res.json(findings.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  try {
    const handle = req.query.handle;
    if (!handle) return res.status(400).json({ error: "handle query param is required" });
    const result = await fetchInstagramProfile(handle);
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── YouTube channel lookup (Add Creator auto-fetch, YouTube creators) ───────
// GET /api/youtube?handle=https://www.youtube.com/@somechannel (or @handle)
// Same response shape as /api/instagram so the frontend card renders both.
app.get("/api/youtube", async (req, res) => {
  try {
    const handle = req.query.handle;
    if (!handle) return res.status(400).json({ error: "handle query param is required" });
    const result = await fetchYouTubeChannel(handle);
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Post metrics (Deliverables tab tracking) ────────────────────────────────
// GET /api/post-metrics?url=&platform= — dispatches on the link/platform:
// Instagram via HikerAPI, YouTube via the Data API.
app.get("/api/post-metrics", async (req, res) => {
  try {
    const { url, platform } = req.query;
    if (!url) return res.status(400).json({ error: "url query param is required" });
    const result = await fetchPostMetrics(url, platform);
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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

// POST /api/post-metrics/refresh-all — run the nightly job now.
// Exists so the scheduled job can be verified (and re-run after an outage)
// without waiting for midnight or redeploying. Returns the same summary the
// scheduler logs.
app.post("/api/post-metrics/refresh-all", async (req, res) => {
  try {
    res.json(await refreshAllPostMetrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  // After the DB is up — the jobs query Mongo directly.
  startScheduler();
});


// const cors = require("cors");

// app.use(cors({
//   origin: [
//     "http://localhost:5173",
//     "https://your-frontend.vercel.app"
//   ],
//   credentials: true
// }));