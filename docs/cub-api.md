# CUB — Lampa cloud service: API research

Research date: 2026-08-12.
Primary source: Lampa app source code — https://github.com/yumata/lampa-source (the `yumata/lampa` repo is only the built output: `app.min.js`). Secondary: official REST docs at https://cub.rip/developer/ (JS-rendered, sparse).

---

## 0. Domains and mirrors

From `src/core/manifest.js`:

| Property | Value |
|---|---|
| `cub_site` | `cub.rip` (current official site) |
| `cub_mirrors` | `['cub.rip', 'durex.monster', 'cubnotrip.top']` + user list from localStorage `cub_mirrors` |
| `old_mirrors` (legacy, compat) | `['cub.red', 'standby.cub.red', 'kurwa-bober.ninja', 'nackhui.com']` |
| `soc_mirrors` (WebSocket) | `['cub.rip', 'kurwa-bober.ninja', 'nackhui.com']` |
| `cub_domain` | localStorage `cub_domain` if it is in the mirror list, else `cub_mirrors[0]` |
| `github_lampa` | `https://yumata.github.io/lampa/`, or `http://lampa.mx/` when `lampa_settings.fix_widget` (lampa.mx is an app-files mirror, not the accounts server) |

All account calls go to `{http|https}://{cub_domain}/api/...`. Subdomain services: `tmdb.{cub_domain}` (CUB catalog), `apitmdb.{cub_domain}` (TMDB API proxy), `imagetmdb.{cub_domain}` (premium image proxy). WebSocket: `wss://{soc_mirror}` (`src/core/socket.js`).

---

## 1. What CUB is

CUB is Lampa's account/cloud service (module `src/core/account/*`, exposed as `Lampa.Account`). It syncs, per account **profile**:

- **Bookmarks** — the cloud version of local favorites: categories `wath` (watching), `book` (planned), `like`, `history` plus marks `look`, `viewed`, `scheduled`, `continued`, `thrown`
- **Timeline** — watch progress (percent/time/duration per file hash)
- **Notices** — new-episode / new-quality notifications
- **Notifications** — subscriptions to a translation/voice for a show
- **Profiles** (multi-profile, child profiles), **devices** (code-based pairing), **plugins list**, reactions, discussions, collections, trailers, its own content catalog, TMDB proxying, premium tier.

### Auth

`src/core/account/api.js`:

```js
function url(){ return Utils.protocol() + Manifest.cub_domain + '/api/' }
// every request:
headers: { token: account.token, profile: account.profile.id }, timeout: 8000
```

- Token+account object live in localStorage `account` (`{token, email, id, profile:{id, name, icon, main, child, age}, ...}`); gates in `src/core/account/permit.js`: `Permit.token`, `Permit.access` (token && `lampa_settings.account_use`), `Permit.sync` (access && setting `account_use` && `lampa_settings.account_sync`), `Permit.child`, `Permit.child_small`.
- In-app login = device pairing (`src/core/account/device.js`): user gets a 6-digit code at `https://{cub_site}/add` (site login is email/password), app does `POST {api}/device/add` with body `{code}` → response is the full account object, saved to `account` / `account_email`, then page reload. Without a token every `Api.load` rejects `{decode_code: 403}`.
- Some methods are premium-only (`Account.hasPremium()` = days left of `account_user.premium`).

### REST endpoints found in source (`src/core/account/*`, `src/core/api/sources/cub.js`)

Base = `https://{cub_domain}/api/`. All under "auth" require `token` + `profile` headers.

| Endpoint | Method | Notes | Code ref |
|---|---|---|---|
| `device/add` | POST `{code}` | pair device, returns account object | core/account/device.js:38 |
| `users/get?device_name=...` | GET | user info incl. `premium` expiry → stored `account_user` | core/account/api.js:51 |
| `bookmarks/all` | GET | all bookmarks (documented at cub.rip/developer) | docs |
| `bookmarks/add` / `bookmarks/remove` | POST `{type, data: JSON.stringify(clearCard(card)), card_id, id}` | queued push on Favorite add/remove | core/account/bookmarks.js:40 |
| `bookmarks/dump` | GET (text) | full dump `{version, bookmarks:[{id,cid,card_id,type,data,profile,time}]}` (`data` = JSON string of card) | core/account/bookmarks.js:202 |
| `bookmarks/changelog?since={version}` | GET | `{version, changelog:[{action: add\|remove\|update\|clear, entity_id, data, updated_at}]}` | core/account/bookmarks.js:251 |
| `bookmarks/clear` | POST `{type:'group', group:<where>}` | clear one category | core/account/bookmarks.js:333 |
| `bookmarks/sync` | POST multipart file `bookmarks.json` (= localStorage `favorite`) | import local favorites to cloud | core/account/bookmarks.js:472 |
| `timeline/dump` | GET (text) | `{version, timelines:{ [hash]: {percent,time,duration,profile,updated} }}` | core/account/timeline.js:51 |
| `timeline/changelog?since={version}` | GET | incremental timeline changes | core/account/timeline.js:116 |
| `notice/all` | GET (cache 10 min) | `{secuses, notice:[{date/time, data: JSON{card, voice, quality, seasons}}]}` | core/account/api.js:89 |
| `notifications/all` | GET | translation subscriptions; `n.card` JSON + `{voice, season, episode, status}` | core/account/api.js:107 |
| `notifications/add` | POST `{voice, data: JSON card, episode, season}` | subscribe to voice; `result.limited` → premium modal | core/account/api.js:136 |
| `person/list` | GET | subscribed persons → `person_subscribes_id` | core/account/api.js:40 |
| `plugins/all` | GET | user plugin list → `account_plugins` | core/account/api.js:62 |
| `plugins/status` / `extensions/status` | POST `{id, status}` | toggle plugin | core/account/api.js:80 |
| `profiles/all` | GET | `{profiles:[{id,name,icon,main,child,age}]}` | core/account/profile.js:73 |
| `profiles/create` | POST `{name}` | create profile | core/account/profile.js:169 |
| `extensions/list` | GET (token optional) | extensions catalog | core/api/sources/cub.js:710 |
| `collections/list?category=new` | GET | curated collections for home rows | core/api/sources/cub.js:196 |
| `reactions/get/{method}_{id}` | GET, no auth | `{result:[{type, counter}]}` per card (`movie_603`, `tv_1399`) | core/api/sources/cub.js:587 |
| `reactions/add/{method}_{id}/{type}?uid={lampa_uid}` | GET, anonymous uid | vote a reaction (types: fire/nice/think/bore/shit; icons `/img/reactions/{type}.svg`) | core/api/sources/cub.js:599 |
| `discuss/get/{method}_{id}/{page}/{language}` | GET | comments | core/api/sources/cub.js:595 |
| `ai/video-view/{id}/metadata?type={method}` | GET | AI metadata (tags/chart) for movies | core/api/sources/cub.js:579 |
| `trailers/short/trailers/{type}` | GET | trailers row (`type='added'`) | core/api/sources/cub.js:559 |
| `checker`, `plugins/blacklist` | GET | misc (mirror health, plugin blacklist) | grep in src |

Sync model: dump every 15 days (bookmarks) / 10 days (timeline), otherwise `changelog?since=<version>`; local IndexedDB cache (`Cache 'other'`, keys `account_bookmarks_{profileId}`, tracker `account_bookmarks_sync`); refresh timer every 5 min; cross-device realtime via WebSocket messages `Socket.send('bookmarks',{})` and `Socket.send('timeline',{params})` (timeline push over socket is **premium-only**, `interaction/timeline.js:117`).

---

## 2. Local favorites without CUB — `Lampa.Favorite`

`src/core/favorite.js`. Persisted in localStorage key **`favorite`**:

```json
{
  "card":    [ {card}, {card}, ... ],
  "like":    [id, id, ...],
  "wath":    [id, ...],
  "book":    [id, ...],
  "history": [id, ...],
  "look": [], "viewed": [], "scheduled": [], "continued": [], "thrown": []
}
```

- `category = ['like','wath','book','history','look','viewed','scheduled','continued','thrown']`; the last five are `marks` — mutually exclusive watch statuses (toggling one removes the other).
- The lists hold only **ids** (TMDB numeric id for tmdb/cub cards); the actual card objects are deduplicated in `data.card`. A card is removed from `card` when no category references it.
- Card objects are stripped by `Utils.clearCard()` (`src/utils/utils.js:837`, field list at line 8):

```
poster_path, overview, release_date, genre_ids, id, original_title,
original_language, title, backdrop_path, popularity, vote_count,
vote_average, imdb_id, kinopoisk_id, original_name, name, first_air_date,
origin_country, status, pg, release_quality, imdb_rating, kp_rating,
source, number_of_seasons, number_of_episodes, next_episode_to_air,
img, poster, background_image
```

plus `img = Lampa.Api.img(poster_path,'w300')` if poster present. Numeric fields default to 0; empty `original_name/name/first_air_date` are deleted.

- Public API: `Favorite.add(where, card, limit)`, `remove`, `toggle(where, card)`, `check(card)` (exported as `check: cloud` — returns `{like:…, wath:…, …, any}` and is CUB-aware), `get({type})` → array of cards, `clear(where, card)`, `full()` (raw structure), `all()`, `continues('tv'|'movie'|'anime')`, `listener` (events `add`, `added`, `remove`).
- Global event: `Lampa.Listener 'state:changed'` with `{target:'favorite', reason:'update'|'read'|'clear', method, type, card}`.
- **When `Account.Permit.sync` is true, local storage is bypassed entirely**: `add`/`remove` only emit listener events (picked up by `Account.Bookmarks.push` → `bookmarks/add|remove`), and `get`/`clear` delegate to `Account.Bookmarks` (in-memory array `[{id, cid, card_id, type, data, profile, time}]`, where `data` is the parsed card).

---

## 3. "Сейчас смотрят" / popularity / trending

Home screen (`src/components/main.js`) calls `Api.main(object,…)` (`src/core/api/api.js`), which dispatches by `params.source` to registered sources `{tmdb, cub}` (setting `source`, default `tmdb`). There is **no** `api/plugins/viewed` endpoint; two different data paths exist:

### CUB source (`src/core/api/sources/cub.js`)
Rows come from CUB's own catalog service at `{protocol}://tmdb.{cub_domain}/{path}` (every URL gets `email={account_email}` appended):

- `?sort=now_playing` → **"Сейчас смотрят"** (`title_now_watch`, lang/ru.js:436) — CUB's server-side "now watching" list (aggregated by CUB, not exposed as a raw view-counter API)
- `?sort=latest` → "Новинки"; `?sort=top` → popular; `?sort=update` → new episodes (tv); `?sort=now&airdate=YYYY` → new this year; `&uhd=true` → 4K row; filters: `cat=movie|tv|anime`, `genre=`, `airdate=`, `vote=`, `page=`, `query=`
- `top/fire/movie|tv` → "Огонь!" row; `top/hundred/movie|tv` → "Топ 100" (CUB-computed tops)
- `search/movie|tv|anime`; `collections/{id}` (+ `https://{cub_domain}/api/collections/list?category=new` for the row list)
- TMDB passthrough on the same host: `3/{method}/{id}?api_key=...&append_to_response=...` for the full card.

### TMDB source (`src/core/api/sources/tmdb.js`)
- main: `movie/now_playing` → **"Сейчас смотрят"** (tmdb.js:254), `trending/movie/day` ("Сегодня в тренде"), `trending/movie/week`, `movie/upcoming`, `movie/popular`
- category: `discover/movie?with_release_type=1` → "Сейчас смотрят", `trending/{movie|tv}/week` → "Популярное".

So: "Сейчас смотрят" = TMDB `now_playing` on the tmdb source, and CUB catalog `?sort=now_playing` on the cub source. The only public per-card popularity endpoints on CUB are the anonymous **reactions** ones (`api/reactions/get|add`, see table above). Additional home rows are injected locally via `ContentRows` (`src/core/content_rows.js`): `continue_watch` (from history), `timetable_lately`, `timetable_recently`.

---

## 4. `Lampa.TMDB` inside the app

`src/core/tmdb/tmdb.js`:

```js
TMDB.key()  // '4ef0d7355d9ffb5151e987764708ce96'  (hardcoded app key)
TMDB.api(url)   // -> {proto}api.themoviedb.org/3/{url}
                //    or {proxy_url}/{base} when Storage 'proxy_tmdb' && 'tmdb_proxy_api'
TMDB.image(url) // -> {proto}image.tmdb.org/{url}  (proxy via 'tmdb_proxy_image')
TMDB.broken()   // 50 broken images -> auto-enable proxy if 'proxy_tmdb_auto'
```

`src/core/tmdb/proxy.js` — built-in "TMDB Proxy" plugin (v1.0.6) that **overrides** those methods when active:

- API: `apitmdb.{cub_domain}/3/{url}` (i.e. `apitmdb.cub.rip`, historically `apitmdb.cub.red`), backup `lampa.byskaz.ru/tmdb/api/3/`; appends `email={account_email}`.
- Images: mirror pool `imagetmdb.com`, `nl./de./pl.imagetmdb.com`, `lampa.byskaz.ru/tmdb/img/`; `imagetmdb.{cub_domain}` is inserted first for premium users; a mirror is banned after 20 errors/10 s (`ImageMirror`).
- The tmdb API source builds URLs through `TMDB.api()` (see `src/core/api/sources/tmdb.js` `get()`), adding `api_key`, `language`, filters.

---

## 5. Timetable (episode release calendar)

`src/core/timetable.js` (data) + `src/components/timetable.js` (calendar UI). **Local feature, data source = TMDB** (direct or via the proxy/CUB passthrough — cards with `source == 'tmdb' || 'cub'` only, must have `original_name`, numeric `id`).

- Tracks every bookmarked series from categories `['like','wath','book','look','viewed','scheduled','continued']` (history alone does not track; a card gone from favorites is dropped). Re-imports favorites every 10 min; with CUB sync the card list comes from `Account.Bookmarks.all()`.
- State: localStorage `timetable` (max 300 entries `{id, season, episodes: [], ssn, next, scaned, scaned_time}`), episode lists stored in IndexedDB `Cache('timetable', id)`.
- Background scanner: every 30 s takes one unscanned entry; if season count unknown/older than 7 days → `TMDB.get('tv/{id}')` → `countSeasons`; then `TMDB.get('tv/{id}/season/{last}')`; keeps episode fields `[air_date, season_number, episode_number, name, still_path]`; computes `next = getNextEpisode(episodes)` (first episode airing today or later, this/next year). TMDB responses cached ~3 days.
- Consumers: home rows `timetable_lately` ("Ближайшие выходы эпизодов") and `timetable_recently` ("Недавние выходы эпизодов", last 14 days, watched < 60% via `Timeline.watchedEpisode`); the Timetable component renders a 30-day calendar of `TimeTable.all()` matched against favorite cards; `TimeTable.get(card)` feeds air dates into the full card view. Notifications about new episodes with a translation come separately from CUB `notice/all` (`src/interaction/notice/cub.js`, enriched via TMDB `find/{imdb_id}?external_source=imdb_id`).

---

## Appendix: local storage keys touched by account/favorites

`account`, `account_user`, `account_email`, `account_use`, `account_plugins`, `account_notice`, `account_bookmarks` (legacy), `favorite`, `timetable`, `file_view` / `file_view_{profileId}` (timeline), `cub_domain`, `cub_alive`, `cub_mirrors`, `lampa_uid` (anonymous reactions uid), `mine_reactions`, `person_subscribes_id`, `tmdb_img_mirror`, `proxy_tmdb`, `tmdb_proxy_api`, `tmdb_proxy_image`, `source`, `cub_notice_time`.
