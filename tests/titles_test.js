const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'shikimori.js'), 'utf8');
const start = src.indexOf('    var Titles = {');
const end = src.indexOf('\n    };', start) + 7;
const Titles = eval('(function(){' + src.slice(start, end) + '; return Titles; })()');
const base = [
  ['葬送のフリーレン 第2期', '葬送のフリーレン'],
  ['薬屋のひとりごと 第2期', '薬屋のひとりごと'],
  ['【推しの子】 第2期', '【推しの子】'],
  ['Re:ゼロから始める異世界生活 3rd season', 'Re:ゼロから始める異世界生活'],
  ['無職転生Ⅱ ～異世界行ったら本気だす～', '無職転生 ～異世界行ったら本気だす～'],
  ['Sousou no Frieren 2nd Season', 'Sousou no Frieren'],
  ['Shingeki no Kyojin: The Final Season Part 2', 'Shingeki no Kyojin:'],
  ['Провожающая в последний путь Фрирен 2', 'Провожающая в последний путь Фрирен'],
  ['Магическая битва 2 сезон', 'Магическая битва'],
  ['Моб Психо 100 III', 'Моб Психо 100'],
  ['Steins;Gate 0', 'Steins;Gate 0'],
  ['Mob Psycho 100', 'Mob Psycho 100'],
  ['Spy x Family Season 2', 'Spy x Family'],
  ['Boku no Hero Academia 7th Season', 'Boku no Hero Academia'],
  ['Dr. Stone (TV)', 'Dr. Stone'],
  ['転生したらスライムだった件 第3期', '転生したらスライムだった件'],
  ['Наруто [ТВ-2]', 'Наруто'],
  ['Kaguya-sama wa Kokurasetai: Ultra Romantic', 'Kaguya-sama wa Kokurasetai: Ultra Romantic'],
  ['86', '86'],
  ['Сезон охоты 2', 'Сезон охоты'],
];
let bad = 0;
for (const [a, b] of base) { const r = Titles.base(a); if (r !== b) { bad++; console.log('BASE', JSON.stringify(a), '->', JSON.stringify(r), 'expected', JSON.stringify(b)); } }
const sims = [
  [['葬送のフリーレン 第2期'], ['葬送のフリーレン'], 0.9, 1],
  [['Sousou no Frieren'], ['葬送のフリーレン'], 0, 0.1],
  [["Frieren: Beyond Journey's End Season 2"], ["Frieren: Beyond Journey's End"], 0.9, 1],
  [['鬼滅の刃 刀鍛冶の里編'], ['鬼滅の刃'], 0.85, 1],
  [['HUNTER×HUNTER'], ['HUNTER×HUNTER'], 1, 1],
  [['Steins;Gate 0'], ['Steins;Gate'], 0, 0.95],
  [['Naruto: Shippuuden'], ['Naruto Shippūden'], 1, 1],
  [['呪術廻戦'], ['呪術廻戦 0'], 0.85, 0.97],
  [['Провожающая в последний путь Фрирен 2'], ['Провожающая в последний путь Фрирен'], 0.9, 1],
  [['Another'], ['Another World'], 0.5, 0.8],
];
for (const [a, b, lo, hi] of sims) { const v = Titles.best(a, b); if (v < lo || v > hi) { bad++; console.log('SIM', a, b, v.toFixed(3), 'expected in', lo, hi); } else console.log('ok sim', a[0], '|', b[0], v.toFixed(3)); }
console.log(bad ? bad + ' problems' : 'all good');
process.exit(bad ? 1 : 0);
