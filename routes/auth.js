// Auth routes — internal user + brand-portal credential management.
// Passwords are stored two ways, never as plaintext:
//   hashKey — sha256(password); what login verifies against.
//   passKey — AES-256-GCM encrypted copy, so the founder-only Auth page can
//             reveal the actual password via GET …/:id/password. Encryption
//             key derives from AUTH_SECRET (falls back to MONGO_URI in dev).
// The founder-only Auth page in 5th-internal-front manages both collections
// via the CRUD routes below (hard delete — removed logins free their id).
import { Router } from "express";
import crypto from "node:crypto";
import User from "../models/User.js";
import BrandCredential from "../models/BrandCredential.js";
import Client from "../models/Client.js";

const router = Router();

export const hashPassword = (pw) =>
  crypto.createHash("sha256").update(String(pw)).digest("hex");

// ── Reversible password copy (founder reveal) ───────────────────────────────
const ENC_KEY = crypto
  .createHash("sha256")
  .update(process.env.AUTH_SECRET || process.env.MONGO_URI || "5th-avenue-dev")
  .digest();

export function encryptPassword(pw) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(pw), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${enc.toString("hex")}`;
}

export function decryptPassword(passKey) {
  const [iv, tag, data] = String(passKey).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
}

// Both secrets stay server-side: no response ever includes hashKey/passKey.
// pub() keeps the soft-delete bookkeeping (the Auth page's "show removed"
// toggle renders it); safe() additionally drops it for login responses.
const pub  = ({ _id, hashKey, passKey, ...rest }) => ({ id: _id, ...rest });
const safe = (doc) => { const { deleted, deletedAt, ...rest } = pub(doc); return rest; };

// Sequential ids in the seed format — "u10" after "u9", "bc3" after "bc2",
// "t9" after "t8" (teamId links auth users to the amId/cmId/eaId slots
// campaigns store) — assigned server-side when the client doesn't send one.
async function nextInSequence(Model, prefix, field = "_id") {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const docs = await Model.find({}, { [field]: 1 }).lean();
  const max = docs.reduce((m, d) => {
    const match = pattern.exec(d[field] || "");
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `${prefix}${max + 1}`;
}
const ID_PREFIX = new Map([[User, "u"], [BrandCredential, "bc"]]);

// Shared login handler: verify email + password hash against a collection.
// `extra` may be async and enriches the response; returning null/undefined
// fails the login closed (401) — e.g. a portal credential whose brand isn't
// linked to a real client must not fall back to any default.
function loginHandler(Model, extra = () => ({}), unlinkedError) {
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
      const extraFields = await extra(doc);
      if (!extraFields)
        return res.status(401).json({ error: unlinkedError || "Invalid email or password." });
      res.json({ ok: true, user: { ...safe(doc), email: doc.username, ...extraFields } });
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
router.post("/api/auth/portal-login", loginHandler(
  BrandCredential,
  async (doc) => {
    const client = await Client.findById(doc.brandId).lean();
    return client && { brandId: doc.brandId, clientName: client.name };
  },
  "This login isn't linked to an active client yet."
));

// CRUD factory for the two credential collections. Same shape as server.js's
// registerCrudRoutes but: password → hashKey + encrypted passKey on
// create/update, and DELETE is a hard delete (keeps the u*/bc* id sequence
// consistent). Responses go through pub() — secrets never leave in bulk;
// reveal is per-record below.
function registerAuthCrudRoutes(basePath, Model) {
  router.get(basePath, async (req, res) => {
    try {
      // deleted-filter kept only for legacy soft-deleted docs that may still
      // exist in the DB; new removals are hard deletes (see DELETE below).
      const q = { deleted: { $ne: true } };
      if (req.query.brandId) q.brandId = req.query.brandId;
      const docs = await Model.find(q).lean();
      res.json(docs.map(pub));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post(basePath, async (req, res) => {
    try {
      const { password, ...body } = req.body;
      if (!body.username) return res.status(400).json({ error: "username is required" });
      if (!password) return res.status(400).json({ error: "password is required" });
      body.username = String(body.username).toLowerCase().trim();
      const clash = await Model.findOne({ username: body.username, deleted: { $ne: true } }).lean();
      if (clash) return res.status(409).json({ error: "username already exists" });
      const id = body.id || await nextInSequence(Model, ID_PREFIX.get(Model) || "");
      if (Model === User && !body.teamId) body.teamId = await nextInSequence(User, "t", "teamId");
      const doc = await Model.create({
        ...body,
        _id: id,
        hashKey: hashPassword(password),
        passKey: encryptPassword(password),
      });
      res.status(201).json(pub(doc.toObject()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch(`${basePath}/:id`, async (req, res) => {
    try {
      const { password, ...patch } = req.body;
      if (patch.username) patch.username = String(patch.username).toLowerCase().trim();
      if (password) {
        patch.hashKey = hashPassword(password);
        patch.passKey = encryptPassword(password);
      }
      const updated = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: patch },
        { new: true }
      ).lean();
      if (!updated) return res.status(404).json({ error: "not found" });
      res.json(pub(updated));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET …/:id/password — decrypt the stored passKey so the founder's Auth
  // page can show the actual password. The DB itself only ever holds
  // hashKey + the encrypted passKey. (Founder-gating is client-side, like
  // every other route here — see the auth gap in the codebase docs.)
  router.get(`${basePath}/:id/password`, async (req, res) => {
    try {
      const doc = await Model.findById(req.params.id).lean();
      if (!doc) return res.status(404).json({ error: "not found" });
      if (!doc.passKey)
        return res.status(404).json({ error: "No recoverable password stored — set a new password to enable reveal." });
      res.json({ id: doc._id, password: decryptPassword(doc.passKey) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Hard delete — the doc is removed from Mongo entirely so the id sequence
  // (u1, u2, … via nextInSequence) stays consistent and freed ids are reused.
  router.delete(`${basePath}/:id`, async (req, res) => {
    try {
      const deleted = await Model.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "not found" });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

registerAuthCrudRoutes("/api/users", User);
registerAuthCrudRoutes("/api/brand-credentials", BrandCredential);

export default router;
