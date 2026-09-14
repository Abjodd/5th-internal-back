import mongoose from "mongoose";

/**
 * A durable cache for one externally-fetched news feed — currently just the
 * "influencer marketing" industry feed behind Market Watch's Latest News
 * list (see ../newsFeed.js). One document per feed, keyed by `_id`.
 *
 * Stored in Mongo rather than kept in process memory for the same reason
 * portalReels.js moved its reel cache to Mongo: an in-memory cache is wiped
 * by every deploy, crash, or idle-instance recycle, which would otherwise
 * turn "refetch every 30 minutes" into "refetch on every cold start."
 */
const NewsCacheSchema = new mongoose.Schema(
  {
    _id: { type: String }, // feed key, e.g. "influencer-marketing"
    items: [
      {
        _id: false,
        title: String,
        link: String,
        source: String,
        image: String, // best-effort og:image from the article — see ../newsFeed.js
        publishedAt: Date,
      },
    ],
    fetchedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

export default mongoose.model("NewsCache", NewsCacheSchema, "newscaches");
