// models/PitchDraft.js
//
// A "prospect" pitch — everything Pitch Client needs BEFORE a brand and
// campaign are real records. The normal Pitch Client flow (routes/pitch.js)
// always needs an existing Client + Campaign to hang a pitch off; this model
// exists for the case that doesn't fit that: a brand that isn't in the
// system yet, being pitched candidate creators (plus a written brief and
// suggested-content links) before anyone has decided this is a real deal.
//
// Deliberately its own collection rather than an early, incomplete Client +
// Campaign pair — a half-formed campaign document would show up in every
// list, filter and pipeline stage built for real ones. This stays invisible
// to all of that until someone here promotes it (see POST
// /api/pitch-drafts/:id/promote in routes/pitchDrafts.js), at which point a
// REAL Client and Campaign get created from it and this draft is marked
// promoted — archived, not deleted, since it's the only place the brief and
// suggested-content links live (they deliberately do NOT copy onto the real
// campaign — see the promote route's own note on why).
//
// Profiles, brief sections and suggested-content links are embedded arrays
// rather than sibling collections (unlike PitchProfile, which is its own
// collection): a draft is small, single-owner, edited by whoever on the team
// is working the prospect, and nothing else in the system ever needs to
// query "all draft-pitch profiles" across drafts the way real pitches are
// queried across campaigns. Simple embedding, read-modify-write on save,
// no concurrency contract to get right.
import mongoose from "mongoose";

const PitchDraftSchema = new mongoose.Schema(
  {
    // A short, URL-safe id (see routes/pitchDrafts.js genDraftId) — this IS
    // the client link's path segment, the same role Client._id plays for a
    // real brand's pitch link.
    _id: { type: String },

    brandName: String,

    // "Campaign form" half of the combined form — enough to seed a real
    // Campaign on promotion (name, service, region, objective/audience/
    // messages map straight onto onCreate's own fields in Campaigns/index.jsx
    // and Campaign.brief). Deliberately NO budget/scope/timeline fields:
    // those aren't decided at pitch stage, same reason the real New
    // Campaign wizard lets them be deferred.
    campaignName: String,
    service: String,
    region: String,
    objective: String,
    audience: String,
    messages: String,

    // The freeform creative brief — an ordered list of heading/body pairs,
    // not a fixed schema, because a brief's sections vary campaign to
    // campaign (see the PaperBoat NATA sample this was modelled on: About,
    // Objective, Do's/Don'ts, Content buckets, Key message, ... — no two
    // briefs share the same shape). Never copied onto the real Campaign on
    // promotion; this draft stays its permanent home.
    briefSections: {
      type: [{ id: String, heading: String, body: String, _id: false }],
      default: [],
    },

    // Reel links the team suggests as reference/direction — shown to the
    // client alongside the brief and the candidate creators. Also never
    // copied onto the real campaign.
    //
    // `media` is a one-time HikerAPI snapshot of the post (thumbnail,
    // caption, counts — see toReel() in portalReels.js), fetched once when
    // the link is added, exactly like Trending/Market Watch's own `media`
    // field (POST /api/trending, POST /api/market-watch) — one credit spent
    // here and never again, no refresh cycle. Absent when the link isn't a
    // fetchable Instagram post, or the fetch failed (the team can still see
    // the bare link). Stripped back to null at promote time (see POST
    // /api/pitch-drafts/:id/promote in routes/pitchDrafts.js) — a signed
    // CDN thumbnail with no refresh mechanism goes stale in days, and once
    // the draft is archived there's no one left to look at it.
    suggestedContent: {
      type: [{ id: String, url: String, note: String, media: mongoose.Schema.Types.Mixed, addedBy: String, addedAt: Date, _id: false }],
      default: [],
    },

    // Candidate creators — same field set PitchProfile snapshots (see that
    // model's own comment for why so many fields are duplicated rather than
    // referenced: a pitch is a snapshot at pitch time, not a live join).
    // Embedded here for the same reason briefSections is: small, single-
    // owner, no cross-draft querying need.
    profiles: {
      type: [{
        id: String,
        creatorId: String,
        source: String, // "directory" | "hiker"
        profileUrl: String,
        addedBy: String,
        name: String,
        handle: String,
        platform: String,
        avatar: String,
        bio: String,
        externalUrl: String,
        followers: Number,
        following: Number,
        posts: Number,
        avgLikes: Number,
        avgComments: Number,
        avgViews: Number,
        avgER: Number,
        isVerified: Boolean,
        isPrivate: Boolean,
        isBusiness: Boolean,
        status: { type: String, default: "pending" }, // pending | approved | rejected
        decision: { at: Date, by: String },
        _id: false,
      }],
      default: [],
    },

    // The client's access code for THIS draft's own public link
    // (/pitch-draft/:id?code=...) — same lightweight code-gate model as a
    // real brand's Client.pitchCode, minted lazily on first profile added.
    pitchCode: String,

    status: { type: String, default: "draft" }, // draft | promoted
    promotedClientId: String,
    promotedCampaignId: String,
    promotedAt: Date,

    createdBy: String,
  },
  { strict: false, versionKey: false, timestamps: true },
);

export default mongoose.model("PitchDraft", PitchDraftSchema, "pitchdrafts");
