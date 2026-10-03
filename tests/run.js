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


/* ------------------------------------------------------------------
 * B. Находки агента по работе в Lampa (3.7.3)
 * ------------------------------------------------------------------ */
// Закладка без даты выхода: имя TMDB плагин дозапрашивает (TmdbInfo.fill)
const FRIEREN_TRUNC = { id: 209867, name: 'Провожающая в последний путь Фрирен', original_name: 'Sousou no Frieren',
    genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: 2 };
function frierenMarks(eps) {
    const { hash } = require('./lampa');
    const t = {};
    for (const ep of eps) t[hash([2, '', ep, '葬送のフリーレン'].join(''))] = 95;
    return t;
}

// Экран закрыли, пока имя TMDB ещё спрашивалось: следующий показ спрашивает снова
scenarios.b1_screen_closed_during_names = async function (S) {
    const now = Date.now();
    const world = makeWorld(frierenWorld(now));
    const route = (m, u, b) => /\/tv\/209867(\?|$)/.test(u) ? Object.assign({ delay: 600 }, world.route(m, u, b)) : world.route(m, u, b);
    const env = createEnv({ route, favorites: { book: [FRIEREN_TRUNC] }, timeline: frierenMarks([1, 2, 3]) });
    env.load(FILE);
    const tmdb = () => env.log.requests.filter(r => /\/tv\/209867(\?|$)/.test(r.url)).length;
    const first = new env.components.shikimori_main({ component: 'shikimori_main', page: 1 });
    first.create();
    await env.waitFor(() => tmdb() > 0, 8000);
    first.onDestroy();
    await new Promise(r => setTimeout(r, 1200));
    const { built } = await openMain(env);
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const card = fresh && fresh.results.find(c => c.id == 209867);
    check(S, 'name asked again after the screen was closed', tmdb() >= 2, tmdb());
    check(S, 'all 3 watched in Lampa → not in «Новые серии»', !card, card && { n: card._kodik_new, w: card._watched_ep });
};

// «Снять отметку» на закладке откатывает отметки серий и метку «Просмотрено»
scenarios.b3_unseen_bookmark = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const favorites = { book: [FRIEREN_BOOK] };   // состояние Lampa живёт между запусками
    const timeline = {};
    const env = createEnv({ route: makeWorld(spec).route, favorites, timeline });
    env.load(FILE);
    const { built } = await openMain(env);
    const card = (lineOf(env, built, 'shikimori_title_fresh') || { results: [] }).results.find(c => c.id == 209867);
    if (!card) return check(S, 'bookmark is new before marking', false);
    await menuAction(env, card, 'seen_all');
    check(S, 'seen_all wrote marks and the «Просмотрено» tag', Object.keys(timeline).length > 0 && (favorites.viewed || []).length == 1,
        { marks: Object.keys(timeline).length, viewed: (favorites.viewed || []).length });
    const env2 = createEnv({ route: makeWorld(spec).route, storage: persisted(env), favorites, timeline });
    env2.load(FILE);
    const second = await openMain(env2);
    const any = second.built.flatMap(l => l.results || []).find(c => String(c.id) == '59978' || c.id == 209867);
    const ok = any && await menuAction(env2, any, 'unseen');
    check(S, '«Снять отметку» offered', !!ok);
    const left = Object.keys(timeline).filter(h => timeline[h]).length;
    check(S, 'our marks and tag are reverted', left == 0 && !(favorites.viewed || []).length, { left, viewed: (favorites.viewed || []).length });
    const env3 = createEnv({ route: makeWorld(spec).route, storage: persisted(env2), favorites, timeline });
    env3.load(FILE);
    const third = await openMain(env3);
    const back = (lineOf(env3, third.built, 'shikimori_title_fresh') || { results: [] }).results.find(c => c.id == 209867);
    check(S, 'after restart the bookmark is back in «Новые серии»', !!back);
};

// Отметки, поставленные до «Отметить все», «Снять отметку» не трогает
scenarios.b3_unseen_keeps_own_marks = async function (S) {
    const now = Date.now();
    const spec = frierenWorld(now);
    const favorites = { book: [FRIEREN_BOOK] };
    const timeline = frierenMarks([1]);          // первую серию досмотрели сами
    const own = Object.keys(timeline)[0];
    const env = createEnv({ route: makeWorld(spec).route, favorites, timeline });
    env.load(FILE);
    const { built } = await openMain(env);
    const card = (lineOf(env, built, 'shikimori_title_fresh') || { results: [] }).results.find(c => c.id == 209867);
    if (!card) return check(S, 'bookmark is new before marking', false);
    await menuAction(env, card, 'seen_all');
    const env2 = createEnv({ route: makeWorld(spec).route, storage: persisted(env), favorites, timeline });
    env2.load(FILE);
    const second = await openMain(env2);
    const any = second.built.flatMap(l => l.results || []).find(c => String(c.id) == '59978' || c.id == 209867);
    if (any) await menuAction(env2, any, 'unseen');
    check(S, 'own mark from before stays', !!timeline[own], timeline[own]);
};

// ONA из списка Shikimori: база соответствий не знает вида TMDB — всё равно сериал
scenarios.b4_ona_unknown_media = async function (S) {
    const now = Date.now();
    const { hash } = require('./lampa');
    const ona = anime({ id: 60001, name: 'Some ONA', russian: 'Какая-то ONA', kind: 'ona', status: 'ongoing',
        episodes: 10, episodesAired: 3, airedOn: { year: 2026, date: '2026-07-01' } });
    const spec = {
        animes: [ona],
        arm: [{ myanimelist: 60001, themoviedb: 300100, media: 'ONA', 'themoviedb-season': null }],
        tmdb: [{ type: 'tv', id: 300100, name_ru: 'Какая-то ONA', original_name: 'オーエヌエー', date: '2026-07-01' }],
        user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 60001, status: 'watching', episodes: 0 }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 60001, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 3, updated_at: iso(now - 3 * HOUR), episodes_aired: 3 }]
    };
    const timeline = {};
    for (let ep = 1; ep <= 3; ep++) timeline[hash([1, '', ep, 'オーエヌエー'].join(''))] = 95;
    const r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, timeline });
    const hit = freshOf(r.env, r.built, ['60001']);
    check(S, 'ONA with 3 of 3 watched in Lampa → not in «Новые серии»', !hit, hit);
};

/* ==================================================================
 * ADV. Adversarial scenarios (agent C) for 3.7.3 season mapping of
 *      «Новые серии». Each check prints "ACT <scenario> :: <label> =>"
 *      with the actual outcome so both versions can be compared.
 * ================================================================== */
const ADV_TOKEN = '56a768d08f43091901c44b54fe970049';
const ADV_VOICE = { id: 610, title: 'AniLibria.TV', type: 'voice' };
const ADV_TMDB_DOWN = { tmdb_blocked: true, cub_dead: true, tmdb_proxy_dead: true };

// parts: [{ id, name, russian, japanese, kind, status, episodes, aired, date,
//           arm: number|null (in ARM with that season / without season), noArm: true (absent from ARM),
//           dub: last dubbed episode (Kodik), hot: true (dub updated hours ago), next: [ids] (sequels) }]
function advWorld(now, o) {
    const parts = o.parts;
    const byId = {};
    parts.forEach(p => { byId[p.id] = p; });
    const seq = {};
    parts.forEach((p, i) => {
        const next = p.next !== undefined ? p.next : (i + 1 < parts.length ? [parts[i + 1].id] : []);
        seq[p.id] = next;
    });
    const pre = {};
    for (const id in seq) for (const n of seq[id]) (pre[n] = pre[n] || []).push(Number(id));
    const animes = parts.map(p => anime({
        id: p.id, name: p.name, russian: p.russian || p.name, japanese: p.japanese || null,
        english: p.english || null, kind: p.kind || 'tv', status: p.status || 'released',
        episodes: p.episodes, episodesAired: p.aired != null ? p.aired : p.episodes,
        airedOn: { year: Number(p.date.slice(0, 4)), date: p.date },
        season: p.status == 'ongoing' ? 'fall_2026' : null,
        related: (seq[p.id] || []).map(n => ({ relationKind: 'sequel', relationText: 'Sequel',
            anime: { id: n, name: byId[n].name, kind: byId[n].kind || 'tv', status: byId[n].status || 'released' } }))
            .concat((pre[p.id] || []).map(n => ({ relationKind: 'prequel', relationText: 'Prequel',
                anime: { id: n, name: byId[n].name, kind: byId[n].kind || 'tv', status: byId[n].status || 'released' } })))
    }));
    const arm = parts.filter(p => !p.noArm).map(p => ({ myanimelist: p.id, themoviedb: o.tmdb.id,
        media: p.media || 'TV', 'themoviedb-season': p.arm === undefined ? null : p.arm }));
    const kodik = parts.filter(p => p.dub).map(p => p.hot
        ? { shikimori_id: p.id, translation: ADV_VOICE, last_episode: p.dub, updated_at: iso(now - (p.dubAgoH || 5) * HOUR),
            episodes_aired: p.aired != null ? p.aired : p.episodes, anime_status: p.status || 'ongoing' }
        : { shikimori_id: p.id, translation: ADV_VOICE, last_episode: p.dub, updated_at: iso(now - 300 * DAY),
            episodes_aired: p.episodes, anime_status: 'released' });
    const t = o.tmdb;
    const tmdb = [{ type: 'tv', id: t.id, name_ru: t.name_ru, name_en: t.name_en, original_name: t.original_name,
        date: t.date, seasons: (t.seasonList || []).filter(s => s.season_number > 0).length || 1, alt: t.alt || [],
        popularity: 100, seasonList: t.seasonList }];
    return Object.assign({ animes, arm, tmdb, kodikTokens: [ADV_TOKEN], kodik }, o.extra || {});
}

function advBook(t, seasons) {
    return { id: t.id, name: t.name_ru, original_name: t.original_name, first_air_date: t.date, genre_ids: [16],
        original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: seasons || 1 };
}

// spec: [[season, from, to], ...] in Lampa numbering
function advMarks(name, spec) {
    const { hash } = require('./lampa');
    const t = {};
    for (const [s, from, to] of spec) for (let ep = from; ep <= to; ep++) t[hash([s, s > 10 ? ':' : '', ep, name].join(''))] = 100;
    return t;
}

function advFlags(spec, down) {
    if (down) spec.flags = Object.assign({}, spec.flags || {}, ADV_TMDB_DOWN);
    return spec;
}

function advDesc(hit) {
    if (!hit) return 'absent';
    return 'present +' + (hit.new || 0) + ' (w=' + hit.w + ' t=' + hit.t + ')';
}

// exp: { present: false } | { present: true, n }
function advCheck(S, label, hit, exp) {
    const ok = exp.present ? (!!hit && (hit.new || 0) == exp.n) : !hit;
    const want = exp.present ? 'present +' + exp.n : 'absent';
    console.log('ACT ' + S + ' :: ' + label + ' => ' + advDesc(hit) + ' | expected ' + want);
    check(S, label + ' → expected ' + want, ok, advDesc(hit));
}

async function advBookmarkRun(spec, book, timeline, extraStorage) {
    const env = createEnv({ route: makeWorld(spec).route, favorites: { book: [book] }, timeline,
        storage: extraStorage || {} });
    env.load(FILE);
    const { built } = await openMain(env);
    await env.idle();
    return { env, built };
}

async function advListRun(spec, timeline, extraStorage) {
    return twoLoads(spec, { storage: Object.assign({ shikimori_user: 'me' }, extraStorage || {}), timeline });
}

const ADV_USER = { user: { id: 42, nickname: 'me' } };

/* ---------------- Oshi no Ko: ARM 1/1/1 (absolute), TMDB per season ---------------- */
const OSHI = '【推しの子】';
const OSHI_TMDB = { id: 203737, name_ru: 'Звёздное дитя', name_en: '[Oshi No Ko]', original_name: OSHI, date: '2023-04-12',
    alt: ['Oshi no Ko'],
    seasonList: [{ season_number: 1, episode_count: 11, air_date: '2023-04-12', name: 'Сезон 1' },
                 { season_number: 2, episode_count: 13, air_date: '2024-07-03', name: 'Сезон 2' },
                 { season_number: 3, episode_count: 11, air_date: '2026-08-19', name: 'Сезон 3' }] };
function oshiWorld(now, o) {
    o = o || {};
    const s3 = { id: 60058, name: '"Oshi no Ko" 3rd Season', russian: 'Звёздное дитя 3', japanese: OSHI + ' 第3期', status: 'ongoing',
        episodes: 11, aired: 7, date: '2026-08-19', arm: 1, dub: 7, hot: true };
    if (o.s3NoArm) s3.noArm = true;
    return advWorld(now, { tmdb: OSHI_TMDB, extra: o.extra, parts: [
        { id: 52034, name: '"Oshi no Ko"', russian: 'Звёздное дитя', japanese: OSHI, episodes: 11, date: '2023-04-12', arm: 1, dub: 11 },
        { id: 55791, name: '"Oshi no Ko" 2nd Season', russian: 'Звёздное дитя 2', japanese: OSHI + ' 第2期', episodes: 13, date: '2024-07-03', arm: 1, dub: 13 },
        s3] });
}
const OSHI_MID3 = [[1, 1, 11], [2, 1, 13], [3, 1, 5]];
const OSHI_DONE2 = [[1, 1, 11], [2, 1, 13]];
const OSHI_ON1 = [[1, 1, 6]];

async function advOshiBook(S, down, s3NoArm) {
    const now = Date.now();
    const cases = [['mid S3 (S3E1-5), dub 7', OSHI_MID3, { present: true, n: 2 }],
                   ['finished S2, S3 not started', OSHI_DONE2, { present: true, n: 7 }],
                   ['stopped at S1E6', OSHI_ON1, { present: true, n: 7 }]];
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(oshiWorld(now, { s3NoArm }), down);
        const { env, built } = await advBookmarkRun(spec, advBook(OSHI_TMDB, 3), advMarks(OSHI, marks));
        advCheck(S, label, freshOf(env, built, ['203737', '60058']), exp);
    }
}
scenarios.adv_oshi_book_tmdb_up = S => advOshiBook(S, false, false);
scenarios.adv_oshi_book_tmdb_down = S => advOshiBook(S, true, false);
scenarios.adv_oshi_book_s3_not_in_arm_tmdb_up = S => advOshiBook(S, false, true);
scenarios.adv_oshi_book_s3_not_in_arm_tmdb_down = S => advOshiBook(S, true, true);

async function advOshiList(S, down) {
    const now = Date.now();
    const cases = [['mid S3 (S3E1-5), dub 7', OSHI_MID3, { present: true, n: 2 }],
                   ['finished S2, S3 not started', OSHI_DONE2, { present: true, n: 7 }]];
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(oshiWorld(now, { extra: Object.assign({ rates: [{ id: 1, target_id: 60058, status: 'watching', episodes: 0 }] }, ADV_USER) }), down);
        // TMDB down: the TMDB name was learnt earlier (e.g. the card was opened once)
        const st = down ? { shikimori_tmdb_info: { i203737: { v: 2, t: 'tv', original_name: OSHI, year: '2023', score: 8 } } } : {};
        const r = await advListRun(spec, advMarks(OSHI, marks), st);
        advCheck(S, label, freshOf(r.env, r.built, ['60058', '203737']), exp);
    }
}
scenarios.adv_oshi_list_tmdb_up = S => advOshiList(S, false);
scenarios.adv_oshi_list_tmdb_down = S => advOshiList(S, true);

/* ---------------- Mushoku Tensei: ARM 1,1,2,2,3; TMDB S1=23 (P1+P2), S2=24, S3 ---------------- */
const MT = '無職転生 ～異世界行ったら本気だす～';
const MT_TMDB = { id: 94664, name_ru: 'Реинкарнация безработного', name_en: 'Mushoku Tensei: Jobless Reincarnation', original_name: MT,
    date: '2021-01-11', alt: ['Mushoku Tensei'],
    seasonList: [{ season_number: 1, episode_count: 23, air_date: '2021-01-11', name: 'Сезон 1' },
                 { season_number: 2, episode_count: 24, air_date: '2023-07-03', name: 'Сезон 2' },
                 { season_number: 3, episode_count: 12, air_date: '2026-08-24', name: 'Сезон 3' }] };
function mtWorld(now, o) {
    o = o || {};
    const parts = [
        { id: 39535, name: 'Mushoku Tensei: Isekai Ittara Honki Dasu', russian: 'Реинкарнация безработного', japanese: MT, episodes: 11, date: '2021-01-11', arm: 1, dub: 11 },
        { id: 45576, name: 'Mushoku Tensei: Isekai Ittara Honki Dasu Part 2', russian: 'Реинкарнация безработного. Часть 2', episodes: 12, date: '2021-10-04', arm: 1, dub: 12 },
        { id: 51179, name: 'Mushoku Tensei II: Isekai Ittara Honki Dasu', russian: 'Реинкарнация безработного 2', episodes: 12, date: '2023-07-03', arm: 2, dub: 12 },
        { id: 55888, name: 'Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2', russian: 'Реинкарнация безработного 2. Часть 2', episodes: 12, date: '2024-04-08', arm: 2, dub: 12 },
        { id: 59193, name: 'Mushoku Tensei III: Isekai Ittara Honki Dasu', russian: 'Реинкарнация безработного 3', status: 'ongoing', episodes: 12, aired: 6, date: '2026-08-24', arm: 3, dub: 6, hot: true }
    ];
    if (o.s3NoArm) parts[4].noArm = true;
    return advWorld(now, { tmdb: MT_TMDB, parts, extra: o.extra });
}
async function advMtBook(S, down, s3NoArm) {
    const now = Date.now();
    const cases = [['mid S3 (S3E1-4), dub 6', [[1, 1, 23], [2, 1, 24], [3, 1, 4]], { present: true, n: 2 }],
                   ['finished S2, S3 not started', [[1, 1, 23], [2, 1, 24]], { present: true, n: 6 }],
                   ['finished S1 only', [[1, 1, 23]], { present: true, n: 6 }]];
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(mtWorld(now, { s3NoArm }), down);
        const { env, built } = await advBookmarkRun(spec, advBook(MT_TMDB, 3), advMarks(MT, marks));
        advCheck(S, label, freshOf(env, built, ['94664', '59193']), exp);
    }
}
scenarios.adv_mt_book_tmdb_up = S => advMtBook(S, false, false);
scenarios.adv_mt_book_tmdb_down = S => advMtBook(S, true, false);
scenarios.adv_mt_book_s3_not_in_arm_tmdb_down = S => advMtBook(S, true, true);

// The S2 "Part 2" era: Part 2 is the airing one, nothing after it yet
function mtPart2World(now, o) {
    o = o || {};
    const parts = [
        { id: 39535, name: 'Mushoku Tensei: Isekai Ittara Honki Dasu', japanese: MT, episodes: 11, date: '2021-01-11', arm: 1, dub: 11 },
        { id: 45576, name: 'Mushoku Tensei: Isekai Ittara Honki Dasu Part 2', episodes: 12, date: '2021-10-04', arm: 1, dub: 12 },
        { id: 51179, name: 'Mushoku Tensei II: Isekai Ittara Honki Dasu', episodes: 12, date: '2026-04-08', arm: 2, dub: 12 },
        { id: 55888, name: 'Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2', status: 'ongoing', episodes: 12, aired: 6, date: '2026-08-24',
          arm: o.p2arm === undefined ? 2 : o.p2arm, noArm: !!o.p2NoArm, dub: 5, hot: true }
    ];
    const tmdb = Object.assign({}, MT_TMDB, { seasonList: [
        { season_number: 1, episode_count: 23, air_date: '2021-01-11', name: 'Сезон 1' },
        { season_number: 2, episode_count: 24, air_date: '2026-04-08', name: 'Сезон 2' }] });
    return advWorld(now, { tmdb, parts, extra: o.extra });
}
async function advMtPart2(S, down, list, extraOpts) {
    const now = Date.now();
    const cases = [['P2 not started (S2E1-12 seen)', [[1, 1, 23], [2, 1, 12]], { present: true, n: 5 }],
                   ['P2 E1-3 seen (S2E13-15)', [[1, 1, 23], [2, 1, 15]], { present: true, n: 2 }],
                   ['P2 E1-8 seen via subs (S2E13-20), dub 5', [[1, 1, 23], [2, 1, 20]], { present: false }]];
    for (const [label, marks, exp] of cases) {
        if (list) {
            const spec = advFlags(mtPart2World(now, Object.assign({ extra: Object.assign({ rates: [{ id: 1, target_id: 55888, status: 'watching', episodes: 0 }] }, ADV_USER) }, extraOpts)), down);
            const st = down ? { shikimori_tmdb_info: { i94664: { v: 2, t: 'tv', original_name: MT, year: '2021', score: 8 } } } : {};
            const r = await advListRun(spec, advMarks(MT, marks), st);
            advCheck(S, label, freshOf(r.env, r.built, ['55888', '94664']), exp);
        } else {
            const spec = advFlags(mtPart2World(now, extraOpts), down);
            const { env, built } = await advBookmarkRun(spec, advBook(MT_TMDB, 2), advMarks(MT, marks));
            advCheck(S, label, freshOf(env, built, ['94664', '55888']), exp);
        }
    }
}
scenarios.adv_mt_part2_book_tmdb_up = S => advMtPart2(S, false, false);
scenarios.adv_mt_part2_book_tmdb_down = S => advMtPart2(S, true, false);
scenarios.adv_mt_part2_list_tmdb_up = S => advMtPart2(S, false, true);
scenarios.adv_mt_part2_list_tmdb_down = S => advMtPart2(S, true, true);
/* ---------------- Frieren-like: TMDB knows only season 1 (28 eps) ---------------- */
const FR = '葬送のフリーレン';
const FR_TMDB = { id: 209867, name_ru: 'Провожающая в последний путь Фрирен', name_en: "Frieren: Beyond Journey's End", original_name: FR,
    date: '2023-09-29', alt: ['Sousou no Frieren'],
    seasonList: [{ season_number: 1, episode_count: 28, air_date: '2023-09-29', name: 'Сезон 1' }] };
function frWorld(now, o) {
    o = o || {};
    const parts = [
        { id: 52991, name: 'Sousou no Frieren', russian: 'Провожающая в последний путь Фрирен', japanese: FR, episodes: 28, date: '2023-09-29', arm: 1, dub: 28 },
        { id: 59978, name: 'Sousou no Frieren 2nd Season', russian: 'Провожающая в последний путь Фрирен 2', japanese: FR + ' 第2期', status: 'ongoing',
          episodes: 10, aired: o.aired || 5, date: '2026-08-28', arm: o.s2arm === undefined ? 2 : o.s2arm, noArm: !!o.s2NoArm, dub: o.dub || 3, hot: true }
    ];
    if (o.ona) {
        // ONA mini-series between the seasons, ARM maps it to TMDB specials (season 0)
        parts.splice(1, 0, { id: 56885, name: 'Sousou no Frieren: ●● no Mahou', kind: 'ona', episodes: 10, date: '2023-10-20', arm: 0, next: [] });
        parts[0].next = [59978];
    }
    return advWorld(now, { tmdb: FR_TMDB, parts, extra: o.extra });
}
async function advFrBook(S, opts, down, cases) {
    const now = Date.now();
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(frWorld(now, opts), down);
        const { env, built } = await advBookmarkRun(spec, advBook(FR_TMDB, 1), advMarks(FR, marks));
        advCheck(S, label, freshOf(env, built, ['209867', '59978']), exp);
    }
}
const FR_CASES = [['S1 done, S2E1-2 marked in season 2', [[1, 1, 28], [2, 1, 2]], { present: true, n: 1 }],
                  ['S1 done, S2 not started', [[1, 1, 28]], { present: true, n: 3 }],
                  ['S1 done, S2E1-5 via subs (dub 3)', [[1, 1, 28], [2, 1, 5]], { present: false }]];
scenarios.adv_fr_book_arm2_tmdb_up = S => advFrBook(S, {}, false, FR_CASES);
scenarios.adv_fr_book_s2_not_in_arm_tmdb_up = S => advFrBook(S, { s2NoArm: true }, false, FR_CASES);
scenarios.adv_fr_book_arm_abs_tmdb_up = S => advFrBook(S, { s2arm: 1 }, false, FR_CASES);
scenarios.adv_fr_book_arm_abs_tmdb_down = S => advFrBook(S, { s2arm: 1 }, true, FR_CASES);
// + an ONA mini-series that ARM maps to TMDB season 0
scenarios.adv_fr_book_ona_arm_abs_tmdb_down = S => advFrBook(S, { s2arm: 1, ona: true }, true, FR_CASES);
scenarios.adv_fr_book_ona_arm_null_tmdb_down = S => advFrBook(S, { s2arm: null, ona: true }, true, FR_CASES);
scenarios.adv_fr_book_ona_arm_abs_tmdb_up = S => advFrBook(S, { s2arm: 1, ona: true }, false, FR_CASES);

async function advFrList(S, opts, down) {
    const now = Date.now();
    for (const [label, marks, exp] of FR_CASES) {
        const spec = advFlags(frWorld(now, Object.assign({ extra: Object.assign({ rates: [{ id: 1, target_id: 59978, status: 'watching', episodes: 0 }] }, ADV_USER) }, opts)), down);
        const st = down ? { shikimori_tmdb_info: { i209867: { v: 2, t: 'tv', original_name: FR, year: '2023', score: 9 } } } : {};
        const r = await advListRun(spec, advMarks(FR, marks), st);
        advCheck(S, label, freshOf(r.env, r.built, ['59978', '209867']), exp);
    }
}
scenarios.adv_fr_list_arm2_tmdb_up = S => advFrList(S, {}, false);
scenarios.adv_fr_list_arm2_tmdb_down = S => advFrList(S, {}, true);

/* ---------------- Single-season ongoing: ARM without season, TMDB without data ---------------- */
const HS = '星の歌';
const HS_TMDB = { id: 300001, name_ru: 'Песнь звёзд', name_en: 'Song of Stars', original_name: HS, date: '2026-08-15', alt: ['Hoshi no Uta'],
    seasonList: [{ season_number: 1, episode_count: 12, air_date: '2026-08-15', name: 'Сезон 1' }] };
function hsWorld(now, o) {
    o = o || {};
    return advWorld(now, { tmdb: HS_TMDB, extra: o.extra, parts: [
        { id: 61000, name: 'Hoshi no Uta', russian: 'Песнь звёзд', japanese: HS, status: 'ongoing', episodes: o.eps === undefined ? 12 : o.eps,
          aired: 7, date: '2026-08-15', arm: null, dub: 5, hot: true }] });
}
const HS_CASES = [['E1-3 watched, dub 5', [[1, 1, 3]], { present: true, n: 2 }],
                  ['E1-5 watched, dub 5', [[1, 1, 5]], { present: false }],
                  ['E1-7 watched via subs, dub 5', [[1, 1, 7]], { present: false }]];
async function advHs(S, list, down, opts) {
    const now = Date.now();
    for (const [label, marks, exp] of HS_CASES) {
        if (list) {
            const spec = advFlags(hsWorld(now, Object.assign({ extra: Object.assign({ rates: [{ id: 1, target_id: 61000, status: 'watching', episodes: 0 }] }, ADV_USER) }, opts)), down);
            const st = down ? { shikimori_tmdb_info: { i300001: { v: 2, t: 'tv', original_name: HS, year: '2026', score: 7 } } } : {};
            const r = await advListRun(spec, advMarks(HS, marks), st);
            advCheck(S, label, freshOf(r.env, r.built, ['61000', '300001']), exp);
        } else {
            const spec = advFlags(hsWorld(now, opts), down);
            const { env, built } = await advBookmarkRun(spec, advBook(HS_TMDB, 1), advMarks(HS, marks));
            advCheck(S, label, freshOf(env, built, ['300001', '61000']), exp);
        }
    }
}
scenarios.adv_single_book_tmdb_down = S => advHs(S, false, true);
scenarios.adv_single_book_tmdb_up = S => advHs(S, false, false);
scenarios.adv_single_list_tmdb_down = S => advHs(S, true, true);
scenarios.adv_single_list_tmdb_up = S => advHs(S, true, false);
scenarios.adv_single_list_eps0_tmdb_down = S => advHs(S, true, true, { eps: 0 });

/* ---------------- Long show, planned episodes unknown (0), absolute numbering ---------------- */
const OP = 'ONE PIECE';
const OP_TMDB = { id: 37854, name_ru: 'Ван-Пис', name_en: 'One Piece', original_name: OP, date: '1999-10-20', alt: ['One Piece'],
    seasonList: [{ season_number: 1, episode_count: 1145, air_date: '1999-10-20', name: 'Сезон 1' }] };
function opWorld(now, o) {
    o = o || {};
    return advWorld(now, { tmdb: OP_TMDB, extra: o.extra, parts: [
        { id: 21, name: 'One Piece', russian: 'Ван-Пис', japanese: 'ONE PIECE', status: 'ongoing', episodes: 0, aired: 1145,
          date: '1999-10-20', arm: 1, dub: 1140, hot: true }] });
}
scenarios.adv_long_book = async function (S) {
    const now = Date.now();
    const cases = [['watched 1-1130 (absolute), dub 1140', [[1, 1, 1130]], { present: true, n: 10 }],
                   ['watched 1-1140', [[1, 1, 1140]], { present: false }],
                   ['watched 1-1100', [[1, 1, 1100]], { present: true, n: 40 }],
                   ['watched 1-300', [[1, 1, 300]], { present: true, n: 840 }]];
    for (const down of [false, true]) {
        for (const [label, marks, exp] of cases) {
            const spec = advFlags(opWorld(now), down);
            const { env, built } = await advBookmarkRun(spec, advBook(OP_TMDB, 1), advMarks(OP, marks));
            advCheck(S, (down ? '[TMDB down] ' : '[TMDB up] ') + label, freshOf(env, built, ['37854', '21']), exp);
        }
    }
};
// Long show split by Shikimori into two entries; the newest has planned episodes unknown
const LS = 'ロングショー';
const LS_TMDB = { id: 310002, name_ru: 'Долгая история', name_en: 'Long Story', original_name: LS, date: '2017-04-05', alt: ['Long Show'],
    seasonList: [{ season_number: 1, episode_count: 293, air_date: '2017-04-05', name: 'Сезон 1' },
                 { season_number: 2, episode_count: 20, air_date: '2026-05-10', name: 'Сезон 2' }] };
function lsWorld(now, o) {
    o = o || {};
    return advWorld(now, { tmdb: LS_TMDB, extra: o.extra, parts: [
        { id: 34566, name: 'Long Show', japanese: LS, episodes: 293, date: '2017-04-05', arm: 1, dub: 293 },
        { id: 58000, name: 'Long Show: Two Blue Vortex', japanese: LS + ' 第2部', status: 'ongoing', episodes: 0, aired: 21, date: '2026-05-10',
          arm: o.s2arm === undefined ? 1 : o.s2arm, noArm: !!o.s2NoArm, dub: 20, hot: true }] });
}
async function advLs(S, opts, down) {
    const now = Date.now();
    const cases = [['part 2 E1-15 marked in season 2, dub 20', [[1, 1, 293], [2, 1, 15]], { present: true, n: 5 }],
                   ['part 1 done, part 2 not started', [[1, 1, 293]], { present: true, n: 20 }],
                   ['part 2 E1-20 marked', [[1, 1, 293], [2, 1, 20]], { present: false }]];
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(lsWorld(now, opts), down);
        const { env, built } = await advBookmarkRun(spec, advBook(LS_TMDB, 2), advMarks(LS, marks));
        advCheck(S, label, freshOf(env, built, ['310002', '58000']), exp);
    }
}
scenarios.adv_long2_arm_abs_tmdb_up = S => advLs(S, {}, false);
scenarios.adv_long2_arm_abs_tmdb_down = S => advLs(S, {}, true);
scenarios.adv_long2_not_in_arm_tmdb_down = S => advLs(S, { s2NoArm: true }, true);

/* ---------------- tv_special (recap) between seasons, in the sequel chain ---------------- */
const SS = '週末ショー';
const SS_TMDB = { id: 320003, name_ru: 'Шоу выходного дня', name_en: 'Weekend Show', original_name: SS, date: '2024-01-10', alt: ['Shuumatsu Show'],
    seasonList: [{ season_number: 0, episode_count: 1, air_date: '2026-08-23', name: 'Спецвыпуски' },
                 { season_number: 1, episode_count: 12, air_date: '2024-01-10', name: 'Сезон 1' },
                 { season_number: 2, episode_count: 12, air_date: '2026-08-30', name: 'Сезон 2' }] };
function ssWorld(now, o) {
    o = o || {};
    const parts = [
        { id: 57001, name: 'Shuumatsu Show', japanese: SS, episodes: 12, date: '2024-01-10', arm: 1, dub: 12 },
        { id: 57002, name: 'Shuumatsu Show: Recap', kind: 'tv_special', episodes: 1, date: '2026-08-23', noArm: true },
        { id: 57003, name: 'Shuumatsu Show 2nd Season', japanese: SS + ' 第2期', status: 'ongoing', episodes: 12, aired: 6, date: '2026-08-30',
          arm: o.s2arm === undefined ? 2 : o.s2arm, noArm: o.s2NoArm !== false, dub: 5, hot: true }
    ];
    return advWorld(now, { tmdb: SS_TMDB, parts, extra: o.extra });
}
async function advSs(S, opts, down) {
    const now = Date.now();
    const cases = [['S2E1-3 watched, dub 5', [[1, 1, 12], [2, 1, 3]], { present: true, n: 2 }],
                   ['S1 done, S2 not started', [[1, 1, 12]], { present: true, n: 5 }],
                   ['S2E1-5 watched', [[1, 1, 12], [2, 1, 5]], { present: false }]];
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(ssWorld(now, opts), down);
        const { env, built } = await advBookmarkRun(spec, advBook(SS_TMDB, 2), advMarks(SS, marks));
        advCheck(S, label, freshOf(env, built, ['320003', '57003']), exp);
    }
}
scenarios.adv_special_between_tmdb_up = S => advSs(S, {}, false);
scenarios.adv_special_between_tmdb_down = S => advSs(S, {}, true);
scenarios.adv_special_between_arm2_tmdb_down = S => advSs(S, { s2NoArm: false, s2arm: 2 }, true);
/* ---------------- Demon Slayer-like: ARM absolute (all season 1), a TMDB season made of two
 *                  Shikimori entries without "part/cour" in the name (Mugen Ressha-hen TV +
 *                  Yuukaku-hen = TMDB S2) ---------------- */
const KNY = '鬼滅の刃';
const KNY_TMDB = { id: 85937, name_ru: 'Клинок, рассекающий демонов', name_en: 'Demon Slayer: Kimetsu no Yaiba', original_name: KNY,
    date: '2019-04-06', alt: ['Kimetsu no Yaiba'],
    seasonList: [{ season_number: 1, episode_count: 26, air_date: '2019-04-06', name: 'Сезон 1' },
                 { season_number: 2, episode_count: 18, air_date: '2021-10-10', name: 'Сезон 2' },
                 { season_number: 3, episode_count: 11, air_date: '2023-04-09', name: 'Сезон 3' },
                 { season_number: 4, episode_count: 8, air_date: '2026-08-30', name: 'Сезон 4' }] };
function knyWorld(now, o) {
    o = o || {};
    const lab = o.labels || [1, 1, 1, 1, 1];
    return advWorld(now, { tmdb: KNY_TMDB, extra: o.extra, parts: [
        { id: 38000, name: 'Kimetsu no Yaiba', japanese: KNY, episodes: 26, date: '2019-04-06', arm: lab[0], dub: 26 },
        { id: 49926, name: 'Kimetsu no Yaiba: Mugen Ressha-hen', episodes: 7, date: '2021-10-10', arm: lab[1], dub: 7 },
        { id: 47778, name: 'Kimetsu no Yaiba: Yuukaku-hen', episodes: 11, date: '2021-12-05', arm: lab[2], dub: 11 },
        { id: 51019, name: 'Kimetsu no Yaiba: Katanakaji no Sato-hen', episodes: 11, date: '2023-04-09', arm: lab[3], dub: 11 },
        { id: 55701, name: 'Kimetsu no Yaiba: Hashira Geiko-hen', status: 'ongoing', episodes: 8, aired: 5, date: '2026-08-30', arm: lab[4], dub: 5, hot: true }] });
}
async function advKny(S, opts, down) {
    const now = Date.now();
    const cases = [['mid S4 (S4E1-3), dub 5', [[1, 1, 26], [2, 1, 18], [3, 1, 11], [4, 1, 3]], { present: true, n: 2 }],
                   ['S3 done, S4 not started', [[1, 1, 26], [2, 1, 18], [3, 1, 11]], { present: true, n: 5 }],
                   ['S4E1-5 watched', [[1, 1, 26], [2, 1, 18], [3, 1, 11], [4, 1, 5]], { present: false }]];
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(knyWorld(now, opts), down);
        const { env, built } = await advBookmarkRun(spec, advBook(KNY_TMDB, 4), advMarks(KNY, marks));
        advCheck(S, label, freshOf(env, built, ['85937', '55701']), exp);
    }
}
scenarios.adv_kny_arm_abs_tmdb_up = S => advKny(S, {}, false);
scenarios.adv_kny_arm_abs_tmdb_down = S => advKny(S, {}, true);
scenarios.adv_kny_arm_tmdbstyle_tmdb_down = S => advKny(S, { labels: [1, 2, 2, 3, 4] }, true);

/* ---------------- New season TMDB does not know yet, fully dubbed; list item ---------------- */
const NS = 'ニッチな話';
function nsWorld(now, o) {
    o = o || {};
    const s1eps = o.s1eps || 12;
    const tmdb = { id: 330004, name_ru: 'Нишевая история', name_en: 'Niche Story', original_name: NS, date: '2024-04-05', alt: ['Niche no Hanashi'],
        seasonList: [{ season_number: 1, episode_count: s1eps, air_date: '2024-04-05', name: 'Сезон 1' }]
            .concat(o.s2NoDate ? [{ season_number: 2, episode_count: 12, air_date: null, name: 'Сезон 2' }] : [])
            .concat(o.s2Late ? [{ season_number: 2, episode_count: 12, air_date: '2026-08-05', name: 'Сезон 2' }] : []) };
    return advWorld(now, { tmdb, extra: o.extra, parts: [
        { id: 58100, name: 'Niche no Hanashi', japanese: NS, episodes: s1eps, date: '2024-04-05', arm: 1, dub: s1eps },
        // finished airing two weeks ago, the dub caught up three days ago
        { id: 58101, name: 'Niche no Hanashi 2nd Season', japanese: NS + ' 第2期', status: o.s2status || 'released', episodes: 12, aired: 12,
          date: '2026-06-28', arm: 2, dub: o.dub || 12, hot: true, dubAgoH: 72 }] });
}
async function advNs(S, list, opts) {
    const now = Date.now();
    opts = opts || {};
    const s1 = opts.s1eps || 12;
    const dub = opts.dub || 12;
    const cases = [['S1 done, S2 not started (S2 dub ' + dub + '/12)', [[1, 1, s1]], { present: true, n: dub }],
                   ['S1 done, S2E1-4 watched', [[1, 1, s1], [2, 1, 4]], { present: true, n: dub - 4 }]];
    for (const [label, marks, exp] of cases) {
        if (list) {
            const spec = nsWorld(now, Object.assign({ extra: Object.assign({ rates: [{ id: 1, target_id: 58101, status: 'watching', episodes: 0 }] }, ADV_USER) }, opts));
            const r = await advListRun(spec, advMarks(NS, marks));
            advCheck(S, label, freshOf(r.env, r.built, ['58101', '330004']), exp);
        } else {
            const spec = nsWorld(now, opts);
            const book = advBook({ id: 330004, name_ru: 'Нишевая история', original_name: NS, date: '2024-04-05' }, 1);
            const { env, built } = await advBookmarkRun(spec, book, advMarks(NS, marks));
            advCheck(S, label, freshOf(env, built, ['330004', '58101']), exp);
        }
    }
}
scenarios.adv_newseason_unknown_to_tmdb_list = S => advNs(S, true);
scenarios.adv_newseason_unknown_to_tmdb_list_s1_24 = S => advNs(S, true, { s1eps: 24 });
scenarios.adv_newseason_unknown_to_tmdb_list_dub10 = S => advNs(S, true, { dub: 10 });
scenarios.adv_newseason_unknown_to_tmdb_book = S => advNs(S, false);
// TMDB already lists season 2, but without an air date yet
scenarios.adv_newseason_tmdb_nodate_list = S => advNs(S, true, { s2NoDate: true });
scenarios.adv_newseason_tmdb_nodate_book = S => advNs(S, false, { s2NoDate: true });
// TMDB has season 2 with its TV date, 38 days after Shikimori's (web) premiere
scenarios.adv_newseason_tmdb_latedate_list = S => advNs(S, true, { s2Late: true });

/* ---------------- Spy x Family Part 2 from the Shikimori list, user ahead via subs ---------------- */
scenarios.adv_sxf_list_ahead = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now, { extra: Object.assign({ rates: [{ id: 1, target_id: 50602, status: 'watching', episodes: 0 }] }, ADV_USER) });
    const cases = [['part 2 E1-8 via subs (S1E13-20), dub 5', sxfMarks(1, 20), { present: false }],
                   ['part 2 E1-5 (S1E13-17), dub 5', sxfMarks(1, 17), { present: false }],
                   ['part 2 E1-4 (S1E13-16), dub 5', sxfMarks(1, 16), { present: true, n: 1 }]];
    for (const [label, timeline, exp] of cases) {
        const r = await advListRun(spec, timeline);
        advCheck(S, label, freshOf(r.env, r.built, ['50602', '120089']), exp);
    }
};

/* ---------------- Apothecary Diaries, TMDB with absolute numbering, Shikimori list only ---------------- */
scenarios.adv_k9_list_absolute = async function (S) {
    const now = Date.now();
    const spec = kWorld(now, { s2season: 1, s3arm: 1, tmdbAbsolute: true,
        extra: Object.assign({ rates: [{ id: 1, target_id: 61987, status: 'watching', episodes: 0 }] }, ADV_USER) });
    const cases = [['S3E1 watched (absolute S1E49)', kMarks(1, true), { present: false }],
                   ['S3 not started (absolute S1E1-48)', kMarks(0, true), { present: true, n: 1 }]];
    for (const [label, timeline, exp] of cases) {
        const r = await advListRun(spec, timeline);
        const hit = kFind(r.built, r.env);
        advCheck(S, label, hit ? { new: hit.new, w: hit.w, t: hit.t } : null, exp);
    }
};
// Same, bookmark + list at once
scenarios.adv_k9_list_and_book_absolute = async function (S) {
    const now = Date.now();
    const spec = kWorld(now, { s2season: 1, s3arm: 1, tmdbAbsolute: true,
        extra: Object.assign({ rates: [{ id: 1, target_id: 61987, status: 'watching', episodes: 0 }] }, ADV_USER) });
    const cases = [['S3E1 watched (absolute S1E49)', kMarks(1, true), { present: false }],
                   ['S3 not started (absolute S1E1-48)', kMarks(0, true), { present: true, n: 1 }]];
    for (const [label, timeline, exp] of cases) {
        const r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, favorites: { book: [K_BOOK] }, timeline });
        const hit = kFind(r.built, r.env);
        advCheck(S, label, hit ? { new: hit.new, w: hit.w, t: hit.t } : null, exp);
    }
};

/* ---------------- Mushoku Tensei with the real "episode 0" TV special (Shugo Jutsushi Fitz)
 *                  that TMDB counts as S2E1 ---------------- */
function mtFitzWorld(now) {
    const parts = [
        { id: 39535, name: 'Mushoku Tensei: Isekai Ittara Honki Dasu', japanese: MT, episodes: 11, date: '2021-01-11', arm: 1, dub: 11 },
        { id: 45576, name: 'Mushoku Tensei: Isekai Ittara Honki Dasu Part 2', episodes: 12, date: '2021-10-04', arm: 1, dub: 12 },
        { id: 50360, name: 'Mushoku Tensei II: Isekai Ittara Honki Dasu - Shugo Jutsushi Fitz', kind: 'tv_special', episodes: 1, date: '2026-03-30', arm: 2 },
        { id: 51179, name: 'Mushoku Tensei II: Isekai Ittara Honki Dasu', episodes: 12, date: '2026-04-06', arm: 2, dub: 12 },
        { id: 55888, name: 'Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2', status: 'ongoing', episodes: 12, aired: 6, date: '2026-08-24', arm: 2, dub: 5, hot: true }
    ];
    const tmdb = Object.assign({}, MT_TMDB, { seasonList: [
        { season_number: 1, episode_count: 23, air_date: '2021-01-11', name: 'Сезон 1' },
        { season_number: 2, episode_count: 25, air_date: '2026-03-30', name: 'Сезон 2' }] });
    return advWorld(now, { tmdb, parts });
}
scenarios.adv_mt_fitz_book = async function (S) {
    const now = Date.now();
    // TMDB S2: E1 = Fitz, E2-13 = cour 1, E14-25 = cour 2
    const cases = [['cour 2 E1-3 (S2E14-16), dub 5', [[1, 1, 23], [2, 1, 16]], { present: true, n: 2 }],
                   ['cour 2 E1-5 (S2E14-18), dub 5', [[1, 1, 23], [2, 1, 18]], { present: false }],
                   ['cour 2 E1-4 (S2E14-17), dub 5', [[1, 1, 23], [2, 1, 17]], { present: true, n: 1 }]];
    for (const down of [false, true]) {
        for (const [label, marks, exp] of cases) {
            const spec = advFlags(mtFitzWorld(now), down);
            const { env, built } = await advBookmarkRun(spec, advBook(MT_TMDB, 2), advMarks(MT, marks));
            advCheck(S, (down ? '[TMDB down] ' : '[TMDB up] ') + label, freshOf(env, built, ['94664', '55888']), exp);
        }
    }
};
/* ---------------- ONA series (e.g. a donghua) in the Shikimori list; ARM row without season, media ONA ---------------- */
const DH = '斗破苍穹';
const DH_TMDB = { id: 340005, name_ru: 'Битва сквозь небеса', name_en: 'Battle Through the Heavens', original_name: DH, date: '2026-07-01',
    alt: ['Doupo Cangqiong'], seasonList: [{ season_number: 1, episode_count: 52, air_date: '2026-07-01', name: 'Сезон 1' }] };
function dhWorld(now, o) {
    o = o || {};
    return advWorld(now, { tmdb: DH_TMDB, extra: o.extra, parts: [
        { id: 62000, name: 'Doupo Cangqiong 6th Season', japanese: DH, kind: 'ona', status: 'ongoing', episodes: 52, aired: 14, date: '2026-07-01',
          arm: null, media: 'ONA', dub: 12, hot: true }] });
}
scenarios.adv_ona_list_media_unknown = async function (S) {
    const now = Date.now();
    const cases = [['E1-10 watched, dub 12', [[1, 1, 10]], { present: true, n: 2 }],
                   ['E1-12 watched, dub 12', [[1, 1, 12]], { present: false }]];
    for (const [label, marks, exp] of cases) {
        const spec = dhWorld(now, { extra: Object.assign({ rates: [{ id: 1, target_id: 62000, status: 'watching', episodes: 0 }] }, ADV_USER) });
        const r = await advListRun(spec, advMarks(DH, marks));
        advCheck(S, label, freshOf(r.env, r.built, ['62000', '340005']), exp);
    }
};

/* ---------------- Re:Zero-like: a TV-kind recap ("Shin Henshuu-ban") that ARM maps to TMDB specials ---------------- */
const RZ = 'Re：ゼロから始める異世界生活';
const RZ_TMDB = { id: 65942, name_ru: 'Re: Жизнь в альтернативном мире с нуля', name_en: 'Re:ZERO -Starting Life in Another World-', original_name: RZ,
    date: '2016-04-04', alt: ['Re:Zero kara Hajimeru Isekai Seikatsu'],
    seasonList: [{ season_number: 1, episode_count: 25, air_date: '2016-04-04', name: 'Сезон 1' },
                 { season_number: 2, episode_count: 25, air_date: '2020-07-08', name: 'Сезон 2' },
                 { season_number: 3, episode_count: 16, air_date: '2026-08-26', name: 'Сезон 3' }] };
function rzWorld(now, o) {
    o = o || {};
    const lab = o.labels || [1, 0, 1, 1, 1];
    return advWorld(now, { tmdb: RZ_TMDB, extra: o.extra, parts: [
        { id: 31240, name: 'Re:Zero kara Hajimeru Isekai Seikatsu', japanese: RZ, episodes: 25, date: '2016-04-04', arm: lab[0], dub: 25, next: [39587] },
        { id: 38414, name: 'Re:Zero kara Hajimeru Isekai Seikatsu Shin Henshuu-ban', episodes: 13, date: '2020-01-01', arm: lab[1], next: [] },
        { id: 39587, name: 'Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season', episodes: 13, date: '2020-07-08', arm: lab[2], dub: 13 },
        { id: 42203, name: 'Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2', episodes: 12, date: '2021-01-06', arm: lab[3], dub: 12 },
        { id: 54857, name: 'Re:Zero kara Hajimeru Isekai Seikatsu 3rd Season', status: 'ongoing', episodes: 16, aired: 6, date: '2026-08-26', arm: lab[4], dub: 5, hot: true }] });
}
async function advRz(S, opts, down) {
    const now = Date.now();
    const cases = [['mid S3 (S3E1-3), dub 5', [[1, 1, 25], [2, 1, 25], [3, 1, 3]], { present: true, n: 2 }],
                   ['S2 done, S3 not started', [[1, 1, 25], [2, 1, 25]], { present: true, n: 5 }],
                   ['S3E1-5 watched', [[1, 1, 25], [2, 1, 25], [3, 1, 5]], { present: false }]];
    for (const [label, marks, exp] of cases) {
        const spec = advFlags(rzWorld(now, opts), down);
        const { env, built } = await advBookmarkRun(spec, advBook(RZ_TMDB, 3), advMarks(RZ, marks));
        advCheck(S, label, freshOf(env, built, ['65942', '54857']), exp);
    }
}
scenarios.adv_rezero_recap_arm_abs_tmdb_down = S => advRz(S, {}, true);
scenarios.adv_rezero_recap_arm_abs_tmdb_up = S => advRz(S, {}, false);
scenarios.adv_rezero_recap_arm_tmdbstyle_tmdb_down = S => advRz(S, { labels: [1, 0, 2, 2, 3] }, true);

/* ---------------- SxF Part 2 from the list, TMDB lists only the episodes aired so far (12 + 5) ---------------- */
scenarios.adv_sxf_list_tmdb_partial = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now, { extra: Object.assign({ rates: [{ id: 1, target_id: 50602, status: 'watching', episodes: 0 }] }, ADV_USER) });
    spec.tmdb[0].seasonList = [{ season_number: 1, episode_count: 17, air_date: '2022-04-09', name: 'Сезон 1' }];
    const cases = [['part 2 E1-3 (S1E13-15), dub 5', sxfMarks(1, 15), { present: true, n: 2 }],
                   ['part 1 done, part 2 not started', sxfMarks(1, 12), { present: true, n: 5 }]];
    for (const [label, timeline, exp] of cases) {
        const r = await advListRun(spec, timeline);
        advCheck(S, label, freshOf(r.env, r.built, ['50602', '120089']), exp);
    }
};

/* ---------------- Frieren S2 finished airing and fully dubbed; TMDB still lists only S1 (28) ---------------- */
async function advFrDone(S, list) {
    const now = Date.now();
    const cases = [['S1 done, S2 not started (dub 10/10)', [[1, 1, 28]], { present: true, n: 10 }],
                   ['S1 done, S2E1-4 watched', [[1, 1, 28], [2, 1, 4]], { present: true, n: 6 }]];
    for (const [label, marks, exp] of cases) {
        const base = frWorld(now, { aired: 10, dub: 10, extra: list ? Object.assign({ rates: [{ id: 1, target_id: 59978, status: 'watching', episodes: 0 }] }, ADV_USER) : undefined });
        // S2 is over: status released, last dubbed episode three days ago
        base.animes.find(a => a.id == 59978).status = 'released';
        base.kodik.find(k => k.shikimori_id == 59978).anime_status = 'released';
        base.kodik.find(k => k.shikimori_id == 59978).updated_at = iso(now - 3 * DAY);
        base.kodik.find(k => k.shikimori_id == 59978).created_at = iso(now - 40 * DAY);
        const r = list ? await advListRun(base, advMarks(FR, marks))
                       : await advBookmarkRun(base, advBook(FR_TMDB, 1), advMarks(FR, marks));
        advCheck(S, label, freshOf(r.env, r.built, ['59978', '209867']), exp);
    }
}
scenarios.adv_fr_s2_done_list = S => advFrDone(S, true);
scenarios.adv_fr_s2_done_book = S => advFrDone(S, false);
/* ---------------- One TMDB failure, then TMDB is back: does the right answer come back? ---------------- */
scenarios.adv_kny_tmdb_blip = async function (S) {
    const now = Date.now();
    const marks = advMarks(KNY, [[1, 1, 26], [2, 1, 18], [3, 1, 11], [4, 1, 3]]);
    const first = createEnv({ route: makeWorld(advFlags(knyWorld(now), true)).route, favorites: { book: [advBook(KNY_TMDB, 4)] }, timeline: marks });
    first.load(FILE);
    await openMain(first);
    await first.idle();
    // next showing, an hour later in real life: TMDB answers again
    const env = createEnv({ route: makeWorld(knyWorld(now)).route, favorites: { book: [advBook(KNY_TMDB, 4)] }, timeline: marks, storage: persisted(first) });
    env.load(FILE);
    const { built } = await openMain(env);
    const tv = env.log.requests.filter(r => /\/tv\/85937(\?|$)/.test(r.url)).length;
    console.log('      TMDB tv/85937 requests on the second showing:', tv);
    advCheck(S, 'TMDB failed once, back now; mid S4 (S4E1-3), dub 5', freshOf(env, built, ['85937', '55701']), { present: true, n: 2 });
};

/* ------------------------------------------------------------------
 * X. Review of 3.7.3 (agent A)
 * ------------------------------------------------------------------ */
function frierenMarksS1(upto) {
    const t = {};
    for (let ep = 1; ep <= upto; ep++) t[xhash([1, '', ep, '葬送のフリーレン'].join(''))] = 100;
    return t;
}
const xhash = require('./lampa').hash;
// TMDB season list of Frieren has only S1 (28) - FRIEREN_TMDB has no seasonList, like a TMDB that has not added S2 yet
function frierenListWorld(now, dub) {
    const S2 = Object.assign({}, F.FRIEREN_S2, { episodesAired: dub });
    return frierenWorld(now, { animes: [F.FRIEREN_S1, S2], user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 59978, status: 'watching', episodes: 0 }],
        kodik: [{ shikimori_id: 59978, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: dub, updated_at: iso(now - 3 * HOUR), episodes_aired: dub },
                { shikimori_id: 52991, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 28, updated_at: iso(now - 200 * DAY), episodes_aired: 28, anime_status: 'released' }] });
}
scenarios.x1_list_tmdb_lacks_season = async function (S) {
    const now = Date.now();
    let r = await twoLoads(frierenListWorld(now, 10), { storage: { shikimori_user: 'me' }, timeline: frierenMarksS1(28) });
    let hit = freshOf(r.env, r.built, ['59978', '209867']);
    check(S, 'S1 finished, S2 10/10 dubbed, nothing of S2 watched → +10', hit && hit.new == 10, hit);
    r = await twoLoads(frierenListWorld(now, 5), { storage: { shikimori_user: 'me' }, timeline: frierenMarksS1(23) });
    hit = freshOf(r.env, r.built, ['59978', '209867']);
    check(S, 'S1 stopped at E23, S2 5 dubbed → +5', hit && hit.new == 5, hit);
};
// Spy x Family Part 2 from the Shikimori list, user is ahead of the dub (watched 7 with subs, dub has 5)
scenarios.x2_list_part2_ahead_of_dub = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now, { extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 50602, status: 'watching', episodes: 0 }] } });
    spec.animes[1] = Object.assign({}, spec.animes[1], { episodesAired: 8 });
    const r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, timeline: sxfMarks(1, 19) });
    const hit = freshOf(r.env, r.built, ['50602', '120089']);
    check(S, 'P2 E1-7 watched (S1E13-19), dub 5 → not in «Новые серии»', !hit, hit);
};
// Apothecary S3 from the Shikimori list, TMDB absolute numbering that lists aired episodes only (S1 = 49)
scenarios.x3_list_absolute_aired_only = async function (S) {
    const now = Date.now();
    const spec = kWorld(now, { s2season: 1, s3arm: 1, tmdbAbsolute: true, extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 61987, status: 'watching', episodes: 0 }] } });
    let r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, timeline: kMarks(1, true) });
    let hit = kFind(r.built, r.env);
    check(S, 'S3E1 watched (S1E49) → not new', !hit, hit);
    r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, timeline: kMarks(0, true) });
    hit = kFind(r.built, r.env);
    check(S, 'S3 not started (S1E48) → +1', hit && hit.new == 1, hit);
};
// Part 2 from the Shikimori list with unknown planned episodes (Shikimori episodes: 0)
scenarios.x4_list_part2_eps_unknown = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now, { extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 50602, status: 'watching', episodes: 0 }] } });
    spec.animes[1] = Object.assign({}, spec.animes[1], { episodes: 0 });
    let r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, timeline: sxfMarks(1, 17) });
    let hit = freshOf(r.env, r.built, ['50602', '120089']);
    check(S, 'P2 E1-5 watched (S1E13-17), dub 5 → not new', !hit, hit);
    r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, timeline: sxfMarks(1, 15) });
    hit = freshOf(r.env, r.built, ['50602', '120089']);
    check(S, 'P2 E1-3 watched (S1E13-15), dub 5 → +2', hit && hit.new == 2, hit);
};

scenarios.x5_arm11_s3_unknown_tmdb_down = S => kBookmark(S, { s2season: 1, tmdbDown: true }, 'ARM 1/1, S3 not in ARM, TMDB down');
scenarios.x6_arm11_s3_unknown_tmdb_ok = S => kBookmark(S, { s2season: 1 }, 'ARM 1/1, S3 not in ARM, TMDB ok');

scenarios.x7_feed_card_tmdb_lacks_season = async function (S) {
    const now = Date.now();
    const spec = frierenListWorld(now, 10);
    delete spec.user; delete spec.rates;
    const r = await twoLoads(spec, { timeline: frierenMarksS1(28) });
    const hits = r.built.flatMap(l => (l.results || []).filter(c => String(c.id) == '59978').map(c => l.title + ': w=' + c._watched_ep + ' t=' + c._total_ep));
    console.log('      ', hits.join(' | '));
    check(S, 'S2 feed cards: S1 finished, S2 not started → no S2 progress', hits.length && hits.every(h => / w=(0|undefined) /.test(h)), hits);
};

// Новый сезон из списка Shikimori, которого ещё нет в базе соответствий (ARM узнаёт
// о новых сезонах через недели). Серии отмечены в Lampa — плагин находит карточку
// TMDB через предыдущий сезон и со второго показа считает их просмотренными
scenarios.p1_list_newest_not_in_arm = async function (S) {
    const now = Date.now();
    const cases = [['S3E1 watched, dub 1', 1, 1, { present: false }],
                   ['S3 not started, dub 1', 1, 0, { present: true, n: 1 }],
                   ['S3E1 watched, dub 3', 3, 1, { present: true, n: 2 }],
                   ['S3E1-3 watched, dub 3', 3, 3, { present: false }]];
    for (const [label, dub, upto, exp] of cases) {
        const spec = kWorld(now, { k3dub: dub, extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 61987, status: 'watching', episodes: 0 }] } });
        const r = await twoLoads(spec, { storage: { shikimori_user: 'me' }, timeline: kMarks(upto) });
        const hit = kFind(r.built, r.env);
        advCheck(S, label, hit ? { new: hit.new, w: hit.w, t: hit.t } : null, exp);
    }
};

// То же для нового сериала: прошлого сезона нет, карточку TMDB плагин находит поиском
// по названиям. Не нашёл — тайтл остаётся с серий из списка Shikimori
scenarios.p2_list_new_show_not_in_arm = async function (S) {
    const now = Date.now();
    const NEW = '新作の話';
    const tmdb = { id: 330777, name_ru: 'Новая история', name_en: 'New Story', original_name: NEW, date: '2026-09-20',
        alt: ['Shinsaku no Hanashi'], seasonList: [{ season_number: 1, episode_count: 12, air_date: '2026-09-20', name: 'Сезон 1' }] };
    const world = (o) => advWorld(now, { tmdb: o.tmdb || tmdb, extra: Object.assign({ rates: [{ id: 1, target_id: 60500, status: 'watching', episodes: 0 }] }, ADV_USER),
        parts: [{ id: 60500, name: 'Shinsaku no Hanashi', japanese: NEW, status: 'ongoing', episodes: 12, aired: 3, date: '2026-09-20', noArm: true, dub: 3, hot: true }] });
    const cases = [['S1E1 watched, dub 3', {}, [[1, 1, 1]], { present: true, n: 2 }],
                   ['S1E1-3 watched, dub 3', {}, [[1, 1, 3]], { present: false }],
                   ['nothing watched, dub 3', {}, [], { present: true, n: 3 }],
                   ['TMDB knows no such show, S1E1-3 watched', { tmdb: Object.assign({}, tmdb, { name_ru: 'Другое', name_en: 'Other', original_name: 'その他', alt: [] }) },
                    [[1, 1, 3]], { present: true, n: 3 }]];
    for (const [label, o, marks, exp] of cases) {
        const r = await advListRun(world(o), advMarks(NEW, marks));
        advCheck(S, label, freshOf(r.env, r.built, ['60500', '330777']), exp);
        // Второй показ: найденное или «не нашли» уже запомнено — в поиск TMDB больше не ходим
        await r.env.idle();
        const searches = r.env.log.requests.filter(q => /search\/tv/.test(q.url)).length;
        check(S, label + ': no TMDB search on the second show', searches == 0, searches);
    }
};


/* ---------------- Рантайм: находки ревью агента lampa-runtime-reviewer ----------------
 * Тайтлы из списка Shikimori идут через семьи сезонов: зависшая база соответствий не должна
 * стоить главной личных строк, кеши не должны писаться на каждый ответ, а номер TMDB,
 * занятый фильмом, — уводить сериал из списка */
async function rtOpen(env, ms) {
    const Main = env.components.shikimori_main;
    const comp = new Main({ component: 'shikimori_main', page: 1 });
    const t0 = Date.now();
    comp.create();
    const built = await env.waitFor(() => comp.built, ms || 25000);
    return { comp, built: built || [], took: Date.now() - t0 };
}
function rtTitles(built) { return built.map(l => l.title).filter(Boolean); }

// Настоящий Storage.get в Lampa держит разобранный объект в readed и отдаёт тот же самый
function rtLampaLikeStorage(env) {
    const S = env.Lampa.Storage;
    const orig = S.get.bind(S);
    const origSet = S.set.bind(S);
    const readed = {};
    S.get = function (name, def) {
        if (readed[name] !== undefined && typeof readed[name] == 'object') return readed[name];
        const v = orig(name, def);
        readed[name] = v;
        return v;
    };
    S.set = function (name, value) { readed[name] = value; origSet(name, value); };
}

function rtListWorld(now, n, o) {
    o = o || {};
    const animes = [], arm = [], tmdb = [], kodik = [], rates = [];
    for (let i = 0; i < n; i++) {
        const id = 81000 + i;
        animes.push(anime({ id, name: 'Show ' + i, russian: 'Шоу ' + i, kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 5,
            airedOn: { year: 2026, date: '2026-07-01' } }));
        arm.push({ myanimelist: id, themoviedb: 91000 + i, media: 'TV', 'themoviedb-season': 1 });
        tmdb.push({ type: 'tv', id: 91000 + i, name_ru: 'Шоу ' + i, name_en: 'Show ' + i, original_name: 'ショー' + i, date: '2026-07-01',
            seasonList: [{ season_number: 1, episode_count: 12, air_date: '2026-07-01', name: 'Сезон 1' }] });
        kodik.push({ shikimori_id: id, translation: ADV_VOICE, last_episode: 5, updated_at: iso(now - 5 * HOUR), episodes_aired: 5 });
        rates.push({ id: i + 1, target_id: id, status: 'watching', episodes: 2 });
    }
    return { animes, arm, tmdb, kodik, kodikTokens: [ADV_TOKEN], user: { id: 42, nickname: 'me' }, rates };
}


// 1. Список Shikimori без закладок; второй показ, обратный запрос ARM висит
async function rtArmReverse(S, n, armReply, label) {
    const now = Date.now();
    const spec = rtListWorld(now, n);
    const world = makeWorld(spec);
    const e1 = createEnv({ route: world.route, storage: { shikimori_user: 'me' } });
    e1.load(FILE);
    await rtOpen(e1);
    await e1.idle(20000);
    const st = persisted(e1);
    const route = (m, u, b) => (/arm\.haglund\.dev\/api\/v2\/themoviedb/.test(u) ? armReply() : world.route(m, u, b));
    const e2 = createEnv({ route, storage: st });
    e2.load(FILE);
    const { built, took } = await rtOpen(e2);
    const fresh = lineOf(e2, built, 'shikimori_title_fresh');
    const revReq = e2.log.requests.filter(r => /api\/v2\/themoviedb/.test(r.url)).length;
    console.log('   ', S, label, 'built in', took, 'ms; reverse requests:', revReq, '; rows:', JSON.stringify(rtTitles(built)));
    check(S, label + ': «Новые серии» present on the main screen', fresh && fresh.results.length == n, { took, rows: rtTitles(built) });
}
scenarios.rt1_arm_reverse_hangs = S => rtArmReverse(S, 3, () => ({ timeout: true, delay: 15000 }), 'ARM reverse hangs (15 s XHR timeout), 3 list titles');
scenarios.rt2_arm_reverse_503 = S => rtArmReverse(S, 20, () => ({ status: 503, body: {}, delay: 300 }), 'ARM reverse 503, 20 list titles');
scenarios.rt3_arm_reverse_slow = S => rtArmReverse(S, 30, () => ({ status: 200, body: [], delay: 1500 }), 'ARM reverse slow 1.5 s, 30 list titles');

// 2. Больше PREQUEL_LOST_MAX «потерянных»: первые десять — новые сериалы без прошлого
//    сезона, одиннадцатый — продолжение, чей прошлый сезон в ARM есть
scenarios.rt4_lost_starvation = async function (S) {
    const now = Date.now();
    const animes = [], kodik = [], rates = [];
    for (let i = 0; i < 10; i++) {
        const id = 82000 + i;
        animes.push(anime({ id, name: 'Original ' + i, kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 3, airedOn: { year: 2026, date: '2026-07-01' } }));
        rates.push({ id: i + 1, target_id: id, status: 'watching', episodes: 0 });
        kodik.push({ shikimori_id: id, translation: ADV_VOICE, last_episode: 3, updated_at: iso(now - 5 * HOUR), episodes_aired: 3 });
    }
    const P = anime({ id: 83000, name: 'Sequel Show', kind: 'tv', status: 'released', episodes: 12, airedOn: { year: 2024, date: '2024-01-01' },
        related: [{ relationKind: 'sequel', relationText: 'Sequel', anime: { id: 83001, name: 'Sequel Show 2nd Season', kind: 'tv', status: 'ongoing' } }] });
    const L = anime({ id: 83001, name: 'Sequel Show 2nd Season', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 3, airedOn: { year: 2026, date: '2026-07-01' },
        related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: 83000, name: 'Sequel Show', kind: 'tv', status: 'released' } }] });
    animes.push(P, L);
    rates.push({ id: 99, target_id: 83001, status: 'watching', episodes: 0 });
    kodik.push({ shikimori_id: 83001, translation: ADV_VOICE, last_episode: 3, updated_at: iso(now - 5 * HOUR), episodes_aired: 3 });
    const spec = { animes, kodik, kodikTokens: [ADV_TOKEN], user: { id: 42, nickname: 'me' }, rates,
        arm: [{ myanimelist: 83000, themoviedb: 93000, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [{ type: 'tv', id: 93000, name_ru: 'Сиквел', name_en: 'Sequel Show', original_name: 'シークエル', date: '2024-01-01' }] };
    let storage = { shikimori_user: 'me' };
    for (let pass = 1; pass <= 3; pass++) {
        const env = createEnv({ route: makeWorld(spec).route, storage });
        env.load(FILE);
        await rtOpen(env);
        await env.idle(20000);
        storage = persisted(env);
    }
    const hit = (storage.shikimori_match || {}).m83001;
    console.log('   ', S, '11th lost title after 3 shows:', JSON.stringify(hit));
    check(S, '11th lost title (sequel) matched through its prequel after 3 shows', hit && hit.tmdb == 93000, hit);
    // контроль: тот же продолжение среди 10 потерянных находится
    const spec2 = Object.assign({}, spec, { rates: rates.slice(1) });
    storage = { shikimori_user: 'me' };
    for (let pass = 1; pass <= 2; pass++) {
        const env = createEnv({ route: makeWorld(spec2).route, storage });
        env.load(FILE);
        await rtOpen(env);
        await env.idle(20000);
        storage = persisted(env);
    }
    const hit2 = (storage.shikimori_match || {}).m83001;
    check(S, 'control: with 10 lost titles the sequel is matched', hit2 && hit2.tmdb == 93000, hit2);
};

// 3. Фильм в закладках и сериал из списка с тем же номером TMDB
scenarios.rt5_movie_tv_same_id = async function (S) {
    const now = Date.now();
    const L = anime({ id: 84000, name: 'Tv Show L', russian: 'Сериал L', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 5, airedOn: { year: 2026, date: '2026-07-01' } });
    const M = anime({ id: 84100, name: 'Movie M', russian: 'Фильм M', kind: 'movie', status: 'released', episodes: 1, episodesAired: 1, airedOn: { year: 2020, date: '2020-01-01' } });
    const spec = { animes: [L, M], kodikTokens: [ADV_TOKEN], user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 84000, status: 'watching', episodes: 1 }],
        arm: [{ myanimelist: 84000, themoviedb: 4444, media: 'TV', 'themoviedb-season': 1 },
              { myanimelist: 84100, themoviedb: 4444, media: 'MOVIE' }],
        tmdb: [{ type: 'tv', id: 4444, name_ru: 'Сериал L', name_en: 'Tv Show L', original_name: 'テレビL', date: '2026-07-01' },
               { type: 'movie', id: 4444, name_ru: 'Фильм M', name_en: 'Movie M', original_name: '映画M', date: '2020-01-01' }],
        kodik: [{ shikimori_id: 84000, translation: ADV_VOICE, last_episode: 5, updated_at: iso(now - 5 * HOUR), episodes_aired: 5 }] };
    const movieFav = { id: 4444, title: 'Фильм M', original_title: '映画M', release_date: '2020-01-01', genre_ids: [16], original_language: 'ja', source: 'tmdb' };
    let storage = { shikimori_user: 'me' };
    let env, built;
    for (let pass = 1; pass <= 2; pass++) {
        env = createEnv({ route: makeWorld(spec).route, storage, favorites: { book: [movieFav] } });
        env.load(FILE);
        ({ built } = await rtOpen(env));
        await env.idle(20000);
        storage = persisted(env);
    }
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const cards = fresh ? fresh.results.map(c => ({ id: c.id, title: c.title || c.name || c.russian, tmdb: !!c._tmdb_card, sids: c._sids, new: c._kodik_new, total: c._total_ep })) : [];
    console.log('   ', S, '«Новые серии»:', JSON.stringify(cards));
    const movieClaims = cards.some(c => c.tmdb && c.id == 4444 && (c.sids || []).map(String).indexOf('84000') >= 0);
    check(S, 'movie bookmark 4444 does not take the TV list title 84000 (tv/4444)', !movieClaims, cards);
};

// 4b. То же на «Монологе»: третий сезон найден через прошлый (how: prequel), ARM знает 1-2
scenarios.rt7_reverse_alias_prequel = async function (S) {
    const now = Date.now();
    const P = anime({ id: 86000, name: 'Base Show', kind: 'tv', status: 'released', episodes: 12, airedOn: { year: 2024, date: '2024-01-01' } });
    const L = anime({ id: 86001, name: 'Other Show', russian: 'Другое шоу', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 5, airedOn: { year: 2026, date: '2026-07-01' } });
    const spec = { animes: [P, L], kodikTokens: [ADV_TOKEN], user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 86001, status: 'watching', episodes: 1 }],
        arm: [{ myanimelist: 86000, themoviedb: 96000, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [{ type: 'tv', id: 96000, name_ru: 'База', name_en: 'Base Show', original_name: 'ベース', date: '2024-01-01' }],
        kodik: [{ shikimori_id: 86001, translation: ADV_VOICE, last_episode: 5, updated_at: iso(now - 5 * HOUR), episodes_aired: 5 }] };
    for (const lampaLike of [false, true]) {
        const storage = { shikimori_user: 'me',
            shikimori_match: { m86001: { tmdb: 96000, media: 'tv', season: 0, how: 'search', time: now - HOUR } },
            shikimori_tmdb_info: { i96000: { v: 2, t: 'tv', original_name: 'ベース', year: '2024', score: 0 } } };
        const env = createEnv({ route: makeWorld(spec).route, storage });
        if (lampaLike) rtLampaLikeStorage(env);
        env.load(FILE);
        await rtOpen(env);
        await env.idle(20000);
        // следующий reverseSet в этой сессии (другая закладка, карточка) пишет кеш целиком
        env.Lampa.Storage.set('shikimori_reverse', env.Lampa.Storage.get('shikimori_reverse', {}));
        const rev = persisted(env).shikimori_reverse || {};
        console.log('   ', S, lampaLike ? 'Lampa-like Storage:' : 'mock Storage:', 'persisted tv96000 =', JSON.stringify(rev.tv96000 && rev.tv96000.mals));
        check(S, (lampaLike ? 'Lampa-like' : 'mock') + ': list sid 86001 not persisted into reverse tv96000',
            !(rev.tv96000 && rev.tv96000.mals.some(m => m.mal == 86001)), rev.tv96000);
    }
};

// 5. Десять новых сезонов из списка, прошлые сезоны в ARM; главная открыта дважды подряд
function rtLostWorld(now, n) {
    const animes = [], kodik = [], rates = [], arm = [], tmdb = [];
    for (let i = 0; i < n; i++) {
        const p = 87000 + 2 * i, l = p + 1;
        animes.push(anime({ id: p, name: 'Base ' + i, kind: 'tv', status: 'released', episodes: 12, airedOn: { year: 2024, date: '2024-01-01' },
            related: [{ relationKind: 'sequel', relationText: 'Sequel', anime: { id: l, name: 'Base ' + i + ' 2nd Season', kind: 'tv', status: 'ongoing' } }] }));
        animes.push(anime({ id: l, name: 'Base ' + i + ' 2nd Season', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 3, airedOn: { year: 2026, date: '2026-07-01' },
            related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: p, name: 'Base ' + i, kind: 'tv', status: 'released' } }] }));
        arm.push({ myanimelist: p, themoviedb: 97000 + i, media: 'TV', 'themoviedb-season': 1 });
        tmdb.push({ type: 'tv', id: 97000 + i, name_ru: 'База ' + i, name_en: 'Base ' + i, original_name: 'ベース' + i, date: '2024-01-01' });
        rates.push({ id: i + 1, target_id: l, status: 'watching', episodes: 0 });
        kodik.push({ shikimori_id: l, translation: ADV_VOICE, last_episode: 3, updated_at: iso(now - 5 * HOUR), episodes_aired: 3 });
    }
    return { animes, kodik, kodikTokens: [ADV_TOKEN], user: { id: 42, nickname: 'me' }, rates, arm, tmdb };
}
function rtCountWrites(env) {
    const S = env.Lampa.Storage;
    const orig = S.set.bind(S);
    const writes = {};
    S.set = function (name, value) { writes[name] = (writes[name] || 0) + 1; orig(name, value); };
    return writes;
}
scenarios.rt8_prequel_batch_cost = async function (S) {
    const now = Date.now();
    const spec = rtLostWorld(now, 10);
    // первый показ: ARM отвечает «не знаю» про новые сезоны → none в кеше
    const e1 = createEnv({ route: makeWorld(spec).route, storage: { shikimori_user: 'me' } });
    const w1 = rtCountWrites(e1);
    e1.load(FILE);
    await rtOpen(e1);
    await e1.idle(20000);
    const req = e1.log.requests;
    const armPost = req.filter(r => /arm\.haglund\.dev\/api\/v2\/ids/.test(r.url) && r.method == 'POST').length;
    const gql = req.filter(r => /graphql/.test(r.url)).length;
    console.log('   ', S, 'one show: ARM POST', armPost, 'GraphQL', gql, 'writes', JSON.stringify(w1));
    // прошлые сезоны — одним запросом, соответствия — одной записью сверх обычных
    check(S, 'one show: ARM batch requests ≤ 2', armPost <= 2, armPost);
    check(S, 'one show: shikimori_match writes ≤ 3', (w1.shikimori_match || 0) <= 3, w1.shikimori_match);
    // главная открыта дважды подряд (вернулись на экран), хранилище то же
    const e2 = createEnv({ route: makeWorld(spec).route, storage: { shikimori_user: 'me' } });
    const w2 = rtCountWrites(e2);
    e2.load(FILE);
    const a = new e2.components.shikimori_main({ component: 'shikimori_main', page: 1 });
    a.create();
    await new Promise(r => setTimeout(r, 30));
    a.destroy ? a.destroy() : (a.onDestroy && a.onDestroy());
    const b = new e2.components.shikimori_main({ component: 'shikimori_main', page: 1 });
    b.create();
    await e2.waitFor(() => b.built, 20000);
    await e2.idle(20000);
    const req2 = e2.log.requests;
    const armPost2 = req2.filter(r => /arm\.haglund\.dev\/api\/v2\/ids/.test(r.url) && r.method == 'POST').length;
    const tmdbTv = req2.filter(r => /\/tv\/97\d\d\d\?/.test(r.url)).length;
    console.log('   ', S, 'two quick shows: ARM POST', armPost2, 'TMDB tv/97xxx', tmdbTv, 'writes', JSON.stringify(w2));
    check(S, 'two quick shows: ARM batch requests ≤ 4', armPost2 <= 4, armPost2);
    check(S, 'two quick shows: shikimori_reverse writes ≤ 2', (w2.shikimori_reverse || 0) <= 2, w2.shikimori_reverse);
};

scenarios.rt10_list_slow_network = async function (S) {
    const now = Date.now();
    const spec = rtListWorld(now, 30);
    const world = makeWorld(spec);
    const slow = (m, u, b) => Object.assign({ delay: 500 }, world.route(m, u, b));
    let storage = { shikimori_user: 'me' };
    for (let pass = 1; pass <= 3; pass++) {
        const env = createEnv({ route: slow, storage });
        const w = rtCountWrites(env);
        env.load(FILE);
        const { built, took } = await rtOpen(env);
        const fresh = lineOf(env, built, 'shikimori_title_fresh');
        await env.idle(30000);
        storage = persisted(env);
        console.log('   ', S, 'show', pass, 'built in', took, 'ms, fresh row:', fresh ? fresh.results.length : 0, ', reverse writes:', w.shikimori_reverse || 0);
        // хранилище пишется целиком: не на каждый ответ базы
        check(S, 'show ' + pass + ': shikimori_reverse written at most once', (w.shikimori_reverse || 0) <= 1, w.shikimori_reverse);
        check(S, 'show ' + pass + ': all 30 list titles in «Новые серии»', fresh && fresh.results.length == 30, fresh && fresh.results.length);
    }
};

// 6. Спецвыпуск из списка (ARM: сезон 0 TMDB) между сезонами; оба сезона досмотрены в Lampa
scenarios.rt11_list_special_family = async function (S) {
    const now = Date.now();
    const NAME = 'メイン';
    const S1 = anime({ id: 88000, name: 'Main', kind: 'tv', status: 'released', episodes: 12, airedOn: { year: 2024, date: '2024-01-05' },
        related: [{ relationKind: 'sequel', relationText: 'Sequel', anime: { id: 88001, name: 'Main Special', kind: 'tv_special', status: 'ongoing' } }] });
    const SP = anime({ id: 88001, name: 'Main Special', russian: 'Главное: спецвыпуск', kind: 'tv_special', status: 'ongoing', episodes: 3, episodesAired: 3,
        airedOn: { year: 2024, date: '2024-06-01' },
        related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: 88000, name: 'Main', kind: 'tv', status: 'released' } },
                  { relationKind: 'sequel', relationText: 'Sequel', anime: { id: 88002, name: 'Main 2nd Season', kind: 'tv', status: 'released' } }] });
    const S2 = anime({ id: 88002, name: 'Main 2nd Season', kind: 'tv', status: 'released', episodes: 12, airedOn: { year: 2025, date: '2025-01-05' },
        related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: 88001, name: 'Main Special', kind: 'tv_special', status: 'ongoing' } }] });
    const spec = { animes: [S1, SP, S2], kodikTokens: [ADV_TOKEN], user: { id: 42, nickname: 'me' },
        rates: [{ id: 1, target_id: 88001, status: 'watching', episodes: 0 }],
        arm: [{ myanimelist: 88000, themoviedb: 98000, media: 'TV', 'themoviedb-season': 1 },
              { myanimelist: 88001, themoviedb: 98000, media: 'TV', 'themoviedb-season': 0 },
              { myanimelist: 88002, themoviedb: 98000, media: 'TV', 'themoviedb-season': 2 }],
        tmdb: [{ type: 'tv', id: 98000, name_ru: 'Главное', name_en: 'Main', original_name: NAME, date: '2024-01-05', seasons: 2,
            seasonList: [{ season_number: 0, episode_count: 3, air_date: '2024-06-01', name: 'Спецвыпуски' },
                         { season_number: 1, episode_count: 12, air_date: '2024-01-05', name: 'Сезон 1' },
                         { season_number: 2, episode_count: 12, air_date: '2025-01-05', name: 'Сезон 2' }] }],
        kodik: [{ shikimori_id: 88001, translation: ADV_VOICE, last_episode: 3, updated_at: iso(now - 5 * HOUR), episodes_aired: 3 }] };
    const { hash } = require('./lampa');
    const timeline = {};
    for (const se of [1, 2]) for (let ep = 1; ep <= 12; ep++) timeline[hash([se, '', ep, NAME].join(''))] = 100;
    let storage = { shikimori_user: 'me' };
    let env, built;
    for (let pass = 1; pass <= 2; pass++) {
        env = createEnv({ route: makeWorld(spec).route, storage, timeline });
        env.load(FILE);
        ({ built } = await rtOpen(env));
        await env.idle(20000);
        storage = persisted(env);
    }
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => String(c.id) == '88001');
    console.log('   ', S, 'special in «Новые серии»:', hit ? '+' + hit._kodik_new + ' w=' + hit._watched_ep : 'absent');
    check(S, 'unwatched special (TMDB season 0) stays new +3', hit && hit._kodik_new == 3, hit && { new: hit._kodik_new, w: hit._watched_ep });
};

// 7. Длинная первая часть (366 серий, сезон 1 TMDB), продолжение — частями во втором сезоне TMDB
scenarios.rt12_long_franchise_budget = async function (S) {
    const now = Date.now();
    const NAME = 'BLEACH';
    const parts = [
        { id: 89000, name: 'Bleach', eps: 366, date: '2004-10-05', arm: 1, status: 'released' },
        { id: 89001, name: 'Bleach: Sennen Kessen-hen', eps: 13, date: '2022-10-11', arm: 2, status: 'released' },
        { id: 89002, name: 'Bleach: Sennen Kessen-hen - Ketsubetsu-tan', eps: 13, date: '2023-07-08', arm: 2, status: 'released' },
        { id: 89003, name: 'Bleach: Sennen Kessen-hen - Soukoku-tan', eps: 14, date: '2024-10-05', arm: 2, status: 'released' },
        { id: 89004, name: 'Bleach: Sennen Kessen-hen - Part 4', eps: 12, aired: 5, date: '2026-07-01', arm: 2, status: 'ongoing' }];
    const animes = parts.map((p, i) => anime({ id: p.id, name: p.name, russian: 'Блич ' + i, kind: 'tv', status: p.status, episodes: p.eps,
        episodesAired: p.aired || p.eps, airedOn: { year: +p.date.slice(0, 4), date: p.date },
        related: [].concat(i > 0 ? [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: parts[i - 1].id, name: parts[i - 1].name, kind: 'tv', status: parts[i - 1].status } }] : [],
                           i + 1 < parts.length ? [{ relationKind: 'sequel', relationText: 'Sequel', anime: { id: parts[i + 1].id, name: parts[i + 1].name, kind: 'tv', status: parts[i + 1].status } }] : []) }));
    const spec = { animes, kodikTokens: [ADV_TOKEN],
        arm: parts.map(p => ({ myanimelist: p.id, themoviedb: 30984, media: 'TV', 'themoviedb-season': p.arm })),
        tmdb: [{ type: 'tv', id: 30984, name_ru: 'Блич', name_en: 'Bleach', original_name: NAME, date: '2004-10-05', seasons: 2,
            seasonList: [{ season_number: 1, episode_count: 366, air_date: '2004-10-05', name: 'Сезон 1' },
                         { season_number: 2, episode_count: 52, air_date: '2022-10-11', name: 'Сезон 2' }] }],
        kodik: [{ shikimori_id: 89004, translation: ADV_VOICE, last_episode: 5, updated_at: iso(now - 5 * HOUR), episodes_aired: 5 }] };
    const book = { id: 30984, name: 'Блич', original_name: NAME, first_air_date: '2004-10-05', genre_ids: [16], original_language: 'ja',
        origin_country: ['JP'], source: 'tmdb', number_of_seasons: 2 };
    const { hash } = require('./lampa');
    const timeline = {};
    for (let ep = 1; ep <= 366; ep++) timeline[hash([1, '', ep, NAME].join(''))] = 100;
    for (let ep = 1; ep <= 43; ep++) timeline[hash([2, '', ep, NAME].join(''))] = 100;
    let storage = {};
    let env, built;
    for (let pass = 1; pass <= 2; pass++) {
        env = createEnv({ route: makeWorld(spec).route, storage, timeline, favorites: { book: [book] } });
        env.load(FILE);
        ({ built } = await rtOpen(env));
        await env.idle(20000);
        storage = persisted(env);
    }
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => c.id == 30984);
    console.log('   ', S, 'bookmark in «Новые серии»:', hit ? '+' + hit._kodik_new + ' w=' + hit._watched_ep + ' t=' + hit._total_ep : 'absent');
    check(S, 'Part 4 E1-3 watched (S2E41-43), dub 5 → +2', hit && hit._kodik_new == 2, hit && { new: hit._kodik_new, w: hit._watched_ep });
};

scenarios.rt13_seasons_dup = async function (S) {
    const now = Date.now();
    const spec = rtListWorld(now, 5);
    const world = makeWorld(spec);
    const e1 = createEnv({ route: world.route, storage: { shikimori_user: 'me' } });
    e1.load(FILE);
    await rtOpen(e1);
    await e1.idle(20000);
    const st = persisted(e1);
    delete st.shikimori_tmdb_seasons;   // сезоны устарели (неделя) или TMDB не ответил час назад
    const slowTmdb = (m, u, b) => (/themoviedb\.org\/3\/tv\/91\d\d\d\?/.test(u) ? Object.assign({ delay: 3000 }, world.route(m, u, b)) : world.route(m, u, b));
    const e2 = createEnv({ route: slowTmdb, storage: st });
    e2.load(FILE);
    await rtOpen(e2);
    await e2.idle(20000);
    const n = e2.log.requests.filter(r => /\/tv\/91\d\d\d\?/.test(r.url)).length;
    console.log('   ', S, 'tv/91xxx requests for 5 list titles:', n);
    check(S, 'one seasons request per title', n == 5, n);
};


/* ---------------- Логика сезонов: находки ревью агента season-logic-reviewer ----------------
 * Сумма отметок (Q) не должна перекрывать место сезона, известное TMDB; номер сезона из базы —
 * не повод писать отметки в сезон, которого у TMDB нет; тайтл из списка без ответа базы —
 * не семья из одного себя; тайтл на много сезонов TMDB («Ван-Пис») — не «прошлый сезон» */
/* ---------- F1. Q-totals: an earlier TMDB season has one episode more than
 * Shikimori counts (a recap / episode 0 TMDB keeps in the regular season).
 * Split-cour Part 2 is never "verified", so the sum of all marks decides ---------- */
const SC = 'スプリットの話';
const SC_TMDB = { id: 350001, name_ru: 'Сплит-история', name_en: 'Split Story', original_name: SC, date: '2025-01-10', alt: ['Split no Hanashi'],
    seasonList: [{ season_number: 1, episode_count: 13, air_date: '2025-01-10', name: 'Сезон 1' },   // 12 + recap 12.5 as E13
                 { season_number: 2, episode_count: 24, air_date: '2026-04-05', name: 'Сезон 2' }] }; // part 1 + part 2
function scWorld(now, o) {
    o = o || {};
    return advWorld(now, { tmdb: SC_TMDB, extra: o.extra, parts: [
        { id: 61101, name: 'Split no Hanashi', japanese: SC, episodes: 12, date: '2025-01-10', arm: 1, dub: 12 },
        { id: 61102, name: 'Split no Hanashi 2nd Season', japanese: SC + ' 第2期', episodes: 12, date: '2026-04-05', arm: 2, dub: 12 },
        { id: 61103, name: 'Split no Hanashi 2nd Season Part 2', japanese: SC + ' 第2期 第2クール', status: 'ongoing', episodes: 12, aired: 6,
          date: '2026-07-05', arm: 2, dub: 5, hot: true }] });
}
const SC_CASES = [['part 2 E1-4 watched (S2E13-16), dub 5', [[1, 1, 13], [2, 1, 16]], { present: true, n: 1 }],
                  ['part 2 E1-3 watched (S2E13-15), dub 5', [[1, 1, 13], [2, 1, 15]], { present: true, n: 2 }]];
scenarios.sl1_qtotals_extra_tmdb_episode_book = async function (S) {
    const now = Date.now();
    for (const [label, marks, exp] of SC_CASES) {
        const { env, built } = await advBookmarkRun(scWorld(now), advBook(SC_TMDB, 2), advMarks(SC, marks));
        advCheck(S, label, freshOf(env, built, ['350001', '61103']), exp);
    }
};
scenarios.sl1_qtotals_extra_tmdb_episode_list = async function (S) {
    const now = Date.now();
    for (const [label, marks, exp] of SC_CASES) {
        const spec = scWorld(now, { extra: Object.assign({ rates: [{ id: 1, target_id: 61103, status: 'watching', episodes: 0 }] }, ADV_USER) });
        const r = await advListRun(spec, advMarks(SC, marks));
        advCheck(S, label, freshOf(r.env, r.built, ['61103', '350001']), exp);
    }
};

/* ---------- F2. Q-totals: season 1 was watched outside Lampa (no marks), the
 * current 2-cour season is not verified (TMDB has not added it yet, the
 * balancer marks it as season 2), its marks exceed the episodes before it ---------- */
const SK = 'スキップの話';
const SK_TMDB = { id: 350002, name_ru: 'Пропуск', name_en: 'Skip Story', original_name: SK, date: '2024-04-05', alt: ['Skip no Hanashi'],
    seasonList: [{ season_number: 1, episode_count: 12, air_date: '2024-04-05', name: 'Сезон 1' }] };
function skWorld(now, o) {
    o = o || {};
    return advWorld(now, { tmdb: o.tmdb || SK_TMDB, extra: o.extra, parts: [
        { id: 61201, name: 'Skip no Hanashi', japanese: SK, episodes: 12, date: '2024-04-05', arm: 1, dub: 12 },
        { id: 61202, name: 'Skip no Hanashi 2nd Season', japanese: SK + ' 第2期', status: 'ongoing', episodes: 24, aired: 20,
          date: '2026-05-10', arm: 2, dub: 20, hot: true }] });
}
scenarios.sl2_qtotals_skipped_season = async function (S) {
    const now = Date.now();
    const cases = [['S1 watched elsewhere, S2E1-15 marked, dub 20', [[2, 1, 15]], { present: true, n: 5 }],
                   ['S1 watched elsewhere, S2E1-19 marked, dub 20', [[2, 1, 19]], { present: true, n: 1 }]];
    for (const [label, marks, exp] of cases) {
        const { env, built } = await advBookmarkRun(skWorld(now), advBook(SK_TMDB, 1), advMarks(SK, marks));
        advCheck(S, label, freshOf(env, built, ['350002', '61202']), exp);
    }
    // «Отметить N» on that card: where do the Lampa marks go?
    const { env, built } = await advBookmarkRun(skWorld(now), advBook(SK_TMDB, 1), advMarks(SK, [[2, 1, 15]]));
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const card = fresh && fresh.results.find(c => c.id == 350002);
    if (!card) return check(S, 'card present for «Отметить»', false, null);
    const before = new Set(Object.keys(env.timeline));
    await menuAction(env, card, 'seen');
    const h = env.hash;
    const written = [];
    for (let s = 1; s <= 3; s++) for (let ep = 1; ep <= 60; ep++) {
        const k = h([s, '', ep, SK].join(''));
        if (!before.has(k) && env.timeline[k]) written.push('S' + s + 'E' + ep);
    }
    const desc = written.length ? written[0] + '..' + written[written.length - 1] + ' (' + written.length + ')' : 'none';
    console.log('ACT ' + S + ' :: «Отметить 20» writes => ' + desc + ' | expected S2E16..S2E20 or none');
    check(S, '«Отметить» does not write marks past the real episodes (S2E21+)', !written.some(w => /^S2E(2[1-9]|[3-9]\d)$/.test(w) || /^S1E(1[3-9]|[2-9]\d)$/.test(w)), desc);
    // Later: TMDB adds season 2 (verified by premiere), all 24 dubbed, the user saw 20
    const tmdb2 = Object.assign({}, SK_TMDB, { seasonList: SK_TMDB.seasonList.concat([{ season_number: 2, episode_count: 24, air_date: '2026-05-10', name: 'Сезон 2' }]) });
    const spec2 = skWorld(now, { tmdb: tmdb2 });
    spec2.kodik.find(k => k.shikimori_id == 61202).last_episode = 24;
    spec2.animes.find(a => a.id == 61202).episodesAired = 24;
    const st2 = persisted(env);
    delete st2.shikimori_tmdb_seasons;   // the 12-hour recheck / weekly refresh has happened
    const env2 = createEnv({ route: makeWorld(spec2).route, favorites: { book: [advBook(tmdb2, 2)] }, timeline: Object.assign({}, env.timeline), storage: st2 });
    env2.load(FILE);
    const b2 = (await openMain(env2)).built;
    advCheck(S, 'after «Отметить 20», TMDB adds S2, dub 24', freshOf(env2, b2, ['350002', '61202']), { present: true, n: 4 });
};

/* ---------- F3. Shikimori list: the "virtual family" is just the list title
 * when the ARM reverse lookup did not answer (first show after the update,
 * ARM slow or down). Part 2 is then judged with offset 0 → "past" ---------- */
scenarios.sl3_list_part2_family_without_reverse = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now, { extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 50602, status: 'watching', episodes: 0 }] } });
    const world = makeWorld(spec);
    // ARM /api/v2/ids answers, /api/v2/themoviedb (reverse) does not
    const route = (m, u, b) => (/arm\.haglund\.dev\/api\/v2\/themoviedb/.test(u) ? { network: true } : world.route(m, u, b));
    const cases = [['part 2 E1-4 watched (S1E13-16), dub 5', sxfMarks(1, 16), { present: true, n: 1 }],
                   ['part 2 E1-3 watched (S1E13-15), dub 5', sxfMarks(1, 15), { present: true, n: 2 }]];
    for (const [label, timeline, exp] of cases) {
        const first = createEnv({ route, storage: { shikimori_user: 'me' }, timeline });
        first.load(FILE);
        await openMain(first);
        await first.idle();
        const env = createEnv({ route, storage: persisted(first), timeline });
        env.load(FILE);
        const { built } = await openMain(env);
        advCheck(S, label, freshOf(env, built, ['50602', '120089']), exp);
    }
};

// Same, but triggered by Match.reverse's cap (REVERSE_MAX = 40 per show): 40 anime
// bookmarks whose 3-day reverse cache expired come first, the list title's
// virtual card is the 41st and gets no ARM family this time
scenarios.sl3b_list_part2_reverse_cap = async function (S) {
    const now = Date.now();
    const spec = sxfWorld(now, { extra: { user: { id: 42, nickname: 'me' }, rates: [{ id: 1, target_id: 50602, status: 'watching', episodes: 0 }] } });
    const book = [];
    for (let i = 0; i < 40; i++) book.push({ id: 700000 + i, name: 'Аниме ' + i, original_name: 'アニメ' + i, first_air_date: '2015-01-01',
        genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: 1 });
    const cases = [['part 2 E1-4 watched (S1E13-16), dub 5', sxfMarks(1, 16), { present: true, n: 1 }]];
    for (const [label, timeline, exp] of cases) {
        // first show caches the forward match and the TMDB name (as 3.7.2 did); the reverse cache is empty/expired
        const first = createEnv({ route: makeWorld(spec).route, storage: { shikimori_user: 'me' }, timeline });
        first.load(FILE);
        await openMain(first);
        await first.idle();
        const st = persisted(first);
        delete st.shikimori_reverse;
        const env = createEnv({ route: makeWorld(spec).route, storage: st, timeline, favorites: { book } });
        env.load(FILE);
        const { built } = await openMain(env);
        const asked = env.log.requests.filter(r => /api\/v2\/themoviedb\?id=120089/.test(r.url)).length;
        console.log('      reverse lookups for tv/120089 on this show:', asked);
        advCheck(S, label, freshOf(env, built, ['50602', '120089']), exp);
    }
};

/* ---------- F4. writable(): ARM numbers seasons TVDB-style (real Fribb data for
 * Demon Slayer: Mugen Ressha TV = 2, Yuukaku-hen = 3), TMDB keeps both in S2.
 * «Отметить» on Yuukaku-hen writes S3E1-4; when TMDB later adds S3 for the
 * next arc, its new episodes are hidden ---------- */
const KN = '鬼滅の刃';
function knPhase1(now) {
    const tmdb = { id: 85937, name_ru: 'Клинок, рассекающий демонов', name_en: 'Demon Slayer', original_name: KN, date: '2024-04-06',
        alt: ['Kimetsu no Yaiba'],
        seasonList: [{ season_number: 1, episode_count: 26, air_date: '2024-04-06', name: 'Сезон 1' },
                     { season_number: 2, episode_count: 18, air_date: '2026-07-05', name: 'Сезон 2' }] };
    return { tmdb, spec: advWorld(now, { tmdb, parts: [
        { id: 38000, name: 'Kimetsu no Yaiba', japanese: KN, episodes: 26, date: '2024-04-06', arm: 1, dub: 26 },
        { id: 49926, name: 'Kimetsu no Yaiba: Mugen Ressha-hen', episodes: 7, date: '2026-07-05', arm: 2, dub: 7 },
        { id: 47778, name: 'Kimetsu no Yaiba: Yuukaku-hen', status: 'ongoing', episodes: 11, aired: 5, date: '2026-08-30', arm: 3, dub: 4, hot: true }] }) };
}
function knPhase2(now) {
    const tmdb = { id: 85937, name_ru: 'Клинок, рассекающий демонов', name_en: 'Demon Slayer', original_name: KN, date: '2023-04-06',
        alt: ['Kimetsu no Yaiba'],
        seasonList: [{ season_number: 1, episode_count: 26, air_date: '2023-04-06', name: 'Сезон 1' },
                     { season_number: 2, episode_count: 18, air_date: '2025-07-05', name: 'Сезон 2' },
                     { season_number: 3, episode_count: 11, air_date: '2026-09-06', name: 'Сезон 3' }] };
    return { tmdb, spec: advWorld(now, { tmdb, parts: [
        { id: 38000, name: 'Kimetsu no Yaiba', japanese: KN, episodes: 26, date: '2023-04-06', arm: 1, dub: 26 },
        { id: 49926, name: 'Kimetsu no Yaiba: Mugen Ressha-hen', episodes: 7, date: '2025-07-05', arm: 2, dub: 7 },
        { id: 47778, name: 'Kimetsu no Yaiba: Yuukaku-hen', episodes: 11, date: '2025-08-30', arm: 3, dub: 11 },
        { id: 51019, name: 'Kimetsu no Yaiba: Katanakaji no Sato-hen', status: 'ongoing', episodes: 11, aired: 4, date: '2026-09-06', arm: 4, dub: 3, hot: true }] }) };
}
scenarios.sl4_writable_tvdb_style_label = async function (S) {
    const now = Date.now();
    // Phase 1: Yuukaku-hen airing, watched elsewhere; S1 + Mugen Ressha watched in Lampa
    const p1 = knPhase1(now);
    const { env, built } = await advBookmarkRun(p1.spec, advBook(p1.tmdb, 2), advMarks(KN, [[1, 1, 26], [2, 1, 7]]));
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const card = fresh && fresh.results.find(c => c.id == 85937);
    if (!card) return check(S, 'phase 1: card in «Новые серии»', false, null);
    const before = new Set(Object.keys(env.timeline));
    await menuAction(env, card, 'seen');
    const written = [];
    for (let s = 1; s <= 4; s++) for (let ep = 1; ep <= 30; ep++) {
        const k = env.hash([s, '', ep, KN].join(''));
        if (!before.has(k) && env.timeline[k]) written.push('S' + s + 'E' + ep);
    }
    console.log('ACT ' + S + ' :: phase 1, «Отметить 4» on Yuukaku-hen (TMDB S2E8-11) writes => ' + (written.join(',') || 'none'));
    check(S, 'phase 1: nothing written outside TMDB S2', !written.some(w => !/^S2E/.test(w)), written);
    // Phase 2: TMDB adds S3 for the next arc; it airs, dub 3, nothing of it watched
    const p2 = knPhase2(now);
    const timeline = Object.assign({}, env.timeline);
    const env2 = createEnv({ route: makeWorld(p2.spec).route, favorites: { book: [advBook(p2.tmdb, 3)] }, timeline });
    env2.load(FILE);
    const b2 = (await openMain(env2)).built;
    advCheck(S, 'phase 2: next arc (TMDB S3) dub 3, not watched', freshOf(env2, b2, ['85937', '51019']), { present: true, n: 3 });
};

/* ---------- F5. Only the balancer's online_watched_last, no timeline marks
 * (marks evicted / the card's timeline lives on another device) ---------- */
scenarios.sl5_balancer_last_only = async function (S) {
    const now = Date.now();
    const { hash } = require('./lampa');
    const last = {};
    last[hash(HS)] = { season: 1, episode: 4, balanser: 'test' };
    for (const down of [false, true]) {
        const spec = advFlags(hsWorld(now), down);
        const { env, built } = await advBookmarkRun(spec, advBook(HS_TMDB, 1), {}, { online_watched_last: last });
        advCheck(S, (down ? '[TMDB down] ' : '[TMDB up] ') + 'balancer says E4, dub 5', freshOf(env, built, ['300001', '61000']), { present: true, n: 1 });
    }
};

/* ---------- F6. Long-running show that TMDB splits into arc seasons with
 * per-season numbering (One Piece, Detective Conan): one Shikimori entry
 * matches TMDB S1 by premiere, marks are in a later TMDB season → "past" ---------- */
const OPA = 'ワンピースA';
const OPA_TMDB = { id: 37855, name_ru: 'Большой куш', name_en: 'Big Piece', original_name: OPA, date: '1999-10-20', alt: ['Big Piece'],
    seasonList: [{ season_number: 1, episode_count: 61, air_date: '1999-10-20', name: 'East' },
                 { season_number: 2, episode_count: 16, air_date: '2001-03-21', name: 'Grand Line' },
                 { season_number: 3, episode_count: 14, air_date: '2001-07-11', name: 'Chopper' },
                 { season_number: 4, episode_count: 39, air_date: '2001-10-31', name: 'Alabasta' }] };
scenarios.sl6_long_show_arc_seasons = async function (S) {
    const now = Date.now();
    // Shikimori: one entry, planned episodes unknown; dub reached absolute 130 = TMDB S4E39
    const spec = advWorld(now, { tmdb: OPA_TMDB, parts: [
        { id: 2100, name: 'Big Piece', japanese: OPA, status: 'ongoing', episodes: 0, aired: 130, date: '1999-10-20', arm: null, dub: 130, hot: true }] });
    const cases = [['watched up to S4E30 (absolute 121), dub 130', [[1, 1, 61], [2, 1, 16], [3, 1, 14], [4, 1, 30]], { present: true, n: 9 }]];
    for (const [label, marks, exp] of cases) {
        const { env, built } = await advBookmarkRun(spec, advBook(OPA_TMDB, 4), advMarks(OPA, marks));
        advCheck(S, label, freshOf(env, built, ['37855', '2100']), exp);
    }
};

/* ---------- F7. placeScan(): widest = place.before even when the TMDB place has a
 * small offset. Long family (real Fribb data for Bleach: the 366-episode TV = TMDB S1,
 * all TYBW cours = TMDB S2): the top-down scan starts at episode 400 of S2 and burns
 * the 700-probe budget before reaching the marks → no progress at all ---------- */
const BL = 'BLEACH';
const BL_TMDB = { id: 30984, name_ru: 'Блич', name_en: 'Bleach', original_name: BL, date: '2004-10-05', alt: ['Bleach'],
    seasonList: [{ season_number: 1, episode_count: 366, air_date: '2004-10-05', name: 'Сезон 1' },
                 { season_number: 2, episode_count: 45, air_date: '2022-10-11', name: 'Тысячелетняя кровавая война' }] };
function blWorld(now) {
    return advWorld(now, { tmdb: BL_TMDB, parts: [
        { id: 269, name: 'Bleach', japanese: BL, episodes: 366, date: '2004-10-05', arm: 1, dub: 366 },
        { id: 41467, name: 'Bleach: Sennen Kessen-hen', episodes: 13, date: '2022-10-11', arm: 2, dub: 13 },
        { id: 53998, name: 'Bleach: Sennen Kessen-hen - Ketsubetsu-tan', episodes: 13, date: '2023-07-08', arm: 2, dub: 13 },
        { id: 56784, name: 'Bleach: Sennen Kessen-hen - Soukoku-tan', episodes: 14, date: '2024-10-05', arm: 2, dub: 14 },
        { id: 60636, name: 'Bleach: Sennen Kessen-hen - Kashin-tan', status: 'ongoing', episodes: 13, aired: 6, date: '2026-07-04', arm: 2, dub: 5, hot: true }] });
}
scenarios.sl7_long_family_scan_budget = async function (S) {
    const now = Date.now();
    const cases = [['part 4 E1-3 watched (S2E41-43), dub 5', [[1, 1, 366], [2, 1, 43]], { present: true, n: 2 }],
                   ['part 4 E1-5 watched (S2E41-45), dub 5', [[1, 1, 366], [2, 1, 45]], { present: false }]];
    for (const [label, marks, exp] of cases) {
        const { env, built } = await advBookmarkRun(blWorld(now), advBook(BL_TMDB, 2), advMarks(BL, marks));
        advCheck(S, label, freshOf(env, built, ['30984', '60636']), exp);
    }
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
