import mongoose from "mongoose";

// Internal platform user (founder, pcm, cm, am, ea, accounts_*).
// Passwords are never stored — only `hashKey` (sha256 of the password, see
// hashPassword() in server.js). The founder-only Auth page displays hashKey
// verbatim since the plaintext can't be recovered.
// Soft delete: deleted:true hides the user from lists and blocks login;
// the doc stays in Mongo so it can be restored by hand.
const UserSchema = new mongoose.Schema(
  {
    _id: { type: String },        // e.g. "u1"
    username: String,             // login email, e.g. "founder@5thavenue.in"
    name: String,
    role: String,                 // founder | pcm | cm | am | ea | accounts_head | accounts_exec
    teamId: String,               // maps to TEAM ids for campaign ownership (amId/cmId/eaId)
    title: String,
    avatar: String,               // initials
    hashKey: String,              // sha256(password) — never the plaintext
    deleted: Boolean,
    deletedAt: Date,
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("User", UserSchema, "users");
