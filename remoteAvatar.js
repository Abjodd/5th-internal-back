/**
 * remoteAvatar.js — capture a platform image ONCE, as bytes we own.
 *
 * Two callers, one rule: a creator's profile photo (routes/creators.js,
 * creatorSync.js) and a reel's poster frame (portalReels.js). Both are handed a
 * signed CDN link by the platform and both need it to still work next year.
 *
 * ── Why we copy the bytes instead of storing the URL ────────────────────────
 * A platform profile-picture URL is not a permanent address. Instagram's CDN
 * signs every one of them: `oh=` is a signature and `oe=` is a hex expiry
 * timestamp, and past that moment the CDN answers 403 for everyone. A shared
 * Instagram post looks permanent because an embed is an iframe pointing back at
 * instagram.com, which re-resolves a fresh signed URL server-side on every
 * render — the permanence lives in their renderer, not in the link. All we are
 * handed is the signed link.
 *
 * Copying the bytes is the right shape even setting expiry aside: it survives
 * the CDN refusing to be hotlinked, rate limits, the creator's account going
 * private, and the creator deleting the photo. After the copy the image is
 * ours, served from our own cacheable route like every other avatar in the app.
 *
 * The photo is captured once and then left alone — a creator's picture is not
 * live data. It is re-captured only when someone re-runs the platform Fetch,
 * which is also the moment a changed picture would be noticed.
 *
 * ── Why the allowlist is not optional ───────────────────────────────────────
 * This takes a URL from a request body and makes the SERVER fetch it, which is
 * server-side request forgery in its textbook form: unguarded, `avatarSourceUrl`
 * of "http://169.254.169.254/…" turns this endpoint into a reader for cloud
 * instance metadata, and "http://localhost:27017" into a port scanner. Only
 * hostnames on the platform CDNs below are ever fetched.
 */
import { MAX_AVATAR_BYTES } from "./avatarStore.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TIMEOUT_MS = 8000;

// Suffix-matched against the hostname, on a dot boundary so that
// "cdninstagram.com.evil.test" cannot pass as "cdninstagram.com".
const ALLOWED_HOSTS = [
  "cdninstagram.com", // scontent-*.cdninstagram.com
  "fbcdn.net",        // the same CDN under Meta's other name
  "ggpht.com",        // yt3.ggpht.com — YouTube channel avatars
  "ytimg.com",
];

const hostAllowed = (host) =>
  ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/** true when `url` is a well-formed https URL on a platform CDN we will fetch. */
export function isAllowedAvatarSource(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === "https:" && hostAllowed(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Download an image from a platform CDN into { data, contentType } — the exact
 * shape avatarStore puts on a document — or null if it cannot be had.
 *
 * Best-effort by contract: every failure path returns null rather than
 * throwing, because every caller wants "no image" and not "the save failed".
 * A creator record is worth more than their picture, and a reel is worth more
 * than its poster frame.
 */
export async function fetchRemoteImage(url, { maxBytes = MAX_AVATAR_BYTES } = {}) {
  if (!isAllowedAvatarSource(url)) return null;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "image/*" },
    });
    if (!res.ok) return null;

    // Re-checked after the fact: fetch follows redirects by default, and the
    // hop we validated is not necessarily the host that answered.
    if (!isAllowedAvatarSource(res.url || url)) return null;

    const contentType = String(res.headers.get("content-type") || "")
      .split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) return null;

    // Declared length first so an oversized image is dropped before it is
    // buffered; the decoded length is checked again below because
    // Content-Length is a claim, not a guarantee.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return null;

    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > maxBytes) return null;

    return { data, contentType };
  } catch {
    // Timeout, DNS failure, connection reset, malformed body — all "no image".
    return null;
  }
}

/** A creator's profile photo, at the avatar size cap. */
export const fetchRemoteAvatar = (url) => fetchRemoteImage(url, { maxBytes: MAX_AVATAR_BYTES });

/**
 * Fetch `url` and stamp it onto an update object, mirroring avatarStore's
 * withAvatar() so both ways of setting a photo write the same two fields.
 * Returns true when a photo was actually captured.
 */
export async function applyRemoteAvatar(target, url) {
  const captured = await fetchRemoteAvatar(url);
  if (!captured) return false;
  target.avatarImage = captured;
  target.avatarUpdatedAt = new Date();
  return true;
}
