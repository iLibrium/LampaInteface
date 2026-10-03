# Проверки плагина

Два уровня, оба без доступа к настоящим API: Shikimori, ARM, TMDB, CUB и Kodik
подменяются фейковыми серверами (`servers.js`), данные — в самих сценариях.

```bash
cd tests
npm install          # jsdom, jquery, playwright-core, acorn, eslint
npm run check        # ES5 + eslint no-undef + все сценарии эмулятора
npm run setup        # один раз: сборка Lampa (github.com/yumata/lampa) в tests/.cache
npm run e2e          # настоящая Lampa в Chromium
```

## Эмулятор Lampa (`run.js`)

`lampa.js` — Lampa на jsdom: Storage, Timeline (отметки серий — карта `hash → percent`),
Favorite, Activity, Select, InteractionMain и т. д. Каждый вызов записывается в `env.log`.
`run.js` — сценарии: `node run.js [файл плагина] [фильтр по имени]`.

```bash
node run.js                         # все сценарии на ../shikimori.js
node run.js ../shikimori.js k7_     # один сценарий
```

Сценарий — функция `scenarios.имя = async function (S) { … check(S, 'что проверяем', условие, детали) }`.
Мир для сценария — `makeWorld({ animes, arm, tmdb, kodik, rates, user, cubPopular, … })`:

- `animes` — записи Shikimori (`anime({...})` из `fixtures.js`), со связями `related` и датами `airedOn`;
- `arm` — строки базы соответствий: `myanimelist`, `themoviedb`, `media`, `'themoviedb-season'`;
- `tmdb` — карточки TMDB; `seasonList` уходит в `tv/{id}` как `seasons`, `episodes[номер]` — в `tv/{id}/season/{номер}`;
- `kodik` — раздачи Kodik: `shikimori_id`, `translation`, `last_episode`, `updated_at`.

Отметки Lampa — `timeline` в `createEnv`: ключ `hash([сезон, сезон > 10 ? ':' : '', серия, original_name].join(''))`.
Готовые миры и помощники: `kWorld`/`kMarks` («Монолог фармацевта»), `sxfWorld`/`sxfMarks`
(«Семья шпиона», сплит-кур), `frierenWorld`, `twoLoads` (два запуска подряд с сохранённым хранилищем).

## Ошибка — сначала сценарий

Прежде чем чинить, воспроизведите ошибку сценарием и убедитесь, что он падает на текущей версии:

```bash
git show origin/main:shikimori.js > .cache/main.js
node run.js .cache/main.js имя_сценария     # должен упасть
node run.js ../shikimori.js имя_сценария    # после исправления — пройти
```

## Матрица «Новых серий» (`matrix.js`)

Одна и та же история просмотра на всех раскладках сезонов сразу, две версии плагина рядом:
путь (закладка Lampa или список Shikimori) × тайтл («Монолог фармацевта», «Семья шпиона» с
частями, «Фрирен», одиночный сезон) × что знает база соответствий (верно, всё первым сезоном,
без сезона, без нового сезона) × как TMDB нарезал сезоны (раздельно, сквозь, ещё не завёл
новый, заблокирован при живом CUB, не отвечает вместе с CUB) × что отмечено в Lampa. Любая
правка прогресса или сезонов — сюда:

```bash
git show origin/main:shikimori.js > .cache/main.js
npm run matrix                                # main против ../shikimori.js
node matrix.js "| apoth |"                    # один тайтл; прогон долгий — делите по тайтлам
WATCH=more DUBS=1,5 node matrix.js "| sxf |"  # другие истории просмотра и озвучка
```

`REGR` — было верно и сломалось (выход с ошибкой), `FIXED` — стало верно, `BOTH` — неверно в обеих.
Неверными остаются только ячейки, где не отвечают ни TMDB, ни CUB, а названия и сезоны TMDB ещё
не запомнены.

## Настоящая Lampa (`e2e*.js`)

Сборка Lampa отдаётся локальным сервером, плагин внедряется в страницу, внешние запросы
перехватываются и отвечаются тем же `servers.js`. Chromium ищется сам (`browser.js`),
иначе — путь в `CHROMIUM_PATH`; сборка Lampa — `LAMPA_APP` или `tests/.cache/lampa-app`.

- `e2e.js` — каталог, полная карточка, главная, «Свежая озвучка»;
- `e2e_focus.js`, `e2e_drop.js` — фокус пульта после «Отметить все» и «Не интересует»;
- `e2e_k.js` — «Монолог фармацевта»: отмеченная в Lampa серия 3×1 убирает тайтл из «Новых серий»;
- `e2e_mark.js` — нажатие по серии в карточке Lampa переключает отметку (`plugin` / `none`).

## Ещё

- `npm run complexity` — сложность запросов к Shikimori GraphQL (лимит сервера 190, глубина 5);
- `npm run titles` — сравнение названий тайтлов (`Titles`).
