// Сборка Lampa для проверок в настоящем приложении: github.com/yumata/lampa
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dir = process.env.LAMPA_APP || path.join(__dirname, '.cache', 'lampa-app');
if (fs.existsSync(path.join(dir, 'index.html'))) {
    console.log('Сборка Lampa уже есть:', dir);
    process.exit(0);
}
fs.mkdirSync(path.dirname(dir), { recursive: true });
execSync('git clone --depth 1 https://github.com/yumata/lampa.git ' + JSON.stringify(dir), { stdio: 'inherit' });
console.log('Сборка Lampa:', dir);
