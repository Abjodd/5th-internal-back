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
import { fetchRemoteAvatar, isAllowedAvatarSource } from "./remoteAvatar.js";
import { OMIT_AVATAR } from "./avatarStore.js";

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

  // Looked up for two reasons now: to merge personalDetails onto what is
  // already stored, and to know who already has a profile photo — a creator
  // whose picture we hold is never re-fetched from the platform.
  const needsLookup = keyed.filter(
    ({ cr, key }) => key && (cr.personalDetails || photoSourceOf(cr)),
  );
  const existing = needsLookup.length
    ? new Map((await Creator.find({ _id: { $in: needsLookup.map((k) => k.key) } })
        .select("personalDetails avatarUpdatedAt").lean())
        .map((d) => [d._id, d]))
    : new Map();
  const existingByKey = new Map(
    [...existing].map(([k, d]) => [k, d.personalDetails || {}]),
  );

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

  // Deliberately NOT awaited. Every creator on the roster who arrived with a
  // platform photo and has none stored yet needs one HTTP round trip to a CDN,
  // and putting those in front of the response would put a stranger's server on
  // the critical path of saving a campaign — a ten-creator roster could hang
  // the save for the full timeout. The documents are already written by this
  // point, so the capture is a later, independent update to rows that exist;
  // the photo simply appears on the next read.
  captureMissingAvatars(keyed, existing);

  return keyed.map(({ cr, key }) => ({ ...omit(cr, PROFILE_FIELDS), creatorId: key || cr.creatorId || null }));
}

/**
 * The platform profile picture on an incoming creator entry, if it is one we
 * are willing to fetch. `igFetched` is the raw snapshot the Add Creator modal's
 * Fetch button stores on the campaign's entry — it is campaign-specific and
 * never enters the directory (see PROFILE_FIELDS), so this is the only moment
 * the directory ever sees the creator's picture.
 */
const photoSourceOf = (cr) => {
  const url = cr?.igFetched?.profilePic;
  return url && isAllowedAvatarSource(url) ? url : null;
};

/**
 * Copy each new creator's platform photo into bytes we own.
 *
 * Once only: a creator with `avatarUpdatedAt` already set is skipped, so this
 * costs nothing on the overwhelmingly common path of re-saving a roster whose
 * creators are all already known. Re-capturing a changed photo is a deliberate
 * act — re-run Fetch in the Edit modal, which PATCHes `avatarSourceUrl`.
 *
 * Fire-and-forget, and silent: this runs after its caller has returned, so a
 * rejection here would be an unhandled promise rejection that takes the process
 * down under Node's default policy. Nothing it does is worth a campaign save,
 * and a creator without a picture is a card with initials on it.
 */
function captureMissingAvatars(keyed, existing) {
  const targets = keyed.filter(({ cr, key }) =>
    key && photoSourceOf(cr) && !existing.get(key)?.avatarUpdatedAt);
  if (!targets.length) return;

  // Deduped: the same creator can appear twice on one roster.
  const byKey = new Map(targets.map(({ cr, key }) => [key, photoSourceOf(cr)]));

  (async () => {
    const captured = await Promise.all(
      [...byKey].map(async ([key, url]) => [key, await fetchRemoteAvatar(url)]),
    );
    const ops = captured
      .filter(([, img]) => img)
      .map(([key, img]) => ({
        updateOne: {
          filter: { _id: key },
          update: { $set: { avatarImage: img, avatarUpdatedAt: new Date() } },
        },
      }));
    if (ops.length) await Creator.bulkWrite(ops);
  })().catch((err) => {
    console.warn("[creatorSync] avatar capture failed:", err.message);
  });
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
  // OMIT_AVATAR matters more here than anywhere: this runs on every campaign
  // read, and without it each hydration would pull every rostered creator's
  // photo bytes into the process only for pick() to drop them again.
  const profiles = await Creator.find({ _id: { $in: [...keys] } }, OMIT_AVATAR).lean();
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
