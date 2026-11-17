// The consultant portal's API — what a signed-in consultant can see and do.
//
//   GET    /api/consultant-portal/me                     their record (no internal notes), brands, who's signed in
//   PUT    /api/consultant-portal/avatar                 { avatarImage } — their profile picture (null removes it)
//   GET    /api/consultant-portal/documents              every document on their record
//   POST   /api/consultant-portal/documents              upload { name, filename, file }
//   GET    /api/consultant-portal/documents/:docId/file  open / ?download=1
//   DELETE /api/consultant-portal/documents/:docId       only ones they uploaded themselves
//
// Every call needs the token from POST /api/auth/consultant-login
// (Authorization: Bearer …, or ?t=… on a link the browser opens). The token
// fixes WHICH consultant, so nothing here takes a consultant id from the
// caller. A login that was removed, or a consultant set inactive, stops
// working at once.
//
// Whatever the consultant changes here lands on the same record the internal
// team sees in Services → Consultant (picture, documents) — and the other way
// round.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import Consultant from "../models/Consultant.js";
import ConsultantDocument from "../models/ConsultantDocument.js";
import ConsultantCredential from "../models/ConsultantCredential.js";
import Client from "../models/Client.js";
import { OMIT_AVATAR } from "../avatarStore.js";
import { readToken } from "../consultantToken.js";
import { BadInput, str, fail, pub, applyAvatar, parseUpload, docPub, sendDocument } from "./consultants.js";

const router = Router();

// Fields the team keeps for itself — never sent to the portal.
const INTERNAL_ONLY = ["notes", "createdBy", "updatedBy", "avatarUpdatedBy"];

async function signedIn(req, res, next) {
  try {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "")?.[1];
    const t = readToken(bearer || req.query.t);
    if (!t) return res.status(401).json({ error: "Please sign in again." });
    const [cred, consultant] = await Promise.all([
      ConsultantCredential.findOne({ _id: t.credentialId, consultantId: t.consultantId, deleted: { $ne: true } }, { name: 1, username: 1, title: 1 }).lean(),
      Consultant.findById(t.consultantId, { _id: 1, name: 1, status: 1 }).lean(),
    ]);
    if (!cred || !consultant || consultant.status === "inactive") {
      return res.status(401).json({ error: "This login is no longer active — contact Fifth Avenue." });
    }
    req.cred = cred;
    req.consultantId = consultant._id;
    next();
  } catch (err) { fail(res, err); }
}
router.use("/api/consultant-portal", signedIn);

async function view(consultantId, cred) {
  const c = await Consultant.findById(consultantId, OMIT_AVATAR).lean();
  const out = pub(c);
  for (const k of INTERNAL_ONLY) delete out[k];
  const brands = c.brandIds?.length
    ? await Client.find({ _id: { $in: c.brandIds } }, { name: 1, website: 1, avatarUpdatedAt: 1 }).lean()
    : [];
  out.brands = (c.brandIds || []).map((id) => brands.find((b) => b._id === id)).filter(Boolean)
    .map((b) => ({ id: b._id, name: b.name, website: b.website || null, hasLogo: !!b.avatarUpdatedAt, logoUpdatedAt: b.avatarUpdatedAt || null }));
  out.signedInAs = { id: cred._id, name: cred.name || null, email: cred.username || null, title: cred.title || null };
  return out;
}

router.get("/api/consultant-portal/me", async (req, res) => {
  try { res.json(await view(req.consultantId, req.cred)); } catch (err) { fail(res, err); }
});

router.put("/api/consultant-portal/avatar", async (req, res) => {
  try {
    if (!("avatarImage" in (req.body || {}))) throw new BadInput("Pick a picture to upload.");
    const set = {};
    try { applyAvatar(set, req.body, "portal", `${req.cred.name || req.cred.username} (consultant)`); }
    catch (e) { throw new BadInput(e.message); }
    await Consultant.updateOne({ _id: req.consultantId }, { $set: set });
    res.json(await view(req.consultantId, req.cred));
  } catch (err) { fail(res, err); }
});

router.get("/api/consultant-portal/documents", async (req, res) => {
  try {
    const docs = await ConsultantDocument.find({ consultantId: req.consultantId }, { "file.data": 0 }).sort({ uploadedAt: -1 }).lean();
    res.json(docs.map(docPub));
  } catch (err) { fail(res, err); }
});

router.post("/api/consultant-portal/documents", async (req, res) => {
  try {
    const name = str(req.body?.name, 160);
    if (!name) throw new BadInput("Give the document a name.");
    const file = parseUpload(req.body?.file);
    const created = await ConsultantDocument.create({
      _id: randomUUID(), consultantId: req.consultantId, name,
      filename: str(req.body?.filename, 200) || name, file,
      uploadedBy: req.cred.name || req.cred.username, uploadedAt: new Date(), source: "portal",
    });
    res.status(201).json(docPub(created.toObject()));
  } catch (err) { fail(res, err); }
});

router.get("/api/consultant-portal/documents/:docId/file", async (req, res) => {
  try {
    sendDocument(res, await ConsultantDocument.findOne({ _id: req.params.docId, consultantId: req.consultantId }).lean(), req.query.download === "1");
  } catch (err) { fail(res, err); }
});

router.delete("/api/consultant-portal/documents/:docId", async (req, res) => {
  try {
    const doc = await ConsultantDocument.findOne({ _id: req.params.docId, consultantId: req.consultantId }, { source: 1 }).lean();
    if (!doc) return res.status(404).json({ error: "not found" });
    // Documents the team filed (agreements, certificates) stay; a consultant
    // can only take back what they uploaded themselves.
    if (doc.source !== "portal") return res.status(403).json({ error: "Only Fifth Avenue can remove this document." });
    await ConsultantDocument.deleteOne({ _id: doc._id });
    res.status(204).end();
  } catch (err) { fail(res, err); }
});

export default router;
