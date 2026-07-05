import mongoose from "mongoose";

const RegistryEntrySchema = new mongoose.Schema(
  { _id: { type: String } },
  { strict: false, versionKey: false }
);

export default mongoose.model("RegistryEntry", RegistryEntrySchema, "registry_entries");
