// Client requests — the founder's inbox of brand signups from the public
// "Start a project" landing page (hosted separately; it POSTs here).
//
//   POST  /api/client-requests      public — landing page submits a signup
//   GET   /api/client-requests      founder tab — newest first
//   PATCH /api/client-requests/:id  founder tab — triage status
//
// On a new signup we notify the founder by email (Resend) fire-and-forget:
// the response returns as soon as the row is saved, and any email failure is
// logged, never surfaced to the caller (see mailer.js).
import { Router } from "express";
import ClientRequest from "../models/ClientRequest.js";
import { sendFounderEmail } from "../mailer.js";

const router = Router();

// Next sequential id ("cr1", "cr2", …) — same scheme the auth routes use for
// users/brand-credentials. Assigned server-side so the landing page never has
// to know our id format.
async function nextId() {
  const docs = await ClientRequest.find({}, { _id: 1 }).lean();
  const max = docs.reduce((m, d) => {
    const match = /^cr(\d+)$/.exec(d._id || "");
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `cr${max + 1}`;
}

const pub = ({ _id, ...rest }) => ({ id: _id, ...rest });

// POST /api/client-requests — public landing-page submission.
router.post("/api/client-requests", async (req, res) => {
  try {
    const { name, contact } = req.body || {};
    if (!name || !contact)
      return res.status(400).json({ error: "name and contact are required" });

    const doc = await ClientRequest.create({
      _id: await nextId(),
      name: String(name).trim(),
      role: req.body.role || "",
      contact: String(contact).trim(),
      organisation: req.body.organisation || "",
      headquarters: req.body.headquarters || "",
      goal: req.body.goal || "",
      status: "new",
    });

    const request = pub(doc.toObject());
    // Fire-and-forget: don't block the signup on the email round-trip, and
    // never fail the request if the mail provider is down / unconfigured.
    sendFounderEmail(request);
    res.status(201).json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/client-requests — founder inbox, newest signup first.
router.get("/api/client-requests", async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    const docs = await ClientRequest.find(q).sort({ createdAt: -1 }).lean();
    res.json(docs.map(pub));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/client-requests/:id — triage (status changes from the founder tab).
router.patch("/api/client-requests/:id", async (req, res) => {
  try {
    const updated = await ClientRequest.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(pub(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
