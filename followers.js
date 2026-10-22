/**
 * Follower counts are stored compact and inconsistently — the creators
 * directory keeps whatever was typed or scraped ("820K", "1.2M", "213001",
 * 11606, ""). This normalizes all of it to a number. Anything it can't parse
 * is 0 rather than NaN, which would poison every sum downstream.
 *
 * Pulled out of server.js so routes/creators.js (Projects' engagement-rate
 * calc) can share the one parser rather than growing its own copy.
 */
export function parseFollowers(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== "string") return 0;
  const up = raw.trim().toUpperCase().replace(/,/g, "");
  const mp = up.match(/^([\d.]+)\s*([KM])?$/);
  if (!mp) return 0;
  const n = parseFloat(mp[1]);
  if (!Number.isFinite(n)) return 0;
  return n * (mp[2] === "M" ? 1e6 : mp[2] === "K" ? 1e3 : 1);
}
