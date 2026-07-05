import "dotenv/config";
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/fifth_avenue_internal";

export async function connectDB() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(MONGO_URI);
  console.log("[db] connected to", MONGO_URI);
}
