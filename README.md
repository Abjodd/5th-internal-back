# 5th-internal-back

## Several people on one campaign (campaignSync.js)

Campaign edits are saved field by field, never as whole lists:

| Route | What it writes |
|---|---|
| `PATCH /api/campaigns/:id/creators/:crId` | `{ set, from, force?, actor }`, only the fields of one roster row that changed |
| `POST /api/campaigns/:id/creators` | adds rows (a row whose `_id` is already there is skipped) |
| `DELETE /api/campaigns/:id/creators/:crId` | removes one row |
| `PATCH /api/campaigns/:id/fields` | campaign fields by path (`stage`, `budget`, `brief.objective`, …) |
| `POST /api/campaigns/:id/timeline` | appends one entry (idempotent on `tid`) |
| `GET /api/campaigns/:id`, `GET /api/campaigns-revs` | one campaign; the `rev` of each campaign |
| `GET /api/live`, `POST /api/live/presence` | live change and "who's here" stream (server-sent events) |

How it behaves:

- **Clashes.** `from` is the value the person started from. If someone else saved a different value in the meantime, the write is refused with `409 { conflicts: [{ path, current, yours, by, at }] }`. Nothing is written, and the app asks "keep theirs / use mine" (`force: true`). The same value from two people is not a clash.
- **Atomic writes.** Each write is guarded by the row's `rev` (or the campaign's `rev`) and retried if another write landed in between.
- **Old clients.** `PATCH /api/campaigns/:id` refuses a whole `creators` or `timeline` list with `409 { outdated: true }`. The fix is to refresh the tab. `?legacy=1` bypasses this for one-off scripts.
- **Nightly metrics.** The metrics job writes only each row's counts, onto the row as it is now.
- **Startup.** `ensureRowIds()` gives `_id`s to any legacy rows when the server boots.
- **One instance only.** The live stream is held in memory, so this relies on running a single instance. Running more would need a shared pub/sub such as Redis.

Test it (needs a MongoDB; uses and drops a throwaway database):

```bash
MONGO_TEST_URI=mongodb://127.0.0.1:27017 node test/campaignSync.test.mjs
```
