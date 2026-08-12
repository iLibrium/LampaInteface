# Matching Shikimori (MAL) anime to TMDB entries — research report

Date: 2026-08-12. All URLs and JSON samples below were verified live on this date.
Context: Shikimori ids ARE MyAnimeList ids (`shikimori.one/animes/{id}` == `myanimelist.net/anime/{id}`),
so the task reduces to **MAL id -> TMDB id** mapping, with a title-search fallback.

---

## 1. Prior art: te9c/jellyfin-plugin-shikimori

Repo: <https://github.com/te9c/jellyfin-plugin-shikimori> (C#, Jellyfin metadata plugin, result language `ru`).

Key files (branch `master`, prefix `Jellyfin.Plugin.Shikimori/`):

- `ProviderIdResolver.cs` — id resolution
- `SearchHelper.cs` — title preprocessing before search
- `ShikimoriClientManager.cs` — search + kind/year filtering
- `Providers/ShikimoriSeriesProvider.cs`, `Providers/ShikimoriMovieProvider.cs` — providers
- `Providers/ShikimoriExternalId.cs` — registers "Shikimori" as an external id on Series/Movie
- `Api/ShikimoriApi.cs`, `Api/ApiModel.cs` — REST client for `shikimori.one/api`

**Matching strategy (direction: Jellyfin library item -> Shikimori, NOT via TMDB):**

1. **Stored provider id**: reads `ProviderIds["Shikimori"]` if the item was already matched.
2. **Filename tag**: regex `\[shikimori-?(\d+)\]` over the file path (RightToLeft, case-insensitive) —
   users can pin the match by naming folders `Title [shikimori-12345]`.
3. **Name search fallback** against the Shikimori API (`SearchAnimesAsync`), with:
   - title preprocessing (`SearchHelper.PreprocessTitle`, copied from the AniList Jellyfin plugin):
     strip ` S01`/`.S1` season designators, `~alt name~`, trailing `(English Name)` parens,
     `&` -> `and`, `#` -> space, and the Jellyfin folder suffix `(2006) [tvdbid-79414]`;
   - kind filter: TV maps to Shikimori kinds `tv,ona,ova`; Movie maps to `movie`;
   - **year tolerance of ±1** between Jellyfin's year and Shikimori `airedOn.year`.

**Takeaways for us:** it never touches TMDB and uses no cross-reference DB — pure name search with
preprocessing + kind + year window. That confirms the pattern (normalize title, constrain by type and
year) but we can do much better by putting an id-mapping database first.

Note: Shikimori's own `GET /api/animes/{id}/external_links` returns official_site, wikipedia, etc. —
**no TMDB link**, so Shikimori itself cannot give us the TMDB id.

---

## 2. Cross-reference databases

### 2.1 Fribb/anime-lists — RECOMMENDED primary source

Repo: <https://github.com/Fribb/anime-lists>. Auto-generated (via
[anime-lists-generator](https://github.com/Fribb/anime-lists-generator)) by merging:
1. `manami-project/anime-offline-database` (MAL/AniList/Kitsu/AniDB/... ids, no TMDB)
2. `Anime-Lists/anime-lists` (`anime-list-full.xml`: AniDB -> TVDB/TMDB/IMDB with season mapping)

Entries are merged over `anidb_id`.

**Files (root, sizes as of 2026-08-12):**

| File | Size | Notes |
|---|---|---|
| `anime-list-full.json` | 7,511,152 B | pretty-printed, all fields |
| `anime-list-mini.json` | 5,866,990 B | **same fields, minified** (~1.13 MB gzipped over CDN — measured) |
| `anime-lists-reduced.json` | 1,238,396 B | only the AniDB->TVDB/TMDB/IMDB part |
| `anime-offline-database-reduced.json` | 6,269,087 B | only the platform-ids part (no TMDB) |
| `indices/mal_index.json` | 1,899,942 B | `mal_id -> {"anime-list":[array positions], "collection":[...]}` |
| `indices/themoviedb_index.json` | 307,211 B | keys like `"movie:100271"` / `"tv:26209"` -> positions |
| `collections/mal_collection.json` | 367,137 B | franchise groups: `[{"name":"3x3 Eyes","ids":[300,1225]}]` |

**Raw URLs (CORS: `Access-Control-Allow-Origin: *` verified on both hosts):**

- `https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json`
- `https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json`
- CDN (also ACAO `*`, gzip ~1.13 MB): `https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-mini.json`
- `https://raw.githubusercontent.com/Fribb/anime-lists/master/indices/mal_index.json`

**JSON shape (real entry from `anime-list-mini.json`):**

```json
{
  "type": "TV",
  "anidb_id": 1,
  "anilist_id": 290,
  "animecountdown_id": 36462,
  "animenewsnetwork_id": 14,
  "anime-planet_id": "crest-of-the-stars",
  "anisearch_id": 3039,
  "imdb_id": ["tt0286390"],
  "kitsu_id": 265,
  "livechart_id": 4157,
  "mal_id": 290,
  "simkl_id": 36462,
  "themoviedb_id": { "tv": 26209 },
  "tvdb_id": 72025,
  "season": { "tvdb": 1, "tmdb": 1 }
}
```

Field semantics (from README + data inspection):

- `type`: `TV | MOVIE | OVA | ONA | SPECIAL | ...`
- `themoviedb_id`: object; `{"tv": <number>}` (single id) **or** `{"movie": [<number>, ...]}`
  (array — several MAL movies can map to several TMDB movies under one AniDB id). This asymmetry
  is intentional per the README.
- `imdb_id`: **array** of `tt...` strings.
- `season`: `{"tvdb": N, "tmdb": N}` — which season of the TVDB/TMDB *show* this MAL entry is
  (0 = specials). `episode_offset`: `{"tvdb": N, "tmdb": N}` — offset when a MAL entry starts
  mid-season (absolute-numbered shows).
- Any field may be absent (many entries have no `themoviedb_id`).
- `indices/mal_index.json` values are **array positions inside `anime-list-full.json`**, not ids —
  usable only together with the main list, so for a browser plugin it is easier to build your own
  `mal -> tmdb` map once.

### 2.2 ARM: arm.haglund.dev (BeeeQueue/arm-server) — RECOMMENDED for on-demand lookups

Docs: <https://arm.haglund.dev/docs> - Repo: <https://github.com/BeeeQueue/arm-server> (v2.1.0, AGPL).
**Data source is exactly Fribb/anime-lists, auto-refreshed every 24 h**, plus manual fix-up rules.

Supported sources: `anidb, anilist, anime-planet, animecountdown, animenewsnetwork, anisearch,
imdb, kitsu, livechart, myanimelist, simkl, themoviedb, thetvdb`.

**Endpoints (all verified live):**

- `GET https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=21` ->

  ```json
  {"anidb":69,"anilist":21,"animecountdown":38636,"animenewsnetwork":null,
   "anime-planet":"one-piece","anisearch":2227,"imdb":"tt0388629","kitsu":12,
   "livechart":321,"myanimelist":21,"media":"TV","simkl":38636,
   "themoviedb":37854,"themoviedb-season":null,"thetvdb":81797,"thetvdb-season":null}
  ```

  **Yes, it returns `themoviedb`** (single number), plus `media` (`TV`/`MOVIE`/...) which tells you
  whether that TMDB id is a tv show or a movie, and `themoviedb-season` when known.
- `include` param trims the response:
  `GET .../api/v2/ids?source=myanimelist&id=32281&include=themoviedb,imdb,thetvdb` ->
  `{"themoviedb":372058,"imdb":"tt5311514","thetvdb":null}` (Your Name, `media:"MOVIE"`).
- **Batch POST** (ideal for a Lampa catalog page):

  ```
  POST https://arm.haglund.dev/api/v2/ids?include=myanimelist,themoviedb,thetvdb,imdb
  Content-Type: application/json
  [{"myanimelist":5114},{"myanimelist":38000},{"myanimelist":9999999}]
  ```

  -> `[{"myanimelist":5114,"themoviedb":31911,...},{...,"themoviedb":85937,...},null]`
  Misses are `null` (never 404) and array order is preserved.
- Reverse lookup: `GET /api/v2/themoviedb?id=37854` -> array of matching entries (one-to-many).
- **CORS: friendly** — verified: request with `Origin: http://lampa.mx` got
  `access-control-allow-origin: http://lampa.mx` + `access-control-expose-headers: *`.
  Cloudflare-fronted; no documented rate limit, but it is a free community service — cache results
  and prefer batch POST.

### 2.3 Kitsu mappings — NOT useful for TMDB

`GET https://kitsu.io/api/edge/anime/{kitsu_id}/mappings` returns `externalSite`/`externalId` pairs
(`myanimelist/anime`, `thetvdb/series`, `anidb`, `hulu`, `aozora`, ...). Verified on anime/1:
**no TMDB mapping exists**. Skip.

### 2.4 manami-project/anime-offline-database — NOT useful directly

<https://github.com/manami-project/anime-offline-database> aggregates 10 anime sites (MAL, AniList,
Kitsu, AniDB, Anime-Planet, AniSearch, Simkl, LiveChart, ANN, AnimeCountdown) as a `sources[]` array
of URLs per entry. **No TMDB/TVDB/IMDB ids.** It is already merged into Fribb's list; datasets now
live in GitHub Releases, not the repo. Skip (use Fribb instead).

---

## 3. TMDB API fallback (title search)

Base `https://api.themoviedb.org/3`, auth via `api_key=` query or Bearer token.
**CORS: `Access-Control-Allow-Origin: *`** (verified). Constants: genre **16 = Animation**,
keyword **210024 = "anime"** (verified at <https://www.themoviedb.org/keyword/210024-anime>).

- Search TV: `GET /search/tv?query={title}&first_air_date_year={year}&language=ru-RU&include_adult=false&page=1`
- Search movie: `GET /search/movie?query={title}&year={year}&language=ru-RU`
  (`year` matches any release; `primary_release_year` is stricter)
- Discover (browse/verify): `GET /discover/tv?with_keywords=210024&with_origin_country=JP&sort_by=popularity.desc`
  - also useful: `with_genres=16`, `first_air_date.gte=YYYY-MM-DD`, `first_air_date.lte=YYYY-MM-DD`,
    `air_date.gte/lte`, `vote_count.gte`; movies: `/discover/movie?with_keywords=210024&with_origin_country=JP`
  - `with_keywords`/`with_genres` accept comma (AND) or pipe (OR) lists.
- **External-id bridge** (gold for entries where Fribb has imdb/tvdb but no tmdb):
  `GET /find/{tt0286390}?external_source=imdb_id` or `GET /find/{81797}?external_source=tvdb_id`
  -> `{ "tv_results":[...], "movie_results":[...] }`.
- Detail check: `GET /tv/{id}?language=ru-RU` (has `genres`, `origin_country`, `first_air_date`,
  `seasons[]`); `GET /tv/{id}/external_ids` returns `tvdb_id`, `imdb_id` for reverse verification.
- Search result fields for scoring: `id, name/title, original_name/original_title,
  original_language ("ja"), origin_country (["JP"]), first_air_date/release_date,
  genre_ids ([16,...]), popularity, vote_count`.

`/search/*` cannot be filtered by genre/keyword — filter client-side on `genre_ids.includes(16)`
and `original_language === "ja"` / `origin_country.includes("JP")`.

---

## 4. The seasons problem

MAL/Shikimori: one entry **per season/cour** (e.g. Seikai no Monshou mal 290 and its sequels
mal 396/397 are separate). TMDB: **one TV entry with seasons** (all map to tmdb tv 26209).

How Fribb encodes it (real data):

```json
{"type":"TV","mal_id":290, "themoviedb_id":{"tv":26209}, "season":{"tvdb":1,"tmdb":1}}
{"type":"TV","mal_id":396, "themoviedb_id":{"tv":26209}, "season":{"tvdb":2,"tmdb":2}}
{"type":"OVA","mal_id":300,"themoviedb_id":{"tv":62913}, "season":{"tvdb":1,"tmdb":1}}
```

i.e. many MAL ids -> same TMDB show id, disambiguated by `season.tmdb` (and `episode_offset.tmdb`
when a MAL entry starts mid-season). ARM exposes the same as `themoviedb-season`.

**Practical recommendation for a Lampa plugin:** do NOT try to deep-link to a specific season.
Lampa's card is per-show (`Lampa.Activity.push({component:'full', method:'tv'|'movie', id:<tmdb>, source:'tmdb'})`),
and the show card already lists seasons/torrents. So: map MAL entry -> TMDB **show** id, open the show
card; optionally keep `season.tmdb` to preselect/highlight the season or to annotate the card
("это 2 сезон"). Movies map 1:1 (`themoviedb_id.movie[0]`) — open the movie card. Consequence:
several Shikimori entries legitimately open the same TMDB card — that is correct behavior.

---

## 5. Recommended matching algorithm (for a Lampa plugin, browser JS)

**Layer 0 — cache.** `localStorage`/`IndexedDB` map `mal:<id> -> {tmdb, media, season} | "none"`,
TTL ~7-30 days (also cache negatives).

**Layer 1 — id mapping (covers the vast majority of titles, zero ambiguity).** Two interchangeable
backends, both CORS-verified:

- **ARM API (lazy, on-demand)** — best default. Single:
  `GET https://arm.haglund.dev/api/v2/ids?source=myanimelist&id={malId}&include=themoviedb,thetvdb,imdb`
  (add `media`/`themoviedb-season` by omitting `include`). For catalog pages, batch:
  `POST /api/v2/ids?include=myanimelist,themoviedb,thetvdb,imdb` with `[{"myanimelist":id},...]` —
  misses come back as `null` in-order.
- **Fribb bulk JSON (offline-friendly, no third-party runtime dep)** — fetch
  `https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-mini.json` once (~1.13 MB gzip),
  reduce to `{ [mal_id]: {t:'tv'|'movie', id, s} }` from `themoviedb_id` + `type` + `season.tmdb`,
  persist in IndexedDB, refresh weekly. (Even better: precompute this ~200-300 KB condensed map at
  plugin build/CI time and ship/host it yourself.)

Resolution from a mapping hit:
1. `themoviedb` present -> done. `media`/`type` in (`MOVIE`) -> movie card, else tv card.
2. No `themoviedb` but `imdb` or `thetvdb` -> TMDB `GET /find/{id}?external_source=imdb_id|tvdb_id`,
   take first of `tv_results`/`movie_results`.

**Layer 2 — TMDB title search fallback (only when Layer 1 misses — mostly very new or obscure titles).**

Inputs from Shikimori API: `name` (romaji), `english`/`japanese` (may be null), `russian`,
`kind` (tv/ona/ova/special -> `/search/tv`; movie -> `/search/movie`), `aired_on` year.

```
candidates = []
for title in [english, name(romaji), russian]:          // in that order, dedup, skip null
    q = preprocess(title)   // strip "2nd Season"/"Part 2"/"Cour 2"/"(TV)", trailing parens, & -> and
    r = /search/{tv|movie}?query=q&first_air_date_year=year   // and retry once WITHOUT year if empty
    candidates += r.results
score(c) = 3*titleSim + 2*yearScore + genreAnime + origin + log10(popularity)/10
  titleSim  = max over [name, original_name] of normalized similarity
              (lowercase, strip diacritics/punct; token-set Dice or Levenshtein ratio), 0..1
  yearScore = 1 if |year(c) - airedYear| == 0; 0.5 if ==1; else 0
  genreAnime= 1 if c.genre_ids.includes(16) else 0     // hard-reject if absent
  origin    = 1 if original_language=='ja' || origin_country.includes('JP') else 0
pick best if score >= threshold (~4.0 of max ~7) AND titleSim >= 0.75; else "not found"
```

Optional verification of a low-confidence pick: `GET /tv/{id}/keywords` contains id 210024, or
`GET /tv/{id}/external_ids` -> `tvdb_id` -> ARM `/api/v2/ids?source=thetvdb&id=...` round-trips to
the same MAL id (strongest check).

**Layer 3 — UX.** On hit: `Lampa.Activity.push` the TMDB card (`method: media==='MOVIE'?'movie':'tv'`).
On miss: fall back to Lampa's own TMDB search screen prefilled with the best title, so the user picks.

**Why this order:** Fribb/ARM is curated and season-aware — it resolves exactly the cases where title
search fails (sequels named "X 2nd Season", franchises where every season shares one TMDB show,
OVAs mapped to specials S0). Title search alone (the jellyfin-shikimori approach) is only acceptable
as a last resort with the scoring above.
