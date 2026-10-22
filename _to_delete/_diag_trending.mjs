import { connectDB } from "./db.js";
import TrendingItem from "./models/TrendingItem.js";
import MarketWatchItem from "./models/MarketWatchItem.js";
import mongoose from "mongoose";

await connectDB();

const [t, m] = await Promise.all([
  TrendingItem.find({}).lean(),
  MarketWatchItem.find({}).lean(),
]);
console.log("trending total:", t.length, "reel kind:", t.filter(x=>x.kind==="reel").length);
for (const x of t.filter(x=>x.kind==="reel")) {
  console.log(" trending", x._id, "url=", x.url, "media.ok=", x.media?.ok, "videoExpiresAt=", x.media?.videoExpiresAt, "fetchedAt=", x.fetchedAt);
}
console.log("marketWatch total:", m.length, "reel kind:", m.filter(x=>x.kind==="reel").length);
for (const x of m.filter(x=>x.kind==="reel")) {
  console.log(" mw", x._id, "brandId=", x.brandId, "url=", x.url, "media.ok=", x.media?.ok, "videoExpiresAt=", x.media?.videoExpiresAt, "fetchedAt=", x.fetchedAt);
}
await mongoose.disconnect();
