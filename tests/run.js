// Scenario runner: node run.js <path-to-shikimori.js> [filter]
'use strict';

const path = require('path');
const { createEnv } = require('./lampa');
const { makeWorld } = require('./servers');
const F = require('./fixtures');
const { HOUR, DAY, iso, anime } = F;

const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'shikimori.js'));
const ONLY = process.argv[3] || '';

const results = [];
function check(scenario, name, ok, details) {
    results.push({ scenario, name, ok: !!ok, details });
}

async function boot(spec, envOpts) {
    const world = makeWorld(spec);
    const env = createEnv(Object.assign({ route: world.route }, envOpts || {}));
    env.load(FILE);
    return { env, world };
}

async function openCatalog(env, object) {
    const Catalog = env.components.shikimori_catalog;
    const comp = new Catalog(Object.assign({ mode: 'catalog', filters: {}, page: 1 }, object || {}));
    comp.activity = { loader() {}, toggle() {} };
    const html = comp.create();
    await env.idle();
    return comp;
}

function cardByTitle(comp, title) {
    const root = comp.render(true);
    const cards = root.querySelectorAll('.shikimori-card');
    for (const c of cards) {
        const t = c.querySelector('.card__title');
        if (t && t.textContent.indexOf(title) >= 0) return c;
    }
    return null;
}

async function press(env, el) {
    el.dispatchEvent(new env.window.Event('hover:enter'));
    await env.idle();
}

async function openMain(env) {
    const Main = env.components.shikimori_main;
    const comp = new Main({ component: 'shikimori_main', page: 1 });
    comp.create();
    const built = await env.waitFor(() => comp.built, 10000);
    await env.idle();
    return { comp, built: built || [] };
}

function lineOf(env, built, key) {
    const title = env.Lampa.Lang.translate(key);
    return built.find(l => l.title && l.title.indexOf(title) === 0) || null;
}

function lastPush(env) { return env.log.pushes[env.log.pushes.length - 1] || null; }

const scenarios = {};

/* ------------------------------------------------------------------
 * T1. Второй сезон, которого ещё нет в ARM: TMDB-поиск с годом сезона
 * ------------------------------------------------------------------ */
scenarios.t1_sequel_search = async function (S) {
    const { env } = await boot({
        animes: [F.FRIEREN_S2, F.FRIEREN_S1],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [F.FRIEREN_TMDB]
    });
    const comp = await openCatalog(env);
    const card = cardByTitle(comp, 'Фрирен 2');
    check(S, 'catalog shows the sequel card', !!card);
    if (!card) return;
    await press(env, card);
    const push = lastPush(env);
    check(S, 'opens TMDB tv 209867', push && push.component == 'full' && push.id == 209867 && push.method == 'tv',
        { push, noty: env.log.noty, selects: env.log.selects.map(s => s.title) });
    check(S, 'no "not found" toast', !env.log.noty.some(n => /Не найдено/.test(n)), env.log.noty);
};

/* ------------------------------------------------------------------
 * T2. ARM знает тайтл, но прямой TMDB не отвечает (блок/таймаут)
 * ------------------------------------------------------------------ */
scenarios.t2_tmdb_blocked = async function (S) {
    const { env } = await boot({
        animes: [F.FRIEREN_S1],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [F.FRIEREN_TMDB],
        flags: { tmdb_blocked: true }
    });
    const comp = await openCatalog(env);
    const card = cardByTitle(comp, 'Фрирен');
    await press(env, card);
    const push = lastPush(env);
    check(S, 'opens full card although api.themoviedb.org is down', push && push.id == 209867 && push.method == 'tv',
        { push, noty: env.log.noty });
    check(S, 'full card gets a source Lampa can load', push && (push.source == 'tmdb' || push.source == 'cub'), push && push.source);
};

/* ------------------------------------------------------------------
 * T3. OVA, которую ARM сопоставил с фильмом TMDB (media = OVA)
 * ------------------------------------------------------------------ */
scenarios.t3_arm_media = async function (S) {
    const ova = anime({ id: 777, name: 'Kara no Kyoukai: Mirai Fukuin', russian: 'Граница пустоты: Евангелие будущего',
        english: 'The Garden of Sinners: Future Gospel', japanese: '空の境界 未来福音', kind: 'ova', status: 'released',
        episodes: 1, episodesAired: 1, airedOn: { year: 2013, date: '2013-09-28' } });
    const { env } = await boot({
        animes: [ova],
        arm: [{ myanimelist: 777, themoviedb: 4444, media: 'OVA', 'themoviedb-season': null }],
        tmdb: [
            { type: 'movie', id: 4444, name_ru: 'Граница пустоты: Евангелие будущего', name_en: 'The Garden of Sinners: Future Gospel',
              original_name: '劇場版 空の境界 未来福音', date: '2013-09-28' },
            { type: 'tv', id: 4444, name_ru: 'Сосед сверху', name_en: 'The Neighbour Upstairs', original_name: 'The Neighbour Upstairs',
              date: '1995-03-01', genre_ids: [35], original_language: 'en', origin_country: ['US'] }
        ]
    });
    const comp = await openCatalog(env);
    const card = cardByTitle(comp, 'Граница пустоты');
    await press(env, card);
    const push = lastPush(env);
    check(S, 'opens movie/4444, not the unrelated tv/4444', push && push.id == 4444 && push.method == 'movie', { push, noty: env.log.noty });
};

/* ------------------------------------------------------------------
 * T4. Словарь студий: /translations отдаёт массив, а не {results}
 * ------------------------------------------------------------------ */
scenarios.t4_studio_dictionary = async function (S) {
    const now = Date.now();
    const { env } = await boot({
        translations: [
            { id: 610, title: 'AniLibria.TV', count: 3000 },
            { id: 609, title: 'AniDUB', count: 2500 },
            { id: 1978, title: 'Dream Cast', count: 900 },
            { id: 869, title: 'Субтитры', type: 'subtitles', count: 5000 }
        ],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 1, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 3, updated_at: iso(now - HOUR) }]
    });
    const param = env.Lampa.SettingsApi.params.find(p => p.param.name == 'shikimori_studios_pick');
    param.onChange();
    await env.idle();
    const sel = env.log.selects[env.log.selects.length - 1];
    const titles = sel ? sel.items.filter(i => i.checkbox).map(i => i.title) : [];
    check(S, 'studio list comes from the full Kodik dictionary', titles.indexOf('AniLibria.TV') >= 0 && titles.indexOf('Dream Cast') >= 0, titles);
    check(S, 'subtitle "studio" is not offered when subtitles are off', titles.indexOf('Субтитры') < 0, titles);
    const dict = env.log.requests.filter(r => /kodik-api\.com\/translations/.test(r.url));
    check(S, 'dictionary costs a single request', dict.length == 1, dict.map(r => r.url.replace(/token=[^&]+/, 'token=*')));
};

/* ------------------------------------------------------------------
 * T5. Выбрана одна студия: лента должна быть её, а не общей
 * ------------------------------------------------------------------ */
scenarios.t5_studio_feed = async function (S) {
    const now = Date.now();
    const rows = [];
    // 250 свежих строк других студий
    for (let i = 0; i < 250; i++) {
        rows.push({ shikimori_id: 1000 + i, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 5,
            updated_at: iso(now - i * 5 * 60e3) });
    }
    // и пять строк выбранной — чуть старше
    const libria = [];
    for (let j = 0; j < 5; j++) {
        rows.push({ shikimori_id: 2000 + j, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 4,
            updated_at: iso(now - 22 * HOUR - j * 60e3) });
        libria.push(anime({ id: 2000 + j, name: 'Libria ' + j, russian: 'Либрия ' + j, kind: 'tv', status: 'ongoing' }));
    }
    const others = [];
    for (let i = 0; i < 250; i++) others.push(anime({ id: 1000 + i, name: 'Other ' + i, russian: 'Другое ' + i, kind: 'tv', status: 'ongoing' }));
    const { env } = await boot({
        animes: libria.concat(others),
        translations: [{ id: 610, title: 'AniLibria.TV', count: 3000 }, { id: 609, title: 'AniDUB', count: 2500 }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: rows
    }, { storage: { shikimori_studios: ['AniLibria.TV'] } });
    const { built } = await openMain(env);
    const released = lineOf(env, built, 'shikimori_title_released');
    const count = released ? released.results.length : 0;
    check(S, 'fresh-dub row shows the chosen studio releases', count == 5, { count, lines: built.map(l => l.title) });
    const list = env.log.requests.filter(r => /kodik-api\.com\/list/.test(r.url));
    check(S, 'feed is filtered by translation_id on the server', list.length && list.every(r => /translation_id=610/.test(r.url)),
        list.map(r => r.url.replace(/token=[^&]+/, 'token=*')));
};

/* ------------------------------------------------------------------
 * T6. Тайтл закончил выходить в Японии, а озвучка догоняет
 * ------------------------------------------------------------------ */
scenarios.t6_released_dub = async function (S) {
    const now = Date.now();
    const a = anime({ id: 60001, name: 'Finished Show', russian: 'Досмотренный эфир', kind: 'tv', status: 'released',
        episodes: 12, episodesAired: 12 });
    const { env } = await boot({
        animes: [a],
        user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 60001, status: 'watching', episodes: 11 }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 60001, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 12,
            updated_at: iso(now - 2 * HOUR), anime_status: 'released', episodes_aired: 12,
            created_at: iso(now - 90 * DAY), released_at: iso(now - 7 * DAY).slice(0, 10) }]
    }, { storage: { shikimori_user: 'me' } });
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => String(c.id) == '60001');
    check(S, 'final episode dubbed after the finale shows as new', !!hit, { lines: built.map(l => l.title + ':' + (l.results || []).length) });
    check(S, 'badge says +1', hit && hit._kodik_new == 1, hit && hit._kodik_new);
};

/* ------------------------------------------------------------------
 * T7. Тайтл уже известен, новую серию лента не застала
 * ------------------------------------------------------------------ */
scenarios.t7_recheck_known = async function (S) {
    const now = Date.now();
    const a = anime({ id: 60002, name: 'Weekly Show', russian: 'Еженедельный', kind: 'tv', status: 'ongoing',
        episodes: 12, episodesAired: 6 });
    const rows = [{ shikimori_id: 60002, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 6,
        updated_at: iso(now - 30 * HOUR), episodes_aired: 6 }];
    for (let i = 0; i < 250; i++) {
        rows.push({ shikimori_id: 3000 + i, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 2,
            updated_at: iso(now - i * 4 * 60e3) });
    }
    const { env } = await boot({
        animes: [a],
        user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 60002, status: 'watching', episodes: 5 }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: rows
    }, { storage: {
        shikimori_user: 'me',
        shikimori_kodik_eps: { s60002: { sid: 60002, ep: 5, base: 5, studio: 'AniLibria.TV', voice: true, at: now - 3 * DAY, aired: 5 } }
    } });
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => String(c.id) == '60002');
    check(S, 'episode that slipped past the feed window is found', !!hit && hit._kodik_new == 1,
        { hit: hit && hit._kodik_new, lines: built.map(l => l.title + ':' + (l.results || []).length) });
};

/* ------------------------------------------------------------------
 * T8. Счётчик эфира у Kodik отстал на серию
 * ------------------------------------------------------------------ */
scenarios.t8_aired_lag = async function (S) {
    const now = Date.now();
    const a = anime({ id: 60003, name: 'Lagging Counter', russian: 'Отставший счётчик', kind: 'tv', status: 'ongoing',
        episodes: 12, episodesAired: 5 });
    const { env } = await boot({
        animes: [a],
        user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 60003, status: 'watching', episodes: 5 }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 60003, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 6,
            updated_at: iso(now - HOUR), episodes_aired: 5 }]
    }, { storage: { shikimori_user: 'me' } });
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => String(c.id) == '60003');
    check(S, 'dubbed episode 6 is not hidden behind aired=5', !!hit && hit._kodik_new == 1, hit && hit._kodik_new);
};

/* ------------------------------------------------------------------
 * T9. Закладка на сериал, у которого начался второй сезон
 * ------------------------------------------------------------------ */
scenarios.t9_bookmark_new_season = async function (S) {
    const now = Date.now();
    const { hash } = require('./lampa');
    const timeline = {};
    for (let ep = 1; ep <= 28; ep++) timeline[hash([1, '', ep, '葬送のフリーレン'].join(''))] = 100;
    const { env } = await boot({
        animes: [F.FRIEREN_S1, F.FRIEREN_S2],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [F.FRIEREN_TMDB],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [
            { shikimori_id: 59978, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 3,
              updated_at: iso(now - 3 * HOUR), episodes_aired: 3 },
            { shikimori_id: 52991, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 28,
              updated_at: iso(now - 200 * DAY), episodes_aired: 28, anime_status: 'released' }
        ]
    }, {
        favorites: { book: [{ id: 209867, name: 'Провожающая в последний путь Фрирен', original_name: '葬送のフリーレン',
            first_air_date: '2023-09-29', genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb',
            number_of_seasons: 1, vote_average: 8.9 }] },
        timeline
    });
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => c.id == 209867);
    check(S, 'bookmark shows up in «Новые серии» for its new season', !!hit, { lines: built.map(l => l.title + ':' + (l.results || []).length) });
    check(S, 'with the three new episodes counted', hit && hit._kodik_new == 3, hit && { n: hit._kodik_new, w: hit._watched_ep, t: hit._total_ep });
};

/* ------------------------------------------------------------------
 * T10. Совпадение номеров фильма и сериала в обратном маппинге
 * ------------------------------------------------------------------ */
scenarios.t10_reverse_collision = async function (S) {
    const now = Date.now();
    const movie = anime({ id: 888, name: 'Some Movie', russian: 'Какой-то фильм', kind: 'movie', status: 'released', episodes: 1, episodesAired: 1 });
    const { env } = await boot({
        animes: [movie],
        arm: [{ myanimelist: 888, themoviedb: 5555, media: 'MOVIE', 'themoviedb-season': null }],
        tmdb: [{ type: 'tv', id: 5555, name_ru: 'Чужой сериал', original_name: 'よその番組', date: '2020-01-01' }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 888, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 1,
            updated_at: iso(now - HOUR), anime_status: 'released' }]
    }, {
        favorites: { wath: [{ id: 5555, name: 'Чужой сериал', original_name: 'よその番組', first_air_date: '2020-01-01',
            genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb' }] }
    });
    const { built } = await openMain(env);
    const later = lineOf(env, built, 'shikimori_title_later');
    const hit = later && later.results.find(c => c.id == 5555);
    check(S, 'bookmark is rendered in «Позже»', !!hit, { lines: built.map(l => l.title + ':' + (l.results || []).length) });
    check(S, 'tv bookmark is not tied to a movie with the same TMDB number', hit && (hit._sids || []).indexOf(888) < 0,
        hit && hit._sids);
};

/* ------------------------------------------------------------------
 * T11. Сбой TMDB при дозапросе закладки не должен помниться вечно
 * ------------------------------------------------------------------ */
scenarios.t11_tmdbinfo_retry = async function (S) {
    const { env, world } = await boot({
        tmdb: [{ type: 'tv', id: 7777, name_ru: 'Закладка', original_name: 'しおり', date: '2025-04-01' }],
        flags: { tmdb_blocked: true, cub_dead: true }
    }, {
        favorites: { book: [{ id: 7777, name: 'Закладка', genre_ids: [16], original_language: 'ja', source: 'tmdb' }] }
    });
    await openMain(env);
    const info = env.Lampa.Storage.get('shikimori_tmdb_info', {});
    const rec = info.i7777;
    check(S, 'network failure is not stored as "no such title"', !rec || !('original_name' in rec) || rec.retry || rec.fail,
        rec);
};

/* ------------------------------------------------------------------
 * R. Регрессия: каталог и главная собираются
 * ------------------------------------------------------------------ */
scenarios.r_basic = async function (S) {
    const now = Date.now();
    const list = [];
    for (let i = 0; i < 40; i++) list.push(anime({ id: 100 + i, name: 'Show ' + i, russian: 'Шоу ' + i, kind: 'tv', status: 'ongoing', popularity: 100 - i }));
    const { env } = await boot({
        animes: list,
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 100, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 4, updated_at: iso(now - HOUR) }]
    });
    const comp = await openCatalog(env);
    const cards = comp.render(true).querySelectorAll('.shikimori-card:not(.shikimori-skeleton)');
    check(S, 'catalog renders 36 cards', cards.length == 36, cards.length);
    const { built } = await openMain(env);
    check(S, 'main screen builds rows', built.length >= 3, built.map(l => l.title));
    check(S, 'no uncaught errors', env.log.errors.length == 0, env.log.errors.map(String));
};


/* ------------------------------------------------------------------
 * E1. Поиск TMDB не находит ничего — выручает предыдущий сезон
 * ------------------------------------------------------------------ */
scenarios.e1_prequel_fallback = async function (S) {
    const tmdbEntry = Object.assign({}, F.FRIEREN_TMDB, { name_ru: 'Фрирен', name_en: 'Frieren', original_name: 'Frieren', alt: [] });
    const { env } = await boot({
        animes: [F.FRIEREN_S2, F.FRIEREN_S1],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [tmdbEntry]
    });
    const comp = await openCatalog(env);
    await press(env, cardByTitle(comp, 'Фрирен 2'));
    const push = lastPush(env);
    check(S, 'opens the prequel show', push && push.id == 209867 && push.method == 'tv', { push, noty: env.log.noty, sel: env.log.selects.map(s => s.items.map(i => i.title)) });
    const cache = env.Lampa.Storage.get('shikimori_match', {});
    check(S, 'mapping remembered as prequel-derived', cache.m59978 && cache.m59978.how == 'prequel', cache.m59978);
};

/* ------------------------------------------------------------------
 * E2. Две похожие карточки — выбор вручную, и он запоминается
 * ------------------------------------------------------------------ */
scenarios.e2_picker_and_memory = async function (S) {
    const a = anime({ id: 901, name: 'Hunter x Hunter', russian: 'Охотник х Охотник', english: 'Hunter x Hunter',
        japanese: 'HUNTER×HUNTER', kind: 'tv', status: 'released', airedOn: { year: 2011, date: '2011-10-02' } });
    const { env } = await boot({
        animes: [a],
        tmdb: [
            { type: 'tv', id: 46298, name_ru: 'Охотник х Охотник', name_en: 'Hunter x Hunter', original_name: 'HUNTER×HUNTER', date: '2011-10-02' },
            { type: 'tv', id: 12345, name_ru: 'Охотник х Охотник', name_en: 'Hunter x Hunter', original_name: 'HUNTER×HUNTER', date: '1999-10-16' }
        ]
    });
    const comp = await openCatalog(env);
    await press(env, cardByTitle(comp, 'Охотник'));
    let push = lastPush(env);
    const sel = env.log.selects[env.log.selects.length - 1];
    // Год 2011 против 1999: у нашего тайтла год совпадает — это не должно быть неоднозначно
    check(S, 'year decides between two same-named shows', push && push.id == 46298,
        { push, sel: sel && sel.items.map(i => i.title) });

    // Ручной выбор через меню карточки
    const before = env.log.pushes.length;
    const card = cardByTitle(comp, 'Охотник');
    card.dispatchEvent(new env.window.Event('hover:long'));
    const menu = env.log.selects[env.log.selects.length - 1];
    const rematch = menu.items.find(i => i.action == 'rematch');
    check(S, 'card menu offers picking another TMDB card', !!rematch, menu.items.map(i => i.title));
    menu.onSelect(rematch);
    await env.idle();
    const picker = env.log.selects[env.log.selects.length - 1];
    const other = picker.items.find(i => i.candidate && i.candidate.id == 12345);
    check(S, 'picker lists every plausible candidate', !!other && picker.items.some(i => i.candidate && i.candidate.id == 46298),
        picker.items.map(i => i.title + ' / ' + i.subtitle));
    picker.onSelect(other);
    push = lastPush(env);
    check(S, 'picked card opens', push && push.id == 12345 && env.log.pushes.length > before, push);
    // Повторное открытие — без вопросов, выбранное
    await press(env, cardByTitle(comp, 'Охотник'));
    push = lastPush(env);
    check(S, 'manual pick is remembered', push && push.id == 12345, push);
};

/* ------------------------------------------------------------------
 * E3. Ничего не найдено — поиск Lampa с названием вместо тупика
 * ------------------------------------------------------------------ */
scenarios.e3_nothing_found = async function (S) {
    const a = anime({ id: 902, name: 'Totally Obscure', russian: 'Совсем неизвестное', japanese: 'まったく無名', kind: 'tv', status: 'ongoing' });
    const { env } = await boot({ animes: [a], tmdb: [] });
    const comp = await openCatalog(env);
    await press(env, cardByTitle(comp, 'Совсем'));
    check(S, 'Lampa search opens with the title', env.log.searches.length == 1 && env.log.searches[0].input == 'Совсем неизвестное', env.log.searches);
};

/* ------------------------------------------------------------------
 * E4. TMDB заблокирован и вид номера неизвестен — уточняем через CUB
 * ------------------------------------------------------------------ */
scenarios.e4_media_via_cub = async function (S) {
    const ova = anime({ id: 777, name: 'Kara no Kyoukai: Mirai Fukuin', russian: 'Граница пустоты: Евангелие будущего',
        english: 'The Garden of Sinners: Future Gospel', japanese: '空の境界 未来福音', kind: 'ova', status: 'released',
        episodes: 1, episodesAired: 1, airedOn: { year: 2013, date: '2013-09-28' } });
    const { env } = await boot({
        animes: [ova],
        arm: [{ myanimelist: 777, themoviedb: 4444, media: 'OVA', 'themoviedb-season': null }],
        tmdb: [
            { type: 'movie', id: 4444, name_ru: 'Граница пустоты: Евангелие будущего', original_name: '劇場版 空の境界 未来福音', date: '2013-09-28' },
            { type: 'tv', id: 4444, name_ru: 'Сосед сверху', original_name: 'The Neighbour Upstairs', date: '1995-03-01', genre_ids: [35], original_language: 'en', origin_country: ['US'] }
        ],
        flags: { tmdb_blocked: true }
    });
    const comp = await openCatalog(env);
    await press(env, cardByTitle(comp, 'Граница'));
    const push = lastPush(env);
    check(S, 'movie/4444 via CUB passthrough', push && push.id == 4444 && push.method == 'movie', { push, noty: env.log.noty });
    const viaCub = env.log.requests.filter(r => /tmdb\.cub\.rip\/3\//.test(r.url));
    check(S, 'fallback route used', viaCub.length > 0, env.log.requests.map(r => r.url).slice(-6));
};

/* ------------------------------------------------------------------
 * E5. Инкрементальная сверка ленты: второй заход дочитывает до виденного
 * ------------------------------------------------------------------ */
scenarios.e5_incremental_sync = async function (S) {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 150; i++) rows.push({ shikimori_id: 5000 + i, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 3, updated_at: iso(now - (i + 1) * 10 * 60e3) });
    const world = makeWorld({ kodikTokens: ['56a768d08f43091901c44b54fe970049'], kodik: rows, animes: [] });
    const env = createEnv({ route: world.route });
    env.load(FILE);
    await openMain(env);
    const first = env.log.requests.filter(r => /\/list/.test(r.url)).length;
    const sync = env.Lampa.Storage.get('shikimori_kodik_sync', null);
    check(S, 'first sync reads two pages and remembers the point', first == 2 && sync && sync.at >= now - 11 * 60e3, { first, sync });

    // 250 новых строк, пока приложение было закрыто
    for (let i = 0; i < 250; i++) rows.push({ shikimori_id: 6000 + i, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 4, updated_at: iso(now + (i + 1) * 60e3) });
    const env2 = createEnv({ route: world.route, storage: { shikimori_kodik_sync: sync, shikimori_kodik_eps: env.Lampa.Storage.get('shikimori_kodik_eps', {}) } });
    env2.load(FILE);
    await openMain(env2);
    const second = env2.log.requests.filter(r => /\/list/.test(r.url)).length;
    const store = env2.Lampa.Storage.get('shikimori_kodik_eps', {});
    check(S, 'second sync pages until it meets known rows', second == 3, second);
    check(S, 'nothing that happened in between is lost', !!store.s6000 && !!store.s6249, Object.keys(store).length);
};

/* ------------------------------------------------------------------
 * E6. Старый формат выбора студий, словарь недоступен — фильтр у себя
 * ------------------------------------------------------------------ */
scenarios.e6_studio_fallback = async function (S) {
    const now = Date.now();
    const { env } = await boot({
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        translations: [],
        animes: [anime({ id: 7001, name: 'A', russian: 'А-тайтл', kind: 'tv', status: 'ongoing' }), anime({ id: 7002, name: 'B', russian: 'Б-тайтл', kind: 'tv', status: 'ongoing' })],
        kodik: [
            { shikimori_id: 7001, translation: { id: 1234, title: 'AniLiberty', type: 'voice' }, last_episode: 2, updated_at: iso(now - HOUR) },
            { shikimori_id: 7002, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 2, updated_at: iso(now - HOUR) }
        ]
    }, { storage: { shikimori_studios: ['AniLibria.TV'] } });
    const { built } = await openMain(env);
    const released = lineOf(env, built, 'shikimori_title_released');
    const ids = released ? released.results.map(c => c.id) : [];
    check(S, 'old AniLibria choice also counts AniLiberty rows', ids.indexOf(7001) >= 0, ids);
    check(S, 'other studios are still filtered out', ids.indexOf(7002) < 0, ids);
};

/* ------------------------------------------------------------------
 * E7. Перезаливка давно вышедшего — не «свежая озвучка»
 * ------------------------------------------------------------------ */
scenarios.e7_reupload = async function (S) {
    const now = Date.now();
    const { env } = await boot({
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        animes: [anime({ id: 7101, name: 'Old', russian: 'Старое', kind: 'tv', status: 'released' }), anime({ id: 7102, name: 'New', russian: 'Новое', kind: 'tv', status: 'ongoing' })],
        kodik: [
            { shikimori_id: 7101, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 24, updated_at: iso(now - HOUR), anime_status: 'released', created_at: iso(now - 900 * DAY) },
            { shikimori_id: 7102, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 5, updated_at: iso(now - 2 * HOUR) }
        ]
    });
    const { built } = await openMain(env);
    const released = lineOf(env, built, 'shikimori_title_released');
    const ids = released ? released.results.map(c => c.id) : [];
    check(S, 'fresh dub of an ongoing is shown', ids.indexOf(7102) >= 0, ids);
    check(S, 're-upload of a 2-year-old dub is not', ids.indexOf(7101) < 0, ids);
};

/* ------------------------------------------------------------------
 * E8. Полная карточка сериала: следующая серия идущего сезона
 * ------------------------------------------------------------------ */
scenarios.e8_full_card = async function (S) {
    const s2 = Object.assign({}, F.FRIEREN_S2, { nextEpisodeAt: new Date(Date.now() + 2 * DAY).toISOString() });
    const { env } = await boot({
        animes: [F.FRIEREN_S1, s2],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }]
    });
    const html = env.$('<div><div class="full-start-new__rate-line"></div><div class="full-start-new__details"></div></div>');
    env.Lampa.Listener.send('full', {
        type: 'complite',
        data: { movie: { id: 209867, name: 'Фрирен', original_name: '葬送のフリーレン', first_air_date: '2023-09-29',
            genres: [{ id: 16 }], original_language: 'ja', origin_country: ['JP'], number_of_seasons: 2 } },
        object: { method: 'tv', activity: { render: () => html } }
    });
    await env.idle();
    const next = html.find('.shikimori-next').text();
    check(S, 'next episode of the airing season 2 is shown', /4 серия/.test(next), next);
};

/* ------------------------------------------------------------------
 * E9. Новинка, которой нет в ARM: закладка находит себя поиском
 * ------------------------------------------------------------------ */
scenarios.e9_bookmark_by_search = async function (S) {
    const now = Date.now();
    const fresh = anime({ id: 61111, name: 'Brand New Show', russian: 'Совсем новое', japanese: 'まったく新しい', kind: 'tv', status: 'ongoing',
        episodes: 12, episodesAired: 2, airedOn: { year: 2026, date: '2026-07-05' } });
    const { env } = await boot({
        animes: [fresh],
        arm: [],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 61111, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 2, updated_at: iso(now - HOUR) }]
    }, {
        favorites: { book: [{ id: 300001, name: 'Совсем новое', original_name: 'まったく新しい', first_air_date: '2026-07-05',
            genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb' }] }
    });
    const { built } = await openMain(env);
    const freshLine = lineOf(env, built, 'shikimori_title_fresh');
    const hit = freshLine && freshLine.results.find(c => c.id == 300001);
    check(S, 'bookmark of a show unknown to ARM is tracked', !!hit, built.map(l => l.title + ':' + (l.results || []).length));
    check(S, 'marker shows episode and studio', hit && hit._show_kodik && hit._kodik && hit._kodik.studio == 'AniLibria.TV', hit && hit._kodik);
};

/* ------------------------------------------------------------------
 * E10. Разная нумерация: Kodik ушёл на 6 вперёд — верим эфиру
 * ------------------------------------------------------------------ */
scenarios.e10_numbering = async function (S) {
    const now = Date.now();
    const a = anime({ id: 60004, name: 'Cour Two', russian: 'Второй кур', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 3 });
    const { env } = await boot({
        animes: [a],
        user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 60004, status: 'watching', episodes: 2 }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 60004, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 15, updated_at: iso(now - HOUR), episodes_aired: 3 }]
    }, { storage: { shikimori_user: 'me' } });
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => String(c.id) == '60004');
    check(S, 'absolute numbering is capped to aired episodes', hit && hit._kodik_new == 1, hit && hit._kodik_new);
};

/* ------------------------------------------------------------------
 * E11. «Очистить кэш» не трогает выбранное вручную
 * ------------------------------------------------------------------ */
scenarios.e11_clear_cache = async function (S) {
    const { env } = await boot({}, { storage: { shikimori_match: {
        m1: { tmdb: 10, media: 'tv', how: 'user', user: 1, time: 1 },
        m2: { tmdb: 20, media: 'tv', how: 'arm', time: Date.now() }
    } } });
    const param = env.Lampa.SettingsApi.params.find(p => p.param.name == 'shikimori_clear_cache');
    param.onChange();
    const cache = env.Lampa.Storage.get('shikimori_match', {});
    check(S, 'manual pick survives', !!cache.m1 && !cache.m2, cache);
};

/* ------------------------------------------------------------------
 * E12. Смена студии: сброс накопленного и точки сверки
 * ------------------------------------------------------------------ */
scenarios.e12_studio_change_resets = async function (S) {
    const now = Date.now();
    const { env } = await boot({
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        translations: [{ id: 610, title: 'AniLibria.TV', count: 3000 }, { id: 609, title: 'AniDUB', count: 2500 }],
        kodik: [{ shikimori_id: 1, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 3, updated_at: iso(now - HOUR) }]
    }, { storage: { shikimori_kodik_sync: { at: now, sig: 'v||' }, shikimori_kodik_eps: { s1: { sid: 1, ep: 3, at: now } } } });
    const param = env.Lampa.SettingsApi.params.find(p => p.param.name == 'shikimori_studios_pick');
    param.onChange();
    await env.idle();
    const sel = env.log.selects[env.log.selects.length - 1];
    const item = sel.items.find(i => i.value == 'AniLibria.TV');
    item.checked = true;
    sel.onCheck(item);
    check(S, 'choice stored with its Kodik ids', JSON.stringify(env.Lampa.Storage.get('shikimori_studio_ids', {})) == '{"AniLibria.TV":[610]}',
        env.Lampa.Storage.get('shikimori_studio_ids', {}));
    check(S, 'known episodes and sync point reset', JSON.stringify(env.Lampa.Storage.get('shikimori_kodik_eps', null)) == '{}' &&
        env.Lampa.Storage.get('shikimori_kodik_sync', 1) === null, [env.Lampa.Storage.get('shikimori_kodik_eps'), env.Lampa.Storage.get('shikimori_kodik_sync')]);
};


/* ------------------------------------------------------------------
 * R2. Календарь: карточка с неизвестным видом номера открывается верно
 * ------------------------------------------------------------------ */
scenarios.r2_calendar = async function (S) {
    const now = Date.now();
    const ona = anime({ id: 7201, name: 'Weekly ONA', russian: 'Еженедельная ONA', japanese: '毎週のONA', kind: 'ona', status: 'ongoing', episodes: 12, episodesAired: 4 });
    const { env } = await boot({
        animes: [ona],
        arm: [{ myanimelist: 7201, themoviedb: 8800, media: 'ONA', 'themoviedb-season': null }],
        tmdb: [{ type: 'tv', id: 8800, name_ru: 'Еженедельная ONA', original_name: '毎週のONA', date: '2026-07-01' }],
        calendar: [{ next_episode: 5, next_episode_at: new Date(now + DAY).toISOString(),
            anime: { id: 7201, name: 'Weekly ONA', russian: 'Еженедельная ONA', kind: 'ona', score: '7.5', status: 'ongoing', episodes: 12, episodes_aired: 4, image: { original: '/x.jpg' } } }]
    });
    const comp = await openCatalog(env, { mode: 'calendar' });
    const card = cardByTitle(comp, 'Еженедельная');
    check(S, 'calendar renders the entry', !!card);
    if (!card) return;
    await press(env, card);
    const push = lastPush(env);
    check(S, 'ambiguous ARM media resolved to tv via TMDB', push && push.id == 8800 && push.method == 'tv', { push, noty: env.log.noty });
};

/* ------------------------------------------------------------------
 * R3. Лента Kodik больше не ограничена онгоингами
 * ------------------------------------------------------------------ */
scenarios.r3_feed_params = async function (S) {
    const { env } = await boot({ kodikTokens: ['56a768d08f43091901c44b54fe970049'], kodik: [], animes: [],
        cubPopular: [{ id: 209867, name: 'Фрирен', original_name: '葬送のフリーレン', first_air_date: '2023-09-29', poster_path: '/p.jpg' }] });
    const { built, comp } = await openMain(env);
    const popular = lineOf(env, built, 'shikimori_title_popular_cub');
    check(S, 'CUB popular row is built', popular && popular.results.length == 1, built.map(l => l.title));
    if (popular) {
        const item = {};
        comp.onAppend(item, popular);
        item.onSelect(null, popular.results[0]);
        const push = lastPush(env);
        check(S, 'CUB card opens through the CUB source', push && push.id == 209867 && push.source == 'cub' && push.method == 'tv', push);
    }
    const list = env.log.requests.filter(r => /kodik-api\.com\/list/.test(r.url));
    check(S, 'no anime_status filter in the feed', list.length && list.every(r => r.url.indexOf('anime_status') < 0), list.map(r => r.url.replace(/token=[^&]+/, 'token=*')));
    const tmdbDirect = env.log.requests.filter(r => /api\.themoviedb\.org/.test(r.url));
    check(S, 'main screen does not call TMDB directly without need', tmdbDirect.length == 0, tmdbDirect.map(r => r.url));
};

/* ------------------------------------------------------------------
 * E13. TMDB недоступен совсем — поиск не висит на каждом названии
 * ------------------------------------------------------------------ */
scenarios.e13_tmdb_down = async function (S) {
    const { env } = await boot({
        animes: [F.FRIEREN_S2],
        arm: [],
        tmdb: [F.FRIEREN_TMDB],
        flags: { tmdb_blocked: true, cub_dead: true }
    });
    const comp = await openCatalog(env);
    await press(env, cardByTitle(comp, 'Фрирен 2'));
    const tmdb = env.log.requests.filter(r => /themoviedb\.org|tmdb\.cub\.rip\/3/.test(r.url));
    check(S, 'gives up after one query on both routes', tmdb.length == 2, tmdb.map(r => r.url.split('?')[0]));
    check(S, 'falls through to Lampa search', env.log.searches.length == 1, env.log.searches);
};

async function menuAction(env, card, action) {
    card._card_el.dispatchEvent(new env.window.Event('hover:long'));
    const menu = env.log.selects[env.log.selects.length - 1];
    const item = menu.items.find(i => i.action == action);
    if (!item) return false;
    menu.onSelect(item);
    await env.idle();
    return true;
}

function persisted(env) {
    const out = {};
    for (const [k, v] of env.store) { try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; } }
    return out;
}

/* ------------------------------------------------------------------
 * W1. «Все серии просмотрены» у закладки с новым сезоном — после
 *     перезапуска не возвращается, а новая серия возвращает
 * ------------------------------------------------------------------ */
scenarios.w1_seen_all_bookmark = async function (S) {
    const now = Date.now();
    const { hash } = require('./lampa');
    const timeline = {};
    for (let ep = 1; ep <= 28; ep++) timeline[hash([1, '', ep, '葬送のフリーレン'].join(''))] = 100;
    const kodik = [
        { shikimori_id: 59978, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 3, updated_at: iso(now - 3 * HOUR), episodes_aired: 3 },
        { shikimori_id: 52991, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 28, updated_at: iso(now - 200 * DAY), episodes_aired: 28, anime_status: 'released' }
    ];
    const spec = {
        animes: [F.FRIEREN_S1, F.FRIEREN_S2],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [F.FRIEREN_TMDB],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik
    };
    const fav = { book: [{ id: 209867, name: 'Провожающая в последний путь Фрирен', original_name: '葬送のフリーレン',
        first_air_date: '2023-09-29', genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: 1 }] };
    const { env } = await boot(spec, { favorites: fav, timeline });
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const card = fresh && fresh.results.find(c => c.id == 209867);
    check(S, 'bookmark is in «Новые серии» before marking', !!card);
    if (!card) return;
    await menuAction(env, card, 'seen_all');
    check(S, 'card leaves the row at once', !card._card_el.parentNode);

    const env2 = createEnv({ route: makeWorld(spec).route, storage: persisted(env), favorites: fav, timeline });
    env2.load(FILE);
    const second = await openMain(env2);
    const fresh2 = lineOf(env2, second.built, 'shikimori_title_fresh');
    check(S, 'after restart it does not come back', !fresh2 || !fresh2.results.find(c => c.id == 209867),
        fresh2 && fresh2.results.map(c => c.id + ':' + c._kodik_new));

};

/* ------------------------------------------------------------------
 * W2. То же для тайтла из списка Shikimori (у него нет имени TMDB)
 * ------------------------------------------------------------------ */
scenarios.w2_seen_all_shiki = async function (S) {
    const now = Date.now();
    const a = anime({ id: 60003, name: 'List Show', russian: 'Из списка', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 6 });
    const spec = {
        animes: [a], user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 60003, status: 'watching', episodes: 4 }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 60003, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 6, updated_at: iso(now - HOUR), episodes_aired: 6 }]
    };
    const { env } = await boot(spec, { storage: { shikimori_user: 'me' } });
    const { built } = await openMain(env);
    const card = (lineOf(env, built, 'shikimori_title_fresh') || { results: [] }).results.find(c => String(c.id) == '60003');
    check(S, 'list title is new before marking', !!card);
    if (!card) return;
    await menuAction(env, card, 'seen_all');
    const env2 = createEnv({ route: makeWorld(spec).route, storage: persisted(env) });
    env2.load(FILE);
    const second = await openMain(env2);
    const fresh2 = lineOf(env2, second.built, 'shikimori_title_fresh');
    check(S, 'after restart it does not come back', !fresh2 || !fresh2.results.find(c => String(c.id) == '60003'));
};

/* ------------------------------------------------------------------
 * P1. Скорость: 15 закладок, каждый ответ сети — 400 мс
 * ------------------------------------------------------------------ */
scenarios.p1_main_speed = async function (S) {
    const now = Date.now();
    const animes = [], arm = [], tmdb = [], kodik = [], book = [];
    for (let i = 0; i < 40; i++) {
        const id = 80000 + i;
        animes.push(anime({ id, name: 'Show ' + i, russian: 'Шоу ' + i, kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 5 }));
        arm.push({ myanimelist: id, themoviedb: 90000 + i, media: 'TV', 'themoviedb-season': 1 });
        book.push({ id: 90000 + i, name: 'Шоу ' + i, original_name: 'ショー' + i, first_air_date: '2026-07-01', genre_ids: [16], original_language: 'ja', source: 'tmdb' });
        kodik.push({ shikimori_id: id, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 5, updated_at: iso(now - 50 * HOUR) });
    }
    for (let j = 0; j < 250; j++) kodik.push({ shikimori_id: 70000 + j, translation: { id: 609, title: 'AniDUB', type: 'voice' }, last_episode: 2, updated_at: iso(now - j * 60e3) });
    const world = makeWorld({ animes, arm, tmdb, kodik, kodikTokens: ['56a768d08f43091901c44b54fe970049'] });
    const slow = (m, u, b) => Object.assign({ delay: 500 }, world.route(m, u, b));
    const env = createEnv({ route: slow, favorites: { book } });
    env.load(FILE);
    const t0 = Date.now();
    const Main = env.components.shikimori_main;
    const comp = new Main({ component: 'shikimori_main', page: 1 });
    comp.create();
    await env.waitFor(() => comp.built, 30000);
    const ms = Date.now() - t0;
    console.log('      cold: main screen built in', ms, 'ms');
    await env.idle(15000);
    const fresh = lineOf(env, comp.built, 'shikimori_title_fresh');
    check(S, 'cold start keeps personal rows', fresh && fresh.results.length > 0, comp.built.map(l => l.title));
    const env2 = createEnv({ route: slow, favorites: { book }, storage: persisted(env) });
    env2.load(FILE);
    const t1 = Date.now();
    const comp2 = new env2.components.shikimori_main({ component: 'shikimori_main', page: 1 });
    comp2.create();
    await env2.waitFor(() => comp2.built, 30000);
    const warm = Date.now() - t1;
    console.log('      warm: main screen built in', warm, 'ms');
    if (process.env.TRACE) for (const r of env2.log.requests) console.log('        ', (r.t - t1) + 'ms', r.method, r.url.replace(/token=[^&]+/, '').slice(0, 110), (r.body || '').slice(0, 60));
    check(S, 'warm start under 4 s on a slow network', warm < 4000, warm);
};

/* ------------------------------------------------------------------
 * M. Отметки, поставленные в списке серий самой Lampa (Enter по серии
 *    пишет 95% по original_name полной карточки TMDB и номеру сезона TMDB)
 * ------------------------------------------------------------------ */
function frierenWorld(now, extra) {
    return Object.assign({
        animes: [F.FRIEREN_S1, F.FRIEREN_S2],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 },
              { myanimelist: 59978, themoviedb: 209867, media: 'TV', 'themoviedb-season': 2 }],
        tmdb: [F.FRIEREN_TMDB],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [
            { shikimori_id: 59978, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 3, updated_at: iso(now - 3 * HOUR), episodes_aired: 3 },
            { shikimori_id: 52991, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 28, updated_at: iso(now - 200 * DAY), episodes_aired: 28, anime_status: 'released' }
        ]
    }, extra || {});
}
function lampaMarks(season, eps) {
    const { hash } = require('./lampa');
    const t = {};
    for (const ep of eps) t[hash([season, season > 10 ? ':' : '', ep, '葬送のフリーレン'].join(''))] = 95;
    return t;
}
const FRIEREN_BOOK = { id: 209867, name: 'Провожающая в последний путь Фрирен', original_name: '葬送のフリーレン',
    first_air_date: '2023-09-29', genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: 2 };

scenarios.m1_lampa_marks_bookmark = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const { env } = await boot(spec, { favorites: { book: [FRIEREN_BOOK] }, timeline: lampaMarks(2, [1, 2]) });
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const card = fresh && fresh.results.find(c => c.id == 209867);
    check(S, 'bookmark: 2 of 3 marked in Lampa → +1', card && card._kodik_new == 1, card && { new: card._kodik_new, w: card._watched_ep, t: card._total_ep });
    const { env: e2 } = await boot(spec, { favorites: { book: [FRIEREN_BOOK] }, timeline: lampaMarks(2, [1, 2, 3]) });
    const b2 = (await openMain(e2)).built;
    const f2 = lineOf(e2, b2, 'shikimori_title_fresh');
    const c2 = f2 && f2.results.find(c => c.id == 209867);
    check(S, 'bookmark: all 3 marked in Lampa → not new', !c2 || !c2._kodik_new, c2 && { new: c2._kodik_new, w: c2._watched_ep });
};

scenarios.m2_lampa_marks_shiki_list = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now, { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 59978, status: 'watching', episodes: 0 }] });
    const first = await boot(spec, { storage: { shikimori_user: 'me' }, timeline: lampaMarks(2, [1, 2]) });
    await openMain(first.env);
    await first.env.idle();
    const env = createEnv({ route: makeWorld(spec).route, storage: persisted(first.env), timeline: lampaMarks(2, [1, 2]) });
    env.load(FILE);
    const { built } = await openMain(env);
    const all = built.flatMap(l => (l.results || []).map(c => ({ line: l.title, c })));
    const hits = all.filter(x => String(x.c.id) == '59978' || x.c.id == 209867);
    console.log('      ', hits.map(x => x.line + ' → ' + x.c.id + ' new=' + x.c._kodik_new + ' w=' + x.c._watched_ep + ' t=' + x.c._total_ep).join(' | '));
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const card = fresh && fresh.results.find(c => String(c.id) == '59978' || c.id == 209867);
    check(S, 'Shikimori list: 2 of 3 marked in Lampa → +1', card && card._kodik_new == 1, card && { new: card._kodik_new, w: card._watched_ep });
};

scenarios.m3_lampa_marks_feed = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const first = await boot(spec, { timeline: lampaMarks(2, [1, 2]) });
    await openMain(first.env);
    await first.env.idle();
    const env = createEnv({ route: makeWorld(spec).route, storage: persisted(first.env), timeline: lampaMarks(2, [1, 2]) });
    env.load(FILE);
    const { built } = await openMain(env);
    const hits = built.flatMap(l => (l.results || []).filter(c => String(c.id) == '59978').map(c => ({ l: l.title, c })));
    console.log('      ', hits.map(x => x.l + ' w=' + x.c._watched_ep + ' t=' + x.c._total_ep).join(' | '));
    check(S, 'feed card shows progress 2 of 3', hits.length && hits.every(x => x.c._watched_ep == 2), hits.map(x => x.l + ':' + x.c._watched_ep));
};

scenarios.m4_full_card_remembers_name = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const { env } = await boot(spec, { timeline: lampaMarks(2, [1, 2]) });
    // Тайтл сопоставлен (открывали из плагина), карточка TMDB открылась
    env.Lampa.Storage.set('shikimori_match', { m59978: { tmdb: 209867, media: 'tv', season: 2, how: 'arm', time: now },
        m52991: { tmdb: 209867, media: 'tv', season: 1, how: 'arm', time: now } });
    env.Lampa.Listener.send('full', { type: 'complite', object: { source: 'tmdb', method: 'tv', activity: { render: () => env.$('<div>') } },
        data: { movie: { id: 209867, original_name: '葬送のフリーレン', name: 'Фрирен', first_air_date: '2023-09-29', genres: [{ id: 16 }], original_language: 'ja' } } });
    const info = persisted(env).shikimori_tmdb_info || {};
    check(S, 'name stored from the opened card', info.i209867 && info.i209867.original_name == '葬送のフリーレン', info);
    const { built } = await openMain(env);
    const s2 = built.flatMap(l => (l.results || []).filter(c => String(c.id) == '59978'));
    check(S, 'S2 card shows 2 watched', s2.length && s2.every(c => c._watched_ep == 2), s2.map(c => c._watched_ep));
    const s1 = built.flatMap(l => (l.results || []).filter(c => String(c.id) == '52991'));
    check(S, 'S1 card does not borrow S2 marks', s1.every(c => !c._watched_ep), s1.map(c => c._watched_ep));
};

/* ------------------------------------------------------------------
 * K. «Монолог фармацевта»: третий сезон вышел 2 октября, в базе
 *    соответствий его ещё нет; первая серия отмечена в самой Lampa
 * ------------------------------------------------------------------ */
const K_NAME = '薬屋のひとりごと';
function kWorld(now, opts) {
    opts = opts || {};
    const K1 = anime({ id: 54492, name: 'Kusuriya no Hitorigoto', russian: 'Монолог фармацевта', japanese: K_NAME, kind: 'tv', status: 'released',
        episodes: 24, episodesAired: 24, airedOn: { year: 2023, date: '2023-10-22' },
        related: [{ relationKind: 'sequel', relationText: 'Sequel', anime: { id: 58514, name: 'Kusuriya no Hitorigoto 2nd Season', kind: 'tv', status: 'released' } }] });
    const K2 = anime({ id: 58514, name: 'Kusuriya no Hitorigoto 2nd Season', russian: 'Монолог фармацевта 2', japanese: K_NAME + ' 第2期', kind: 'tv', status: 'released',
        episodes: 24, episodesAired: 24, airedOn: { year: 2025, date: '2025-01-10' },
        related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: 54492, name: 'Kusuriya no Hitorigoto', kind: 'tv', status: 'released' } },
                  { relationKind: 'sequel', relationText: 'Sequel', anime: { id: 61987, name: 'Kusuriya no Hitorigoto 3rd Season', kind: 'tv', status: 'ongoing' } }] });
    const K3 = anime({ id: 61987, name: 'Kusuriya no Hitorigoto 3rd Season', russian: 'Монолог фармацевта 3', japanese: K_NAME + ' 第3期', kind: 'tv', status: 'ongoing',
        episodes: opts.k3eps === undefined ? 12 : opts.k3eps, episodesAired: opts.k3dub || 1, airedOn: { year: 2026, date: '2026-10-02' }, season: 'fall_2026',
        related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: 58514, name: 'Kusuriya no Hitorigoto 2nd Season', kind: 'tv', status: 'released' } },
                  { relationKind: 'sequel', relationText: 'Sequel', anime: { id: 62999, name: 'Kusuriya no Hitorigoto Movie', kind: 'movie', status: 'anons' } }] });
    const arm = [{ myanimelist: 54492, themoviedb: 220542, media: 'TV', 'themoviedb-season': 1 },
                 { myanimelist: 58514, themoviedb: 220542, media: 'TV', 'themoviedb-season': opts.s2season === undefined ? 2 : opts.s2season }];
    if (opts.s3arm !== undefined) arm.push({ myanimelist: 61987, themoviedb: 220542, media: 'TV', 'themoviedb-season': opts.s3arm });
    return Object.assign({
        animes: [K1, K2, K3],
        arm,
        tmdb: [{ type: 'tv', id: 220542, name_ru: 'Монолог фармацевта', name_en: 'The Apothecary Diaries', original_name: K_NAME,
            date: '2023-10-22', seasons: 3, alt: ['Kusuriya no Hitorigoto'], popularity: 150,
            seasonList: opts.tmdbAbsolute
                ? [{ season_number: 1, episode_count: 49, air_date: '2023-10-22', name: 'Сезон 1' }]
                : [{ season_number: 0, episode_count: 3, air_date: '2024-03-01', name: 'Спецвыпуски' },
                   { season_number: 1, episode_count: 24, air_date: '2023-10-22', name: 'Сезон 1' },
                   { season_number: 2, episode_count: 24, air_date: '2025-01-10', name: 'Сезон 2' },
                   { season_number: 3, episode_count: 12, air_date: '2026-10-03', name: 'Сезон 3' }] }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [
            { shikimori_id: 61987, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: opts.k3dub || 1, updated_at: iso(now - 20 * HOUR), episodes_aired: opts.k3dub || 1 },
            { shikimori_id: 58514, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 24, updated_at: iso(now - 400 * DAY), episodes_aired: 24, anime_status: 'released' },
            { shikimori_id: 54492, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 24, updated_at: iso(now - 800 * DAY), episodes_aired: 24, anime_status: 'released' }
        ]
    }, opts.extra || {});
}
function kMarks(upto3, absolute) {
    const { hash } = require('./lampa');
    const t = {};
    if (absolute) {
        for (let ep = 1; ep <= 48 + upto3; ep++) t[hash([1, '', ep, K_NAME].join(''))] = 100;
        return t;
    }
    for (let s = 1; s <= 2; s++) for (let ep = 1; ep <= 24; ep++) t[hash([s, '', ep, K_NAME].join(''))] = 100;
    for (let ep = 1; ep <= upto3; ep++) t[hash([3, '', ep, K_NAME].join(''))] = 95;
    return t;
}
const K_BOOK = { id: 220542, name: 'Монолог фармацевта', original_name: K_NAME, first_air_date: '2023-10-22',
    genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: 2 };

function kFind(built, env) {
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => c.id == 220542 || String(c.id) == '61987' || String(c.id) == '58514');
    return hit ? { id: hit.id, new: hit._kodik_new, w: hit._watched_ep, t: hit._total_ep, label: hit._show_kodik } : null;
}

async function kBookmark(S, opts, title) {
    const now = Date.now();
    const spec = kWorld(now, opts);
    const abs = !!opts.tmdbAbsolute;
    const route = opts.tmdbDown ? (m, u, b) => (/themoviedb|tmdb\./.test(u) && /\/tv\/220542(\?|$)/.test(u) ? { network: true } : makeWorld(spec).route(m, u, b)) : null;
    const env1 = createEnv({ route: route || makeWorld(spec).route, favorites: { book: [K_BOOK] }, timeline: kMarks(1, abs) });
    env1.load(FILE);
    const hit = kFind((await openMain(env1)).built, env1);
    check(S, title + ': S3E1 watched in Lampa → not in «Новые серии»', !hit, hit);
    const cached = (persisted(env1).shikimori_tmdb_seasons || {}).i220542;
    const have = !!(cached && cached.s && cached.s.length);
    check(S, title + ': TMDB seasons ' + (opts.tmdbDown ? 'not cached when TMDB is down' : 'fetched and cached'),
        opts.tmdbDown ? !have : have, cached);
    const env2 = createEnv({ route: route || makeWorld(spec).route, favorites: { book: [K_BOOK] }, timeline: kMarks(0, abs) });
    env2.load(FILE);
    const hit2 = kFind((await openMain(env2)).built, env2);
    check(S, title + ': S3E1 not watched → in «Новые серии» +1', hit2 && hit2.new == 1, hit2);
}

scenarios.k1_bookmark_arm_ok = S => kBookmark(S, {}, 'ARM S2→2');
scenarios.k2_bookmark_arm_s2_as_1 = S => kBookmark(S, { s2season: 1 }, 'ARM S2→1');
scenarios.k3_bookmark_arm_no_season = S => kBookmark(S, { s2season: null }, 'ARM без сезонов');
scenarios.k4_bookmark_arm_s3_known = S => kBookmark(S, { s3arm: 3 }, 'ARM знает S3');
// Как в настоящей базе: все три сезона — первый сезон TMDB со сквозной нумерацией
scenarios.k7_real_arm_tmdb_split = S => kBookmark(S, { s2season: 1, s3arm: 1 }, 'ARM 1/1/1, TMDB 1/2/3');
scenarios.k8_real_arm_tmdb_down = S => kBookmark(S, { s2season: 1, s3arm: 1, tmdbDown: true }, 'ARM 1/1/1, TMDB молчит');
scenarios.k9_real_arm_tmdb_absolute = S => kBookmark(S, { s2season: 1, s3arm: 1, tmdbAbsolute: true }, 'ARM 1/1/1, TMDB сквозной');

scenarios.k5_list_only = async function (S) {
    const now = Date.now();
    const spec = kWorld(now, { s2season: 1, s3arm: 1, extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 61987, status: 'watching', episodes: 0 }] } });
    const first = await boot(spec, { storage: { shikimori_user: 'me' }, timeline: kMarks(1) });
    const hit1 = kFind((await openMain(first.env)).built, first.env);
    await first.env.idle();
    const env = createEnv({ route: makeWorld(spec).route, storage: persisted(first.env), timeline: kMarks(1) });
    env.load(FILE);
    const hit = kFind((await openMain(env)).built, env);
    check(S, 'list only, first show: S3E1 watched in Lampa → not new', !hit1, hit1);
    check(S, 'list only, second show: S3E1 watched in Lampa → not new', !hit, hit);
    const { env: e3 } = await boot(spec, { storage: { shikimori_user: 'me' }, timeline: kMarks(0) });
    const hit3 = kFind((await openMain(e3)).built, e3);
    check(S, 'list only, not watched → new +1', hit3 && hit3.new == 1, hit3);
};

scenarios.k6_list_and_bookmark = async function (S) {
    const now = Date.now();
    const spec = kWorld(now, { s2season: 1, extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 61987, status: 'watching', episodes: 0 }] } });
    const { env } = await boot(spec, { storage: { shikimori_user: 'me' }, favorites: { book: [K_BOOK] }, timeline: kMarks(1) });
    const hit = kFind((await openMain(env)).built, env);
    check(S, 'list + bookmark (ARM S2→1): S3E1 watched → not new', !hit, hit);
};

/* ------------------------------------------------------------------
 * R. Находки ревью 3.7.2
 * ------------------------------------------------------------------ */
const SXF_NAME = 'SPY×FAMILY';
function sxfWorld(now, opts) {
    opts = opts || {};
    const P1 = anime({ id: 50265, name: 'Spy x Family', russian: 'Семья шпиона', kind: 'tv', status: 'released', episodes: 12, episodesAired: 12,
        airedOn: { year: 2022, date: '2022-04-09' },
        related: [{ relationKind: 'sequel', relationText: 'Sequel', anime: { id: 50602, name: 'Spy x Family Part 2', kind: 'tv', status: 'ongoing' } }] });
    const P2 = anime({ id: 50602, name: 'Spy x Family Part 2', russian: 'Семья шпиона. Часть 2', kind: 'tv', status: 'ongoing', episodes: 13, episodesAired: 5,
        airedOn: { year: 2022, date: '2022-10-01' },
        related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: 50265, name: 'Spy x Family', kind: 'tv', status: 'released' } }] });
    return Object.assign({
        animes: [P1, P2],
        arm: [{ myanimelist: 50265, themoviedb: 120089, media: 'TV', 'themoviedb-season': 1 },
              { myanimelist: 50602, themoviedb: 120089, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [{ type: 'tv', id: 120089, name_ru: 'Семья шпиона', name_en: 'SPY x FAMILY', original_name: SXF_NAME, date: '2022-04-09', seasons: 2,
            seasonList: [{ season_number: 1, episode_count: 25, air_date: '2022-04-09', name: 'Сезон 1' },
                         { season_number: 2, episode_count: 12, air_date: '2023-10-07', name: 'Сезон 2' }] }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 50602, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 5, updated_at: iso(now - 10 * HOUR), episodes_aired: 5 },
                { shikimori_id: 50265, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 12, updated_at: iso(now - 300 * DAY), episodes_aired: 12, anime_status: 'released' }]
    }, opts.extra || {});
}
function sxfMarks(from, to) {
    const { hash } = require('./lampa');
    const t = {};
    for (let ep = from; ep <= to; ep++) t[hash([1, '', ep, SXF_NAME].join(''))] = 100;
    return t;
}
function freshOf(env, built, ids) {
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => ids.indexOf(String(c.id)) >= 0);
    return hit ? { id: hit.id, new: hit._kodik_new, w: hit._watched_ep, t: hit._total_ep } : null;
}
async function twoLoads(spec, envOpts) {
    const first = createEnv(Object.assign({ route: makeWorld(spec).route }, envOpts));
    first.load(FILE);
    await openMain(first);
    await first.idle();
    const env = createEnv(Object.assign({ route: makeWorld(spec).route }, envOpts, { storage: persisted(first) }));
    env.load(FILE);
    const { built } = await openMain(env);
    return { env, built };
}

// F1: часть 2 из списка Shikimori; первая часть досмотрена в Lampa (S1E1-12)
scenarios.r1_list_part2_offset = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now, { extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 50602, status: 'watching', episodes: 0 }] } });
    const base = { storage: { shikimori_user: 'me' } };
    let r = await twoLoads(spec, Object.assign({ timeline: sxfMarks(1, 12) }, base));
    let hit = freshOf(r.env, r.built, ['50602', '120089']);
    check(S, 'part 1 watched, part 2 not started → «Новые серии» +5', hit && hit.new == 5, hit);
    r = await twoLoads(spec, Object.assign({ timeline: sxfMarks(1, 15) }, base));
    hit = freshOf(r.env, r.built, ['50602', '120089']);
    check(S, 'part 2 E1-3 watched (S1E13-15) → +2', hit && hit.new == 2, hit);
};

// F5: закладка; часть 2 отмечена с S1E13, первая часть смотрелась не в Lampa
scenarios.r5_bookmark_part2_probe = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now);
    const book = { id: 120089, name: 'Семья шпиона', original_name: SXF_NAME, first_air_date: '2022-04-09', genre_ids: [16],
        original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: 2 };
    const { env } = await boot(spec, { favorites: { book: [book] }, timeline: sxfMarks(13, 15) });
    const { built } = await openMain(env);
    const hit = freshOf(env, built, ['120089']);
    check(S, 'marks S1E13-15 → watched 3 of 5, +2', hit && hit.new == 2 && hit.w == 3, hit);
};

// F2: «Монолог», TMDB молчит, второй сезон досмотрен, третий не начат
async function rApothecaryDown(S, k3eps) {
    const now = Date.now();
    const spec = kWorld(now, { s2season: 1, s3arm: 1, k3eps, k3dub: 3 });
    const route = (m, u, b) => (/themoviedb|tmdb\./.test(u) && /\/tv\/220542(\?|$)/.test(u) ? { network: true } : makeWorld(spec).route(m, u, b));
    const env = createEnv({ route, favorites: { book: [K_BOOK] }, timeline: kMarks(0) });
    env.load(FILE);
    const hit = kFind((await openMain(env)).built, env);
    check(S, 'S3 planned ' + k3eps + ', S2 finished, S3 not started → +3', hit && hit.new == 3, hit);
}
scenarios.r2_tmdb_down_eps_unknown = S => rApothecaryDown(S, 0);
scenarios.r2_tmdb_down_eps_24 = S => rApothecaryDown(S, 24);

// F3: главная собралась по таймеру раньше личных данных — счётчик в меню не обнуляется
scenarios.r3_badge_on_timeout = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const world = makeWorld(spec);
    const route = (m, u, b) => /haglund/.test(u) ? Object.assign({ delay: 12000 }, world.route(m, u, b)) : world.route(m, u, b);
    const env = createEnv({ route, favorites: { book: [FRIEREN_BOOK] }, storage: { shikimori_badge: 4 } });
    env.load(FILE);
    const comp = new env.components.shikimori_main({ component: 'shikimori_main', page: 1 });
    comp.create();
    await env.waitFor(() => comp.built, 15000);
    const badge = env.Lampa.Storage.get('shikimori_badge', null);
    check(S, 'badge keeps 4 when tracked did not arrive in time', badge == 4, badge);
    if (comp.destroy) try { comp.destroy(); } catch (e) {}
};

// F4: карточка TMDB с номером, совпавшим с номером Shikimori в хранилище Kodik
scenarios.r4_tmdb_id_collision = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now, { cubPopular: [{ id: 59978, name: 'Чужой сериал', original_name: 'Unrelated', first_air_date: '2020-01-01',
        poster_path: '/u.jpg', genre_ids: [18], original_language: 'en', origin_country: ['US'], vote_average: 7 }] });
    const { env } = await boot(spec);
    const { comp } = await openMain(env);
    await env.idle();
    const cards = [...comp.render(true).querySelectorAll('.card')].filter(c => /Чужой сериал/.test(c.textContent));
    const markers = cards.map(c => { const m = c.querySelector('.card__marker'); return m ? (m.classList.contains('hide') ? '(hidden)' : m.textContent.trim()) : '(none)'; });
    check(S, 'TMDB card does not show another title’s dub count', cards.length && markers.every(t => !/озвуч/.test(t)), markers);
};

// F9: отметку плагина «просмотрено» можно снять — тайтл возвращается
scenarios.r9_unseen = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const { env } = await boot(spec, { favorites: { book: [FRIEREN_BOOK] } });
    const { built } = await openMain(env);
    const card = (lineOf(env, built, 'shikimori_title_fresh') || { results: [] }).results.find(c => c.id == 209867);
    check(S, 'bookmark is new before marking', !!card);
    if (!card) return;
    await menuAction(env, card, 'seen_all');
    const env2 = createEnv({ route: makeWorld(spec).route, storage: persisted(env), favorites: { book: [FRIEREN_BOOK] } });
    env2.load(FILE);
    const second = await openMain(env2);
    const gone = !(lineOf(env2, second.built, 'shikimori_title_fresh') || { results: [] }).results.find(c => c.id == 209867);
    check(S, 'marked: gone after restart', gone);
    // Снять отметку — с любой карточки этого тайтла, например из «Свежей озвучки»
    const any = second.built.flatMap(l => l.results || []).find(c => String(c.id) == '59978' || c.id == 209867);
    const ok = any && await menuAction(env2, any, 'unseen');
    check(S, '«Снять отметку» is offered on the title', !!ok);
    const env3 = createEnv({ route: makeWorld(spec).route, storage: persisted(env2), favorites: { book: [FRIEREN_BOOK] } });
    env3.load(FILE);
    const third = await openMain(env3);
    const back = (lineOf(env3, third.built, 'shikimori_title_fresh') || { results: [] }).results.find(c => c.id == 209867);
    check(S, 'unmarked: back in «Новые серии»', !!back);
};

// F10 + F9: «Очистить кэш» сбрасывает и сезоны TMDB, и отметки плагина
scenarios.r10_clear_cache_seasons_seen = async function (S) {
    const { env } = await boot({}, { storage: {
        shikimori_tmdb_seasons: { i1: { t: Date.now(), s: [[1, 0, 12]] } },
        shikimori_seen: { s5: { ep: 12, at: Date.now() } }
    } });
    const param = env.Lampa.SettingsApi.params.find(p => p.param.name == 'shikimori_clear_cache');
    param.onChange();
    await env.idle();
    const st = persisted(env);
    check(S, 'seasons cache cleared', !st.shikimori_tmdb_seasons || !Object.keys(st.shikimori_tmdb_seasons).length, st.shikimori_tmdb_seasons);
    check(S, 'plugin “watched” marks cleared', !st.shikimori_seen || !Object.keys(st.shikimori_seen).length, st.shikimori_seen);
};

// F14: страница каталога не спрашивает у TMDB имена вышедших тайтлов
scenarios.r14_catalog_tmdb_requests = async function (S) {
    const animes = [], arm = [], tmdb = [];
    for (let i = 0; i < 30; i++) {
        const id = 81000 + i;
        animes.push(anime({ id, name: 'Old ' + i, russian: 'Старое ' + i, kind: 'tv', status: i < 3 ? 'ongoing' : 'released', episodes: 12, episodesAired: 12, popularity: 100 - i }));
        arm.push({ myanimelist: id, themoviedb: 91000 + i, media: 'TV', 'themoviedb-season': 1 });
        tmdb.push({ type: 'tv', id: 91000 + i, name_ru: 'Старое ' + i, original_name: 'オールド' + i, date: '2020-01-01' });
    }
    const { env } = await boot({ animes, arm, tmdb });
    await openCatalog(env, {});
    await env.idle();
    const details = env.log.requests.filter(r => /\/tv\/91\d{3}(\?|$)/.test(r.url));
    check(S, 'TMDB details only for airing cards (≤ 3)', details.length <= 3, details.length);
};

// F17: «Отметить все» пишет отметки под одним именем
scenarios.r17_mark_one_name = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const book = Object.assign({}, FRIEREN_BOOK, { original_name: 'Sousou no Frieren' });   // ромадзи в закладке
    const timeline = {};
    const env = createEnv({ route: makeWorld(spec).route, favorites: { book: [book] }, timeline,
        storage: { shikimori_tmdb_info: { i209867: { v: 2, t: 'tv', original_name: '葬送のフリーレン', year: '2023', score: 9 } } } });
    env.load(FILE);
    const { built } = await openMain(env);
    const card = (lineOf(env, built, 'shikimori_title_fresh') || { results: [] }).results.find(c => c.id == 209867);
    if (!card) return check(S, 'bookmark is new', false);
    const before = Object.keys(timeline).length;
    await menuAction(env, card, 'seen_all');
    const written = Object.keys(timeline).length - before;
    const { hash } = require('./lampa');
    const tmdbFirst = timeline[hash([card._season || 1, '', (card._offset || 0) + 1, '葬送のフリーレン'].join(''))];
    check(S, 'marks written once, under the TMDB name', written > 0 && written <= 3 && tmdbFirst, { written, season: card._season, offset: card._offset });
};

(async function () {
    const names = Object.keys(scenarios).filter(n => !ONLY || n.indexOf(ONLY) >= 0);
    for (const name of names) {
        try { await scenarios[name](name); }
        catch (e) { check(name, 'scenario crashed', false, e && e.stack); }
    }
    let failed = 0;
    for (const r of results) {
        if (!r.ok) failed++;
        console.log((r.ok ? 'OK  ' : 'FAIL') + '  ' + r.scenario + ' :: ' + r.name + (r.ok ? '' : '\n        ' + JSON.stringify(r.details)));
    }
    console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
