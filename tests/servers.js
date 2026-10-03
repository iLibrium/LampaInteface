// Fake Shikimori / ARM / TMDB / CUB / Kodik backends for the harness.
// They follow the real contracts as far as the plugin can observe them:
// field projection in GraphQL, ARM null-in-order batches, Kodik cursors,
// TMDB's first_air_date_year filter and language-dependent names.
'use strict';

/* ---------------- GraphQL mini-parser ---------------- */

function tokenize(src) {
    const tokens = [];
    const re = /\s*(?:("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([{}():,]))/y;
    let m;
    re.lastIndex = 0;
    while (re.lastIndex < src.length) {
        const at = re.lastIndex;
        m = re.exec(src);
        if (!m) {
            if (/^\s*$/.test(src.slice(at))) break;
            throw new Error('graphql tokenize failed at: ' + src.slice(at, at + 30));
        }
        if (m[1] !== undefined) tokens.push({ t: 'str', v: JSON.parse(m[1]) });
        else if (m[2] !== undefined) tokens.push({ t: 'num', v: Number(m[2]) });
        else if (m[3] !== undefined) tokens.push({ t: 'id', v: m[3] });
        else if (m[4] !== undefined) tokens.push({ t: m[4] });
    }
    return tokens;
}

function parseGraphql(src) {
    const tokens = tokenize(src);
    let i = 0;
    const peek = () => tokens[i];
    const eat = (t) => {
        const tok = tokens[i++];
        if (!tok || (t && tok.t !== t)) throw new Error('graphql parse: expected ' + t + ' got ' + JSON.stringify(tok));
        return tok;
    };

    function value() {
        const tok = peek();
        if (tok.t === 'str' || tok.t === 'num') { i++; return tok.v; }
        if (tok.t === 'id') { i++; return tok.v === 'true' ? true : tok.v === 'false' ? false : tok.v; }
        if (tok.t === '{') {
            eat('{');
            const obj = {};
            while (peek().t !== '}') {
                const k = eat('id').v;
                eat(':');
                obj[k] = value();
                if (peek().t === ',') i++;
            }
            eat('}');
            return obj;
        }
        throw new Error('graphql value: ' + JSON.stringify(tok));
    }

    function field() {
        let name = eat('id').v;
        let alias = name;
        if (peek() && peek().t === ':') {
            eat(':');
            name = eat('id').v;
        }
        const args = {};
        if (peek() && peek().t === '(') {
            eat('(');
            while (peek().t !== ')') {
                const k = eat('id').v;
                eat(':');
                args[k] = value();
                if (peek().t === ',') i++;
            }
            eat(')');
        }
        let sel = null;
        if (peek() && peek().t === '{') sel = set();
        return { name, alias, args, sel };
    }

    function set() {
        eat('{');
        const out = [];
        while (peek().t !== '}') out.push(field());
        eat('}');
        return out;
    }

    return set();
}

function project(obj, sel) {
    if (obj == null) return null;
    if (Array.isArray(obj)) return obj.map(o => project(o, sel));
    if (!sel) return obj;
    const out = {};
    for (const f of sel) {
        const v = obj[f.name];
        out[f.alias] = v === undefined ? null : (f.sel ? project(v, f.sel) : v);
    }
    return out;
}

/* ---------------- helpers ---------------- */

function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9а-яё぀-ヿ㐀-鿿]+/g, ' ').trim();
}

function words(s) { return norm(s).split(' ').filter(Boolean); }

// Crude TMDB/Shikimori-like search: every query word must occur in one of the names
function matches(query, names) {
    const q = words(query);
    if (!q.length) return false;
    return names.some(n => {
        const nn = norm(n);
        const compact = nn.replace(/ /g, '');
        return q.every(w => nn.indexOf(w) >= 0 || compact.indexOf(w) >= 0);
    });
}

function qs(url) {
    const out = {};
    const q = url.split('?')[1] || '';
    q.split('&').forEach(pair => {
        if (!pair) return;
        const at = pair.indexOf('=');
        const k = decodeURIComponent(at < 0 ? pair : pair.slice(0, at));
        const v = at < 0 ? '' : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
        out[k] = v;
    });
    return out;
}

/* ---------------- the world ---------------- */

function makeWorld(spec) {
    spec = spec || {};
    const animes = spec.animes || [];            // Shikimori entries (GraphQL shape)
    const arm = spec.arm || [];                  // ARM relations
    const tmdb = spec.tmdb || [];                // TMDB entries
    const kodik = spec.kodik || [];              // Kodik rows
    const translations = spec.translations || []; // [{id,title,type,count}]
    const flags = Object.assign({}, spec.flags || {});

    function byId(id) { return animes.find(a => String(a.id) === String(id)); }

    /* ----- Shikimori GraphQL ----- */
    function animesQuery(args) {
        let list = animes.slice();
        if (args.ids) {
            const ids = String(args.ids).split(',').map(s => s.trim());
            list = ids.map(byId).filter(Boolean);
        }
        if (args.search) {
            list = list.filter(a => matches(args.search, [a.name, a.russian, a.english, a.japanese].concat(a.synonyms || [])));
        }
        if (args.status) {
            const st = String(args.status).split(',');
            list = list.filter(a => st.indexOf(a.status) >= 0);
        }
        if (args.kind) {
            const k = String(args.kind).split(',');
            list = list.filter(a => k.indexOf(a.kind) >= 0);
        }
        if (args.season) list = list.filter(a => a.season === args.season || String(a.airedOn && a.airedOn.year) === String(args.season));
        if (args.order === 'popularity') list.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        const limit = Math.min(args.limit || 2, 50);
        const page = args.page || 1;
        return list.slice((page - 1) * limit, page * limit);
    }

    function graphql(body) {
        const query = JSON.parse(body).query;
        spec.onGraphql && spec.onGraphql(query);
        const root = parseGraphql(query);
        const data = {};
        for (const f of root) {
            if (f.name === 'animes') {
                data[f.alias] = project(animesQuery(f.args), f.sel);
            }
            else if (f.name === 'genres') {
                data[f.alias] = project([{ id: 1, name: 'Action', russian: 'Экшен', kind: 'genre' }], f.sel);
            }
            else throw new Error('unknown graphql root ' + f.name);
        }
        return { data };
    }

    /* ----- ARM ----- */
    function armFull(e) {
        return Object.assign({
            anidb: null, anilist: null, 'anime-planet': null, anisearch: null, imdb: null, kitsu: null,
            livechart: null, myanimelist: null, media: null, themoviedb: null, 'themoviedb-season': null,
            thetvdb: null, 'thetvdb-season': null
        }, e);
    }

    /* ----- TMDB ----- */
    function tmdbName(e, lang) {
        const l = String(lang || 'ru').slice(0, 2);
        if (l === 'ru' && e.name_ru) return e.name_ru;
        if (l === 'en' && e.name_en) return e.name_en;
        return e.original_name;
    }

    function tmdbShape(e, lang) {
        const name = tmdbName(e, lang);
        const base = {
            id: e.id,
            genre_ids: e.genre_ids || [16],
            original_language: e.original_language || 'ja',
            origin_country: e.origin_country || ['JP'],
            popularity: e.popularity || 10,
            vote_average: e.vote_average || 8
        };
        if (e.type === 'movie') {
            return Object.assign(base, { title: name, original_title: e.original_name, release_date: e.date || '' });
        }
        return Object.assign(base, { name, original_name: e.original_name, first_air_date: e.date || '' });
    }

    function tmdbRoute(path, q) {
        const lang = q.language;
        let m;
        if ((m = path.match(/^search\/(tv|movie)$/))) {
            const type = m[1];
            let list = tmdb.filter(e => e.type === type);
            list = list.filter(e => matches(q.query, [e.name_ru, e.name_en, e.original_name].concat(e.alt || [])));
            const year = q.first_air_date_year || q.year;
            if (year) list = list.filter(e => String(e.date || '').slice(0, 4) === String(year));
            return { status: 200, body: { page: 1, results: list.map(e => tmdbShape(e, lang)), total_results: list.length } };
        }
        if ((m = path.match(/^(tv|movie)\/(\d+)\/season\/(\d+)$/))) {
            const e = tmdb.find(x => x.type === m[1] && String(x.id) === m[2]);
            const num = Number(m[3]);
            const eps = (e && e.episodes && e.episodes[num]) || [];
            return { status: 200, body: { id: 1, name: 'Сезон ' + num, season_number: num,
                episodes: eps.map(ep => Object.assign({ season_number: num, runtime: 24, still_path: '', overview: '', vote_average: 0, crew: [], guest_stars: [] }, ep)) } };
        }
        if ((m = path.match(/^(tv|movie)\/(\d+)\/(credits|recommendations|similar|videos|images|keywords|external_ids)$/))) {
            return { status: 200, body: { id: Number(m[2]), results: [], cast: [], crew: [] } };
        }
        if ((m = path.match(/^(tv|movie)\/(\d+)$/))) {
            const e = tmdb.find(x => x.type === m[1] && String(x.id) === m[2]);
            if (!e) return { status: 404, body: { status_code: 34 } };
            const card = tmdbShape(e, lang);
            card.genres = (e.genre_ids || [16]).map(id => ({ id, name: id == 16 ? 'Мультфильм' : 'Жанр' }));
            Object.assign(card, {
                overview: 'Описание', status: 'Returning Series', poster_path: '/p.jpg', backdrop_path: '/b.jpg',
                vote_count: 100, production_countries: [{ iso_3166_1: 'JP', name: 'Japan' }], production_companies: [],
                spoken_languages: [], networks: [], created_by: [], episode_run_time: [24], runtime: 24,
                content_ratings: { results: [] }, release_dates: { results: [] }, keywords: { results: [] },
                alternative_titles: { results: [] }, external_ids: {}, images: { backdrops: [], logos: [], posters: [] }
            });
            if (e.type === 'tv') {
                card.number_of_seasons = e.seasons || 1;
                card.number_of_episodes = 28;
                card.seasons = e.seasonList || [{ season_number: 1, episode_count: 28, air_date: e.date, name: 'Сезон 1' }];
                card.last_air_date = e.date;
            }
            return { status: 200, body: card };
        }
        if ((m = path.match(/^find\/(.+)$/))) {
            const ext = m[1];
            const hits = tmdb.filter(e => e.imdb === ext || String(e.tvdb) === ext);
            return { status: 200, body: {
                tv_results: hits.filter(e => e.type === 'tv').map(e => tmdbShape(e, lang)),
                movie_results: hits.filter(e => e.type === 'movie').map(e => tmdbShape(e, lang))
            } };
        }
        if (path.indexOf('discover/') === 0) return { status: 200, body: { results: [] } };
        return { status: 404, body: {} };
    }

    /* ----- Kodik ----- */
    function kodikRows(q) {
        let list = kodik.slice();
        if (q.types) {
            const t = q.types.split(',');
            list = list.filter(r => t.indexOf(r.type || 'anime-serial') >= 0);
        }
        if (q.translation_type) list = list.filter(r => r.translation.type === q.translation_type);
        if (q.translation_id) {
            const ids = q.translation_id.split(',').map(Number);
            list = list.filter(r => ids.indexOf(r.translation.id) >= 0);
        }
        if (q.anime_status) {
            const st = q.anime_status.split(',');
            list = list.filter(r => st.indexOf(r.anime_status || 'ongoing') >= 0);
        }
        if (q.shikimori_id) list = list.filter(r => String(r.shikimori_id) === String(q.shikimori_id));
        list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
        return list;
    }

    function kodikShape(r, q) {
        const row = {
            id: r.kid || ('serial-' + r.shikimori_id + '-' + r.translation.id),
            type: r.type || 'anime-serial',
            title: r.title || 'T' + r.shikimori_id,
            translation: r.translation,
            last_season: 1,
            last_episode: r.last_episode,
            episodes_count: r.last_episode,
            shikimori_id: String(r.shikimori_id),
            created_at: r.created_at || r.updated_at,
            updated_at: r.updated_at
        };
        if (q.with_material_data) {
            row.material_data = {
                anime_status: r.anime_status || 'ongoing',
                episodes_aired: r.episodes_aired == null ? r.last_episode : r.episodes_aired,
                episodes_total: r.episodes_total || 12
            };
            if (r.released_at) row.material_data.released_at = r.released_at;
        }
        return row;
    }

    function kodikRoute(host, path, q, url) {
        if (flags.kodik_dead) return { network: true };
        const tokenOk = q.token && (!spec.kodikTokens || spec.kodikTokens.indexOf(q.token) >= 0);
        if (!tokenOk) return { status: 403, body: { error: 'Отсутствует или неверный токен' } };

        if (path === '/translations') {
            // v1: bare array of {id,title,type}
            return { status: 200, body: translations.map(t => ({ id: t.id, title: t.title, type: t.type || 'voice' })) };
        }
        if (path === '/translations/v2') {
            let list = translations.slice();
            if (q.translation_type) list = list.filter(t => (t.type || 'voice') === q.translation_type);
            if (q.sort === 'count') list.sort((a, b) => (b.count || 0) - (a.count || 0));
            return { status: 200, body: { time: '1ms', total: list.length, results: list.map(t => ({ id: t.id, title: t.title, count: t.count || 0 })) } };
        }
        if (path === '/search') {
            const list = kodikRows(q).slice(0, Number(q.limit) || 50);
            return { status: 200, body: { time: '1ms', total: list.length, results: list.map(r => kodikShape(r, q)) } };
        }
        if (path === '/list') {
            const all = kodikRows(q);
            const limit = Math.min(Number(q.limit) || 50, 100);
            const offset = q.next ? JSON.parse(Buffer.from(q.next, 'base64').toString())[0] : 0;
            const page = all.slice(offset, offset + limit);
            let next = null;
            if (offset + limit < all.length) {
                const params = Object.assign({}, q);
                params.next = Buffer.from(JSON.stringify([offset + limit])).toString('base64');
                next = 'https://' + host + '/list?' + Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
            }
            return { status: 200, body: { time: '1ms', total: all.length, prev_page: null, next_page: next, results: page.map(r => kodikShape(r, q)) } };
        }
        return { status: 404, body: { error: 'not found' } };
    }

    /* ----- router ----- */
    function route(method, url, body) {
        const u = new URL(url.indexOf('//') === 0 ? 'https:' + url : url);
        const host = u.host;
        const path = u.pathname;
        const q = qs(url);

        if (host === 'shikimori.io') {
            if (flags.shiki_dead) return { network: true };
            if (path === '/api/graphql') return { status: 200, body: graphql(body) };
            if (path === '/api/calendar') return { status: 200, body: spec.calendar || [] };
            let m;
            if ((m = path.match(/^\/api\/users\/(.+)$/))) {
                return spec.user ? { status: 200, body: spec.user } : { status: 404, body: {} };
            }
            if (path === '/api/v2/user_rates') return { status: 200, body: spec.rates || [] };
            if ((m = path.match(/^\/api\/animes\/(\d+)$/))) {
                const a = byId(m[1]);
                return a ? { status: 200, body: { id: a.id, score: a.score, next_episode_at: a.nextEpisodeAt, episodes_aired: a.episodesAired } } : { status: 404, body: {} };
            }
            return { status: 404, body: {} };
        }

        if (host === 'arm.haglund.dev') {
            if (flags.arm_dead) return { network: true };
            if (path === '/api/v2/ids' && method === 'GET') {
                const e = arm.find(x => String(x.myanimelist) === String(q.id));
                return { status: 200, body: e ? armFull(e) : null };
            }
            if (path === '/api/v2/ids' && method === 'POST') {
                const items = JSON.parse(body);
                return { status: 200, body: items.map(it => {
                    const e = arm.find(x => String(x.myanimelist) === String(it.myanimelist));
                    return e ? armFull(e) : null;
                }) };
            }
            if (path === '/api/v2/themoviedb') {
                return { status: 200, body: arm.filter(x => String(x.themoviedb) === String(q.id)).map(armFull) };
            }
            return { status: 404, body: {} };
        }

        if (host === 'api.themoviedb.org') {
            if (flags.tmdb_blocked) return { network: true };
            return tmdbRoute(path.replace(/^\/3\//, ''), q);
        }

        if (host.indexOf('apitmdb.') === 0) {
            if (flags.tmdb_proxy_dead) return { network: true };
            return tmdbRoute(path.replace(/^\/3\//, ''), q);
        }

        if (host.indexOf('tmdb.') === 0 && host.indexOf('image') < 0) {
            if (flags.cub_dead) return { network: true };
            if (path.indexOf('/3/') === 0) return tmdbRoute(path.replace(/^\/3\//, ''), q);
            if (path === '/blocked') return { status: 200, body: [] };
            if (/\.json$/.test(path)) return { status: 200, body: {} };
            return { status: 200, body: { results: spec.cubPopular || [] } };
        }

        if (host === 'kodik-api.com' || host === 'kodik.test') return kodikRoute(host, path, q, url);

        return { network: true };
    }

    return { route, flags, spec };
}

module.exports = { makeWorld, parseGraphql, project };
