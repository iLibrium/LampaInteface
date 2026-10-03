// End-to-end: real Lampa (yumata/lampa build) in Chromium, plugin injected,
// every external API answered by the fixture world through request interception.
'use strict';
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeWorld } = require('./servers');
const F = require('./fixtures');

const FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'shikimori.js'));
const ROOT = require('./browser').lampaApp();
const PORT = 8123;

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg' };

function serve() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let p = decodeURIComponent(req.url.split('?')[0]);
            if (p === '/') p = '/index.html';
            const file = path.join(ROOT, p);
            fs.readFile(file, (err, data) => {
                if (err) { res.writeHead(404); return res.end(); }
                res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(PORT, () => resolve(server));
    });
}

(async () => {
    const results = [];
    const check = (name, ok, details) => results.push({ name, ok: !!ok, details });

    const world = makeWorld({
        animes: [Object.assign({}, F.FRIEREN_S2, { nextEpisodeAt: new Date(Date.now() + 2 * 86400e3).toISOString() }), F.FRIEREN_S1],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [F.FRIEREN_TMDB],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 59978, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 3,
            updated_at: new Date(Date.now() - 3600e3).toISOString() },
            { shikimori_id: 52991, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 28,
            updated_at: new Date(Date.now() - 7200e3).toISOString() }],
        translations: [{ id: 610, title: 'AniLibria.TV', count: 3000 }, { id: 609, title: 'AniDUB', count: 2000 }]
    });

    const server = await serve();
    const browser = await chromium.launch({ executablePath: require('./browser').chromium(), args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    const apiLog = [];

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
        try { res = world.route(req.method(), url, req.postData()); }
        catch (e) { res = { status: 500, body: { error: String(e) } }; }
        if (/shikimori|haglund|themoviedb|tmdb\.cub|kodik/.test(url)) apiLog.push(req.method() + ' ' + url.split('?')[0] + ' -> ' + (res && !res.network ? res.status || 200 : 'ABORT'));
        if (!res || res.network) return route.abort();
        return route.fulfill({ status: res.status || 200, headers: Object.assign({ 'content-type': 'application/json' }, cors),
            body: typeof res.body == 'string' ? res.body : JSON.stringify(res.body) });
    });

    const page = await context.newPage();
    page.on('pageerror', e => errors.push(String(e && e.stack || e)));

    await page.goto('http://localhost:' + PORT + '/');
    const ready = await page.waitForFunction(() => window.appready === true, null, { timeout: 60000 }).then(() => true, () => false);
    check('Lampa boots', ready);
    if (!ready) { console.log(errors.slice(0, 5)); await browser.close(); server.close(); process.exit(1); }

    await page.addScriptTag({ content: fs.readFileSync(FILE, 'utf8') });
    const registered = await page.evaluate(() => !!window.plugin_shikimori_anime_ready);
    check('plugin registers itself', registered);

    // Каталог плагина
    await page.evaluate(() => Lampa.Activity.push({ url: '', title: 'Каталог', component: 'shikimori_catalog', page: 1, mode: 'catalog', filters: {} }));
    const cards = await page.waitForFunction(() => {
        const list = [...document.querySelectorAll('.shikimori-card:not(.shikimori-skeleton)')];
        return list.length ? list.map(c => c.querySelector('.card__title').textContent) : null;
    }, null, { timeout: 20000 }).then(h => h.jsonValue(), () => null);
    check('catalog renders in real Lampa', cards && cards.length >= 2, cards);

    // Клик по второму сезону: ARM его не знает, поиск без года находит сериал
    await page.evaluate(() => {
        const c = [...document.querySelectorAll('.shikimori-card')].find(x => x.textContent.indexOf('Фрирен 2') >= 0);
        c.dispatchEvent(new Event('hover:enter'));
    });
    const full = await page.waitForFunction(() => {
        const a = Lampa.Activity.active();
        if (!a || a.component !== 'full') return null;
        const title = document.querySelector('.full-start-new__title, .full-start__title');
        return title && title.textContent.trim() ? { id: a.id, method: a.method, source: a.source, title: title.textContent.trim() } : null;
    }, null, { timeout: 30000 }).then(h => h.jsonValue(), () => null);
    check('real full card opens and loads itself', full && full.id == 209867 && full.method == 'tv' && /Фрирен/.test(full.title), full);
    if (!full) {
        const state = await page.evaluate(() => {
            const a = Lampa.Activity.active();
            return { component: a && a.component, id: a && a.id, method: a && a.method, source: a && a.source,
                noty: [...document.querySelectorAll('.noty')].map(n => n.textContent).slice(-3),
                html: (document.querySelector('.activity--active') || document.body).innerHTML.slice(0, 1500) };
        });
        console.log(JSON.stringify(state, null, 1));
        console.log(apiLog.filter(l => /themoviedb|haglund|graphql|tmdb\./.test(l) && !/discover/.test(l)).slice(-30).join('\n'));
    }

    // Обогащение полной карточки: у сериала идёт второй сезон — строка «Следующая серия»
    const next = await page.waitForFunction(() => {
        const el = document.querySelector('.activity--active .shikimori-next') || document.querySelector('.shikimori-next');
        return el ? el.textContent : null;
    }, null, { timeout: 15000 }).then(h => h.jsonValue(), () => null);
    check('full card shows the next episode of the airing season', next && /4 серия/.test(next), next);
    const remembered = await page.evaluate(() => (Lampa.Storage.get('shikimori_tmdb_info', {}) || {}).i209867);
    check('opened full card remembers the TMDB name for Lampa marks', remembered && remembered.original_name == '葬送のフリーレン', remembered);
    const seasonsSaved = await page.evaluate(() => (Lampa.Storage.get('shikimori_tmdb_seasons', {}) || {}).i209867);
    check('opened full card remembers TMDB seasons', seasonsSaved && seasonsSaved.s && seasonsSaved.s.length >= 1, seasonsSaved);

    // Главная плагина в настоящей Lampa: «Свежая озвучка» из накопленного
    await page.evaluate(() => Lampa.Activity.push({ url: '', title: 'Аниме', component: 'shikimori_main', page: 1 }));
    const rows = await page.waitForFunction(() => {
        const a = Lampa.Activity.active();
        if (!a || a.component !== 'shikimori_main') return null;
        const heads = [...document.querySelectorAll('.activity--active .items-line__title')].map(t => t.textContent.trim()).filter(Boolean);
        return heads.length ? heads : null;
    }, null, { timeout: 30000 }).then(h => h.jsonValue(), () => null);
    check('main screen rows render in real Lampa', rows && rows.indexOf('Свежая озвучка') >= 0, rows);
    const marker = await page.evaluate(() => {
        const lines = [...document.querySelectorAll('.activity--active .items-line')];
        const line = lines.find(l => (l.querySelector('.items-line__title') || {}).textContent == 'Свежая озвучка');
        const m = line && line.querySelector('.shikimori-card .card__marker span');
        return m ? m.textContent : null;
    });
    check('fresh-dub card shows episode and studio', marker && /3 серия · AniLibria\.TV/.test(marker), marker);

    check('no page errors', errors.length === 0, errors.slice(0, 5));

    for (const r of results) console.log((r.ok ? 'OK  ' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '\n        ' + JSON.stringify(r.details)));
    if (results.some(r => !r.ok)) console.log(apiLog.slice(-40).join('\n'));
    await browser.close();
    server.close();
    process.exit(results.some(r => !r.ok) ? 1 : 0);
})();
