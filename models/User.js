import mongoose from "mongoose";
import { AVATAR_FIELDS } from "../avatarStore.js";

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
    avatar: String,               // initials, e.g. "AF" — the fallback when no photo is set
    // Optional profile photo, stored ON the user document rather than in its own
    // collection or GridFS: the image is downscaled to 256px and re-encoded
    // client-side before upload (~20-30KB), which is small enough to live inline
    // and avoids a second round trip on every avatar render.
    //
    // NEVER returned by the list routes — see pub()/OMIT_AVATAR in routes/auth.js.
    // A 30KB blob per row would add ~600KB to a 20-user list call that is fetched
    // on the Auth page, the Summary and the app shell. It is served instead from
    // GET …/:id/avatar, which is cacheable and only fetched for rows on screen.
    ...AVATAR_FIELDS,
    hashKey: String,              // sha256(password) — never the plaintext
    deleted: Boolean,
    deletedAt: Date,
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("User", UserSchema, "users");
