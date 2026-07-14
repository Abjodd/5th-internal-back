import "dotenv/config";
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/fifth_avenue_internal";

export async function connectDB() {
  // Our schemas are strict:false (docs carry undeclared fields like brandId,
  // deleted, client), so query filters must NOT be stripped to declared paths —
  // strictQuery:true silently drops them and the filter matches everything.
  mongoose.set("strictQuery", false);
  await mongoose.connect(MONGO_URI);
  console.log("[db] connected to", MONGO_URI);
}
