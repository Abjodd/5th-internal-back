// Career requests — the founder's inbox of job applications from the public
// Careers page's "Tell us about you" form (client portal; it POSTs here).
//
//   POST   /api/career-requests      public — careers page submits an application
//   GET    /api/career-requests      founder tab — newest first
//   PATCH  /api/career-requests/:id  founder tab — triage status
//   DELETE /api/career-requests/:id  founder tab — once the application is done with
//
// Mirrors routes/creatorRequests.js: on a new application we notify the founder
// by email (Resend) fire-and-forget — the response returns as soon as the row
// is saved, and any email failure is logged, never surfaced (see mailer.js).
//
// There is no "promote" step like creator requests have. A creator application
// has a directory to graduate into (models/Creator.js); a job application has
// no equivalent collection — hiring happens outside the platform — so triage
// here ends at a status, and the row is deleted when it's served its purpose.
import { Router } from "express";
import CareerRequest from "../models/CareerRequest.js";
import { sendCareerApplicationEmail } from "../mailer.js";
import { pub, nextSeqId } from "./requestInbox.js";

const router = Router();

// Sequential ids: "car1", "car2", … — see requestInbox.js.
const nextId = () => nextSeqId(CareerRequest, "car");

// POST /api/career-requests — public careers-page submission.
router.post("/api/career-requests", async (req, res) => {
  try {
    const { name, email } = req.body || {};
    // Email is required, not merely one of several contacts: the careers form
    // collects no phone, so without it the application is unactionable.
    if (!name || !email)
      return res.status(400).json({ error: "name and email are required" });

    const doc = await CareerRequest.create({
      _id: await nextId(),
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      roleId: req.body.roleId || "general",
      roleTitle: req.body.roleTitle || "",
      link: req.body.link || "",
      note: req.body.note || "",
      status: "new",
    });

    const request = pub(doc.toObject());
    // Fire-and-forget: don't block the application on the email round-trip, and
    // never fail the request if the mail provider is down / unconfigured.
    sendCareerApplicationEmail(request);
    res.status(201).json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/career-requests — founder inbox, newest application first.
router.get("/api/career-requests", async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    const docs = await CareerRequest.find(q).sort({ createdAt: -1 }).lean();
    res.json(docs.map(pub));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/career-requests/:id — triage (status changes from the founder tab).
router.patch("/api/career-requests/:id", async (req, res) => {
  try {
    const updated = await CareerRequest.findByIdAndUpdate(
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

// DELETE /api/career-requests/:id — founder tab, once the application has been
// dealt with outside the platform. Same reasoning as the client-request delete:
// the row has done its job, so it's removed rather than kept forever archived.
router.delete("/api/career-requests/:id", async (req, res) => {
  try {
    const deleted = await CareerRequest.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
