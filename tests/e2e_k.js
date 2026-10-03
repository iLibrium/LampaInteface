// Real Lampa: «Монолог фармацевта» — ARM says season 1 for all three seasons,
// TMDB has seasons 1/2/3; S3E1 marked in Lampa. Is it still in «Новые серии»?
'use strict';
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeWorld } = require('./servers');
const { anime, iso, HOUR, DAY } = require('./fixtures');

const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'shikimori.js'));
const ROOT = require('./browser').lampaApp();
const PORT = 8126;
const K = '薬屋のひとりごと';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg' };

function serve() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let p = decodeURIComponent(req.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            fs.readFile(path.join(ROOT, p), (err, data) => {
                if (err) { res.writeHead(404); return res.end(); }
                res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(PORT, () => resolve(server));
    });
}

(async () => {
    const now = Date.now();
    const rel = (kind, id, name, status) => ({ relationKind: kind, relationText: kind, anime: { id, name, kind: 'tv', status } });
    const world = makeWorld({
        animes: [
            anime({ id: 54492, name: 'Kusuriya no Hitorigoto', russian: 'Монолог фармацевта', japanese: K, kind: 'tv', status: 'released', episodes: 24, episodesAired: 24,
                airedOn: { year: 2023, date: '2023-10-22' }, related: [rel('sequel', 58514, 'Kusuriya no Hitorigoto 2nd Season', 'released')] }),
            anime({ id: 58514, name: 'Kusuriya no Hitorigoto 2nd Season', russian: 'Монолог фармацевта 2', kind: 'tv', status: 'released', episodes: 24, episodesAired: 24,
                airedOn: { year: 2025, date: '2025-01-10' }, related: [rel('prequel', 54492, 'Kusuriya no Hitorigoto', 'released'), rel('sequel', 61987, 'Kusuriya no Hitorigoto 3rd Season', 'ongoing')] }),
            anime({ id: 61987, name: 'Kusuriya no Hitorigoto 3rd Season', russian: 'Монолог фармацевта 3', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 1,
                airedOn: { year: 2026, date: '2026-10-02' }, related: [rel('prequel', 58514, 'Kusuriya no Hitorigoto 2nd Season', 'released')] })
        ],
        arm: [54492, 58514, 61987].map(mal => ({ myanimelist: mal, themoviedb: 220542, media: 'TV', 'themoviedb-season': 1 })),
        tmdb: [{ type: 'tv', id: 220542, name_ru: 'Монолог фармацевта', name_en: 'The Apothecary Diaries', original_name: K, date: '2023-10-22', seasons: 3,
            seasonList: [
                { season_number: 1, episode_count: 24, air_date: '2023-10-22', name: 'Сезон 1' },
                { season_number: 2, episode_count: 24, air_date: '2025-01-10', name: 'Сезон 2' },
                { season_number: 3, episode_count: 12, air_date: '2026-10-03', name: 'Сезон 3' }] }],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [
            { shikimori_id: 61987, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 1, updated_at: iso(now - 20 * HOUR), episodes_aired: 1 },
            { shikimori_id: 58514, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 24, updated_at: iso(now - 400 * DAY), episodes_aired: 24, anime_status: 'released' },
            { shikimori_id: 54492, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 24, updated_at: iso(now - 800 * DAY), episodes_aired: 24, anime_status: 'released' }
        ],
        translations: [{ id: 610, title: 'AniLibria.TV', count: 3000 }]
    });

    const server = await serve();
    const browser = await chromium.launch({ executablePath: require('./browser').chromium(), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    await context.addInitScript(() => {
        try {
            localStorage.setItem('language', 'ru');
            localStorage.setItem('tmdb_lang', 'ru');
            localStorage.setItem('source', 'tmdb');
            localStorage.setItem('proxy_tmdb', 'true');
        } catch (e) {}
    });
    await context.route('**/*', async route => {
        const req = route.request();
        const url = req.url();
        if (url.startsWith('http://localhost:' + PORT)) return route.continue();
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
        let res;
        try { res = world.route(req.method(), url, req.postData()); } catch (e) { res = { status: 500, body: {} }; }
        if (!res || res.network) return route.abort();
        return route.fulfill({ status: res.status || 200, headers: Object.assign({ 'content-type': 'application/json' }, cors),
            body: typeof res.body == 'string' ? res.body : JSON.stringify(res.body) });
    });

    const page = await context.newPage();
    page.on('pageerror', e => errors.push(String(e && e.stack || e)));
    await page.goto('http://localhost:' + PORT + '/');
    await page.waitForFunction(() => window.appready === true, null, { timeout: 60000 });
    await page.addScriptTag({ content: fs.readFileSync(FILE, 'utf8') });
    await page.waitForFunction(() => Lampa.Activity.active() && Lampa.Activity.active().component == 'main', null, { timeout: 30000 });
    await page.waitForTimeout(1000);

    // Закладка и отметки — средствами самой Lampa
    await page.evaluate(K => {
        Lampa.Favorite.add('book', { id: 220542, name: 'Монолог фармацевта', original_name: K, first_air_date: '2023-10-22',
            genre_ids: [16], original_language: 'ja', origin_country: ['JP'], source: 'tmdb', number_of_seasons: 2 });
        const mark = (s, e, p) => Lampa.Timeline.update({ hash: Lampa.Utils.hash([s, '', e, K].join('')), percent: p, time: 0, duration: 0 });
        for (let s = 1; s <= 2; s++) for (let e = 1; e <= 24; e++) mark(s, e, 100);
        mark(3, 1, 95);
    }, K);

    async function freshRow() {
        await page.evaluate(() => Lampa.Activity.push({ url: '', title: 'Аниме', component: 'shikimori_main', page: 1 }));
        await page.waitForFunction(() => document.querySelectorAll('.activity--active .items-line__title').length > 1, null, { timeout: 30000 });
        await page.waitForTimeout(1500);
        return page.evaluate(() => {
            const act = document.querySelector('.activity--active');
            const out = {};
            for (const line of act.querySelectorAll('.items-line')) {
                const t = line.querySelector('.items-line__title');
                if (!t) continue;
                out[t.textContent] = [...line.querySelectorAll('.card__title')].map(x => x.textContent);
            }
            return out;
        });
    }

    const withMark = await freshRow();
    await page.evaluate(K => Lampa.Timeline.update({ hash: Lampa.Utils.hash([3, '', 1, K].join('')), percent: 0, time: 0, duration: 0 }), K);
    await page.evaluate(() => Lampa.Activity.backward());
    await page.waitForTimeout(800);
    const withoutMark = await freshRow();

    const inFresh = rows => (rows['Новые серии'] || []).some(t => /Монолог/.test(t));
    const results = [
        ['S3E1 marked in Lampa → not in «Новые серии»', !inFresh(withMark), withMark],
        ['S3E1 unmarked → in «Новые серии»', inFresh(withoutMark), withoutMark],
        ['TMDB seasons cached', await page.evaluate(() => !!((Lampa.Storage.get('shikimori_tmdb_seasons', {}) || {}).i220542 || {}).s), null],
        ['no page errors', errors.length === 0, errors.slice(0, 3)]
    ];
    for (const [name, ok, det] of results) console.log((ok ? 'OK  ' : 'FAIL') + '  ' + name + (ok ? '' : '\n        ' + JSON.stringify(det)));
    await browser.close();
    server.close();
    process.exit(results.some(r => !r[1]) ? 1 : 0);
})();
