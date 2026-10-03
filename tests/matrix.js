'use strict';
// Матрица «Новых серий»: одна и та же история просмотра на всех раскладках сезонов,
// две версии плагина рядом. Ячейка — путь (закладка / список Shikimori) × тайтл ×
// что знает база соответствий × как TMDB нарезал сезоны × что отмечено в Lampa.
//
//   node matrix.js [фильтр] [--all]
//   BASE=.cache/main.js CAND=../shikimori.js   — какие версии сравнивать (по умолчанию так)
//   WATCH=more                                 — другие истории просмотра
//   DUBS=1,5                                   — сколько серий озвучено у нового сезона
//
// Фильтр — подстрока имени ячейки: «| apoth |», «list | sxf |», «| down |». Прогон
// долгий (по минуте на десяток ячеек), его удобно делить по тайтлам на несколько процессов.
// Итог: regressions — верно в BASE и неверно в CAND, fixed — наоборот,
// wrong-in-both — неверно в обеих.
const path = require('path');
const { createEnv, hash } = require('./lampa');
const { makeWorld } = require('./servers');
const { HOUR, iso, anime } = require('./fixtures');

const BASE = path.resolve(__dirname, process.env.BASE || '.cache/main.js');
const CAND = path.resolve(__dirname, process.env.CAND || '../shikimori.js');

const ONLY = process.argv[2] && process.argv[2] != '--all' ? process.argv[2] : '';
const SHOW_ALL = process.argv.indexOf('--all') >= 0;

// Тайтлы. ts — сезон TMDB при раздельных сезонах, newest — выходит сейчас
const FAMILIES = {
    apoth: {
        name: '薬屋のひとりごと',
        entries: [
            { id: 54492, name: 'Kusuriya no Hitorigoto', eps: 24, date: '2023-10-22', ts: 1, dubh: 800 * 24 },
            { id: 58514, name: 'Kusuriya no Hitorigoto 2nd Season', eps: 24, date: '2025-01-10', ts: 2, dubh: 400 * 24 },
            { id: 61987, name: 'Kusuriya no Hitorigoto 3rd Season', status: 'ongoing', eps: 12, date: '2026-10-02', ts: 3, newest: true }
        ]
    },
    sxf: {
        name: 'SPY×FAMILY',
        entries: [
            { id: 50265, name: 'Spy x Family', eps: 12, date: '2022-04-09', ts: 1, dubh: 1200 * 24 },
            { id: 50602, name: 'Spy x Family Part 2', eps: 13, date: '2022-10-01', ts: 1, dubh: 1000 * 24 },
            { id: 53887, name: 'Spy x Family Season 2', eps: 12, date: '2023-10-07', ts: 2, dubh: 700 * 24 },
            { id: 59999, name: 'Spy x Family Season 3', status: 'ongoing', eps: 13, date: '2026-09-20', ts: 3, newest: true }
        ]
    },
    sxf_p2: {   // выходит вторая часть сплит-кура
        name: 'SPY×FAMILY',
        entries: [
            { id: 50265, name: 'Spy x Family', eps: 12, date: '2026-04-09', ts: 1, dubh: 100 * 24 },
            { id: 50602, name: 'Spy x Family Part 2', status: 'ongoing', eps: 13, date: '2026-09-26', ts: 1, newest: true }
        ]
    },
    frieren: {
        name: '葬送のフリーレン',
        entries: [
            { id: 52991, name: 'Sousou no Frieren', eps: 28, date: '2025-09-29', ts: 1, dubh: 200 * 24 },
            { id: 59978, name: 'Sousou no Frieren 2nd Season', status: 'ongoing', eps: 10, date: '2026-09-16', ts: 2, newest: true }
        ]
    },
    single: {
        name: 'ワンシーズン',
        entries: [
            { id: 70001, name: 'One Season Show', status: 'ongoing', eps: 12, date: '2026-09-05', ts: 1, newest: true }
        ]
    }
};

// Сезоны TMDB и куда Lampa кладёт отметку серии ep части i: [сезон, серия]
//   split        — сезоны раздельные, у нового сезона перечислены все серии
//   split_aired  — то же, но у нового сезона только вышедшие
//   lacks        — TMDB ещё не завёл новый сезон
//   abs_full     — всё в первом сезоне сквозной нумерацией
//   abs_aired    — то же, только вышедшие серии
//   down, down_abs — TMDB не отвечает (отметки — раздельные или сквозные)
function layoutOf(E, tmdbKind, dub) {
    const split = [];
    const offs = {};
    const perSeason = {};
    for (let i = 0; i < E.length; i++) {
        const e = E[i];
        perSeason[e.ts] = perSeason[e.ts] || { date: e.date, count: 0 };
        offs[i] = perSeason[e.ts].count;
        perSeason[e.ts].count += e.newest && tmdbKind == 'split_aired' ? dub : e.eps;
    }
    for (const s in perSeason) split.push([Number(s), perSeason[s].date, perSeason[s].count]);
    const splitMap = (i, ep) => [E[i].ts, offs[i] + ep];
    let absOff = 0;
    const absOffs = {};
    for (let i = 0; i < E.length; i++) { absOffs[i] = absOff; absOff += E[i].eps; }
    const absMap = (i, ep) => [1, absOffs[i] + ep];
    const ni = E.findIndex(e => e.newest);
    switch (tmdbKind) {
        case 'split': case 'split_aired': return { seasons: split, map: splitMap };
        case 'lacks': {
            const ns = E[ni].ts;
            const alone = E.filter(e => e.ts == ns).length == 1;
            const s = alone ? split.filter(x => x[0] != ns) : split.map(x => x[0] == ns ? [x[0], x[1], x[2] - E[ni].eps] : x);
            return { seasons: s, map: splitMap };
        }
        case 'abs_full': return { seasons: [[1, E[0].date, absOff]], map: absMap };
        case 'abs_aired': return { seasons: [[1, E[0].date, absOff - E[ni].eps + dub]], map: absMap };
        case 'down': return { seasons: split, map: splitMap, down: true };
        case 'down_abs': return { seasons: [[1, E[0].date, absOff]], map: absMap, down: true };
    }
    throw new Error(tmdbKind);
}

// Сезон в базе соответствий: correct — как у TMDB, all1 — все первым (как у «Монолога
// фармацевта» в Fribb/anime-lists), noseason — без сезона, *_nonewest — нового сезона в базе нет
function armOf(E, armKind, tmdbKind) {
    const abs = /abs/.test(tmdbKind);
    return E.map(e => {
        switch (armKind) {
            case 'correct': return abs ? 1 : e.ts;
            case 'all1': return 1;
            case 'noseason': return null;
            case 'nonewest': return e.newest ? undefined : (abs ? 1 : e.ts);
            case 'all1_nonewest': return e.newest ? undefined : 1;
        }
        throw new Error(armKind);
    });
}

function specOf(cfg, now) {
    const T = cfg.tmdb;
    const entries = cfg.entries;
    const animes = entries.map((e, i) => {
        const related = [];
        const prev = entries[i - 1];
        const next = entries[i + 1];
        if (prev) related.push({ relationKind: 'prequel', relationText: 'Prequel', anime: { id: prev.id, name: prev.name, kind: 'tv', status: prev.status } });
        if (next) related.push({ relationKind: 'sequel', relationText: 'Sequel', anime: { id: next.id, name: next.name, kind: 'tv', status: next.status } });
        return anime({ id: e.id, name: e.name, russian: e.name, japanese: e.japanese, kind: 'tv', status: e.status,
            episodes: e.eps, episodesAired: e.aired, airedOn: { year: Number(e.date.slice(0, 4)), date: e.date }, related });
    });
    const arm = entries.filter(e => e.arm !== undefined)
        .map(e => ({ myanimelist: e.id, themoviedb: T.id, media: 'TV', 'themoviedb-season': e.arm }));
    const tmdb = [{ type: 'tv', id: T.id, name_ru: 'Тайтл', name_en: 'Title', original_name: T.name, date: entries[0].date,
        seasons: T.seasons.length, alt: [], popularity: 100,
        seasonList: T.seasons.map(s => ({ season_number: s[0], air_date: s[1], episode_count: s[2], name: 'Сезон ' + s[0] })) }];
    const kodik = entries.map(e => ({ shikimori_id: e.id, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' },
        last_episode: e.dub.ep, updated_at: iso(now - e.dub.hours * HOUR), episodes_aired: e.dub.aired || e.dub.ep,
        anime_status: e.status == 'released' ? 'released' : 'ongoing' }));
    const spec = { animes, arm, tmdb, kodikTokens: ['56a768d08f43091901c44b54fe970049'], kodik };
    if (cfg.list) {
        spec.user = { id: 42, nickname: 'me' };
        spec.rates = [{ id: 1, target_id: cfg.list, status: 'watching', episodes: 0 }];
    }
    return spec;
}

function lineOf(env, built, key) {
    const title = env.Lampa.Lang.translate(key);
    return built.find(l => l.title && l.title.indexOf(title) === 0) || null;
}

async function openMain(env) {
    const Main = env.components.shikimori_main;
    const comp = new Main({ component: 'shikimori_main', page: 1 });
    comp.create();
    const built = await env.waitFor(() => comp.built, 15000);
    await env.idle();
    return built || [];
}

function persisted(env) {
    const out = {};
    for (const [k, v] of env.store) { try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; } }
    return out;
}

// Что «Новые серии» показывают для тайтла: null — его там нет
async function runOne(file, cfg) {
    const now = Date.now();
    const spec = specOf(cfg, now);
    const T = cfg.tmdb;
    const re = new RegExp('/tv/' + T.id + '(\\?|$)');
    const routeOf = () => {
        const w = makeWorld(spec).route;
        return T.down ? (m, u, b) => (/themoviedb|tmdb\./.test(u) && re.test(u) ? { network: true } : w(m, u, b)) : w;
    };
    const timeline = () => {
        const t = {};
        for (const [s, ep] of cfg.marks) t[hash([s, s > 10 ? ':' : '', ep, T.name].join(''))] = 100;
        return t;
    };
    const storage = cfg.list ? { shikimori_user: 'me' } : {};
    const opts = { route: routeOf(), timeline: timeline(), storage };
    if (!cfg.list) {
        opts.favorites = { book: [{ id: T.id, name: 'Тайтл', original_name: T.name, first_air_date: cfg.entries[0].date,
            genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: T.seasons.length }] };
    }
    let env = createEnv(opts);
    env.load(file);
    let built = await openMain(env);
    // Список Shikimori: второй показ — то, что нашлось в фоне, учитывается со следующего
    if (cfg.list) {
        await env.idle();
        env = createEnv(Object.assign({}, opts, { route: routeOf(), storage: persisted(env), timeline: timeline() }));
        env.load(file);
        built = await openMain(env);
    }
    const ids = [String(T.id)].concat(cfg.entries.map(e => String(e.id)));
    const fresh = lineOf(env, built, 'shikimori_title_fresh');
    const hit = fresh && fresh.results.find(c => ids.indexOf(String(c.id)) >= 0);
    return hit ? { new: hit._kodik_new, w: hit._watched_ep, t: hit._total_ep, s: hit._season, o: hit._offset } : null;
}

function cell(pathKind, famKey, armKind, tmdbKind, watch, dub) {
    const fam = FAMILIES[famKey];
    const E = fam.entries.map(e => Object.assign({ status: 'released' }, e));
    const ni = E.findIndex(e => e.newest);
    const aired = Math.max(dub, watch.cur || 0);
    const lay = layoutOf(E, tmdbKind, aired);
    const arm = armOf(E, armKind, tmdbKind);
    const entries = E.map((e, i) => Object.assign({}, e, {
        japanese: i == 0 ? fam.name : fam.name + ' 第' + (i + 1) + '期',
        aired: e.newest ? aired : e.eps,
        arm: arm[i],
        dub: e.newest ? { ep: dub, hours: 20, aired } : { ep: e.eps, hours: e.dubh }
    }));
    // watch: older — прошлые сезоны (false — не отмечены), prev — сколько серий части перед
    // новой, cur — сколько серий новой
    const marks = [];
    for (let i = 0; i < E.length; i++) {
        let upto = 0;
        if (i < ni - 1) upto = watch.older === false ? 0 : E[i].eps;
        else if (i == ni - 1) upto = watch.prev === undefined ? E[i].eps : watch.prev;
        else if (i == ni) upto = watch.cur || 0;
        for (let ep = 1; ep <= upto; ep++) marks.push(lay.map(i, ep));
    }
    const cfg = { entries, marks, tmdb: { id: 300000 + E[0].id, name: fam.name, seasons: lay.seasons, down: lay.down } };
    if (pathKind == 'list') cfg.list = E[ni].id;
    return { cfg, expectNew: Math.max(0, dub - (watch.cur || 0)) };
}

// Верно: тайтл есть с точным числом новых (или без числа, если просмотренное неизвестно);
// нового нет — тайтла нет
function judgeRes(r, expectNew) {
    if (expectNew <= 0) return !r;
    return !!r && (r.new == expectNew || (!r.new && r.w == 0));
}

function fmt(r) {
    if (!r) return 'hidden';
    if (r.err) return 'ERROR ' + r.err.split('\n')[0];
    return `IN(+${r.new} w=${r.w} t=${r.t} s=${r.s} o=${r.o})`;
}

(async () => {
    let watches = [
        { label: 'prev done, cur 0', w: {} },
        { label: 'prev done, cur 1', w: { cur: 1 } },
        { label: 'prev done, cur all', w: { cur: 'ALL' } },
        { label: 'prev half, cur 0', w: { prev: 'HALF' } }
    ];
    if (process.env.WATCH == 'more') watches = [
        { label: 'prev done, cur 0', w: {} },
        { label: 'prev done, cur all', w: { cur: 'ALL' } },
        { label: 'prev -1, cur 0', w: { prev: 'M1' } },
        { label: 'prev -3, cur 0', w: { prev: 'M3' } },
        { label: 'prev done, cur ahead+4', w: { cur: 'AHEAD' } },
        { label: 'nothing at all', w: { prev: 0, older: false } }
    ];
    const dubs = process.env.DUBS ? process.env.DUBS.split(',').map(Number) : [3];
    const arms = ['correct', 'all1', 'noseason', 'nonewest', 'all1_nonewest'];
    const tmdbs = ['split', 'split_aired', 'lacks', 'abs_full', 'abs_aired', 'down', 'down_abs'];
    let regr = 0, fixed = 0, both = 0, total = 0;
    for (const p of ['book', 'list']) for (const f of Object.keys(FAMILIES)) for (const a of arms) for (const t of tmdbs) for (const wt of watches) for (const d of dubs) {
        const name = [p, f, a, t, wt.label, 'dub' + d].join(' | ');
        if (ONLY && name.indexOf(ONLY) < 0) continue;
        const fam = FAMILIES[f];
        if (f == 'single' && t == 'lacks') continue;
        const ni = fam.entries.findIndex(e => e.newest);
        const w = Object.assign({}, wt.w);
        if (w.cur == 'ALL') w.cur = d;
        if (w.cur == 'AHEAD') w.cur = d + 4;
        const pe = fam.entries[ni - 1] ? fam.entries[ni - 1].eps : 0;
        if (w.prev == 'HALF') w.prev = Math.floor(pe / 2);
        if (w.prev == 'M1') w.prev = pe - 1;
        if (w.prev == 'M3') w.prev = pe - 3;
        if (f == 'single' && w.prev !== undefined) continue;
        const { cfg, expectNew } = cell(p, f, a, t, w, d);
        let rb, rc;
        try { rb = await runOne(BASE, cfg); } catch (e) { rb = { err: String(e && e.stack || e) }; }
        try { rc = await runOne(CAND, cfg); } catch (e) { rc = { err: String(e && e.stack || e) }; }
        const okB = !(rb && rb.err) && judgeRes(rb, expectNew);
        const okC = !(rc && rc.err) && judgeRes(rc, expectNew);
        total++;
        const tag = okC ? (okB ? 'ok   ' : 'FIXED') : (okB ? 'REGR ' : 'BOTH ');
        if (tag == 'REGR ') regr++;
        if (tag == 'FIXED') fixed++;
        if (tag == 'BOTH ') both++;
        if (SHOW_ALL || tag != 'ok   ') {
            console.log(`${tag} ${name.padEnd(70)} exp:${expectNew > 0 ? '+' + expectNew : 'hidden'}  base: ${fmt(rb).padEnd(30)} cand: ${fmt(rc)}`);
        }
    }
    console.log(`\ntotal ${total}  regressions ${regr}  fixed ${fixed}  wrong-in-both ${both}`);
    process.exit(regr ? 1 : 0);
})();
