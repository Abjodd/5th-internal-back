import mongoose from "mongoose";

// External (client-portal) login credential, mapped to a brand via brandId
// (= Client._id, e.g. "fb"). Same hashKey convention as models/User.js —
// sha256 of the password, plaintext never stored. Managed from the
// founder-only Auth page; the client portal's login can be pointed at these
// docs via POST /api/auth/portal-login.
const BrandCredentialSchema = new mongoose.Schema(
  {
    _id: { type: String },        // e.g. "bc_fb_1"
    brandId: String,              // Client._id this login is scoped to
    username: String,             // login email, e.g. "rahul@freshbitefoods.com"
    name: String,                 // contact person
    title: String,                // e.g. "Owner", "Marketing Head"
    avatar: String,
    hashKey: String,              // sha256(password)
    deleted: Boolean,
    deletedAt: Date,
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("BrandCredential", BrandCredentialSchema, "brand_credentials");
