// Consultants — Services → Consultant in the internal app (founder only).
//
//   GET    /api/consultants                     every consultant, with document/login counts
//   POST   /api/consultants                     add one
//   GET    /api/consultants/:id                 one consultant
//   PATCH  /api/consultants/:id                 change any section (send only what changed)
//   DELETE /api/consultants/:id                 remove — with their documents and portal logins
//   GET    /api/consultants/:id/documents       their documents (no bytes)
//   POST   /api/consultants/:id/documents       upload { name, filename, file: data URI }
//   GET    /api/consultants/:id/documents/:docId/file
//   DELETE /api/consultants/:id/documents/:docId
//
// Portal logins for consultants are the shared credential routes in
// routes/auth.js (/api/consultant-credentials, /api/auth/consultant-login).
//
// Every field is cleaned here — only known fields are stored, emails, PAN and
// GSTINs are checked, and brand ids must be real brands — so the consultant
// portal can trust what it reads later.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import Consultant from "../models/Consultant.js";
import ConsultantDocument from "../models/ConsultantDocument.js";
import ConsultantCredential from "../models/ConsultantCredential.js";
import Client from "../models/Client.js";
import { toBuffer, withAvatar, serveAvatar, OMIT_AVATAR } from "../avatarStore.js";

const router = Router();

export class BadInput extends Error { constructor(msg) { super(msg); this.status = 400; } }

// ── field checks ────────────────────────────────────────────────────────────
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const TIN = /^[A-Z0-9-]{6,20}$/;

export const str = (v, max = 400) => (v == null ? "" : String(v).trim().slice(0, max));
function email(v, label) {
  const s = str(v, 200).toLowerCase();
  if (s && !EMAIL.test(s)) throw new BadInput(`${label} doesn't look like an email address.`);
  return s;
}
function upperCode(v, re, label, example) {
  const s = str(v, 30).toUpperCase().replace(/\s+/g, "");
  if (s && !re.test(s)) throw new BadInput(`${label} doesn't look right — expected something like ${example}.`);
  return s;
}
const gst = (v, label) => upperCode(v, GSTIN, label, "27AAPFU0939F1ZV (15 characters)");

function person(p, label) {
  if (!p || typeof p !== "object") return {};
  return {
    _id: str(p._id || p.id, 60) || randomUUID(),
    name: str(p.name, 120),
    designation: str(p.designation, 120),
    email: email(p.email, `${label} email`),
    phone: str(p.phone, 30),
  };
}

function ugc(u) {
  if (!u || typeof u !== "object") return null;
  const name = str(u.name, 120), handle = str(u.handle, 120);
  if (!name && !handle) return null;
  const rate = u.rate === "" || u.rate == null ? null : Number(u.rate);
  if (rate != null && (!Number.isFinite(rate) || rate < 0)) throw new BadInput(`Rate for ${name || handle} must be a positive number.`);
  return {
    _id: str(u._id || u.id, 60) || randomUUID(),
    creatorId: str(u.creatorId, 160) || null,
    name, handle,
    platform: str(u.platform, 40),
    rate,
    status: u.status === "paused" ? "paused" : "active",
    notes: str(u.notes, 1000),
    addedAt: u.addedAt ? new Date(u.addedAt) : new Date(),
  };
}

/** The writable fields present in `body`, cleaned. Sections are replaced whole. */
async function clean(body, { creating = false } = {}) {
  const b = body || {};
  const out = {};
  if (creating || "name" in b) {
    out.name = str(b.name, 160);
    if (!out.name) throw new BadInput("Name is required.");
  }
  if ("email" in b) out.email = email(b.email, "Email");
  if ("status" in b) out.status = b.status === "inactive" ? "inactive" : "active";
  if ("billing" in b) {
    const x = b.billing || {};
    out.billing = { gstNumber: gst(x.gstNumber, "GST number"), address: str(x.address, 600), gst: gst(x.gst, "Billing GST"), email: email(x.email, "Billing email") };
  }
  if ("hq" in b) {
    const x = b.hq || {};
    out.hq = { address: str(x.address, 600), gst: gst(x.gst, "HQ GST") };
  }
  if ("tax" in b) {
    const x = b.tax || {};
    out.tax = { tin: upperCode(x.tin, TIN, "TIN", "29123456789 (6–20 letters or digits)"), pan: upperCode(x.pan, PAN, "PAN", "ABCDE1234F") };
  }
  if ("primaryContact" in b) out.primaryContact = person(b.primaryContact, "Primary contact");
  if ("pocs" in b) {
    if (!Array.isArray(b.pocs)) throw new BadInput("POCs must be a list.");
    out.pocs = b.pocs.slice(0, 50).map((p, i) => person(p, `POC ${i + 1}`)).filter((p) => p.name || p.email || p.phone);
  }
  if ("brandIds" in b) {
    if (!Array.isArray(b.brandIds)) throw new BadInput("Brands must be a list.");
    const ids = [...new Set(b.brandIds.map((x) => str(x, 120)).filter(Boolean))];
    const found = ids.length ? await Client.find({ _id: { $in: ids } }, { _id: 1 }).lean() : [];
    const missing = ids.filter((id) => !found.some((f) => f._id === id));
    if (missing.length) throw new BadInput(`Unknown brand${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
    out.brandIds = ids;
  }
  if ("ugcCreators" in b) {
    if (!Array.isArray(b.ugcCreators)) throw new BadInput("UGC creators must be a list.");
    out.ugcCreators = b.ugcCreators.slice(0, 200).map(ugc).filter(Boolean);
  }
  if ("notes" in b) out.notes = str(b.notes, 4000);
  return out;
}

async function nextId() {
  const docs = await Consultant.find({}, { _id: 1 }).lean();
  const max = docs.reduce((m, d) => Math.max(m, Number(/^cs(\d+)$/.exec(d._id)?.[1] || 0)), 0);
  return `cs${max + 1}`;
}

// Photo bytes never travel in JSON — only whether there is one and when it
// changed (the picture is GET /api/consultants/:id/avatar?v=<avatarUpdatedAt>).
export const pub = ({ _id, avatarImage, ...rest }) => ({ id: _id, ...rest, hasAvatar: !!rest.avatarUpdatedAt });
/** Applies an avatarImage from the body (absent = leave, null = remove, data URI = replace). */
export function applyAvatar(target, body, source, by) {
  withAvatar(target, body);
  if ("avatarImage" in (body || {})) {
    target.avatarSource = target.avatarImage ? source : null;
    target.avatarUpdatedBy = target.avatarImage ? (by || null) : null;
  }
  return target;
}
export const fail = (res, err) => res.status(err.status || (err.name === "ValidationError" ? 400 : 500)).json({ error: err.message });

// ── consultants ─────────────────────────────────────────────────────────────
router.get("/api/consultants", async (_req, res) => {
  try {
    const [list, docCounts, loginCounts] = await Promise.all([
      Consultant.find({}, OMIT_AVATAR).sort({ name: 1 }).lean(),
      ConsultantDocument.aggregate([{ $group: { _id: "$consultantId", n: { $sum: 1 } } }]),
      ConsultantCredential.aggregate([{ $match: { deleted: { $ne: true } } }, { $group: { _id: "$consultantId", n: { $sum: 1 } } }]),
    ]);
    const docs = new Map(docCounts.map((d) => [d._id, d.n]));
    const logins = new Map(loginCounts.map((d) => [d._id, d.n]));
    res.json(list.map((c) => ({ ...pub(c), documentCount: docs.get(c._id) || 0, loginCount: logins.get(c._id) || 0 })));
  } catch (err) { fail(res, err); }
});

router.get("/api/consultants/:id", async (req, res) => {
  try {
    const c = await Consultant.findById(req.params.id, OMIT_AVATAR).lean();
    if (!c) return res.status(404).json({ error: "not found" });
    res.json(pub(c));
  } catch (err) { fail(res, err); }
});

router.post("/api/consultants", async (req, res) => {
  try {
    const data = await clean(req.body, { creating: true });
    if (data.email && await Consultant.exists({ email: data.email })) {
      return res.status(409).json({ error: `A consultant with ${data.email} already exists.` });
    }
    try { applyAvatar(data, req.body, "internal", str(req.body.actor, 80)); }
    catch (e) { throw new BadInput(e.message); }
    const created = await Consultant.create({ _id: await nextId(), ...data, createdBy: str(req.body.actor, 80) || null });
    res.status(201).json({ ...pub(created.toObject()), documentCount: 0, loginCount: 0 });
  } catch (err) { fail(res, err); }
});

router.patch("/api/consultants/:id", async (req, res) => {
  try {
    const data = await clean(req.body);
    try { applyAvatar(data, req.body, "internal", str(req.body.actor, 80)); }
    catch (e) { throw new BadInput(e.message); }
    if (!Object.keys(data).length) return res.status(400).json({ error: "Nothing to save." });
    if (data.email && await Consultant.exists({ email: data.email, _id: { $ne: req.params.id } })) {
      return res.status(409).json({ error: `Another consultant already uses ${data.email}.` });
    }
    const updated = await Consultant.findByIdAndUpdate(req.params.id, { $set: { ...data, updatedBy: str(req.body.actor, 80) || null } }, { new: true, runValidators: true, projection: OMIT_AVATAR }).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(pub(updated));
  } catch (err) { fail(res, err); }
});

router.delete("/api/consultants/:id", async (req, res) => {
  try {
    const gone = await Consultant.findByIdAndDelete(req.params.id);
    if (!gone) return res.status(404).json({ error: "not found" });
    // Their files and portal logins go with them — a login for a consultant
    // that no longer exists must not keep working.
    const [docs, creds] = await Promise.all([
      ConsultantDocument.deleteMany({ consultantId: req.params.id }),
      ConsultantCredential.deleteMany({ consultantId: req.params.id }),
    ]);
    res.json({ ok: true, documents: docs.deletedCount, logins: creds.deletedCount });
  } catch (err) { fail(res, err); }
});

// The picture itself — public like every other avatar route (users, brands),
// cached immutably and busted by ?v=<avatarUpdatedAt>.
router.get("/api/consultants/:id/avatar", serveAvatar(Consultant));

// ── documents ───────────────────────────────────────────────────────────────
// PDFs, images, Word/Excel, CSV and text — up to 3MB each (the request body
// limit is 5MB and base64 adds a third).
export const MAX_DOC_BYTES = 3 * 1024 * 1024;
export const DOC_TYPES = new Map([
  ["application/pdf", "PDF"],
  ["image/png", "PNG"], ["image/jpeg", "JPEG"], ["image/webp", "WebP"],
  ["application/msword", "Word"], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word"],
  ["application/vnd.ms-excel", "Excel"], ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Excel"],
  ["text/csv", "CSV"], ["text/plain", "Text"],
]);
const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i;

export function parseUpload(uri) {
  const m = DATA_URI.exec(String(uri || ""));
  if (!m) throw new BadInput("Pick a file to upload.");
  const type = m[1].toLowerCase();
  if (!DOC_TYPES.has(type)) throw new BadInput("That file type isn't supported — use PDF, an image (PNG/JPEG/WebP), Word, Excel, CSV or text.");
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw new BadInput("That file is empty.");
  if (data.length > MAX_DOC_BYTES) throw new BadInput("Files must be 3MB or smaller.");
  return { data, contentType: type, size: data.length };
}

export const docPub = ({ _id, consultantId, file, ...rest }) => ({ id: _id, ...rest, type: DOC_TYPES.get(file?.contentType) || null, size: file?.size || null });
const docScope = (req) => ({ _id: req.params.docId, consultantId: req.params.id });

router.get("/api/consultants/:id/documents", async (req, res) => {
  try {
    const docs = await ConsultantDocument.find({ consultantId: req.params.id }, { "file.data": 0 }).sort({ uploadedAt: -1 }).lean();
    res.json(docs.map(docPub));
  } catch (err) { fail(res, err); }
});

router.post("/api/consultants/:id/documents", async (req, res) => {
  try {
    if (!(await Consultant.exists({ _id: req.params.id }))) return res.status(404).json({ error: "consultant not found" });
    const name = str(req.body?.name, 160);
    if (!name) throw new BadInput("Give the document a name.");
    const file = parseUpload(req.body?.file);
    const created = await ConsultantDocument.create({
      _id: randomUUID(), consultantId: req.params.id, name,
      filename: str(req.body?.filename, 200) || name, file,
      uploadedBy: str(req.body?.uploadedBy, 80) || null, uploadedAt: new Date(), source: "internal",
    });
    res.status(201).json(docPub(created.toObject()));
  } catch (err) { fail(res, err); }
});

/** Writes a stored document out (PDFs and images open in the browser; the rest download). */
export function sendDocument(res, doc, download) {
  const bytes = toBuffer(doc?.file?.data);
  if (!bytes) return res.status(404).json({ error: "not found" });
  const fname = String(doc.filename || doc.name || "document").replace(/[^\w.\- ]+/g, "").trim() || "document";
  res.set("Content-Type", doc.file.contentType || "application/octet-stream");
  const inline = /^(application\/pdf|image\/)/.test(doc.file.contentType || "") && !download;
  res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${fname}"`);
  res.send(bytes);
}

router.get("/api/consultants/:id/documents/:docId/file", async (req, res) => {
  try {
    sendDocument(res, await ConsultantDocument.findOne(docScope(req)).lean(), req.query.download === "1");
  } catch (err) { fail(res, err); }
});

router.delete("/api/consultants/:id/documents/:docId", async (req, res) => {
  try {
    const { deletedCount } = await ConsultantDocument.deleteOne(docScope(req));
    if (!deletedCount) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (err) { fail(res, err); }
});

export default router;
