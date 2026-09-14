import mongoose from "mongoose";

/**
 * One brand's answers on the Insights → Questions shelf: four fixed prompts
 * the internal team fills in by hand on the Founder Summary page (What
 * Worked / What Didn't Work / Next Actions / Areas to Improve), read straight
 * through to that brand's own portal (GET /api/portal/questions).
 *
 * Unlike TrendingItem this IS per-brand — every client's answers are their
 * own — so `_id` is the same brandId as Client._id: one document per brand,
 * upserted from the internal editor (see PATCH /api/account-questions/:brandId
 * in server.js) rather than a growing collection of dated entries.
 */
const AccountQuestionsSchema = new mongoose.Schema(
  {
    _id: { type: String },   // brandId — same id as Client._id
    whatWorked: String,
    whatDidntWork: String,
    nextActions: String,
    areasToImprove: String,
    updatedAt: { type: Date, default: Date.now },
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("AccountQuestions", AccountQuestionsSchema, "accountquestions");
