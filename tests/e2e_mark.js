// Real Lampa: does Enter on an episode in the full card toggle the watched mark,
// with and without the plugin? Usage: node e2e_mark.js [plugin|none]
'use strict';
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeWorld } = require('./servers');

const MODE = process.argv[2] || 'plugin';
const FILE = path.resolve(process.argv[3] || path.join(__dirname, '..', 'shikimori.js'));
const ROOT = require('./browser').lampaApp();
const PORT = 8125;
const DAY = 86400e3;
const ymd = t => new Date(t).toISOString().slice(0, 10);

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
    const APO = {
        type: 'tv', id: 220542, name_ru: 'Монолог фармацевта', name_en: 'The Apothecary Diaries',
        original_name: '薬屋のひとりごと', date: '2023-10-22', seasons: 3, popularity: 150,
        seasonList: [
            { season_number: 1, episode_count: 24, air_date: '2023-10-22', name: 'Сезон 1' },
            { season_number: 2, episode_count: 24, air_date: '2025-01-10', name: 'Сезон 2' },
            { season_number: 3, episode_count: 12, air_date: ymd(now - DAY), name: 'Сезон 3' }
        ],
        episodes: { 3: [
            { episode_number: 1, air_date: ymd(now - DAY), name: 'Серия 1' },
            { episode_number: 2, air_date: ymd(now + 6 * DAY), name: 'Серия 2' }
        ] }
    };
    const world = makeWorld({ animes: [], arm: [], tmdb: [APO], kodikTokens: ['56a768d08f43091901c44b54fe970049'], kodik: [] });

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
    if (MODE == 'plugin') await page.addScriptTag({ content: fs.readFileSync(FILE, 'utf8') });
    await page.waitForFunction(() => Lampa.Activity.active() && Lampa.Activity.active().component == 'main', null, { timeout: 30000 });
    await page.waitForTimeout(1500);

    // Серия 1 третьего сезона уже отмечена — как у пользователя «от 2 октября»
    const hash = await page.evaluate(() => {
        const h = Lampa.Utils.hash([3, '', 1, '薬屋のひとりごと'].join(''));
        Lampa.Timeline.update({ hash: h, percent: 100, time: 0, duration: 0 });
        return h;
    });

    await page.evaluate(() => Lampa.Activity.push({ url: '', component: 'full', id: 220542, method: 'tv',
        card: { id: 220542, name: 'Монолог фармацевта', source: 'tmdb' }, source: 'tmdb' }));
    const found = await page.waitForFunction(() => {
        const act = document.querySelector('.activity--active') || document;
        return [...act.querySelectorAll('.full-episode')].length > 0;
    }, null, { timeout: 30000 }).then(() => true, () => false);

    const state = () => page.evaluate(h => {
        const act = document.querySelector('.activity--active') || document;
        const eps = [...act.querySelectorAll('.full-episode')].map(e => ({
            num: (e.querySelector('.full-episode__num') || {}).textContent,
            cls: e.className
        }));
        return { percent: Lampa.Timeline.view(h).percent, eps };
    }, hash);

    const log = [];
    log.push(['start', await state()]);
    for (let i = 1; i <= 3; i++) {
        await page.evaluate(() => {
            const act = document.querySelector('.activity--active') || document;
            const ep = [...act.querySelectorAll('.full-episode')].find(e => (e.querySelector('.full-episode__num') || {}).textContent == '1');
            ep.dispatchEvent(new Event('hover:enter'));
        });
        await page.waitForTimeout(400);
        log.push(['click ' + i, await state()]);
    }
    console.log('mode:', MODE, 'episodes rendered:', found);
    for (const [k, v] of log) console.log(' ', k.padEnd(8), 'percent=' + v.percent, JSON.stringify(v.eps.map(e => e.num + ':' + (/viewed/.test(e.cls) ? 'VIEWED' : '-'))));
    console.log('  page errors:', errors.length, errors.slice(0, 2).join(' | ').slice(0, 300));
    // Нажатие по серии переключает отметку: была — снимается, не было — ставится
    const percents = log.map(([, v]) => v.percent);
    const ok = found && percents[0] && !percents[1] && percents[2] && !percents[3] && errors.length === 0;
    console.log((ok ? 'OK  ' : 'FAIL') + '  Enter on an episode toggles the Lampa mark (' + MODE + ')');
    await browser.close();
    server.close();
    process.exit(ok ? 0 : 1);
})();
