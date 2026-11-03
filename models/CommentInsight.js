import mongoose from "mongoose";

/**
 * Comment analysis — two collections, both written only by commentInsights.js.
 *
 * post_comments: the comments we fetched for one live Instagram post, plus the
 * AI read of that post on its own. Keyed by post URL, like reel_cache, because
 * a post is the same post whichever campaign carries it. `analysisHash` is the
 * fingerprint of the comments the stored analysis was made from, so a post
 * whose comments haven't changed is never re-analysed (or re-paid for).
 *
 * comment_insights: the brand-level read the client portal shows — one
 * document per brand. The portal only ever reads this; nothing on the
 * client's request path fetches or analyses anything.
 */
const PostCommentsSchema = new mongoose.Schema(
  {
    _id: { type: String },           // the Instagram post URL
    mediaId: String,
    code: String,
    commentCount: Number,            // what Instagram says the post has in total
    comments: [{
      _id: false,
      id: String,
      text: String,
      user: String,
      likes: Number,
      replies: Number,
      at: Date,
    }],
    fetchedAt: Date,                 // last successful fetch
    attemptedAt: Date,
    lastError: String,
    requests: Number,                // HikerAPI pages the last fetch used
    analysis: mongoose.Schema.Types.Mixed, // per-post AI read (counts, themes, highlights…)
    analysisHash: String,
    analysedAt: Date,
  },
  { versionKey: false, timestamps: true },
);

const CommentInsightSchema = new mongoose.Schema(
  {
    _id: { type: String },           // brandId
    brandName: String,
    status: { type: String, default: "idle" }, // idle | running | ready | error
    statusNote: String,
    startedAt: Date,
    generatedAt: Date,               // when the analysis below was produced
    insight: mongoose.Schema.Types.Mixed,
    lastRun: mongoose.Schema.Types.Mixed,    // { posts, fetched, requests, analysed, ms, error? }
  },
  { versionKey: false, timestamps: true },
);

export const PostComments = mongoose.model("PostComments", PostCommentsSchema, "post_comments");
export const CommentInsight = mongoose.model("CommentInsight", CommentInsightSchema, "comment_insights");
