import mongoose from "mongoose";

/**
 * A standalone paid deal for a creator we manage directly — "Acme Sneakers,
 * ₹3,00,000 in, ₹1,80,000 out to the creator, that reel" — separate from the
 * agency's own campaign pipeline (models/Campaign.js). A managed creator can
 * have several of these running at once, for different brands, alongside
 * whatever campaigns they're also booked on; neither one is a record of the
 * other.
 *
 * Two money fields, deliberately not one: `budget` is the CLIENT cost (what
 * the brand paid us for the deal — the same figure Billing's revenue-by-
 * source chart already sums as agency revenue), `internalCost` is what we
 * actually paid the creator out of that. The gap between them is the
 * agency's margin on the deal — computed wherever it's shown (Campaigns,
 * Summary), never stored, so it can never drift from the two numbers it's
 * made of.
 *
 * Scoped under one creator via `creatorId`, the same way
 * models/CreatorDocument.js scopes agreements — see routes/creators.js for
 * both. `brand` is what turns a bare "Project 1" into an actual deal: the
 * brand this specific reel/video was made for, free text (the managed roster
 * has no brand/vendor directory of its own the way client campaigns do) but
 * indexed so the Managed Creators ecosystem (Summary/Campaigns/Assets tabs,
 * and eventually a standalone creator dashboard) can group, filter and chart
 * by it without a table scan.
 *
 * `media` is a HikerAPI snapshot of the project's reel/video — exactly the
 * shape fetchReelSnapshot() in portalReels.js already produces for Insights →
 * Trending/Market Watch (`{ok, likes, comments, views, forwards, video,
 * thumbnail, ...}`), fetched once when the project is added or its link
 * changes, and kept fresh by the same nightly job that refreshes those two
 * shelves (see trendingReels.js) so its signed CDN links never expire into a
 * dead player. `fetchedAt`/`attemptedAt`/`lastError` are that job's own
 * bookkeeping, same field names and meaning as TrendingItem/MarketWatchItem.
 */
const ProjectSchema = new mongoose.Schema(
  {
    _id: { type: String },
    creatorId: { type: String, index: true },
    name: String,              // "Project 1" — whatever the founder calls it
    brand: { type: String, index: true }, // "Acme Sneakers" — who it's for
    // The brand's own site, typed by whoever adds the deal (see BrandLogo
    // in the frontend) — a known-good domain to fetch its logo from, rather
    // than guessing one from `brand`'s free text. Optional: falls back to
    // guessing when absent.
    brandWebsite: String,
    budget: Number,            // CLIENT cost — what the brand paid us for this deal
    internalCost: Number,      // INTERNAL cost — what we actually paid the creator
    url: String,                // the Instagram reel/video link, if any
    media: mongoose.Schema.Types.Mixed,
    fetchedAt: Date,
    attemptedAt: Date,
    lastError: String,
    createdAt: { type: Date, default: Date.now },
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("Project", ProjectSchema, "projects");
