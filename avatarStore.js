/**
 * avatarStore.js — profile-photo handling shared by every collection that can
 * carry one: `users` and `brand_credentials` (routes/auth.js) and `clients`
 * (server.js, where the photo is the brand's logo).
 *
 * ── Why photos live on the document ─────────────────────────────────────────
 * The image is downscaled to 256px and re-encoded client-side before it is
 * uploaded (see 5th-internal-front src/lib/avatar.js), so a stored photo is
 * ~20-30KB. At that size an inline field beats both a separate collection and
 * GridFS: no join, no second round trip, no orphan cleanup when a record is
 * hard-deleted — the photo goes with it. Every schema here is `strict: false`,
 * so this needed no migration.
 *
 * The one thing that inline storage gets wrong is LIST weight, and that is
 * handled explicitly rather than accepted: every list query projects the bytes
 * away ({ avatarImage: 0 }) and the image is served from its own cacheable
 * route. See serveAvatar below.
 */

// Uploads arrive as a data URI in the JSON body (no multipart, so no multer and
// no new dependency).
//
// The cap is enforced on the DECODED bytes, not the string length. Base64
// inflates by ~33%, so checking the string would have rejected a legitimate
// 1.6MB image while letting nothing bigger through — the wrong number in both
// directions. express.json's own limit sits above this and catches anything
// pathological before it reaches here.
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2MB
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i;

/**
 * data URI -> { data, contentType }, or null to CLEAR the photo.
 * Throws with a human-readable message on anything malformed or oversized, so
 * callers can pass it straight back as a 400.
 */
export function parseAvatar(dataUri) {
  if (dataUri === null || dataUri === "") return null;
  const m = DATA_URI.exec(String(dataUri));
  if (!m) throw new Error("avatarImage must be a base64 data URI");
  const [, contentType, b64] = m;
  if (!AVATAR_TYPES.has(contentType.toLowerCase()))
    throw new Error("Profile photo must be a PNG, JPEG or WebP image.");
  const data = Buffer.from(b64, "base64");
  if (!data.length) throw new Error("Profile photo is empty.");
  if (data.length > MAX_AVATAR_BYTES)
    throw new Error("Profile photo must be 2MB or smaller.");
  return { data, contentType: contentType.toLowerCase() };
}

/**
 * Applies an `avatarImage` field from a request body onto an update/create
 * object. The three-way distinction is load-bearing on a PATCH:
 *   absent    — leave the existing photo alone
 *   null / "" — remove it
 *   data URI  — replace it
 * Collapsing the first two is what would make an unrelated edit wipe a photo.
 */
export function withAvatar(target, body) {
  if (!body || !("avatarImage" in body)) return target;
  const parsed = parseAvatar(body.avatarImage);
  target.avatarImage = parsed;
  target.avatarUpdatedAt = parsed ? new Date() : null;
  return target;
}

// Mongoose schema fragment, so the three models declare the same shape.
export const AVATAR_FIELDS = {
  avatarImage: { data: Buffer, contentType: String },
  // Bumped on every write, cleared on removal. Two jobs: it is the witness for
  // "has a photo" in list responses that projected the bytes away, and clients
  // put it in the avatar URL's query string so a replaced photo busts the
  // browser cache immediately.
  avatarUpdatedAt: Date,
};

// Pass to .find()/.findById() so photo bytes never load for a list or a login.
export const OMIT_AVATAR = { avatarImage: 0 };

/**
 * Normalises whatever Mongo hands back for a Buffer path into a real Node
 * Buffer, or null when there is nothing there.
 *
 * This exists because the answer differs by read style, and getting it wrong
 * fails SILENTLY:
 *
 *   hydrated  -> Node Buffer. Fine as-is.
 *   .lean()   -> the driver's `Binary` wrapper. Its `.length` is a METHOD, not
 *                a number, so the obvious `!img.data.length` guard is truthy
 *                for an absent image; and `Buffer.from(binary)` returns an
 *                EMPTY buffer rather than throwing. Together those produce a
 *                200 response with the correct Content-Type and zero bytes —
 *                which renders as a broken image instead of falling back to
 *                initials. The real bytes are on `.buffer`.
 *   JSON round -> `{ type: "Buffer", data: [...] }`, if a doc ever arrives
 *                that way.
 *
 * Exported because it is not avatar-specific: portalReels stores reel posters
 * as the same { data, contentType } pair and its route reads them the same
 * `.lean()` way, so it inherits the identical trap. One implementation means
 * the next collection to store bytes cannot rediscover the bug.
 *
 * Handling all three here is also what lets serveAvatar stay on `.lean()`,
 * which it must: models/Client.js declares a schema path named `init`, and
 * `init` is a reserved Mongoose name (Document.prototype.init drives
 * hydration). Hydrating any Client document therefore throws
 * "Cannot read properties of undefined (reading 'Symbol(mongoose#Document#scope)')".
 * Every other Client read in this codebase happens to use .lean(), which skips
 * hydration, so the clash has never surfaced — but a non-lean read here would
 * have made brand logos a guaranteed 500.
 */
export function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  // driver Binary
  if (Buffer.isBuffer(value.buffer)) return value.buffer.length ? value.buffer : null;
  // JSON-serialised buffer
  if (value.type === "Buffer" && Array.isArray(value.data))
    return value.data.length ? Buffer.from(value.data) : null;
  return null;
}

/**
 * Express handler factory for GET …/:id/avatar.
 *
 * Cached immutably for a year and read through `?v=<avatarUpdatedAt>`: the URL
 * changes the instant the photo does, so a stale image is impossible despite
 * the long max-age.
 */
export function serveAvatar(Model) {
  return async (req, res) => {
    try {
      const doc = await Model.findById(req.params.id, { avatarImage: 1 }).lean();
      const bytes = toBuffer(doc?.avatarImage?.data);
      if (!bytes) return res.status(404).json({ error: "no profile photo set" });
      res.set("Content-Type", doc.avatarImage.contentType || "image/jpeg");
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.send(bytes);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}
