import mongoose from "mongoose";

/**
 * One brand's star on one Trending or Market Watch item — the client
 * portal's Insights → Trending "Favourite" tab, and this brand's own
 * Founder Summary → Insights → Favourites panel (GET /api/favourites).
 *
 * `itemId` is a TrendingItem._id when `itemType` is "trending", or a
 * MarketWatchItem._id when it's "market-watch" — the two shelves a brand can
 * favourite off (see GET /api/portal/favourites and POST
 * /api/portal/favourites below). Deliberately just the pointer, not a copy
 * of the reel/note itself: the content lives on whichever of those two
 * collections it already lives on, and a reader joins back onto it (see GET
 * /api/favourites in server.js) rather than this schema duplicating it and
 * drifting out of sync.
 *
 * The compound unique index is what makes POST /api/portal/favourites a
 * plain toggle: a second star on the same (brand, item) either 11000s (read
 * as "it's already favourited") or is guarded against explicitly, rather
 * than silently creating a duplicate row.
 */
const FavouriteSchema = new mongoose.Schema(
  {
    _id: { type: String },                 // client-generated id, matches the other CRUD collections
    brandId: { type: String, index: true }, // same id as Client._id — whose star this is
    itemType: { type: String },            // "trending" | "market-watch"
    itemId: { type: String },              // TrendingItem._id or MarketWatchItem._id, per itemType
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
FavouriteSchema.index({ brandId: 1, itemType: 1, itemId: 1 }, { unique: true });

export default mongoose.model("Favourite", FavouriteSchema, "favourites");
