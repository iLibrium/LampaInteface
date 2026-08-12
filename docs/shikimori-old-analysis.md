# Анализ старого плагина "LME Shikimori" (lampame.github.io)

## Происхождение файла

- Исходный URL `https://lampame.github.io/main/shikimori.js` теперь отдаёт 404.
- Wayback Machine (снапшот `20250701103541`) показал, что этот файл был лишь **загрузчиком-стабом**:
  ```js
  Lampa.Utils.putScriptAsync(['https://lampame.github.io/main/Shikimori/Shikimori.js'], function () { });
  ```
- Реальный код по адресу `https://lampame.github.io/main/Shikimori/Shikimori.js` **до сих пор доступен** (46 655 байт, 877 строк) и сохранён в `research/shikimori-old-plugin.js`.
- Код — это Babel-транспилированный бандл (Rollup + regenerator-runtime), т.е. авторский исходник был на ES2017+ (async/await, spread), собранный в ES5 IIFE.

## Манифест и регистрация

```js
var manifest = {
  type: "other",
  version: "0.1",
  name: "LME Shikimori",
  description: "Add Shikimori catalogue",
  component: "LMEShikimori"
};
Lampa.Manifest.plugins = manifest;
Lampa.Component.add("LMEShikimori", Component$1);
```

- Защита от повторной инициализации: флаг `window.plugin_shikimori_ready`.
- Пункт меню добавляется в `$(".menu .menu__list").eq(0)` — `<li class="menu__item selector">` с inline-SVG иконкой Shikimori; по `hover:enter` пушится активити:
  ```js
  Lampa.Activity.push({ url: '', title: 'Shikimori', component: 'LMEShikimori', page: 1 });
  ```
- Если `window.appready` ещё false — подписка на `Lampa.Listener.follow("app", ...)` и добавление кнопки по событию `ready`.

## Структура компонента (Component$1)

Классический "ручной" компонент Lampa (не наследует Lampa.InteractionCategory):

- **Состояние**: `Lampa.Reguest()` (не используется для запросов — всё на jQuery `$.ajax`/`$.get`), `Lampa.Scroll({mask:true, over:true, step:250})`, массив `items`, jQuery-узлы `html` / `head` / `body`, переменные `active`, `last`.
- **Жизненный цикл**:
  - `create()` → `API.main(object, this.build, this.empty)` — первая загрузка.
  - `build(result)` — настраивает `scroll.onWheel` (Navigator.move up/down) и `scroll.onEnd` → `object.page++` и повторный `API.main` (**бесконечная пагинация**: новые карточки просто дозаписываются в тот же `body`).
  - `body(data)` — на каждую аниме создаёт `new Card(anime, userLang)`, вешает `hover:focus` (запоминает `last`, `scroll.update`) и `hover:enter` → `API.search(anime)` (переход к TMDB-карточке).
  - `start()` — регистрирует контроллер `content` (collectionSet/collectionFocus, стрелки, `back`).
  - `empty()` — `Lampa.Empty()`; `destroy()` — очистка network/items/scroll/html.
- **Шапка** (`head`): две кнопки-«фильтра» — `Home` (сброс на страницу 1) и `Filter` (открывает меню фильтров).
- **Карточка** (`Card`): собственный шаблон `LMEShikimori-Card` через `Lampa.Template.get` — постер `poster.originalUrl`, бейджи `kind` (тип), `score` (рейтинг), `season` (или `airedOn.year`), `status`; заголовок: для `ru`-языка `russian || name || japanese`, иначе `name || japanese`. Стили — отдельный шаблон `LMEShikimoriStyle` (позиционирование бейджей поверх `card__view`).

## Эндпоинты Shikimori

1. **Каталог — GraphQL** `POST https://shikimori.one/api/graphql`:
   - Запрос `animes(limit: 36, order: <sort>, page: <page>, kind, status, genre, season)`.
   - Поля: `id, name, russian, licenseNameRu, english, japanese, kind, score, status, season, airedOn { year }, poster { originalUrl }`.
   - ВАЖНО: запрос строится **конкатенацией строк** (не GraphQL variables) — сортировка вставляется без кавычек как enum, фильтры в кавычках.
   - Дефолтная сортировка `aired_on`, страница из `params.page`.
2. **Жанры — REST** `GET https://shikimori.one/api/genres` — фильтруется по `entry_type === "Anime"`, `name` переименовывается в `title` для `Lampa.Select`.
3. **Детали аниме — REST** `GET https://shikimori.one/api/animes/{malId}` — используется в обогащении полной карточки (см. ниже): берёт `score`, `fandubbers`, `fansubbers`.

## Сопоставление с TMDB (API.search)

Цепочка при клике на карточку (Shikimori id == MyAnimeList id):

1. `GET https://arm.haglund.dev/api/v2/ids?source=myanimelist&id={anime.id}` (ARM — Anime Relational Mapping, кросс-БД маппер ID).
2. Если ответ `null` / `themoviedb: null` / 404 → **фолбэк на текстовый поиск** `search/multi` TMDB по `anime.name` (английское название), с чисткой имени: regex `/\b(Season|Part)\s*\d*\.?\d*\b/gi` удаляет «Season 2», «Part 1» и т.п.
3. Если и это дало 0 результатов → повторный `search/multi` по `anime.japanese`.
4. Если ARM вернул TMDB id → прямой `GET {type}/{id}` где `type` берётся из `anime.kind` (`movie`/`tv`...).
5. Обработка результатов (`processResults`):
   - 0 результатов → `Lampa.Noty.show(...)`.
   - 1 результат → сразу `Lampa.Activity.push({component:'full', id, method: media_type, card})`.
   - Несколько → `Lampa.Select.show` со списком `[TV]/[MOVIE] Название`, выбор пушит `full`.
   - Для прямого запроса по id тип определяется эвристикой `response.number_of_episodes ? 'tv' : 'movie'`.
- TMDB-запросы: захардкоженный api_key `4ef0d7355d9ffb5151e987764708ce96` (публичный ключ Lampa), язык из `Lampa.Storage.field('language')`, поддержка прокси: если `Storage.field('proxy_tmdb')` — то `apitmdb.{Lampa.Manifest.cub_domain || 'cub.red'}/3/`, иначе `api.themoviedb.org/3/`.

## Фильтры и поиск

- Меню фильтров строится вручную на `Lampa.Select.show` (главное меню + подменю на каждый фильтр, single-select через флаг `selected`, подзаголовки через `subtitle`).
- Категории:
  - **Genre** — динамически с `/api/genres` (передаётся как `genre: item.id`).
  - **Type (kind)** — tv, movie, ova, ona, special, tv_special, music, pv, cm.
  - **Status** — anons / ongoing / released.
  - **Sort (order)** — id, id_desc, ranked, kind, popularity, name, aired_on, episodes, status, random, ranked_random, ranked_shiki, created_at, created_at_desc.
  - **Season** — генерируется динамически: текущий сезон (`winter|spring|summer|fall_YYYY`, декабрь относится к зиме следующего года), декадные диапазоны `2016_2025`-стиля до 2000, плюс статические `199x`, `198x`, `ancient`. (Баг: `generateDynamicSeasons` в цикле добавляет `getCurrentSeason()` от текущей даты, а не от `nextDate`, так что реально в списке один сезон.)
- «Поиск» = применение фильтров: собирается объект `query` и пушится **новая активити того же компонента** с выбранными параметрами (`Lampa.Activity.push({component:'LMEShikimori', page:1, kind, status, genre, sort, seasons})`). Текстового поиска по названию нет.

## Обогащение полной карточки (Component)

Глобальный слушатель `Lampa.Listener.follow("full", ...)` на событие `complite` для **любой** карточки:

1. `GET https://arm.haglund.dev/api/v2/themoviedb?id={tmdbId}` — обратный маппинг TMDB → MAL.
2. `GET https://shikimori.one/api/animes/{malId}`.
3. В `.full-descr__right` дописываются блоки «Fan Dubbers» / «Fan Subbers» (`response.fandubbers/fansubbers`), а в `.full-start-new__rate-line` префиксом добавляется бейдж рейтинга Shikimori (`response.score`).

## Авторизация

- **Отсутствует полностью.** Никакого OAuth Shikimori, токенов, User-Agent-регистраций или пользовательских списков (watchlist/rates) нет. Все запросы к Shikimori анонимные; TMDB — на общем захардкоженном ключе.

## Слабые места (что учесть в новом плагине)

- GraphQL-запрос через конкатенацию строк — хрупко (инъекции/экранирование), лучше variables.
- jQuery `$.ajax`/`$.get` вместо `Lampa.Reguest` — нет таймаутов/отмены/прокси-фолбэков Lampa.
- `$(document).ready` внутри каждого вызова `API.main` — лишнее.
- Гонка в фильтрах: `filters.kind` (жанры) заполняется асинхронно после отрисовки меню.
- Баг генерации сезонов (см. выше); дубль "By random" в сортировках.
- `empty()` вызывает `html.appendChild(...)` на jQuery-объекте — рантайм-ошибка (должно быть `html.append`).
- Нет кэширования маппинга ARM; нет обработки нескольких fandubbers-полей при `null`.
- Слушатель "full" срабатывает на всех карточках (не только аниме) — лишние запросы к ARM на каждый фильм.
