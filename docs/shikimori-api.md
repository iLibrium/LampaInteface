# Shikimori API Reference (for anime tracking app / Lampa plugin)

Researched 2026-08-12. Sources: official docs (shikimori.io/api/doc), live API calls (curl), GraphQL introspection, shikimori-oauth2 gem docs. All examples below were verified against the live API on the research date unless marked otherwise.

---

## 0. Base facts

| Item | Value |
|---|---|
| Current base URL | `https://shikimori.io` (**important:** `shikimori.one` now returns `301 → https://shikimori.io/...` and the redirect response has NO CORS headers — browsers must call `.io` directly) |
| API versions | GraphQL (preferred by Shikimori), REST v2 (`/api/v2/...`), REST v1 (`/api/...`) — both REST versions marked "outdated" but fully working |
| Docs | `https://shikimori.io/api/doc/1.0`, `/api/doc/2.0.html`, `/api/doc/graphql` (GraphQL playground, JS-rendered), OAuth guide: `https://shikimori.io/oauth` |
| Protocol | HTTPS only |
| Rate limits | **5 rps and 90 rpm** (exceeding → 429; sustained abuse / missing User-Agent → IP ban) |
| User-Agent | **Required on every request.** Must contain your OAuth2 application name. "Otherwise your IP may be banned for further requests to Shikimori" |
| Auth | OAuth2 only (all other methods deprecated). Public read endpoints work without auth |
| Pagination quirk | "When you request N elements from paginated API, in most cases you will get N+1 results if API has next page" — the extra element is the has-next-page signal; slice to N and treat the extra as `hasNext` |
| Server | Behind DDoS-Guard (`Server: ddos-guard`); sets `__ddg*` cookies. Plain curl/fetch worked from a EU datacenter IP during research, but DDoS-Guard can serve JS challenges to some clients/regions |
| Timezone | All timestamps are Moscow time (`+03:00`) |

---

## 1. GET /api/animes — list / search

`GET https://shikimori.io/api/animes`

### Query parameters (verified from official v1 docs)

| Param | Type | Values / notes |
|---|---|---|
| `page` | int | 1..100000 |
| `limit` | int | **max 50** |
| `order` | string | `id`, `id_desc`, `ranked` (by score), `kind`, `popularity`, `name`, `aired_on`, `episodes`, `status`, `random`, `ranked_random`, `ranked_shiki`, `created_at`, `created_at_desc`, `updated_at`, `updated_at_desc` |
| `kind` | string | `tv`, `movie`, `ova`, `ona`, `special`, `tv_special`, `music`, `pv`, `cm`, plus TV-length pseudo-kinds `tv_13`, `tv_24`, `tv_48` |
| `status` | string | `anons`, `ongoing`, `released` |
| `season` | string | `summer_2026`, `2016`, `2014_2016`, `199x` (single season = `{winter|spring|summer|fall}_{year}`) |
| `score` | number | minimum score threshold (e.g. `score=8` → score ≥ 8) |
| `duration` | string | `S` (<10 min), `D` (<30 min), `F` (>30 min) |
| `rating` | string | `none`, `g`, `pg`, `pg_13`, `r`, `r_plus`, `rx` |
| `genre` | string | comma-separated genre IDs (from `/api/genres`) |
| `genre_v2` | string | comma-separated genre v2 IDs |
| `studio` | string | comma-separated studio IDs (from `/api/studios`) |
| `franchise` | string | comma-separated franchise names |
| `censored` | bool | `true` (default behavior) hides hentai/yaoi/yuri; `false` includes them |
| `mylist` | string | `planned`, `watching`, `rewatching`, `completed`, `on_hold`, `dropped` — filters by the **authorized** user's list (needs Bearer token) |
| `ids` | string | comma-separated anime IDs to fetch |
| `exclude_ids` | string | comma-separated anime IDs to exclude |
| `search` | string | text query by name (works with Russian and romaji) |

**Filter syntax:** comma = OR (`season=2016,2015`); `!` prefix = exclusion (`kind=!tv,!movie`); mixable (`season=2016,!summer_2016`). Applies to `kind`, `status`, `season`, `rating`, `duration`, `genre`, `studio`, `franchise`, `mylist`.

### Response — array of preview objects (live example, `?status=ongoing&order=popularity&limit=1&season=summer_2026`)

```json
[
  {
    "id": 59193,
    "name": "Mushoku Tensei III: Isekai Ittara Honki Dasu",
    "russian": "Реинкарнация безработного: История о приключениях в другом мире 3",
    "image": {
      "original": "/assets/globals/missing_original.jpg",
      "preview": "/assets/globals/missing_preview.jpg",
      "x96": "/assets/globals/missing_x96.jpg",
      "x48": "/assets/globals/missing_x48.jpg"
    },
    "url": "/animes/59193-mushoku-tensei-iii-isekai-ittara-honki-dasu",
    "kind": "tv",
    "score": "8.64",
    "status": "ongoing",
    "episodes": 14,
    "episodes_aired": 7,
    "aired_on": "2026-07-06",
    "released_on": "2026-09-28"
  }
]
```

Notes:
- `score` is a **string** in REST; number in GraphQL.
- `image.*` paths are relative → prepend `https://shikimori.io`. **Poster caveat (verified):** many newer titles return `/assets/globals/missing_*.jpg` placeholders via REST v1 while GraphQL `poster { originalUrl mainUrl }` returns the real image. If posters matter, use GraphQL (or fall back to `https://shikimori.io/system/animes/original/{id}.jpg`, which works for older titles).
- `episodes` = total planned, `episodes_aired` = aired so far (0 for released titles in the detail endpoint).
- `aired_on` / `released_on` are `YYYY-MM-DD` or `null`.

---

## 2. GET /api/animes/:id — full details

`GET https://shikimori.io/api/animes/5114`

All fields (documented structure + live 5114 verification):

```json
{
  "id": 5114,
  "name": "Fullmetal Alchemist: Brotherhood",
  "russian": "Стальной алхимик: Братство",
  "image": { "original": "/system/animes/original/5114.jpg?1711949773", "preview": "...", "x96": "...", "x48": "..." },
  "url": "/animes/z5114-fullmetal-alchemist-brotherhood",
  "kind": "tv",
  "score": "9.11",
  "status": "released",
  "episodes": 64,
  "episodes_aired": 0,
  "aired_on": "2009-04-05",
  "released_on": "2010-07-04",
  "rating": "r",
  "english": ["Fullmetal Alchemist: Brotherhood"],
  "japanese": ["鋼の錬金術師 FULLMETAL ALCHEMIST"],
  "synonyms": ["FMA", "FMAB", "..."],
  "license_name_ru": "Стальной алхимик: Братство",
  "duration": 24,
  "description": "Текст с BB-кодами вида [anime=121]...[/anime], [character=...]",
  "description_html": "<div class=\"b-text_with_paragraphs\">...</div>",
  "description_source": null,
  "franchise": "fullmetal_alchemist",
  "favoured": false,
  "anons": false,
  "ongoing": false,
  "thread_id": 270127,
  "topic_id": 270127,
  "myanimelist_id": 5114,
  "rates_scores_stats": [ { "name": 10, "value": 34460 }, { "name": 9, "value": 15600 } ],
  "rates_statuses_stats": [ { "name": "Запланировано", "value": 4326 }, { "name": "Просмотрено", "value": 70000 } ],
  "updated_at": "2022-11-26T17:19:33.411+03:00",
  "next_episode_at": null,
  "fansubbers": ["..."], "fandubbers": ["..."], "licensors": ["..."],
  "genres": [ { "id": 2, "name": "Adventure", "russian": "Приключения", "kind": "genre", "entry_type": "Anime" } ],
  "studios": [ { "id": 4, "name": "Bones", "filtered_name": "Bones", "real": true, "image": "/system/studios/original/4.png" } ],
  "videos": [ { "id": 1, "url": "https://youtube.com/watch?v=...", "image_url": "http://img.youtube.com/vi/.../hqdefault.jpg", "player_url": "http://youtube.com/embed/...", "name": "PV 1", "kind": "pv", "hosting": "youtube" } ],
  "screenshots": [ { "original": "/system/screenshots/original/....jpg", "preview": "/system/screenshots/x332/....jpg" } ],
  "user_rate": null
}
```

- `next_episode_at`: ISO timestamp for ongoing titles, `null` otherwise (also available in `/api/calendar` and GraphQL `nextEpisodeAt`).
- `user_rate`: the authorized user's rate object (see §6) or `null`; filled only with a Bearer token.
- `description` uses Shikimori BB-codes; `description_html` is ready-to-render HTML.
- `duration` is minutes per episode.

### Sub-endpoints (all `GET /api/animes/:id/...`)

| Endpoint | Returns |
|---|---|
| `/roles` | characters & staff |
| `/similar` | array of anime previews |
| `/related` | relations (`relation`, `relation_russian`, `anime`/`manga`) |
| `/screenshots` | screenshots array |
| `/franchise` | franchise graph (`nodes` + `links`) |
| `/external_links` | see below |
| `/topics` | forum topics (incl. episode topics) |
| `/videos` | PV/OP/ED videos |

### GET /api/animes/:id/external_links (live-verified on 5114)

`kind` values actually observed: `official_site`, `wikipedia`, `anime_news_network`, `myanimelist`, `anime_db` (AniDB), `world_art`, `kinopoisk`, `kage_project`, `twitter`. Others that exist in schema: `smotret_anime`, `amediateka`, `crunchyroll`, `wink`, `okko`, `kinopoisk_hd`, `netflix`, `readmanga`, `mangalib`, etc.

```json
{"id":43780903,"kind":"kinopoisk","url":"https://www.kinopoisk.ru/series/452838/","source":"shikimori","entry_id":5114,"entry_type":"Anime","created_at":"2020-01-13T20:27:51.859+03:00","updated_at":"2020-02-09T12:27:14.087+03:00","imported_at":null}
```

**IMDB/TMDB: NOT provided.** Kinopoisk links ARE provided (not for every title). For IMDB/TMDB mapping use `myanimelist_id` (always present, equals Shikimori id for most titles) + an external mapping (e.g. Kitsu/ARM/animeApi `Fribb/anime-lists` MAL→TMDB/IMDB mapping), or parse the Kinopoisk id from the `kinopoisk` link.

---

## 3. GET /api/calendar — ongoing episode schedule

`GET https://shikimori.io/api/calendar[?censored=false]`

- `censored` (optional, default `true`): `false` includes hentai/yaoi/yuri.
- Returns a flat array (one element per upcoming episode of each ongoing/anons title), sorted by `next_episode_at`.

Live example (2026-08-12):

```json
[
  {
    "next_episode": 7,
    "next_episode_at": "2026-08-13T15:30:00.000+03:00",
    "duration": 1380,
    "anime": {
      "id": 63082,
      "name": "Reiwa no Dara-san",
      "russian": "Дара из Рэйвы",
      "image": { "original": "...", "preview": "...", "x96": "...", "x48": "..." },
      "url": "/animes/63082-reiwa-no-dara-san",
      "kind": "tv",
      "score": "6.82",
      "status": "ongoing",
      "episodes": 13,
      "episodes_aired": 6,
      "aired_on": "2026-07-02",
      "released_on": "2026-09-24"
    }
  }
]
```

- `next_episode` = number of the upcoming episode; `next_episode_at` = its air time (MSK); `duration` = minutes until airing at generation time (can be `null`; observed values like `120`, `1380`).
- `anime` is the standard preview object (§1). Entries with `status: "anons"` (premieres) also appear.
- No pagination — one full array (~can be 100+ entries). Cache it; refresh a few times per day.

---

## 4. GET /api/genres

`GET https://shikimori.io/api/genres` — no params in v1 (GraphQL variant accepts `entryType: Anime|Manga`). Returns full array (90 entries at research time), mixed Anime + Manga — **filter by `entry_type": "Anime"` client-side**.

```json
[
  {"id":8,"name":"Drama","russian":"Драма","kind":"genre","entry_type":"Anime"},
  {"id":11,"name":"Game","russian":"Игры","kind":"genre","entry_type":"Anime"},
  {"id":40,"name":"Psychological","russian":"Психологическое","kind":"genre","entry_type":"Anime"},
  {"id":47,"name":"Shounen","russian":"Сёнен","kind":"genre","entry_type":"Manga"}
]
```

In GraphQL, `kind` distinguishes `genre` / `demographic` / `theme` (e.g. Shounen = demographic, Military = theme). Use `id` values in `/api/animes?genre=...`. Related: `GET /api/studios` → `[{id, name, filtered_name, real, image}]`.

---

## 5. OAuth2

### Registration
Create app at **`https://shikimori.io/oauth/applications`** → get `client_id`, `client_secret`. Set redirect URI(s); `urn:ietf:wg:oauth:2.0:oob` is allowed as redirect URI.

### Scopes
`user_rates` (modify anime/manga lists — the one a tracker needs), `email`, `messages`, `comments`, `topics`, `content`, `clubs`, `friends`, `ignores`. Scope string joins with `+` (URL-encoded space): `scope=user_rates`.

### Authorization (authorization_code)

```
https://shikimori.io/oauth/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=user_rates
```

**Device-style / TV flow (verified supported):** with `redirect_uri=urn:ietf:wg:oauth:2.0:oob`, after login Shikimori shows the authorization code on a page (`/oauth/authorize/native?code=...`) for the user to copy into the app — no callback server needed. Ideal for Lampa/TV: show the URL/QR, let the user paste the code.

### Token exchange

```bash
curl -X POST "https://shikimori.io/oauth/token" \
  -H "User-Agent: APPLICATION_NAME" \
  -F grant_type="authorization_code" \
  -F client_id="CLIENT_ID" \
  -F client_secret="CLIENT_SECRET" \
  -F code="AUTHORIZATION_CODE" \
  -F redirect_uri="REDIRECT_URI"      # must equal the one used in /oauth/authorize (incl. oob)
```

Response: `{"access_token":"...","token_type":"Bearer","expires_in":86400,"refresh_token":"...","scope":"user_rates","created_at":...}`

- **Access token lives 1 day.** Expired → `401 {"error":"invalid_token"}`.
- Refresh: `POST /oauth/token` with `grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=...` → new access + new refresh token (rotate stored refresh token).

### Authenticated requests

```bash
curl https://shikimori.io/api/users/whoami \
  -H "User-Agent: APPLICATION_NAME" \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

`GET /api/users/whoami` → `{id, nickname, avatar, image{x160,x148,x80,x64,x48,x32,x16}, last_online_at, url, name, sex, website, birth_on, full_years, locale}`. **Verified: without/with invalid token it returns `null` with HTTP 200** — check for `null`, not just status.

⚠ `client_secret` in a pure browser app is exposable; Shikimori has no PKCE — acceptable for hobby plugins (secret is not treated as strongly confidential in this ecosystem), or proxy the token exchange through a tiny backend.

---

## 6. User rates (anime lists)

### Read (public, no auth needed)

`GET /api/users/:id/anime_rates?page=1&limit=100&status=watching&censored=true`
- `limit` max **5000**; `status`: `planned|watching|rewatching|completed|on_hold|dropped`.
- `:id` can be numeric id or nickname (nickname needs `?is_nickname=1` on `/api/users/:nickname`).

```json
[
  {
    "id": 33, "score": 8, "status": "watching", "text": null,
    "episodes": 7, "chapters": null, "volumes": null,
    "text_html": "", "rewatches": 0,
    "created_at": "2026-08-01T10:00:00.000+03:00",
    "updated_at": "2026-08-12T10:00:00.000+03:00",
    "user":  { "id": 1, "nickname": "...", "avatar": "...", "image": {}, "last_online_at": "...", "url": "..." },
    "anime": { "id": 63082, "name": "...", "russian": "...", "image": {}, "url": "...", "kind": "tv", "score": "6.82", "status": "ongoing", "episodes": 13, "episodes_aired": 6, "aired_on": "2026-07-02", "released_on": null },
    "manga": null
  }
]
```

### v2 CRUD (write needs Bearer token + `user_rates` scope)

| Method & path | Purpose |
|---|---|
| `GET /api/v2/user_rates?user_id=&target_id=&target_type=Anime&status=&page=&limit=` | list rates (flat objects: `{id, user_id, target_id, target_type, score, status, rewatches, episodes, volumes, chapters, text, text_html, created_at, updated_at}`) |
| `GET /api/v2/user_rates/:id` | one rate |
| `POST /api/v2/user_rates` | create — body `{"user_rate":{"user_id":U,"target_id":A,"target_type":"Anime","status":"watching","score":8,"episodes":3,"rewatches":0,"text":""}}` |
| `PATCH /api/v2/user_rates/:id` | update (same fields; send only what changes, e.g. `{"user_rate":{"episodes":4}}`) |
| `DELETE /api/v2/user_rates/:id` | remove from list |
| `POST /api/v2/user_rates/:id/increment` | **+1 episode with one request** — perfect for a "watched next episode" button |

`target_type`: `Anime` or `Manga` (capitalized). `status` values as above. `score` 0–10 (0 = unrated). Also: `POST /api/v2/episode_notifications` (partner endpoint to notify about releases).

Old v1 `POST/PATCH/DELETE /api/user_rates` is deprecated — use v2.

---

## 7. Rate limits & CORS (verified with live requests)

- Limits: **5 rps / 90 rpm** per IP/token. On 429 back off ≥1 s. Batch via `ids=` and GraphQL to stay under.
- **CORS is OPEN** — response headers captured live from `https://shikimori.io/api/...`:

```
access-control-allow-origin: *
access-control-allow-methods: GET, OPTIONS, POST, PUT, PATCH, DELETE
access-control-max-age: 7200
access-control-allow-headers: authorization    (echoed on OPTIONS preflight)
```

  → A browser/TV-webview app (Lampa plugin) **can call the API directly**, including authorized requests (the `Authorization` header passes preflight). GraphQL endpoint shares the same behavior.

- **Pitfalls for browser use:**
  1. Call `https://shikimori.io` directly. `shikimori.one` answers `301` (via DDoS-Guard) **without** CORS headers → browser `fetch` dies on the redirect.
  2. Browsers can't set `User-Agent` from JS (forbidden header) — for browser apps the UA rule is effectively waived (the browser's UA is sent); pass your app name in OAuth requests where possible. Non-browser callers MUST set it.
  3. DDoS-Guard may serve a JS challenge (HTML instead of JSON) for suspicious clients/regions/old TV webviews. Lampa-ecosystem workaround: route through a reverse proxy — plugins typically try direct fetch first, then fall back to a CORS/mirror proxy (own tiny proxy on a VPS, a Cloudflare Worker, or generic proxies like `corsproxy.io` / community Lampa proxies, e.g. the `api.*`/`cors.*` hosts plugins bundle). Since ACAO is `*`, a plain pass-through proxy suffices — no header rewriting needed.

---

## 8. GraphQL

Endpoint: `POST https://shikimori.io/api/graphql` (playground/docs at `https://shikimori.io/api/doc/graphql`). Content-Type `application/json`, body `{"query": "...", "variables": {...}}`. Auth: same `Authorization: Bearer` header. Max query depth: **5** (introspection deeper than 5 is rejected: "Query has depth of 7, which exceeds max depth of 5").

Top-level queries (introspected live): `animes`, `mangas`, `characters`, `people`, `users`, `userRates`, `genres`, `contests`, `currentUser`.

`animes` arguments (introspected): `page`, `limit` (max 50), `order` (enum, same values as REST), `kind`, `status`, `season`, `score`, `duration`, `rating`, `origin`, `genre`, `studio`, `franchise`, `censored` (Boolean), `mylist`, `ids`, `excludeIds`, `search` — string filters use the same comma/`!` syntax as REST.

`userRates` arguments: `page`, `limit`, `userId`, `targetType` (`Anime`/`Manga`), `status`, `order` (`{field: updated_at, order: desc}`). `genres(entryType: Anime)`.

### Example 1 — anime search with filters (verified live)

```graphql
{
  animes(search: "fullmetal", limit: 2, order: ranked, status: "released", kind: "tv,movie") {
    id malId name russian licenseNameRu english japanese
    kind score status episodes episodesAired duration rating season
    airedOn { year month day date } releasedOn { date }
    url
    poster { originalUrl mainUrl }
    genres { id name russian kind }
    studios { id name }
    nextEpisodeAt
  }
}
```

Live response (trimmed):

```json
{"data":{"animes":[{
  "id":"9135","malId":"9135","name":"Fullmetal Alchemist: The Sacred Star of Milos",
  "russian":"Стальной алхимик: Священная звезда Милоса","kind":"movie","score":7.26,
  "status":"released","episodes":1,"episodesAired":0,"duration":110,"rating":"r","season":null,
  "airedOn":{"year":2011,"month":7,"day":2,"date":"2011-07-02"},"releasedOn":{"date":null},
  "url":"https://shikimori.io/animes/z9135-...",
  "poster":{"originalUrl":"https://shikimori.io/uploads/poster/animes/9135/994afeda....jpeg",
            "mainUrl":"https://shikimori.io/uploads/poster/animes/9135/main-ffb5c....webp"},
  "genres":[{"id":"27","name":"Shounen","russian":"Сёнен","kind":"demographic"},
            {"id":"1","name":"Action","russian":"Экшен","kind":"genre"}],
  "studios":[{"id":"4","name":"Bones"}],
  "nextEpisodeAt":null}]}}
```

Note: GraphQL ids are strings; `score` is a number; `poster` gives absolute URLs (more reliable than REST `image`). Other useful anime fields: `description`, `descriptionHtml`, `screenshots { originalUrl x332Url }`, `videos { url name kind }`, `externalLinks { kind url }`, `related { relationRu anime { id } }`, `userRate { id status episodes score }`, `scoresStats { score count }`, `statusesStats { status count }`, `fansubbers`, `fandubbers`, `licensors`, `createdAt`, `updatedAt`, `isCensored`.

### Example 2 — user's list (verified live)

```graphql
{
  userRates(userId: 1, targetType: Anime, status: watching, limit: 50, page: 1,
            order: { field: updated_at, order: desc }) {
    id status score episodes rewatches text createdAt updatedAt
    anime { id name russian poster { previewUrl } episodes episodesAired status nextEpisodeAt }
  }
}
```

Live response (trimmed):

```json
{"data":{"userRates":[{"id":"195913781","status":"watching","score":0,"episodes":1,
  "rewatches":0,"text":null,"createdAt":"2025-07-05T17:33:16+03:00",
  "updatedAt":"2025-07-13T19:15:58+03:00",
  "anime":{"id":"57334","name":"Dandadan","russian":"Дандадан"}}]}}
```

With a Bearer token, `currentUser { id nickname avatarUrl }` identifies the user (returns `null` unauthenticated — verified), and `userRates` without `userId` returns the current user's rates. GraphQL has **no mutations** for user_rates — writes go through REST v2 (§6).

---

## 9. Cheat-sheet for the tracker app

| Need | Call |
|---|---|
| Browse/search catalog | `GET /api/animes?search=&status=&season=&genre=&order=ranked&limit=50&page=1` or GraphQL `animes` (better posters) |
| Title card | `GET /api/animes/:id` (+ `/screenshots`, `/similar`, `/external_links`) or one GraphQL query |
| Episode calendar | `GET /api/calendar` → filter by ids of user's `watching` list |
| Genres for filter UI | `GET /api/genres` (filter `entry_type == "Anime"`) |
| Login | OAuth2 code flow; TV: `redirect_uri=urn:ietf:wg:oauth:2.0:oob`, user pastes code; refresh daily |
| Who am I | `GET /api/users/whoami` (null = not authed) |
| Read list | GraphQL `userRates` or `GET /api/users/:id/anime_rates?limit=5000` |
| Add/update/rate | `POST/PATCH /api/v2/user_rates` |
| "+1 episode" button | `POST /api/v2/user_rates/:id/increment` |
| Kinopoisk link | `GET /api/animes/:id/external_links` → `kind == "kinopoisk"`; IMDB/TMDB absent — map via `myanimelist_id` |
