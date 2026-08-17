// Client requests — the founder's inbox of brand signups from the public
// "Start a project" landing page (hosted separately; it POSTs here).
//
//   POST   /api/client-requests      public — landing page submits a signup
//   GET    /api/client-requests      founder tab — newest first
//   DELETE /api/client-requests/:id  founder tab — once credentials are generated
//
// On a new signup we notify the founder by email (Resend) fire-and-forget:
// the response returns as soon as the row is saved, and any email failure is
// logged, never surfaced to the caller (see mailer.js).
import { Router } from "express";
import ClientRequest from "../models/ClientRequest.js";
import { sendFounderEmail } from "../mailer.js";
import { pub, nextSeqId } from "./requestInbox.js";

const router = Router();

// Sequential ids: "cr1", "cr2", … — see requestInbox.js.
const nextId = () => nextSeqId(ClientRequest, "cr");

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
    const docs = await ClientRequest.find({}).sort({ createdAt: -1 }).lean();
    res.json(docs.map(pub));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/client-requests/:id — founder tab, once a BrandCredential login
// has been generated for this lead. Same reasoning as the creator-requests
// promote flow: the request has done its job (produced a login), so it's
// removed rather than kept around retitled "contacted".
router.delete("/api/client-requests/:id", async (req, res) => {
  try {
    const deleted = await ClientRequest.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
