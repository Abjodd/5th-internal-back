import mongoose from "mongoose";

// Client requests — brand signups from the public "Start a project" landing
// page (hosted separately). Each finished sign-up is POSTed to
// /api/client-requests (see routes/clientRequests.js) and lands here as the
// founder's inbox of inbound leads.
//
// Loose schema (strict:false) like the other collections, so the landing page
// can send extra fields without a schema change. `contact` is the combined
// "email or phone" field from the form; `goal` is the free-text "what they
// want from us". `status` drives the founder tab's triage (new → contacted…).
const ClientRequestSchema = new mongoose.Schema(
  {
    _id: { type: String }, // e.g. "cr1" — sequential, assigned server-side
    name: String,          // full name of the person signing up
    role: String,          // their role, e.g. "Founder / CEO"
    contact: String,       // email or phone (single field on the form)
    organisation: String,  // brand / company name
    headquarters: String,  // city / base of operations
    goal: String,          // what they want from us (free text)
    status: { type: String, default: "new" }, // new | reviewed | contacted | archived
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("ClientRequest", ClientRequestSchema, "client_requests");
