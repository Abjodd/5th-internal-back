import mongoose from "mongoose";

// Vendors — the agencies and talent managers that invoice us on a creator's
// behalf. A creator points at one through `vendorId` (see PROFILE_FIELDS in
// creatorSync.js); the roster on each vendor card is derived from that link at
// read time rather than stored here, so it can never go stale — the same
// contract routes/creators.js uses for "where they've worked".
//
// _id is a slug of the name, assigned frontend-side exactly like a brand's, so
// the unique index turns a duplicate vendor into a 409 instead of two rows that
// are indistinguishable in a picker.
const VendorSchema = new mongoose.Schema(
  {
    _id: { type: String },
    name: String,
    contact: String, // the person we actually deal with
    phone: String,
    email: String,
    gstin: String,
    pan: String,
    address: String,
    // How we settle their invoices — the creator payType vocabulary minus
    // "vendor" itself, which would only point back here.
    payType: String, // "net_banking" | "upi"
    bankName: String,
    bankAccount: String,
    bankBranch: String,
    ifsc: String,
    upiId: String,
    notes: String,
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("Vendor", VendorSchema, "vendors");
