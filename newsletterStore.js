/**
 * newsletterStore.js — PDF upload handling for Insights → Newsletter.
 *
 * Same call avatarStore.js already made for profile photos and brand logos:
 * uploads arrive as a data URI in the JSON body (no multipart, so no multer
 * and no new dependency), the size cap is enforced on the DECODED bytes —
 * base64 inflates by ~33%, so checking the string length would reject a
 * legitimate file while letting an oversized one through in the other
 * direction — and express.json's own 5mb body limit sits comfortably above
 * this 2MB cap, catching anything pathological before it reaches here.
 *
 * Differs from an avatar in the one way that matters: a brand keeps every
 * newsletter it's been sent, not just the latest one, so this backs its own
 * collection (NewsletterItem, one document per upload) rather than a single
 * field replaced in place.
 */
export const MAX_NEWSLETTER_BYTES = 2 * 1024 * 1024; // 2MB
const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i;

/**
 * data URI -> { data, contentType, size }. Throws with a human-readable
 * message on anything malformed, wrong-typed or oversized, so callers can
 * pass it straight back as a 400.
 */
export function parseNewsletterFile(dataUri) {
  const m = DATA_URI.exec(String(dataUri || ""));
  if (!m) throw new Error("file must be a base64 data URI");
  const [, contentType, b64] = m;
  if (contentType.toLowerCase() !== "application/pdf")
    throw new Error("Newsletter must be a PDF.");
  const data = Buffer.from(b64, "base64");
  if (!data.length) throw new Error("That PDF is empty.");
  if (data.length > MAX_NEWSLETTER_BYTES)
    throw new Error("Newsletter PDFs must be 2MB or smaller.");
  return { data, contentType: "application/pdf", size: data.length };
}

// Pass to .find() so PDF bytes never load for a history list.
export const OMIT_NEWSLETTER_FILE = { file: 0 };
