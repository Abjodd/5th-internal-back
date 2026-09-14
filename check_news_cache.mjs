// Checks (and optionally clears) the Mongo-backed news cache that backs
// Market Watch's "Latest News" list. Run from inside the backend folder —
// it reuses your existing db.js/NewsCache.js, same connection as the app.
//
// Usage:
//   node check_news_cache.mjs           -> just reports what's cached
//   node check_news_cache.mjs --clear   -> deletes the cached doc too,
//                                          forcing a fresh fetch (with the
//                                          new image logic) on the next
//                                          request to /api/news/... or
//                                          /api/portal/news
import { connectDB } from "./db.js";
import mongoose from "mongoose";
import NewsCache from "./models/NewsCache.js";

const clear = process.argv.includes("--clear");

await connectDB();

const doc = await NewsCache.findById("influencer-marketing").lean();

if (!doc) {
  console.log("No cached document found — the next page load will fetch fresh (with images).");
} else {
  const ageMin = Math.round((Date.now() - new Date(doc.fetchedAt).getTime()) / 60000);
  const withImage = (doc.items || []).filter((i) => i.image).length;
  console.log(`Cached ${doc.items?.length ?? 0} items, fetched ${ageMin} min ago.`);
  console.log(`${withImage} of them have an image.`);
  console.log(`TTL is 30 min, so this cache ${ageMin >= 30 ? "is already stale and will refetch on next request" : `will auto-refresh in ${30 - ageMin} min`}.`);

  if (clear) {
    await NewsCache.findByIdAndDelete("influencer-marketing");
    console.log("Cleared — the next request to /api/news/influencer-marketing or /api/portal/news will fetch fresh.");
  }
}

await mongoose.disconnect();
