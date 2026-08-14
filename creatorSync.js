// Shared creator-normalization helpers.
//
// A campaign's embedded creators[] entry only ever holds campaign-specific
// fields (fee, status, concept/demo/live, tracking, invoiceNo, ...) plus a
// `creatorId` FK into the `creators` collection (models/Creator.js) — that
// collection is the single source of truth for a creator's profile (name,
// handle, platform, followers, niche, personalDetails, ...), so it's never
// duplicated across every campaign the creator appears on.
//
// Used by:
//   server.js         — split on write (POST/PATCH /api/campaigns), hydrate
//                        on read (GET /api/campaigns, /api/portal/campaigns)
//   routes/creators.js — the founder directory (PATCH edits the profile once)
//   scripts/normalize-creators.js — one-off migration for existing records
import Creator from "./models/Creator.js";

// Dedup key: handle when present (stable across campaigns), else name.
export const keyOf = (cr) => String(cr?.handle || cr?.name || "").toLowerCase().trim();

// Fields owned by the creators directory — everything else on a campaign's
// creator entry (fee, status, concept/demo/live, tracking, invoiceNo, dbId,
// igFetched, ...) is campaign-specific and stays embedded.
export const PROFILE_FIELDS = [
  "name", "handle", "platform", "igUrl", "followers", "avgLikes", "avgER",
  "niche", "state", "languages", "phone", "payType", "payId", "personalDetails",
];

const pick = (obj, keys) => keys.reduce((o, k) => (k in (obj || {}) ? { ...o, [k]: obj[k] } : o), {});
const omit = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !keys.includes(k)));

// Given a campaign's incoming creators[] (full objects — the frontend still
// builds/edits them as one flat shape), upsert each one's profile fields into
// the creators directory and return the slim array that actually gets stored
// on the campaign document.
//
// Batched rather than one findById + updateOne per creator: a 10-creator
// roster used to mean up to 20 sequential round trips to Mongo on every save
// (drag a slider on the Creators tab, and every locked creator's profile got
// refetched one at a time). One find({_id:{$in}}) plus one bulkWrite covers
// the whole roster in two round trips regardless of size.
export async function splitCreatorsForStorage(creators) {
  const list = creators || [];
  const keyed = list.map((cr) => ({ cr, key: keyOf(cr) }));

  const withDetails = keyed.filter(({ cr, key }) => key && cr.personalDetails);
  const existingByKey = withDetails.length
    ? new Map((await Creator.find({ _id: { $in: withDetails.map((k) => k.key) } })
        .select("personalDetails").lean())
        .map((d) => [d._id, d.personalDetails || {}]))
    : new Map();

  const ops = [];
  for (const { cr, key } of keyed) {
    if (!key) continue;
    const profile = pick(cr, PROFILE_FIELDS);
    if (!Object.keys(profile).length) continue;
    const { personalDetails, ...rest } = profile;
    const set = { ...rest };
    if (personalDetails) set.personalDetails = { ...(existingByKey.get(key) || {}), ...personalDetails };
    ops.push({ updateOne: { filter: { _id: key }, update: { $set: set }, upsert: true } });
  }
  if (ops.length) await Creator.bulkWrite(ops);

  return keyed.map(({ cr, key }) => ({ ...omit(cr, PROFILE_FIELDS), creatorId: key || cr.creatorId || null }));
}

// Reverse of the split above — merges each campaign's creator entries with
// their profile from the directory, so API responses keep the same
// full-object shape the frontend has always worked with. Mutates and returns
// the given campaigns array (all lean POJOs).
export async function hydrateCampaignCreators(campaigns) {
  const keys = new Set();
  for (const c of campaigns) for (const cr of c.creators || []) {
    const k = cr.creatorId || keyOf(cr);
    if (k) keys.add(k);
  }
  if (!keys.size) return campaigns;
  const profiles = await Creator.find({ _id: { $in: [...keys] } }).lean();
  const byKey = new Map(profiles.map((p) => [p._id, p]));
  for (const c of campaigns) {
    c.creators = (c.creators || []).map((cr) => {
      const k = cr.creatorId || keyOf(cr);
      const profile = k && byKey.get(k);
      // Campaign-specific fields win on conflict — also covers legacy
      // un-migrated docs that still carry their own profile fields.
      return profile ? { ...pick(profile, PROFILE_FIELDS), ...cr } : cr;
    });
  }
  return campaigns;
}
