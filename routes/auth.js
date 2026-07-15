// Auth routes — internal user + brand-portal credential management.
// Passwords are hashed (sha256) into `hashKey` before storage; the plaintext
// never touches the DB. Login endpoints compare hashes. The founder-only
// Auth page in 5th-internal-front manages both collections via the CRUD
// routes below (soft delete, like campaigns).
import { Router } from "express";
import crypto from "node:crypto";
import User from "../models/User.js";
import BrandCredential from "../models/BrandCredential.js";
import Client from "../models/Client.js";

const router = Router();

export const hashPassword = (pw) =>
  crypto.createHash("sha256").update(String(pw)).digest("hex");

const safe = ({ _id, hashKey, deleted, deletedAt, ...rest }) => ({ id: _id, ...rest });

// Shared login handler: verify email + password hash against a collection.
function loginHandler(Model, extra = () => ({})) {
  return async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password)
        return res.status(400).json({ error: "email and password are required" });
      const doc = await Model.findOne({
        username: String(email).toLowerCase().trim(),
        deleted: { $ne: true },
      }).lean();
      if (!doc || doc.hashKey !== hashPassword(password))
        return res.status(401).json({ error: "Invalid email or password." });
      res.json({ ok: true, user: { ...safe(doc), email: doc.username, ...extra(doc) } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// POST /api/auth/login — internal platform login ({ email, password }).
router.post("/api/auth/login", loginHandler(User));

// POST /api/auth/portal-login — client-portal (brand) login. Resolves
// brandId -> the real Client document and returns clientName, so the portal
// scopes every subsequent query (/api/portal/campaigns?client=clientName) to
// exactly the client this credential belongs to — never a hardcoded name.
// A credential whose brandId doesn't resolve to a real Client fails closed
// (401) rather than falling back to any default, so a newly-created brand
// with no client doc yet can't accidentally see someone else's data.
router.post("/api/auth/portal-login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: "email and password are required" });
    const doc = await BrandCredential.findOne({
      username: String(email).toLowerCase().trim(),
      deleted: { $ne: true },
    }).lean();
    if (!doc || doc.hashKey !== hashPassword(password))
      return res.status(401).json({ error: "Invalid email or password." });
    const client = await Client.findById(doc.brandId).lean();
    if (!client)
      return res.status(401).json({ error: "This login isn't linked to an active client yet." });
    res.json({ ok: true, user: { ...safe(doc), email: doc.username, brandId: doc.brandId, clientName: client.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CRUD factory for the two credential collections. Same shape as server.js's
// registerCrudRoutes but: password → hashKey on create/update, DELETE is a
// soft delete (?actor= recorded), and lists hide deleted docs unless
// ?includeDeleted=1 (the Auth page's "show removed" toggle). hashKey IS
// returned in lists — it's what the founder Auth page displays in place of
// the unrecoverable password.
function registerAuthCrudRoutes(basePath, Model) {
  router.get(basePath, async (req, res) => {
    try {
      const q = req.query.includeDeleted === "1" ? {} : { deleted: { $ne: true } };
      if (req.query.brandId) q.brandId = req.query.brandId;
      const docs = await Model.find(q).lean();
      res.json(docs.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post(basePath, async (req, res) => {
    try {
      const { password, ...body } = req.body;
      if (!body.id) return res.status(400).json({ error: "id is required" });
      if (!body.username) return res.status(400).json({ error: "username is required" });
      if (!password) return res.status(400).json({ error: "password is required" });
      body.username = String(body.username).toLowerCase().trim();
      const clash = await Model.findOne({ username: body.username, deleted: { $ne: true } }).lean();
      if (clash) return res.status(409).json({ error: "username already exists" });
      const doc = await Model.create({ ...body, _id: body.id, hashKey: hashPassword(password) });
      const { _id, ...rest } = doc.toObject();
      res.status(201).json({ id: _id, ...rest });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch(`${basePath}/:id`, async (req, res) => {
    try {
      const { password, ...patch } = req.body;
      if (patch.username) patch.username = String(patch.username).toLowerCase().trim();
      if (password) patch.hashKey = hashPassword(password);
      const updated = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: patch },
        { new: true }
      ).lean();
      if (!updated) return res.status(404).json({ error: "not found" });
      const { _id, ...rest } = updated;
      res.json({ id: _id, ...rest });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Soft delete — doc stays in Mongo (deleted:true) so it can be restored;
  // login and default lists both exclude it.
  router.delete(`${basePath}/:id`, async (req, res) => {
    try {
      await Model.findByIdAndUpdate(req.params.id, {
        $set: { deleted: true, deletedAt: new Date(), deletedBy: req.query.actor || "Unknown" },
      });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

registerAuthCrudRoutes("/api/users", User);
registerAuthCrudRoutes("/api/brand-credentials", BrandCredential);

export default router;
