// Где взять Chromium и сборку Lampa для проверок в настоящем приложении
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function chromium() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    try {
        const p = require('playwright-core').chromium.executablePath();
        if (p && fs.existsSync(p)) return p;
    }
    catch (e) {}
    const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
    const rels = ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe'];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        const dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
        for (const dir of dirs) {
            for (const rel of rels) {
                const p = path.join(root, dir, rel);
                if (fs.existsSync(p)) return p;
            }
        }
    }
    throw new Error('Chromium не найден — укажите путь в CHROMIUM_PATH');
}

function lampaApp() {
    const dir = process.env.LAMPA_APP || path.join(__dirname, '.cache', 'lampa-app');
    if (!fs.existsSync(path.join(dir, 'index.html'))) {
        throw new Error('Нет сборки Lampa в ' + dir + ' — выполните npm run setup или укажите LAMPA_APP');
    }
    return dir;
}

module.exports = { chromium, lampaApp };
