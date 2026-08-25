import mongoose from "mongoose";

/**
 * One Instagram media object, as the portal's Reels shelf needs it, keyed by
 * the post URL.
 *
 * ── Why this collection exists ──────────────────────────────────────────────
 * portalReels.js used to hold exactly this, in a process-local `Map`. The TTL
 * was right (24h, inside the video signature) but the storage was not: a Map
 * dies with the process. Every deploy, every crash, every idle-instance
 * recycle emptied it, so the "one HikerAPI call per post per day" the comment
 * promised was really one call per post per COLD START — and on a host that
 * sleeps an idle service, a brand opening the portal each morning paid for the
 * whole shelf again. That is where the credits went.
 *
 * Keyed by post URL rather than by client, for the same reason the Map was:
 * two campaigns can carry the same post and the media object is identical
 * either way. Client scoping stays in the campaigns collection, which is the
 * authority on who may see what — see getClientReels().
 *
 * ── Why storing the URLs is safe now, when it wasn't before ─────────────────
 * The old header argued against persisting because Instagram signs its CDN
 * links with an expiry (video ~32h, poster ~106h) and "a stored one that
 * expires is a broken <video>". That is an argument against storing WITHOUT a
 * refresh cycle. With `fetchedAt` on the document and a scheduled job that
 * rewrites anything older than the TTL, a stored link is no more likely to be
 * expired than an in-memory one was — and unlike the Map, it survives the
 * restart that was causing the refetch in the first place.
 *
 * The TTL therefore has a hard ceiling that is not a preference: it must stay
 * under the ~32h video signature. See REELS_TTL_MS in portalReels.js.
 */
const ReelCacheSchema = new mongoose.Schema(
  {
    _id: { type: String },              // the Instagram post URL — natural key

    // The toReel() projection, or null when the post fetched fine but carries
    // nothing renderable (no video and no usable thumbnail). Null is a real
    // answer here and must be distinguishable from "never fetched", which is
    // the absence of the whole document.
    reel: mongoose.Schema.Types.Mixed,

    // Last SUCCESSFUL fetch. Freshness is measured against this alone, so a
    // run of failures can never make a stale document look current.
    fetchedAt: Date,

    // Last attempt, successful or not. Exists so a permanently dead post — one
    // that was deleted on Instagram, or set private — is retried on a backoff
    // instead of on every single pass. Without it, a handful of dead links
    // would quietly become a standing daily charge.
    attemptedAt: Date,
    lastError: String,
  },
  { strict: false, versionKey: false }
);

// The refresh job's own query: "everything I might need to refetch, oldest
// first". Sorting by fetchedAt lets a capped run always spend its budget on
// the stalest entries rather than on whatever Mongo returned first.
ReelCacheSchema.index({ fetchedAt: 1 });

export default mongoose.model("ReelCache", ReelCacheSchema, "reel_cache");
