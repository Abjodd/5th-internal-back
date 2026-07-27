import mongoose from "mongoose";

// Creator requests — applications from the public "Apply as a creator" form on
// the landing page (hosted separately). Each submission is POSTed to
// /api/creator-requests (see routes/creatorRequests.js) and lands here as the
// founder's inbox of inbound creator applications.
//
// Loose schema (strict:false) like the other collections, so the landing page
// can send extra fields without a schema change. Field names deliberately
// mirror models/Creator.js — `name`, `handle`, `platform`, `phone`, `niche`,
// `state` — so an approved application can be promoted into the Creator
// directory without remapping. `status` drives the founder tab's triage.
const CreatorRequestSchema = new mongoose.Schema(
  {
    _id: { type: String }, // e.g. "crq1" — sequential, assigned server-side
    name: String,          // full name of the creator
    handle: String,        // @handle on their primary platform
    platform: String,      // Instagram | YouTube | …
    email: String,         // contact email
    phone: String,         // contact phone
    state: String,         // state code, e.g. "mh"
    followers: String,     // self-reported band, e.g. "10K–50K"
    niche: { type: [String], default: [] },     // content verticals
    languages: { type: [String], default: [] }, // languages they create in
    status: { type: String, default: "new" },   // new | reviewed | contacted | archived
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("CreatorRequest", CreatorRequestSchema, "creator_requests");
