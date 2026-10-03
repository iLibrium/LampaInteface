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
        animes: [Object.assign({}, F.FRIEREN_S2, { nextEpisodeAt: new Date(Date.now() + 2 * 86400e3).toISOString() }), F.FRIEREN_S1,
            F.anime({ id: 70001, name: 'Show A', russian: 'Шоу А', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 4 }),
            F.anime({ id: 70002, name: 'Show B', russian: 'Шоу Б', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 4 }),
            F.anime({ id: 70003, name: 'Show C', russian: 'Шоу В', kind: 'tv', status: 'ongoing', episodes: 12, episodesAired: 4 })],
        arm: [{ myanimelist: 52991, themoviedb: 209867, media: 'TV', 'themoviedb-season': 1 }],
        tmdb: [F.FRIEREN_TMDB],
        kodikTokens: ['56a768d08f43091901c44b54fe970049'],
        kodik: [{ shikimori_id: 59978, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 3,
            updated_at: new Date(Date.now() - 3600e3).toISOString() },
            { shikimori_id: 52991, translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 28,
            updated_at: new Date(Date.now() - 7200e3).toISOString() }].concat([70001, 70002, 70003].map((id, i) => ({ shikimori_id: id,
            translation: { id: 610, title: 'AniLibria.TV', type: 'voice' }, last_episode: 4, updated_at: new Date(Date.now() - (3 + i) * 3600e3).toISOString() }))),
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
    await page.waitForFunction(() => window.appready === true, null, { timeout: 60000 });
    await page.addScriptTag({ content: fs.readFileSync(FILE, 'utf8') });
    await page.waitForFunction(() => Lampa.Activity.active() && Lampa.Activity.active().component == 'main', null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => Lampa.Activity.push({ url: '', title: 'Аниме', component: 'shikimori_main', page: 1 }));
    await page.waitForFunction(() => [...document.querySelectorAll('.items-line__title')].some(t => t.textContent == 'Свежая озвучка'), null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const pos = () => page.evaluate(() => {
        const f = document.querySelector('.activity--active .focus') || document.querySelector('.focus');
        const line = f && f.closest('.items-line');
        const t = line && line.querySelector('.items-line__title');
        const sel = window.Navigator && Navigator._collection ? Navigator._collection.length : null;
        return { line: t ? t.textContent : '', card: f ? f.textContent.trim().slice(0, 30) : null,
            connected: f ? document.body.contains(f) : null, focusCount: document.querySelectorAll('.focus').length };
    });
    let p = await pos();
    for (let i = 0; i < 8 && p.line != 'Свежая озвучка'; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(350); p = await pos(); }
    // к началу строки — ровно до первой карточки, иначе уйдём в меню Lampa
    const index = () => page.evaluate(() => {
        const f = document.querySelector('.activity--active .items-line .focus');
        if (!f) return -1;
        const cards = [...f.closest('.items-line').querySelectorAll('.card')];
        return cards.indexOf(f);
    });
    for (let i = 0; i < 10 && (await index()) > 0; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(300); }
    const rowSize = await page.evaluate(() => { const f = document.querySelector('.activity--active .items-line .focus'); return f ? f.closest('.items-line').querySelectorAll('.card').length : 0; });
    // Середина строки: два шага вправо, скрыть, влево — должны попасть на карточку перед скрытой
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400);
    const mid = Object.assign(await pos(), { index: await index() });
    const before = await page.evaluate(() => { const f = document.querySelector('.activity--active .items-line .focus'); const cards = [...f.closest('.items-line').querySelectorAll('.card')]; const b = cards[cards.indexOf(f) - 1]; return b ? b.textContent.trim().slice(0, 30) : null; });
    await page.evaluate(() => document.querySelector('.activity--active .items-line .focus').dispatchEvent(new Event('hover:long')));
    await page.waitForTimeout(400);
    await page.evaluate(() => { const item = [...document.querySelectorAll('.selectbox-item')].find(i => /Не интересует/.test(i.textContent)); $(item).trigger('hover:enter'); });
    await page.waitForTimeout(600);
    const midAfterHide = await pos();
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(500);
    const midAfterLeft = Object.assign(await pos(), { index: await index() });
    console.log(JSON.stringify({ rowSize, mid, before, midAfterHide, midAfterLeft }));
    const midOk = !!midAfterLeft.connected && midAfterLeft.card == before;
    console.log((midOk ? 'OK  ' : 'FAIL') + '  middle card hidden, Left goes to the previous card');
    const first = Object.assign(await pos(), { index: await index() });
    // «Не интересует» на первой карточке строки
    await page.evaluate(() => (document.querySelector('.activity--active .items-line .focus') || document.querySelector('.items-line .focus')).dispatchEvent(new Event('hover:long')));
    await page.waitForTimeout(400);
    const menu = await page.evaluate(() => [...document.querySelectorAll('.selectbox-item')].map(i => i.textContent.trim()));
    await page.evaluate(() => {
        const item = [...document.querySelectorAll('.selectbox-item')].find(i => /Не интересует|Скрыть/.test(i.textContent));
        $(item).trigger('hover:enter');
    });
    await page.waitForTimeout(600);
    const afterHide = await pos();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(500);
    const afterLeft = await pos();
    console.log(JSON.stringify({ first, menu: menu.slice(0, 8), afterHide, afterLeft }, null, 1));
    const firstOk = afterLeft.connected !== false && !!afterLeft.card;
    console.log((firstOk ? 'OK  ' : 'FAIL') + '  after hiding the first card, Left keeps focus on a real element');
    console.log('page errors:', errors.length);
    await browser.close();
    server.close();
    process.exit(firstOk && midOk && errors.length === 0 ? 0 : 1);
})();
