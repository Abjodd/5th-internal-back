import mongoose from "mongoose";

// Career requests — job applications from the public Careers page's "Tell us
// about you" form. Each submission is POSTed to /api/career-requests (see
// routes/careerRequests.js) and lands here as the founder's inbox of inbound
// hiring applications.
//
// Loose schema (strict:false) like the other inboxes, so the careers page can
// send extra fields without a schema change.
//
// `roleId` is the opening's id from the careers page's own OPENINGS list
// (5th-avenue-client-front src/lib/marketing/data/careers.ts), e.g.
// "performance-manager" or the "general" sentinel for an open application.
// `roleTitle` is stored ALONGSIDE it rather than resolved from the id at read
// time: openings are edited and retired in that file, and a request whose
// opening no longer exists must still say what the person actually applied
// for. `status` drives the founder tab's triage, same vocabulary as
// models/CreatorRequest.js.
const CareerRequestSchema = new mongoose.Schema(
  {
    _id: { type: String }, // e.g. "car1" — sequential, assigned server-side
    name: String,          // full name of the applicant
    email: String,         // contact email
    roleId: String,        // opening id, or "general" for an open application
    roleTitle: String,     // the opening's title as it read when they applied
    link: String,          // portfolio / LinkedIn (optional on the form)
    note: String,          // "Why 5th Avenue?" free text (optional on the form)
    status: { type: String, default: "new" }, // new | reviewed | contacted | archived
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("CareerRequest", CareerRequestSchema, "career_requests");
