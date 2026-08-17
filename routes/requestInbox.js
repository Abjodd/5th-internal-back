// Shared plumbing for the three public-form inboxes — client requests, creator
// requests and career requests (routes/{client,creator,career}Requests.js).
//
// They are the same shape of thing: a public form POSTs, the row gets a
// sequential id, the founder triages it in a tab, and it is deleted when it has
// served its purpose. Only the model, the id prefix and the fields differ, so
// the two pieces that were being copied verbatim into each route live here.

// `_id` → `id`, so the frontends never see Mongo's field name. Note the
// credential routes in auth.js keep their OWN `pub`: that one also strips
// hashKey/passKey/avatarImage, and merging the two would make it far too easy
// to add a secret-bearing collection to this one by accident.
export const pub = ({ _id, ...rest }) => ({ id: _id, ...rest });

/**
 * Next sequential id for an inbox — `nextSeqId(ClientRequest, "cr")` → "cr7".
 * Same scheme the auth routes use for users/brand-credentials, and assigned
 * server-side so a public form never has to know our id format.
 *
 * Reads the ids rather than counting: rows are hard-deleted on triage, so a
 * count would hand out an id that is already taken the moment anything has been
 * removed. Scanning the whole collection is fine at inbox scale — these hold
 * tens of rows, and the alternative (a counters collection) is more moving
 * parts than the problem is worth.
 */
export async function nextSeqId(Model, prefix) {
  const docs = await Model.find({}, { _id: 1 }).lean();
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const max = docs.reduce((m, d) => {
    const match = pattern.exec(d._id || "");
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `${prefix}${max + 1}`;
}
