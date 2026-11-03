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

## Audience Voice: comment analysis (commentInsights.js)

This is the client portal's Insights → Audience Voice section: what people said in the comments on a brand's live Instagram posts, the same posts as the portal's Content tab.

How it works:

1. **Fetch.** `/v2/media/comments` (HikerAPI) returns about 15 comments per request. Up to `COMMENTS_PER_POST` (100) are fetched per post, using the media id from `reel_cache`. They are stored in `post_comments`.
2. **Per-post read.** One Gemini call per post labels every comment (positive / neutral / negative / spam) and picks out themes, questions, buying intent and highlights. It refers to comments **by number**, so every quote shown to a client is a real comment. A post whose comments haven't changed is never re-read.
3. **Brand read.** One more Gemini call writes the headline, summary, merged themes, praise, concerns and recommendations. The result is stored in `comment_insights`.

Routes:

| Route | Use |
|---|---|
| `GET /api/portal/comment-insights?brand=` | What the portal shows. Read-only; nothing is fetched on page load. |
| `GET /api/comment-insights/:brandId` | Status for the internal app's panel (campaign → Insights tab). |
| `POST /api/comment-insights/:brandId/refresh` `{ force? }` | Runs in the background. `force` re-fetches comments that are less than a week old. |

When it runs: a scheduler job (`comment-insights-refresh`, 03:00 IST) checks every night but only refreshes brands whose analysis is older than `COMMENTS_REFRESH_DAYS` (7), so it is weekly in effect. It also runs when someone presses Refresh in the internal app.

Settings: `GEMINI_API_KEY` (the same one AVA uses), `COMMENTS_PER_POST` (100), `COMMENTS_REFRESH_DAYS` (7), `COMMENTS_MAX_REQUESTS_PER_RUN` (600 HikerAPI requests), and `COMMENTS_GEMINI_MODELS` (Flash-Lite, as AVA uses).

Test (fake HikerAPI and Gemini, real MongoDB): `MONGO_TEST_URI=mongodb://127.0.0.1:27017 node test/commentInsights.test.mjs`
