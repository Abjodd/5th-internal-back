// Creator requests — the founder's inbox of creator applications from the
// public "Apply as a creator" landing page (hosted separately; it POSTs here).
//
//   POST  /api/creator-requests              public — landing page submits an application
//   GET   /api/creator-requests              founder tab — newest first
//   PATCH /api/creator-requests/:id          founder tab — triage status
//   GET   /api/creator-requests/:id/promote  founder tab — dry run: would this collide?
//   POST  /api/creator-requests/:id/promote  founder tab — write into the directory
//
// Mirrors routes/clientRequests.js: on a new application we notify the founder
// by email (Resend) fire-and-forget — the response returns as soon as the row
// is saved, and any email failure is logged, never surfaced (see mailer.js).
import { Router } from "express";
import CreatorRequest from "../models/CreatorRequest.js";
import Creator from "../models/Creator.js";
import { keyOf } from "../creatorSync.js";
import { sendCreatorApplicationEmail } from "../mailer.js";
import { pub, nextSeqId } from "./requestInbox.js";
import { OMIT_AVATAR } from "../avatarStore.js";

const router = Router();

// Sequential ids: "crq1", "crq2", … — see requestInbox.js.
const nextId = () => nextSeqId(CreatorRequest, "crq");

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

// DELETE /api/creator-requests/:id — founder tab, dismissing an application
// that isn't going anywhere. Promoting one already removes it (see below);
// this is the other ending, for applications that are never going to be
// promoted and would otherwise sit in the inbox forever.
router.delete("/api/creator-requests/:id", async (req, res) => {
  try {
    const deleted = await CreatorRequest.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Promote an application into the creators directory ──────────────────────
// The directory keys creators by `keyOf` (lower-cased handle, else name), the
// same key creatorSync.js uses when splitting campaign creators out — so a
// promoted application lands on exactly the row a future campaign would
// resolve to, rather than creating a near-duplicate.
//
// Field mapping is mostly one-to-one because CreatorRequest was modelled to
// mirror Creator. The two that aren't:
//   · niche  — [String] on the request, String on the directory (joined)
//   · email  — top-level on the request, personalDetails.email on the directory
// `languages` stays an array on both sides — it used to be dropped here, which
// silently discarded the one piece of information only the creator can tell us.

function creatorFromRequest(reqDoc) {
  return {
    name: reqDoc.name || "",
    handle: reqDoc.handle || "",
    platform: reqDoc.platform || "",
    followers: reqDoc.followers || "",
    niche: Array.isArray(reqDoc.niche) ? reqDoc.niche.join(", ") : reqDoc.niche || "",
    languages: Array.isArray(reqDoc.languages) ? reqDoc.languages : [],
    state: reqDoc.state || "",
    phone: reqDoc.phone || "",
    ...(reqDoc.email ? { personalDetails: { email: reqDoc.email } } : {}),
    // Provenance: this row came from a public application rather than from a
    // campaign's creator list. Useful for filtering the directory later, and
    // it records that the profile has not yet been verified against any
    // delivered work.
    source: "application",
  };
}

// GET — dry run. Lets the founder tab show a real confirmation ("this will
// create X" / "X already exists") before anything is written.
router.get("/api/creator-requests/:id/promote", async (req, res) => {
  try {
    const doc = await CreatorRequest.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: "not found" });

    const key = keyOf(doc);
    if (!key) return res.status(400).json({ error: "application has no handle or name to key on" });

    const existing = await Creator.findById(key, OMIT_AVATAR).lean();
    res.json({
      key,
      exists: !!existing,
      alreadyPromoted: !!doc.creatorId,
      existing: existing ? { id: existing._id, name: existing.name, handle: existing.handle } : null,
      preview: creatorFromRequest(doc),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST — write it. Refuses to clobber an existing directory row unless the
// caller explicitly passes { overwrite: true }, so the confirm step in the UI
// is a real gate rather than decoration.
router.post("/api/creator-requests/:id/promote", async (req, res) => {
  try {
    const doc = await CreatorRequest.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: "not found" });

    const key = keyOf(doc);
    if (!key) return res.status(400).json({ error: "application has no handle or name to key on" });

    const existing = await Creator.findById(key, OMIT_AVATAR).lean();
    if (existing && !req.body?.overwrite) {
      return res.status(409).json({
        error: "A creator with this handle is already in the directory.",
        key,
        existing: { id: existing._id, name: existing.name, handle: existing.handle },
      });
    }

    const fields = creatorFromRequest(doc);
    // Merge rather than replace personalDetails, matching creatorSync.js — an
    // overwrite must not wipe bank/PAN details the directory already holds.
    if (existing?.personalDetails || fields.personalDetails) {
      fields.personalDetails = { ...(existing?.personalDetails || {}), ...(fields.personalDetails || {}) };
    }

    await Creator.updateOne({ _id: key }, { $set: fields }, { upsert: true });
    // Projected: this doc goes straight out in the response below, and the
    // photo bytes have no business on that wire.
    const creator = await Creator.findById(key, OMIT_AVATAR).lean();

    // The application has done its job — it produced (or updated) this
    // directory row — so it's removed rather than kept around retitled.
    // The directory row itself now carries `source: "application"` for
    // provenance, so promotion is traceable without keeping a duplicate
    // record in two collections.
    await CreatorRequest.findByIdAndDelete(req.params.id);

    res.status(existing ? 200 : 201).json({
      ok: true,
      overwrote: !!existing,
      creator: { ...creator, id: creator._id },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
