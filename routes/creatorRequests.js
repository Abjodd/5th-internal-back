// Creator requests — the founder's inbox of creator applications from the
// public "Apply as a creator" landing page (hosted separately; it POSTs here).
//
//   POST  /api/creator-requests      public — landing page submits an application
//   GET   /api/creator-requests      founder tab — newest first
//   PATCH /api/creator-requests/:id  founder tab — triage status
//
// Mirrors routes/clientRequests.js: on a new application we notify the founder
// by email (Resend) fire-and-forget — the response returns as soon as the row
// is saved, and any email failure is logged, never surfaced (see mailer.js).
import { Router } from "express";
import CreatorRequest from "../models/CreatorRequest.js";
import { sendCreatorApplicationEmail } from "../mailer.js";

const router = Router();

// Next sequential id ("crq1", "crq2", …) — same scheme the client-request and
// auth routes use. Assigned server-side so the landing page never has to know
// our id format.
async function nextId() {
  const docs = await CreatorRequest.find({}, { _id: 1 }).lean();
  const max = docs.reduce((m, d) => {
    const match = /^crq(\d+)$/.exec(d._id || "");
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `crq${max + 1}`;
}

const pub = ({ _id, ...rest }) => ({ id: _id, ...rest });

// Accept either an array or a comma-separated string for the multi-select
// fields, so the landing page can post whichever shape is convenient.
const toArray = (v) =>
  Array.isArray(v) ? v.filter(Boolean)
  : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

// POST /api/creator-requests — public landing-page submission.
router.post("/api/creator-requests", async (req, res) => {
  try {
    const { name, handle } = req.body || {};
    // A contact route is required or the application is unactionable.
    const email = (req.body.email || "").trim();
    const phone = (req.body.phone || "").trim();
    if (!name || !handle)
      return res.status(400).json({ error: "name and handle are required" });
    if (!email && !phone)
      return res.status(400).json({ error: "an email or phone is required" });

    const doc = await CreatorRequest.create({
      _id: await nextId(),
      name: String(name).trim(),
      handle: String(handle).trim(),
      platform: req.body.platform || "",
      email,
      phone,
      state: req.body.state || "",
      followers: req.body.followers || "",
      niche: toArray(req.body.niche),
      languages: toArray(req.body.languages),
      status: "new",
    });

    const request = pub(doc.toObject());
    // Fire-and-forget: don't block the application on the email round-trip, and
    // never fail the request if the mail provider is down / unconfigured.
    sendCreatorApplicationEmail(request);
    res.status(201).json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/creator-requests — founder inbox, newest application first.
router.get("/api/creator-requests", async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    const docs = await CreatorRequest.find(q).sort({ createdAt: -1 }).lean();
    res.json(docs.map(pub));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/creator-requests/:id — triage (status changes from the founder tab).
router.patch("/api/creator-requests/:id", async (req, res) => {
  try {
    const updated = await CreatorRequest.findByIdAndUpdate(
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
