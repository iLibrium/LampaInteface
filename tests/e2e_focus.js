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

    await page.waitForFunction(() => Lampa.Activity.active() && Lampa.Activity.active().component == 'main', null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => Lampa.Activity.push({ url: '', title: 'Аниме', component: 'shikimori_main', page: 1 }));
    await page.waitForFunction(() => [...document.querySelectorAll('.items-line__title')].some(t => t.textContent == 'Свежая озвучка'), null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const where = await page.evaluate(() => {
        const f = document.querySelector('.focus');
        const act = f && f.closest('.activity');
        const acts = [...document.querySelectorAll('.activity')].map(a => a.className + ' :: ' + (a.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' '));
        return { ctrl: Lampa.Controller.enabled().name, active: Lampa.Activity.active().component, focus: f && f.className, focusText: f && f.textContent.trim().slice(0, 30), inActivity: act && act.className, acts };
    });
    console.log('start', JSON.stringify(where));
    // Фокус: карточка в фокусе помечается «все серии просмотрены» — с пульта
    const inFresh = () => page.evaluate(() => {
        const f = document.querySelector('.items-line .focus, .shikimori-action.focus');
        const line = f && f.closest('.items-line');
        const t = line && line.querySelector('.items-line__title');
        return { line: t ? t.textContent : '', card: f ? f.textContent.trim().slice(0, 30) : null, cls: f ? f.className.slice(0, 50) : null };
    });
    let pos = await inFresh();
    for (let i = 0; i < 8 && pos.line != 'Свежая озвучка'; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(400);
        pos = await inFresh();
    }
    const startPos = pos;
    await page.evaluate(() => document.querySelector('.items-line .focus, .shikimori-action.focus').dispatchEvent(new Event('hover:long')));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const item = [...document.querySelectorAll('.selectbox-item')].find(i => /все серии просмотренными/.test(i.textContent));
        $(item).trigger('hover:enter');
    });
    await page.waitForTimeout(600);
    const afterMark = await inFresh();
    // Стрелки внутри экрана должны работать: вверх — и мы на другой строке
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(400);
    const afterUp = await inFresh();
    console.log(JSON.stringify({ startPos, afterMark, afterUp }));
    check('focus survives «mark all watched»', startPos.line == 'Свежая озвучка' && afterMark.card && afterMark.card != startPos.card &&
        afterUp.card && afterUp.line != afterMark.line, { startPos, afterMark, afterUp });

    check('no page errors', errors.length === 0, errors.slice(0, 5));

    for (const r of results) console.log((r.ok ? 'OK  ' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '\n        ' + JSON.stringify(r.details)));
    if (results.some(r => !r.ok)) console.log(apiLog.slice(-40).join('\n'));
    await browser.close();
    server.close();
    process.exit(results.some(r => !r.ok) ? 1 : 0);
})();
