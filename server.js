import express from "express";
import cors from "cors";
import { connectDB } from "./db.js";
import Campaign from "./models/Campaign.js";
import Invoice from "./models/Invoice.js";
import Expense from "./models/Expense.js";
import PurchaseOrder from "./models/PurchaseOrder.js";
import ClientPO from "./models/ClientPO.js";
import Quote from "./models/Quote.js";
import RegistryEntry from "./models/RegistryEntry.js";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));

// Generic CRUD route factory for the simple Billing collections — they're
// all "list everything / create / patch by id" with no special filtering,
// so one factory avoids repeating the same 4 routes 6 times.
function registerCrudRoutes(basePath, Model) {
  app.get(basePath, async (req, res) => {
    const docs = await Model.find().lean();
    res.json(docs.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
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
  const campaigns = await Campaign.find().lean();
  // map _id -> id so the frontend shape stays identical
  res.json(campaigns.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
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

// DELETE /api/campaigns/:id
app.delete("/api/campaigns/:id", async (req, res) => {
  await Campaign.findByIdAndDelete(req.params.id);
  res.status(204).end();
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

import { fetchInstagramProfile } from "./instagramFetch.js";

// ── Instagram lookup (Add Creator auto-fetch) ───────────────────────────────
// GET /api/instagram?handle=https://www.instagram.com/someuser/
app.get("/api/instagram", async (req, res) => {
  const handle = req.query.handle;
  if (!handle) return res.status(400).json({ error: "handle query param is required" });
  const result = await fetchInstagramProfile(handle);
  if (result.error) return res.status(502).json(result);
  res.json(result);
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