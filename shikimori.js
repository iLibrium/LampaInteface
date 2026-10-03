(function () {
    'use strict';

    /* ============================================================
     * Anime Shikimori — плагин для Lampa
     * ------------------------------------------------------------
     * - Каталог аниме Shikimori с фильтрами и поиском
     * - Списки пользователя Shikimori (по нику, без OAuth)
     * - Подсветка новых серий в «Я смотрю»
     * - Календарь выхода серий (30 дней) по спискам + закладкам Lampa/CUB
     * - Матчинг Shikimori -> TMDB (ARM + поиск TMDB)
     * - «Сейчас смотрят в Lampa» (каталог CUB, фолбэк TMDB)
     * ============================================================ */

    var PLUGIN = 'shikimori';
    var VERSION = '3.7.3';

    var SHIKI_BASE = 'https://shikimori.io';
    var ARM_BASE = 'https://arm.haglund.dev';
    var CALENDAR_DAYS = 30;
    var CALENDAR_TTL = 60 * 60 * 1000;        // кэш календаря: 1 час
    var RATES_TTL = 10 * 60 * 1000;           // кэш списков пользователя: 10 минут
    var MATCH_TTL = 30 * 24 * 60 * 60 * 1000; // кэш маппинга mal->tmdb: 30 дней
    // Отрицательный ответ живёт сутки: база соответствий узнаёт о новых
    // сезонах с опозданием в недели, и три дня «не найдено» — это три дня,
    // когда новинку нельзя открыть, хотя ответ уже появился
    var MATCH_NEG_TTL = 24 * 60 * 60 * 1000;
    var REVERSE_TTL = 3 * 24 * 60 * 60 * 1000;   // TMDB -> Shikimori: 3 дня, иначе не узнать о новом сезоне
    var REVERSE_SEARCH_MAX = 8;               // поисков по названию за обновление (лимит Shikimori — 5 в секунду)
    var SEQUEL_DEPTH = 3;                     // на сколько сезонов вперёд ищем продолжения закладки
    var TMDB_TIMEOUT = 8000;                  // прямой TMDB часто не отвечает вовсе — ждём недолго
    var GENRES_TTL = 24 * 60 * 60 * 1000;     // кэш жанров: сутки

    // Kodik — источник «серия уже доступна с озвучкой». Адрес и токен переопределяются
    // в настройках: домен уже переезжал (kodikapi.com отключён регистратором 20.03.2026),
    // а токены — общий публичный пул, они регулярно умирают.
    var KODIK_HOST = 'kodik-api.com';
    var KODIK_TOKENS = [
        '56a768d08f43091901c44b54fe970049',
        '41dd95f84c21719b09d6c71182237a25',
        '77b567ec164db6ca9162d2f3dc4948c3'
    ];
    var KODIK_TTL = 15 * 60 * 1000;           // как часто сверяемся с лентой Kodik
    var KODIK_PAGES = 2;                      // первая сверка: 2 страницы по 100 строк
    var KODIK_SYNC_PAGES = 10;                // догоняем пропущенное не глубже 10 страниц
    var KODIK_LOOKUP_MAX = 24;                // точечных запросов за обновление — не больше
    var KODIK_LOOKUP_PARALLEL = 6;            // и сколько из них одновременно
    var KODIK_RECHECK = 6 * 60 * 60 * 1000;   // выходящее из ваших списков перепроверяем раз в 6 часов
    var KODIK_RECHECK_DONE = 24 * 60 * 60 * 1000; // вышедшее, но ещё не озвученное целиком, — раз в сутки
    var KODIK_RELEASED_HOURS = 36;            // «Свежая озвучка» — за последние полтора дня
    var KODIK_STORE_MAX = 1000;               // сколько тайтлов помним
    var KODIK_FRESH_DAYS = 14;                // «новой» серия считается столько дней
    var BADGE_REFRESH = 30 * 60 * 1000;       // пересчёт счётчика в меню, пока приложение открыто
    var KODIK_LOOKUP_WAIT = 2000;             // столько главная ждёт точечных запросов, остальное — в фоне
    var BACKGROUND_WAIT = 30000;              // фоновому пересчёту счётчика спешить некуда
    var MAIN_WAIT = 10000;                     // дольше этого главная не ждёт ни один источник
    var RELATED_TTL = 30 * 60 * 1000;         // связи сезонов в памяти: полчаса
    var RELATED_MEMO_MAX = 400;               // а записей в этой памяти — не больше стольких
    var ARM_TIMEOUT = 6000;                   // база соответствий отвечает быстро или не отвечает вовсе
    var REVERSE_MAX = 40;                     // обратных запросов TMDB->MAL за обновление
    var REVERSE_PARALLEL = 8;                 // и сколько из них одновременно
    var FAVORITES_WAIT = 2500;                // ждём синхронизацию закладок аккаунта, мс
    var BADGE_DELAY = 6000;                   // пересчёт счётчика в меню — после загрузки приложения
    var SEQUELS_MAX = 40;                     // сколько досмотренных тайтлов проверяем на продолжения
    var FAV_TAGS = ['look', 'wath', 'book', 'viewed', 'thrown'];  // метки Lampa: Смотрю, Позже, Закладки, Просмотрено, Брошено
    var MARK_SEEN_LIMIT = 2000;               // потолок отметок за одно нажатие
    var MARK_SEEN_FALLBACK = 24;              // если число серий неизвестно
    var WATCHING_RECENT_DAYS = 30;            // сколько дней просмотр считается активным
    var PROGRESS_SCAN_MAX = 400;              // потолок перебора серий при поиске отметок
    var PROGRESS_SCAN_HARD = 4096;            // а дальше — шагами, у «Ван-Писа» за тысячу
    var FRESH_SANE_MAX = 26;
    var PROGRESS_SCAN_MIN = 26;      // минимум серий на сезон при переборе
    var PROGRESS_SEASON_MAX = 8;     // до какого сезона искать всегда
    var PROGRESS_SEASON_HARD = 12;   // и дальше, если карточка знает о большем
    var PROGRESS_SEASON_SPAN = 40;   // у тайтла на много сезонов TMDB («Ван-Пис») — до стольких
    var PROGRESS_SEASON_PROBE = 3;   // сколько первых серий щупать, чтобы отсечь пустой сезон
    var PROGRESS_EXACT_WINDOW = 60;  // сколько серий сверху перебирать подряд в сезоне, где остановились
    var PROGRESS_PROBE_BUDGET = 700; // потолок обращений к таймлайну на карточку
    var POSTER_LAZY_FALLBACK = 1500;          // если событие visible не пришло — грузим постер сами
    var AMBIENCE_KEY = 'shikimori_ambience';  // фон по карточке в фокусе
    var MOTION_KEY = 'shikimori_motion';      // движение карточек: масштаб фокуса и отклик
    var RETRY_MAX = 2;                        // повторов после 429/5xx
    var RETRY_DELAY = 1200;                   // пауза перед первым, дальше вдвое
    var TRANSLATIONS_TTL = 7 * 24 * 60 * 60 * 1000; // список студий Kodik: неделя
    var TRANSLATIONS_MAX = 150;               // и сколько самых ходовых показываем
    var TMDB_INFO_KEY = 'shikimori_tmdb_info';
    var TMDB_INFO_MAX = 60;      // сколько закладок дозапрашиваем за один заход
    var TMDB_INFO_PARALLEL = 4;  // и по сколько запросов разом
    var TMDB_INFO_RETRY = 24 * 60 * 60 * 1000; // сеть не ответила — пробуем снова через сутки
    var TMDB_INFO_LEGACY = 8;    // записей прежних версий перепроверяем за заход
    var SEEN_UNDO_MAX = 300;     // отметок серий, которые «Снять отметку» умеет откатить
    var PREFETCH_NAMES_MAX = 20;  // имён TMDB заранее — не больше стольких за раз
    var LOST_MATCH_MAX = 5;       // тайтлов списка без сопоставления ищем в фоне за заход
    var SEASONS_KEY = 'shikimori_tmdb_seasons';
    var SEASONS_TTL = 7 * 24 * 60 * 60 * 1000;  // сезоны TMDB меняются редко — неделя
    var SEASONS_RECHECK = 12 * 60 * 60 * 1000;  // а вышел новый сезон, которого TMDB не знал, — полсуток
    var SEASONS_MAX = 300;                       // тайтлов в кеше сезонов
    var SEASONS_FETCH_MAX = 12;                  // запросов сезонов за один заход
    var SEASONS_WAIT = 1500;                     // сколько главная ждёт сезоны сверх остального
    var SEASON_MATCH_DAYS = 45;                  // премьера Shikimori и начало сезона TMDB — тот же сезон
                                                 // (веб-премьера бывает на месяц раньше телевизионной)
    var SEASONS_RETRY = 60 * 60 * 1000;          // TMDB не ответил про сезоны — снова через час

    var manifest = {
        type: 'video',
        version: VERSION,
        // Раздел называется по содержимому, а не по источнику данных: человеку
        // важно «Аниме», а Shikimori — это то, откуда мы берём каталог, и
        // упоминать его стоит только там, где он правда нужен: ник, профиль, API
        name: 'Аниме',
        description: 'Каталог, списки и календарь аниме',
        component: PLUGIN + '_main'
    };

    /* ============================================================
     * Утилиты
     * ============================================================ */

    function storGet(name, def) {
        return Lampa.Storage.get(name, def);
    }

    // Строковая настройка: Storage может вернуть значение в кавычках или с пробелами
    function storString(name, def) {
        var value = Lampa.Storage.get(name, def);
        if (typeof value != 'string') return def;
        value = value.replace(/^\s+|\s+$/g, '').replace(/^["']|["']$/g, '');
        return value || def;
    }

    // Переключатель: Storage может вернуть строку "true"/"false" вместо булева
    function storBool(name, def) {
        var value = Lampa.Storage.get(name, def);
        if (typeof value == 'string') return value.replace(/["'\s]/g, '') == 'true';
        return value === true;
    }

    function storSet(name, value) {
        Lampa.Storage.set(name, value);
    }

    /* Кому возвращать фокус, когда список закроется.
     *
     * Lampa.Select.show() сама переключает контроллер на 'select', поэтому
     * внутри onSelect/onCheck/onBack текущий контроллер — это уже сам список.
     * Запомнить его и потом вернуться в него — значит отдать управление
     * закрытому окну: экран перестаёт слушать пульт. Так ломалось управление
     * после вложенных списков фильтра. Берём имя только когда оно не 'select',
     * а последнее нормальное держим про запас. */
    var last_owner = 'content';

    function ownerController() {
        var name = '';
        try { name = Lampa.Controller.enabled().name; }
        catch (e) {}
        if (name && name != 'select') last_owner = name;
        return last_owner;
    }

    function restoreController(name) {
        try { Lampa.Controller.toggle(name && name != 'select' ? name : last_owner); }
        catch (e) {}
    }

    // Виды, у которых бывают сезоны TMDB; фильмы и OVA живут отдельно
    var SERIES_KINDS = ['tv', 'ona', 'tv_special'];
    // «Part 2» в TMDB обычно продолжает тот же сезон, «2nd Season» — следующий
    var PART_RE = /part|cour|クール|часть|後編|後半/i;

    // Входит ли сезон Shikimori в нумерацию серий сезонов TMDB. Сериал и ONA —
    // да, если база соответствий не относит их к спецвыпускам (сезон 0: так
    // у неё рекапы и мини-серии вроде «●● no Mahou»). Спецвыпуск — только
    // если база сама дала ему обычный сезон: «Фиц» у «Реинкарнации
    // безработного» в TMDB — первая серия второго сезона
    function numbered(f) {
        if (f.sp) return false;
        if (f.kind == 'tv' || f.kind == 'ona') return true;
        return f.kind == 'tv_special' && f.season > 0 && !f.sequel;
    }

    // Дата без времени («2026-10-02») — полночь UTC, как у TMDB и Shikimori
    function dayOf(str) {
        var m = String(str || '').match(/^(\d{4})-(\d\d)-(\d\d)/);
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : 0;
    }

    // ISO-строка с таймзоной -> ms (ручной парсер для старых WebKit)
    function parseISO(str) {
        if (!str) return 0;
        var m = String(str).match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?(?:([+-])(\d\d):?(\d\d)|Z)?/);
        if (!m) {
            var d = new Date(str);
            return isNaN(d.getTime()) ? 0 : d.getTime();
        }
        var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        if (m[7]) {
            var off = (+m[8]) * 60 + (+m[9]);
            if (m[7] == '+') ms -= off * 60000;
            else ms += off * 60000;
        }
        return ms;
    }

    var MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

    function formatDate(ms) {
        var d = new Date(ms);
        var now = new Date();
        var day = d.getDate() + ' ' + MONTHS_RU[d.getMonth()];
        var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        if (d.getDate() == now.getDate() && d.getMonth() == now.getMonth() && d.getFullYear() == now.getFullYear()) {
            return Lampa.Lang.translate('shikimori_today') + ' ' + hm;
        }
        var tomorrow = new Date(now.getTime() + 86400000);
        if (d.getDate() == tomorrow.getDate() && d.getMonth() == tomorrow.getMonth() && d.getFullYear() == tomorrow.getFullYear()) {
            return Lampa.Lang.translate('shikimori_tomorrow') + ' ' + hm;
        }
        return day;
    }

    var MONTHS_RU_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    var WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    var WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

    // Склонение: 1 серия, 2 серии, 5 серий
    function plural(n, forms) {
        var abs = Math.abs(n) % 100;
        var last = abs % 10;
        if (abs > 10 && abs < 20) return forms[2];
        if (last > 1 && last < 5) return forms[1];
        if (last == 1) return forms[0];
        return forms[2];
    }

    function dayKey(ms) {
        var d = new Date(ms);
        return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }

    function dayTitle(ms) {
        var d = new Date(ms);
        var now = new Date();
        if (dayKey(ms) == dayKey(now.getTime())) return Lampa.Lang.translate('shikimori_today_full');
        if (dayKey(ms) == dayKey(now.getTime() + 86400000)) return Lampa.Lang.translate('shikimori_tomorrow_full');
        return d.getDate() + ' ' + MONTHS_RU_FULL[d.getMonth()] + ', ' + WEEKDAYS_RU[d.getDay()];
    }

    // Текущий аниме-сезон вида summer_2026
    function currentSeason(shift) {
        var d = new Date();
        var m = d.getMonth() + (shift || 0) * 3;
        var y = d.getFullYear();
        while (m < 0) { m += 12; y--; }
        while (m > 11) { m -= 12; y++; }
        var names = ['winter', 'winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'fall', 'fall', 'fall'];
        return names[m] + '_' + y;
    }

    function seasonTitle(season) {
        var map = { winter: 'Зима', spring: 'Весна', summer: 'Лето', fall: 'Осень' };
        var p = String(season).split('_');
        return (map[p[0]] || p[0]) + ' ' + (p[1] || '');
    }

    // Простой join параллельных задач
    function makeJoin(count, done) {
        var left = count;
        var fired = false;
        return function () {
            left--;
            if (left <= 0 && !fired) {
                fired = true;
                done();
            }
        };
    }

    /* ============================================================
     * Сеть: собственный XHR-слой (ES5, отменяемый)
     * ============================================================ */

    function NetPool() {
        this.list = [];
        this.timers = [];
        this.gen = 0;   // поколение: clear() отменяет и уже назначенные повторы
    }

    // Запрос с повтором. У Shikimori жёсткий лимит (5 запросов в секунду),
    // и 429 там означает «подожди», а не «нельзя»: без повтора экран просто
    // оставался пустым — так пропадал календарь и сбрасывался каталог.
    // Повторяем только то, что имеет смысл повторять: лимит и 5xx
    NetPool.prototype.req = function (method, url, body, headers, ok, err, timeout) {
        var self = this;
        var gen = this.gen;
        var tries = 0;

        function send() {
            self.once(method, url, body, headers, function (data) {
                if (gen == self.gen && ok) ok(data);
            }, function (reason) {
                if (gen != self.gen) return;
                var again = reason == 429 || (typeof reason == 'number' && reason >= 500 && reason < 600);
                if (!again || tries >= RETRY_MAX) return err ? err(reason) : null;
                tries++;
                var timer = setTimeout(function () {
                    var at = self.timers.indexOf(timer);
                    if (at >= 0) self.timers.splice(at, 1);
                    if (gen == self.gen) send();
                }, RETRY_DELAY * tries);
                self.timers.push(timer);
            }, timeout);
        }

        send();
        return null;
    };

    NetPool.prototype.once = function (method, url, body, headers, ok, err, timeout) {
        var self = this;
        var xhr = new XMLHttpRequest();
        var finished = false;

        try {
            xhr.open(method, url, true);
        }
        catch (e) {
            if (err) err('open');
            return null;
        }

        xhr.timeout = timeout || 15000;

        if (headers) {
            for (var k in headers) {
                try { xhr.setRequestHeader(k, headers[k]); } catch (e) {}
            }
        }

        function finish(fn, arg) {
            if (finished) return;
            finished = true;
            var idx = self.list.indexOf(xhr);
            if (idx >= 0) self.list.splice(idx, 1);
            if (fn) fn(arg);
        }

        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                var data = null;
                try { data = JSON.parse(xhr.responseText); }
                catch (e) { return finish(err, 'parse'); }
                finish(ok, data);
            }
            else finish(err, xhr.status);
        };

        xhr.onerror = function () { finish(err, 'network'); };
        xhr.ontimeout = function () { finish(err, 'timeout'); };

        try {
            // Строку шлём как есть — это форма OAuth, объект сериализуем в JSON
            xhr.send(body ? (typeof body == 'string' ? body : JSON.stringify(body)) : null);
        }
        catch (e) {
            finish(err, 'send');
            return null;
        }

        this.list.push(xhr);
        return xhr;
    };

    NetPool.prototype.get = function (url, ok, err, timeout) {
        return this.req('GET', url, null, null, ok, err, timeout);
    };

    NetPool.prototype.post = function (url, body, ok, err) {
        return this.req('POST', url, body, { 'Content-Type': 'application/json' }, ok, err);
    };

    NetPool.prototype.clear = function () {
        this.gen++;
        for (var i = 0; i < this.list.length; i++) {
            try { this.list[i].abort(); } catch (e) {}
        }
        this.list = [];
        for (i = 0; i < this.timers.length; i++) clearTimeout(this.timers[i]);
        this.timers = [];
    };

    // Общий пул для фоновых задач (матчинг, обогащение карточек)
    var background_net = new NetPool();

    /* ============================================================
     * Shikimori API
     * ============================================================ */

    var Shiki = {
        base: function () {
            var proxy = storString('shikimori_proxy', '');
            return proxy ? proxy + SHIKI_BASE : SHIKI_BASE;
        },

        // GraphQL: строим запрос конкатенацией, значения экранируем JSON.stringify,
        // enum-значения берём только из собственных белых списков
        graphql: function (net, query, ok, err) {
            net.post(this.base() + '/api/graphql', { query: query }, function (json) {
                // Ошибку запроса Shikimori кладёт в errors, а data при этом null.
                // Раньше это выглядело как «в каталоге пусто», и понять, что
                // именно не понравилось серверу, было нельзя
                if (json && json.errors && json.errors.length) {
                    return err('graphql: ' + (json.errors[0].message || 'error'));
                }
                if (json && json.data) ok(json.data);
                else err('graphql');
            }, err);
        },

        animeFields: function () {
            return 'id malId name russian english japanese kind score status episodes episodesAired nextEpisodeAt season airedOn { year date } poster { originalUrl mainUrl }';
        },

        // Урезанный набор — для запросов по 50 id, чтобы не упереться в лимит сложности GraphQL
        animeFieldsSlim: function () {
            return 'id malId name russian kind score status episodes episodesAired airedOn { year date } poster { mainUrl }';
        },

        // Аргументы animes(...) из объекта фильтров
        animesArgs: function (params) {
            var args = [];
            args.push('limit: ' + (params.limit || 36));
            args.push('page: ' + (params.page || 1));
            if (params.order) args.push('order: ' + params.order); // enum, из белого списка
            if (params.kind) args.push('kind: ' + JSON.stringify(params.kind));
            if (params.duration) args.push('duration: ' + JSON.stringify(params.duration));
            if (params.rating) args.push('rating: ' + JSON.stringify(params.rating));
            if (params.status) args.push('status: ' + JSON.stringify(params.status));
            if (params.season) args.push('season: ' + JSON.stringify(params.season));
            if (params.genre) args.push('genre: ' + JSON.stringify(params.genre));
            if (params.score) args.push('score: ' + parseInt(params.score, 10));
            if (params.search) args.push('search: ' + JSON.stringify(params.search));
            if (!storBool('shikimori_uncensored', false)) args.push('censored: true');
            return args.join(', ');
        },

        catalog: function (net, params, ok, err) {
            var q = '{ animes(' + this.animesArgs(params) + ') { ' + this.animeFields() + ' } }';
            this.graphql(net, q, function (data) {
                ok(data.animes || []);
            }, err);
        },

        // Несколько лент одним запросом (алиасы)
        multiCatalog: function (net, blocks, ok, err) {
            var parts = [];
            for (var i = 0; i < blocks.length; i++) {
                parts.push(blocks[i].alias + ': animes(' + this.animesArgs(blocks[i].params) + ') { ' + this.animeFields() + ' }');
            }
            this.graphql(net, '{ ' + parts.join(' ') + ' }', ok, err);
        },

        // Все оценки пользователя одним плоским запросом REST v2
        // (без вложенных аниме — обходит лимит сложности GraphQL, отдаёт все статусы)
        userRatesFlat: function (net, user_id, ok, err) {
            net.get(this.base() + '/api/v2/user_rates?user_id=' + parseInt(user_id, 10) + '&target_type=Anime', function (list) {
                if (!list || Object.prototype.toString.call(list) !== '[object Array]') return err('rates');
                ok(list);
            }, err);
        },

        // Карточки аниме по списку id (GraphQL, чанками по 50)
        animesByIds: function (net, ids, ok, err) {
            var self = this;
            var result = [];
            var offset = 0;

            function nextChunk() {
                if (offset >= ids.length) return ok(result);
                var part = ids.slice(offset, offset + 50);
                offset += 50;
                var q = '{ animes(ids: ' + JSON.stringify(part.join(',')) + ', limit: 50) { ' + self.animeFieldsSlim() + ' } }';
                self.graphql(net, q, function (data) {
                    var list = data.animes || [];
                    for (var i = 0; i < list.length; i++) result.push(list[i]);
                    nextChunk();
                }, err);
            }

            if (!ids.length) return ok([]);
            nextChunk();
        },

        // Связи тайтлов — предыдущий и следующий сезоны. Нужны там, где
        // база соответствий ещё не знает новый сезон: в TMDB он живёт в том
        // же сериале, что и прошлый, а закладке на сериал нужен именно новый
        // сезон, чтобы следить за его сериями. Глубина запроса у Shikimori
        // ограничена пятью уровнями, поэтому у связанного тайтла — только
        // плоские поля
        related_memo: {},

        // Память о связях не растёт без конца: за долгий вечер у телевизора
        // в ней оказывалось всё, что открывали
        pruneRelated: function (now) {
            var keys = [];
            for (var k in this.related_memo) keys.push(k);
            if (keys.length < RELATED_MEMO_MAX) return;
            for (var i = 0; i < keys.length; i++) {
                if (now - this.related_memo[keys[i]].time >= RELATED_TTL) delete this.related_memo[keys[i]];
            }
        },

        related: function (net, ids, ok, err) {
            var self = this;
            var result = {};
            var offset = 0;
            var now = Date.now();
            var need = [];

            // Связи меняются редко, а спрашиваются при каждом показе главной
            // и каждом пересчёте счётчика — держим их в памяти полчаса. Но
            // вместе со связями приходит и эфир: вышла серия, которую запись
            // ждала, — запись устарела, иначе карточка показывала бы
            // «Следующая серия: сегодня 17:30» и после 17:30
            for (var n = 0; n < ids.length; n++) {
                var memo = this.related_memo[ids[n]];
                var aired = memo && memo.data.nextEpisodeAt && parseISO(memo.data.nextEpisodeAt) <= now;
                if (memo && now - memo.time < RELATED_TTL && !aired) result[ids[n]] = memo.data;
                else need.push(ids[n]);
            }
            ids = need;
            this.pruneRelated(now);

            function nextChunk() {
                if (offset >= ids.length) return ok(result);
                var part = ids.slice(offset, offset + 50);
                offset += 50;
                var q = '{ animes(ids: ' + JSON.stringify(part.join(',')) + ', limit: 50) { id malId name score kind status episodes episodesAired ' +
                        'nextEpisodeAt airedOn { year date } related { relationKind anime { id name kind status } } } }';
                self.graphql(net, q, function (data) {
                    var list = data.animes || [];
                    for (var i = 0; i < list.length; i++) {
                        var id = parseInt(list[i].malId || list[i].id, 10);
                        if (!id) continue;
                        result[id] = list[i];
                        self.related_memo[id] = { data: list[i], time: Date.now() };
                    }
                    nextChunk();
                }, function (reason) {
                    // Что успели и что было в памяти — отдаём: без связей часть
                    // закладок просто останется без нового сезона, это не повод
                    // терять остальное
                    // Устаревшая память лучше, чем ничего: связи не меняются, а эфир
                    // уточнится при следующем ответе
                    for (var m = 0; m < ids.length; m++) {
                        var old = self.related_memo[ids[m]];
                        if (old && !result[ids[m]]) result[ids[m]] = old.data;
                    }
                    var any = false;
                    for (var k in result) { any = true; break; }
                    if (any) return ok(result);
                    err(reason);
                });
            }

            if (!ids.length) return ok(result);
            nextChunk();
        },

        // Все названия одного тайтла вместе со связями. Карточки календаря
        // и ленты Kodik приходят без английского и японского названий,
        // а искать в TMDB без них — почти наугад
        titles: function (net, id, ok, err) {
            var q = '{ animes(ids: ' + JSON.stringify(String(id)) + ', limit: 1) { id malId name russian english japanese synonyms ' +
                    'kind status episodes airedOn { year } related { relationKind anime { id name kind status } } } }';
            this.graphql(net, q, function (data) {
                ok((data.animes || [])[0] || null);
            }, err);
        },

        // Поиск по названию: для закладок, которых ещё нет в базе соответствий
        search: function (net, query, kinds, ok, err) {
            var q = '{ animes(search: ' + JSON.stringify(String(query)) + ', limit: 10' +
                    (kinds ? ', kind: ' + JSON.stringify(kinds) : '') +
                    ') { id malId name russian english japanese synonyms kind status episodes episodesAired airedOn { year } } }';
            this.graphql(net, q, function (data) {
                ok(data.animes || []);
            }, err);
        },

        userId: function (net, nickname, ok, err) {
            var cached = storGet('shikimori_user_id', null);
            if (cached && cached.nick === nickname && cached.id) return ok(cached.id);
            net.get(this.base() + '/api/users/' + encodeURIComponent(nickname) + '?is_nickname=1', function (user) {
                if (user && user.id) {
                    storSet('shikimori_user_id', { nick: nickname, id: user.id });
                    ok(user.id);
                }
                else err('user');
            }, err);
        },

        calendar: function (net, ok, err) {
            var self = this;
            var cached = storGet('shikimori_calendar_cache', null);
            if (cached && cached.time && Date.now() - cached.time < CALENDAR_TTL && cached.data && cached.data.length) {
                return ok(cached.data);
            }
            net.get(this.base() + '/api/calendar', function (list) {
                var slim = self.calendarSlim(list || []);
                // Пустой ответ — это тоже отказ: онгоингов не бывает ноль
                if (!slim.length) return self.calendarGraphql(net, ok, err, 'empty');
                self.calendarRemember(slim);
                ok(slim);
            }, function (reason) {
                self.calendarGraphql(net, ok, err, reason);
            });
        },

        // Ответ REST-календаря -> то, что нужно экрану. Храним только это:
        // календарь целиком большой, а в Storage он лежит сутками
        calendarSlim: function (list) {
            var slim = [];
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                if (!e || !e.anime || !e.next_episode_at) continue;
                slim.push({
                    episode: e.next_episode,
                    at: parseISO(e.next_episode_at),
                    anime: {
                        id: e.anime.id,
                        name: e.anime.name,
                        russian: e.anime.russian,
                        image: e.anime.image && e.anime.image.original ? e.anime.image.original : '',
                        kind: e.anime.kind,
                        score: e.anime.score,
                        status: e.anime.status,
                        episodes: e.anime.episodes,
                        episodes_aired: e.anime.episodes_aired
                    }
                });
            }
            return slim;
        },

        calendarRemember: function (slim) {
            storSet('shikimori_calendar_cache', { time: Date.now(), data: slim });
        },

        // Запасной календарь через GraphQL. /api/calendar — единственная точка,
        // и когда она молчит (лимит запросов, прокси, временный отказ), экран
        // раньше оставался пустым без единого слова. Даты ближайших серий есть
        // и у самих тайтлов — nextEpisodeAt, этого достаточно
        calendarGraphql: function (net, ok, err, reason) {
            var self = this;
            var rows = [];
            var page = 1;

            function ask() {
                var q = '{ animes(' + self.animesArgs({ limit: 50, page: page, status: 'ongoing', order: 'popularity' }) +
                        ') { ' + self.animeFields() + ' } }';
                self.graphql(net, q, function (data) {
                    var list = data.animes || [];
                    rows = rows.concat(list);
                    page++;
                    if (list.length >= 50 && page <= 2) return ask();
                    finish();
                }, finish);
            }

            function finish() {
                var slim = [];
                for (var i = 0; i < rows.length; i++) {
                    var anime = rows[i];
                    var at = parseISO(anime.nextEpisodeAt);
                    if (!at) continue;
                    slim.push({
                        episode: (parseInt(anime.episodesAired, 10) || 0) + 1,
                        at: at,
                        anime: {
                            id: parseInt(anime.malId || anime.id, 10),
                            name: anime.name,
                            russian: anime.russian,
                            image: '',
                            poster_url: anime.poster ? (anime.poster.mainUrl || anime.poster.originalUrl || '') : '',
                            kind: anime.kind,
                            score: anime.score,
                            status: anime.status,
                            episodes: anime.episodes,
                            episodes_aired: anime.episodesAired
                        }
                    });
                }
                if (!slim.length) return err(reason || 'calendar');
                self.calendarRemember(slim);
                ok(slim);
            }

            ask();
        },

        // Жанры, темы и демография одним запросом. REST /api/genres отдаёт
        // только жанры, темы там просто нет — а их у Shikimori больше полусотни
        genresAll: function (net, ok, err) {
            var cached = storGet('shikimori_genres_cache', null);
            if (cached && cached.time && Date.now() - cached.time < GENRES_TTL && cached.list && cached.list.length) {
                return ok(cached.list);
            }

            this.graphql(net, '{ genres(entryType: Anime) { id name russian kind } }', function (data) {
                var raw = data.genres || [];
                var list = [];
                for (var i = 0; i < raw.length; i++) {
                    if (!raw[i] || !raw[i].id) continue;
                    list.push({
                        id: raw[i].id,
                        kind: raw[i].kind,
                        title: raw[i].russian || raw[i].name
                    });
                }
                list.sort(function (a, b) { return a.title > b.title ? 1 : -1; });
                storSet('shikimori_genres_cache', { time: Date.now(), list: list });
                ok(list);
            }, function () {
                if (cached && cached.list) return ok(cached.list);
                err('genres');
            });
        },

        details: function (net, mal_id, ok, err) {
            net.get(this.base() + '/api/animes/' + mal_id, ok, err);
        },

        posterUrl: function (anime) {
            if (anime.poster_url) return anime.poster_url;
            if (anime.poster && (anime.poster.originalUrl || anime.poster.mainUrl)) {
                return anime.poster.originalUrl || anime.poster.mainUrl;
            }
            var img = anime.image || '';
            if (typeof img == 'object') img = img.original || '';
            if (img && img.indexOf('missing_') == -1) {
                return img.indexOf('http') == 0 ? img : SHIKI_BASE + img;
            }
            return SHIKI_BASE + '/system/animes/original/' + (anime.id || '0') + '.jpg';
        }
    };

    /* ============================================================
     * Kodik — серии, которые уже доступны с русской озвучкой
     * ------------------------------------------------------------
     * Shikimori даёт дату эфира в Японии, а не «можно посмотреть с озвучкой».
     * Kodik ищет напрямую по shikimori_id и отдаёт last_episode по каждой студии.
     * Ограничения API (проверены живьём):
     *   - OPTIONS-преflight отвечает 500 -> только простой GET без своих заголовков;
     *   - ответы с ошибкой приходят без CORS, в браузере это неотличимо от сетевого
     *     сбоя -> любая неудача трактуется как «токен мёртв, пробуем следующий»;
     *   - limit жёстко ограничен сотней, next_page — готовый абсолютный адрес,
     *     лента отсортирована по updated_at и листается курсором;
     *   - /list и /search принимают translation_id списком через запятую;
     *   - /translations (первая версия) отдаёт голый массив без results,
     *     словарь с числом озвучек — /translations/v2.
     * ============================================================ */

    // Одна и та же студия в данных Kodik пишется по-разному, а после
    // переименования AniLibria в AniLiberty встречаются оба имени
    var STUDIO_ALIASES = {
        anilibria: 'aniliberty',
        anilibriatv: 'aniliberty',
        anilibertytv: 'aniliberty'
    };

    var Kodik = {
        feed_cache: null,
        feed_time: 0,
        gap: false,
        token_index: 0,
        active_token: '',

        host: function () {
            var host = storString('shikimori_kodik_host', KODIK_HOST);
            return host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        },

        // Свой токен из настроек — первым, встроенный пул — резервом
        tokens: function () {
            var own = storString('shikimori_kodik_token', '');
            var list = own ? [own] : [];
            for (var i = 0; i < KODIK_TOKENS.length; i++) {
                if (KODIK_TOKENS[i] != own) list.push(KODIK_TOKENS[i]);
            }
            return list;
        },

        enabled: function () {
            return storBool('shikimori_kodik', true);
        },

        withSubtitles: function () {
            return storBool('shikimori_kodik_subs', false);
        },

        // Предпочитаемые студии (названия). Пусто — засчитываем любую озвучку
        studios: function () {
            var list = storGet('shikimori_studios', []);
            return Object.prototype.toString.call(list) == '[object Array]' ? list : [];
        },

        // Ключ студии для сравнения: регистр, точки и «.TV» в названии
        // не должны решать, засчитана серия или нет
        studioKey: function (title) {
            var key = String(title || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-я]+/g, '');
            return STUDIO_ALIASES[key] || key;
        },

        // Набор ключей выбранных студий; null — выбрана любая озвучка
        allowedKeys: function () {
            var list = this.studios();
            if (!list.length) return null;
            var keys = {};
            for (var i = 0; i < list.length; i++) keys[this.studioKey(list[i])] = true;
            return keys;
        },

        // Словарь студий из кэша: [{title, count, ids}]
        dictionary: function () {
            var cached = storGet('shikimori_translations', null);
            var list = cached && cached.list;
            return list && list.length && list[0].ids ? list : [];
        },

        // Номера выбранных студий в Kodik. По ним лента фильтруется на
        // сервере: двести строк ленты — это двести серий ваших студий,
        // а не всех подряд. Раньше лента была общей, и студии отсеивались
        // уже у нас: выбранной студии в суточной ленте могло не оказаться
        // вовсе, и выглядело это так, будто выбор не работает.
        // Пустой список — фильтровать на сервере нельзя: номер хотя бы одной
        // выбранной студии неизвестен, и её серии пропали бы
        studioIds: function () {
            var chosen = this.studios();
            if (!chosen.length) return [];

            var dict = this.dictionary();
            var own = storGet('shikimori_studio_ids', {}) || {};
            var ids = [];

            for (var i = 0; i < chosen.length; i++) {
                var key = this.studioKey(chosen[i]);
                var found = (own[chosen[i]] || []).slice(0);
                for (var j = 0; j < dict.length; j++) {
                    if (this.studioKey(dict[j].title) == key) found = found.concat(dict[j].ids || []);
                }
                if (!found.length) return [];
                for (j = 0; j < found.length; j++) {
                    var id = parseInt(found[j], 10);
                    if (id && ids.indexOf(id) < 0) ids.push(id);
                }
            }

            ids.sort(function (a, b) { return a - b; });
            return ids;
        },

        // Полный список студий Kodik, самые ходовые сверху, с номерами.
        // Раньше запрос шёл в /translations: он отдаёт голый массив, а плагин
        // ждал results — ответ считался ошибкой, по очереди перебирались все
        // токены, и словарь не загружался никогда. Выбирать оставалось из
        // студий, случайно попавших в суточную ленту
        translations: function (net, ok) {
            var self = this;
            var subs = this.withSubtitles();
            var cached = storGet('shikimori_translations', null);
            if (cached && cached.time && Date.now() - cached.time < TRANSLATIONS_TTL &&
                cached.subs === subs && this.dictionary().length) return ok(cached.list);

            var params = '&types=anime-serial,anime&sort=count' + (subs ? '' : '&translation_type=voice');

            this.request(net, '/translations/v2', params, function (json) {
                var rows = json.results || [];
                var by = {};
                var list = [];
                for (var i = 0; i < rows.length; i++) {
                    var row = rows[i];
                    if (!row || !row.title) continue;
                    var title = String(row.title);
                    if (!by[title]) {
                        by[title] = { title: title, count: 0, ids: [] };
                        list.push(by[title]);
                    }
                    by[title].count += parseInt(row.count, 10) || 0;
                    var id = parseInt(row.id, 10);
                    if (id && by[title].ids.indexOf(id) < 0) by[title].ids.push(id);
                }
                // По числу озвучек: сверху те, кого человек реально встречает
                list.sort(function (a, b) { return b.count - a.count; });
                if (list.length) storSet('shikimori_translations', { time: Date.now(), subs: subs, list: list });
                ok(list);
            }, function () {
                ok(self.dictionary());
            });
        },

        // Студии, которые встречаются в ваших данных: ими дополняем общий
        // словарь и ими же обходимся, если Kodik его не отдал
        knownStudios: function () {
            var seen = {};
            var list = [];

            function add(title, id) {
                if (!title) return;
                if (!seen[title]) {
                    seen[title] = { title: title, count: 0, ids: [] };
                    list.push(seen[title]);
                }
                id = parseInt(id, 10);
                if (id && seen[title].ids.indexOf(id) < 0) seen[title].ids.push(id);
            }

            var rows = this.feed_cache || [];
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].translation) add(rows[i].translation.title, rows[i].translation.id);
            }
            var store = this.store();
            for (var key in store) {
                if (store[key] && store[key].studio) add(store[key].studio, store[key].tid);
            }
            var chosen = this.studios();
            for (i = 0; i < chosen.length; i++) add(chosen[i]);

            list.sort(function (a, b) { return a.title > b.title ? 1 : -1; });
            return list;
        },

        request: function (net, path, params, ok, err) {
            var self = this;
            var tokens = this.tokens();
            var base = this.token_index;
            var attempt = 0;

            function tryToken() {
                if (attempt >= tokens.length) return err('kodik_dead');
                var index = (base + attempt) % tokens.length;
                attempt++;
                var url = 'https://' + self.host() + path +
                    '?token=' + encodeURIComponent(tokens[index]) + params;
                net.get(url, function (json) {
                    if (json && json.results) {
                        self.token_index = index;
                        self.active_token = tokens[index];
                        ok(json);
                    }
                    else tryToken();
                }, tryToken);
            }

            tryToken();
        },

        // Условия ленты. Статус тайтла намеренно не ограничиваем: последние
        // серии сезона озвучивают уже после того, как эфир в Японии кончился
        // и Shikimori перевёл тайтл в «вышло». С фильтром по онгоингам эти
        // серии не попадали в ленту никогда
        listParams: function () {
            var params = '&types=anime-serial&sort=updated_at&order=desc&limit=100&with_material_data=true';
            if (!this.withSubtitles()) params += '&translation_type=voice';
            var ids = this.studioIds();
            if (ids.length) params += '&translation_id=' + ids.join(',');
            return params;
        },

        // Подпись условий: сменились студии или субтитры — прежняя точка
        // сверки не годится, начинаем заново
        signature: function () {
            return (this.withSubtitles() ? 's' : 'v') + '|' + this.studioIds().join(',') + '|' + this.studios().join(',');
        },

        // Номера выбранных студий берутся из словаря Kodik. Выбор мог быть
        // сделан, пока словарь ещё не загрузился (или прежней версией, где он
        // не грузился вовсе), — тогда сперва подтягиваем словарь
        prepare: function (net, done) {
            if (!this.studios().length || this.studioIds().length) return done();
            this.translations(net, function () { done(); });
        },

        // Лента обновлений. Раньше каждый раз брались две свежие страницы,
        // и всё, что случилось между заходами в приложение, проходило мимо:
        // серия, вышедшая вчера днём, сегодня вечером в ленту уже не попадала,
        // а больше нигде новой не считалась. Теперь помним, до какого момента
        // лента просмотрена, и листаем её, пока не дойдём до виденного
        feed: function (net, ok, err) {
            var self = this;
            if (this.feed_cache && Date.now() - this.feed_time < KODIK_TTL) return ok(this.feed_cache);

            this.prepare(net, function () {
                var sig = self.signature();
                var sync = storGet('shikimori_kodik_sync', null);
                var same = !!(sync && sync.sig == sig && sync.at);
                // С запасом в десять минут: строки с одинаковым временем
                // могут лечь по разные стороны границы страницы
                var since = same ? sync.at - 10 * 60000 : 0;
                var limit = since ? KODIK_SYNC_PAGES : KODIK_PAGES;
                var rows = [];
                var newest = 0;
                var reached = false;

                function take(json) {
                    var list = (json && json.results) || [];
                    for (var i = 0; i < list.length; i++) {
                        rows.push(list[i]);
                        var at = parseISO(list[i].updated_at);
                        if (at > newest) newest = at;
                        if (since && at && at <= since) reached = true;
                    }
                }

                function page(next_url, depth) {
                    if (reached || !next_url) return finish(true);
                    if (depth >= limit) return finish(false);
                    if (next_url.indexOf('token=') == -1 && self.active_token) {
                        next_url += (next_url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(self.active_token);
                    }
                    net.get(next_url, function (json) {
                        take(json);
                        page(json && json.next_page, depth + 1);
                    }, function () {
                        finish(false);
                    });
                }

                function finish(complete) {
                    // До виденного не дошли — что-то могло пройти мимо.
                    // Отслеживаемое тогда перепроверяется точечно
                    self.gap = !!since && !complete;
                    self.feed_cache = rows;
                    self.feed_time = Date.now();
                    if (newest) storSet('shikimori_kodik_sync', { at: Math.max(newest, same ? sync.at : 0), sig: sig });
                    ok(rows);
                }

                self.request(net, '/list', self.listParams(), function (json) {
                    take(json);
                    page(json.next_page, 1);
                }, err);
            });
        },

        // Точечные запросы по конкретным тайтлам: то, чего не было в ленте,
        // и то, что давно не перепроверялось. Идут параллельно, но понемногу
        lookup: function (net, ids, ok) {
            var self = this;
            var result = {};
            var checked = [];
            var queue = ids.slice(0, KODIK_LOOKUP_MAX);
            var index = 0;
            var running = 0;
            var done = false;

            function next() {
                while (running < KODIK_LOOKUP_PARALLEL && index < queue.length) ask(queue[index++]);
                if (!running && index >= queue.length && !done) {
                    done = true;
                    ok(result, checked);
                }
            }

            function ask(sid) {
                running++;
                var params = '&shikimori_id=' + sid + '&with_material_data=true&limit=100' +
                    (self.withSubtitles() ? '' : '&translation_type=voice');
                self.request(net, '/search', params, function (json) {
                    var merged = self.mergeRows(json.results || []);
                    for (var key in merged) result[key] = merged[key];
                    checked.push(sid);
                    running--;
                    next();
                }, function () {
                    running--;
                    next();
                });
            }

            next();
            // Что уже пришло — видно и до конца: главная не ждёт всех ответов
            return { result: result, checked: checked };
        },

        // Живая ли озвучка. У выходящего — всегда. У вышедшего — если эфир
        // кончился недавно или студия взялась за тайтл недавно: иначе свежая
        // дата строки означает перезаливку давно озвученного, а не новую серию
        live: function (row) {
            var data = row.material_data || {};
            if (data.anime_status != 'released') return true;
            var recent = Date.now() - 180 * 86400000;
            return parseISO(data.released_at) >= recent || parseISO(row.created_at) >= recent;
        },

        // Строка Kodik = (тайтл × студия). Схлопываем в одну запись на тайтл:
        // больше серий важнее, при равенстве озвучка важнее субтитров.
        mergeRows: function (rows) {
            var map = {};
            var allowed = this.allowedKeys();
            var subs = this.withSubtitles();

            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var sid = parseInt(row.shikimori_id, 10);
                // episodes_count — сколько серий у студии, а не номер серии; нужен last_episode
                var ep = parseInt(row.last_episode, 10) || 0;
                if (!sid || !ep) continue;

                var studio = (row.translation && row.translation.title) || '';
                if (allowed && !allowed[this.studioKey(studio)]) continue;

                var voice = !row.translation || row.translation.type != 'subtitles';
                // Лента спрашивается с translation_type=voice, а точечный поиск раньше — нет,
                // поэтому субтитровая раздача с большим числом серий выигрывала у озвучки
                if (!voice && !subs) continue;

                var key = 's' + sid;
                var prev = map[key];
                // Озвучка важнее субтитров всегда, число серий сравниваем только внутри типа
                if (prev) {
                    if (prev.voice && !voice) continue;
                    if (!(voice && !prev.voice) && ep <= prev.ep) continue;
                }

                map[key] = {
                    sid: sid,
                    ep: ep,
                    voice: voice,
                    studio: studio,
                    tid: (row.translation && parseInt(row.translation.id, 10)) || 0,
                    at: parseISO(row.updated_at),
                    aired: (row.material_data && parseInt(row.material_data.episodes_aired, 10)) || 0,
                    live: this.live(row)
                };
            }
            return map;
        },

        // Постоянное хранилище: что мы уже знаем про каждый тайтл.
        // Читается на каждой карточке каталога, поэтому держим разобранным
        store_memo: null,

        store: function () {
            if (this.store_memo) return this.store_memo;
            var store = storGet('shikimori_kodik_eps', {});
            this.store_memo = store && typeof store == 'object' ? store : {};
            return this.store_memo;
        },

        // Что известно про конкретный тайтл: null, если озвученных серий не знаем
        known: function (sid) {
            var rec = sid ? this.store()['s' + sid] : null;
            return rec && rec.ep ? rec : null;
        },

        // fresh — найденное в ленте и точечных запросах, checked — номера
        // тайтлов, про которые мы только что спросили Kodik напрямую
        remember: function (fresh, checked) {
            var store = this.store();
            var now = Date.now();
            var changed = false;

            for (var key in fresh) {
                var next = fresh[key];
                var prev = store[key];
                // at — момент, когда серий стало больше. Переоцифровка тайтла тоже
                // двигает updated_at, но новой серией не является
                if (prev && prev.ep && next.ep <= prev.ep) {
                    if (next.aired > (prev.aired || 0)) {
                        prev.aired = next.aired;
                        changed = true;
                    }
                    continue;
                }
                store[key] = {
                    sid: next.sid,
                    ep: next.ep,
                    base: prev && prev.ep ? prev.base : next.ep,
                    studio: next.studio,
                    tid: next.tid || 0,
                    voice: next.voice,
                    // Тайтл, встреченный впервые на перезаливке давно озвученного:
                    // число серий запоминаем, а свежей озвучкой не считаем
                    at: prev && prev.ep ? next.at : (next.live === false ? 0 : next.at),
                    aired: next.aired,
                    checked: (prev && prev.checked) || 0
                };
                changed = true;
            }

            // «Проверено» ставим и тем, у кого серий не прибавилось, и тем, где
            // озвучки нет вовсе: спрашивать о них снова раньше срока незачем
            for (var i = 0; checked && i < checked.length; i++) {
                var ck = 's' + checked[i];
                if (store[ck]) store[ck].checked = now;
                else store[ck] = { sid: checked[i], ep: 0, base: 0, at: 0, checked: now };
                changed = true;
            }

            var keys = [];
            for (var k in store) keys.push(k);
            if (keys.length > KODIK_STORE_MAX) {
                keys.sort(function (a, b) {
                    return Math.max(store[a].at || 0, store[a].checked || 0) -
                           Math.max(store[b].at || 0, store[b].checked || 0);
                });
                for (i = 0; i < keys.length - KODIK_STORE_MAX; i++) delete store[keys[i]];
                changed = true;
            }

            if (changed) storSet('shikimori_kodik_eps', store);
            this.store_memo = store;
            return store;
        },

        // Всё, что знаем о тайтлах, сбрасывается вместе с точкой сверки:
        // иначе после смены студий лента продолжила бы с прежнего места
        // и не узнала бы о сериях, озвученных до этого момента
        reset: function () {
            storSet('shikimori_kodik_eps', {});
            storSet('shikimori_kodik_sync', null);
            this.dropCache();
        },

        dropCache: function () {
            this.feed_cache = null;
            this.feed_time = 0;
            this.store_memo = null;
        }
    };

    /* ============================================================
     * Скрытые тайтлы: «Не интересует»
     * ============================================================ */

    var Hidden = {
        // Список читается на каждой карточке, а Storage каждый раз разбирает JSON —
        // держим разобранным, как и накопленные серии Kodik
        memo: null,

        all: function () {
            if (this.memo) return this.memo;
            var map = storGet('shikimori_hidden', {});
            this.memo = map && typeof map == 'object' ? map : {};
            return this.memo;
        },

        save: function (map) {
            this.memo = map;
            storSet('shikimori_hidden', map);
        },

        // Один и тот же тайтл приходит тремя путями: карточкой Shikimori (id),
        // строкой Kodik (shikimori_id) и закладкой Lampa (id TMDB). Раньше
        // скрытие умело только средний случай, поэтому в каталоге пункта
        // «Не интересует» не было вовсе, а скрытое всё равно показывалось.
        // Поэтому у карточки есть НАБОР ключей, и совпадения любого хватает
        keys: function (card) {
            var keys = [];
            if (!card) return keys;

            function add(prefix, value) {
                var id = parseInt(value, 10);
                if (!id) return;
                var key = prefix + id;
                if (keys.indexOf(key) < 0) keys.push(key);
            }

            if (card._kodik) add('s', card._kodik.sid);
            if (card._sids) for (var i = 0; i < card._sids.length; i++) add('s', card._sids[i]);
            if (!isTmdbCard(card)) {
                add('s', card.id);
                add('s', card.malId);
            }
            else add('t', card.id);
            if (card._direct_tmdb) add('t', card._direct_tmdb.id);
            return keys;
        },

        has: function (sid) {
            return !!this.all()['s' + parseInt(sid, 10)];
        },

        hasCard: function (card) {
            var keys = this.keys(card);
            var map = this.all();
            for (var i = 0; i < keys.length; i++) if (map[keys[i]]) return true;
            return false;
        },

        // Скрываем по всем ключам разом: карточка того же тайтла в другой
        // строке придёт с другим идентификатором, и по одному ключу мы бы
        // её не узнали. Название храним тут же — иначе список скрытого
        // нечем подписать, пока Shikimori не ответит
        toggleCard: function (card, title) {
            var keys = this.keys(card);
            if (!keys.length) return false;

            var map = this.all();
            var hide = !this.hasCard(card);

            for (var i = 0; i < keys.length; i++) {
                if (hide) map[keys[i]] = { at: Date.now(), title: title || '', group: keys[0] };
                else delete map[keys[i]];
            }
            this.save(map);
            return hide;
        },

        // Вернуть тайтл: снимаем всю группу ключей, которой его прятали
        drop: function (key) {
            var map = this.all();
            var rec = map[key];
            var group = rec && typeof rec == 'object' ? rec.group : '';
            delete map[key];
            if (group) {
                for (var other in map) {
                    var item = map[other];
                    if (item && typeof item == 'object' && item.group == group) delete map[other];
                }
            }
            this.save(map);
        }
    };

    /* ============================================================
     * «Просмотрено» — своя отметка плагина
     * ------------------------------------------------------------
     * Отметки Lampa пишутся хешем от сезона, серии и оригинального
     * названия, и угадать их можно не всегда: у тайтла из списка Shikimori
     * оригинального названия TMDB нет вовсе, а у закладки сезон из
     * закладки отстаёт от настоящего. Отмеченное «всё просмотрено»
     * возвращалось после перезапуска. Поэтому плагин помнит сам: сколько
     * серий было доступно, когда тайтл отметили. Выйдет новая — тайтл
     * вернётся, как и должен
     * ============================================================ */

    var Seen = {
        memo: null,

        all: function () {
            if (this.memo) return this.memo;
            var map = storGet('shikimori_seen', {});
            this.memo = map && typeof map == 'object' ? map : {};
            return this.memo;
        },

        get: function (sid) {
            var rec = sid ? this.all()['s' + parseInt(sid, 10)] : null;
            return rec ? (rec.ep || 0) : 0;
        },

        // undo — что отметка сделала в самой Lampa: отметки серий, которых до неё
        // не было (h), и метка «Просмотрено» на закладке (v). Снимая отметку,
        // откатываем ровно это — иначе закладка так и оставалась спрятанной
        mark: function (sid, ep, undo) {
            sid = parseInt(sid, 10);
            if (!sid || !ep) return;
            var map = this.all();
            var prev = map['s' + sid];
            var rec = { ep: ep, at: Date.now() };
            // Повторная отметка не теряет то, что откатывать после прошлой
            var h = (prev && prev.u && prev.u.h || []).concat(undo && undo.h || []);
            if (h.length > SEEN_UNDO_MAX) h = h.slice(h.length - SEEN_UNDO_MAX);
            var v = (undo && undo.v) || (prev && prev.u && prev.u.v) || null;
            if (h.length || v) rec.u = { h: h, v: v };
            map['s' + sid] = rec;
            var keys = [];
            for (var k in map) keys.push(k);
            if (keys.length > 500) {
                keys.sort(function (a, b) { return (map[a].at || 0) - (map[b].at || 0); });
                for (var i = 0; i < keys.length - 500; i++) delete map[keys[i]];
            }
            storSet('shikimori_seen', map);
        },

        // Отметку плагина можно снять: случайное «Отметить все» иначе прятало
        // тайтл до выхода следующей серии, и вернуть его было нечем.
        // Возвращает запись — в ней то, что нужно откатить в Lampa
        take: function (sid) {
            sid = parseInt(sid, 10);
            var map = this.all();
            var rec = sid ? map['s' + sid] : null;
            if (!rec) return null;
            delete map['s' + sid];
            storSet('shikimori_seen', map);
            return rec;
        },

        reset: function () {
            this.memo = {};
            storSet('shikimori_seen', {});
        }
    };

    // Сериал ли номер TMDB из сопоставления. Вид известен — по нему; не
    // известен (так база соответствий отвечает про ONA и спецвыпуски) —
    // по виду тайтла Shikimori: фильм и OVA могли оказаться фильмом TMDB
    function isSeries(hit, kind) {
        if (hit.media) return hit.media == 'tv';
        return SERIES_KINDS.indexOf(kind) >= 0;
    }

    // Тайтл Shikimori, по которому считаются серии карточки: у закладки —
    // сезон, где вышла озвучка, у карточки Shikimori — она сама
    function cardSid(data) {
        if (data._kodik && data._kodik.sid) return parseInt(data._kodik.sid, 10);
        if (!isTmdbCard(data)) return parseInt(data.malId || data.id, 10) || 0;
        return 0;
    }

    // Сколько серий у карточки сейчас доступно — столько и считаем просмотренными
    function cardEpisodes(data) {
        var sid = cardSid(data);
        var known = Kodik.known(sid);
        return data._total_ep || (known ? countAvailable(known, data.episodesAired) : 0) ||
            parseInt(data.episodesAired, 10) || parseInt(data.episodes, 10) || 0;
    }

    // Убрать карточку из строки, не потеряв пульт. Если спрятать карточку,
    // на которой стоит фокус, Lampa продолжает держать его на невидимом
    // элементе: стрелки внутри экрана перестают работать, а меню слева и
    // шапка — нет. Поэтому сперва уводим фокус на соседа, потом убираем
    function dropCard(el) {
        if (!el || !el.parentNode) return;
        try {
            if (el.classList.contains('focus')) {
                var dirs = ['right', 'left', 'down', 'up'];
                for (var i = 0; i < dirs.length; i++) {
                    if (Navigator.canmove(dirs[i])) { Navigator.move(dirs[i]); break; }
                }
            }
        }
        catch (e) {}
        el.parentNode.removeChild(el);
    }

    // Карточка TMDB или Shikimori — от этого зависит и вид карточки, и то,
    // каким идентификатором тайтл вообще опознаётся
    function isTmdbCard(data) {
        return !!(data.poster_path || data.backdrop_path || data.first_air_date ||
                  data.release_date || data._tmdb_card);
    }

    /* ============================================================
     * Ник Shikimori
     * ------------------------------------------------------------
     * Токенов и OAuth здесь нет намеренно. Записывать прогресс обратно
     * в Shikimori смысла нет: он и так весь в Lampa, а подключение
     * требовало двух строк по 43 символа, которые на телевизор не внести.
     * Ник нужен только для чтения публичных списков: он даёт точное
     * «просмотрено», которого нет в отметках Lampa, если смотрели не в ней.
     * ============================================================ */

    function accountScreen() {
        askNickname();
    }

    // Адрес, по которому загружен сам плагин: в инструкции должен стоять
    // не абстрактный пример, а то, что человек реально вписывал в Lampa
    function selfUrl() {
        try {
            var list = document.getElementsByTagName('script');
            for (var i = list.length - 1; i >= 0; i--) {
                if (list[i].src && list[i].src.indexOf('shikimori') >= 0) return list[i].src.split('?')[0];
            }
        }
        catch (e) {}
        return '';
    }

    // Скрытые тайтлы: карточки в строках больше нет, значит и долгим нажатием
    // её не вернуть — список нужен отдельным экраном в настройках
    function pickHidden() {
        var map = Hidden.all();
        var rows = [];
        var need = [];

        for (var key in map) {
            var rec = map[key];
            // Ключи одного тайтла лежат группой — показываем только первый
            if (rec && typeof rec == 'object' && rec.group && rec.group != key) continue;
            var title = rec && typeof rec == 'object' ? (rec.title || '') : '';
            rows.push({ key: key, title: title });
            if (!title && key.charAt(0) == 's') need.push(parseInt(key.slice(1), 10));
        }

        if (!rows.length) return Lampa.Noty.show(Lampa.Lang.translate('shikimori_hidden_empty'));

        var owner = ownerController();

        // Названия скрытого теперь хранятся вместе с записью, и список
        // открывается без сети. Сеть нужна только для старых записей,
        // спрятанных прежними версиями плагина
        if (!need.length) return show();

        Shiki.animesByIds(background_net, need.slice(0, 100), function (animes) {
            var by = {};
            for (var i = 0; i < animes.length; i++) {
                var name = animes[i].russian || animes[i].name;
                by['s' + parseInt(animes[i].id, 10)] = name;
                if (animes[i].malId) by['s' + parseInt(animes[i].malId, 10)] = name;
            }
            for (i = 0; i < rows.length; i++) if (!rows[i].title) rows[i].title = by[rows[i].key] || '';
            show();
        }, show);

        function show() {
            var items = [];
            for (var i = 0; i < rows.length; i++) {
                items.push({
                    title: rows[i].title || (Lampa.Lang.translate('shikimori_hidden_unknown') + ' ' + rows[i].key),
                    key: rows[i].key,
                    checkbox: true,
                    checked: true
                });
            }

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_settings_hidden'),
                items: items,
                nohide: true,
                // Галочка стоит у скрытого: снимаете — тайтл возвращается.
                // Список не закрывается, поэтому вернуть можно сразу несколько
                onCheck: function (item) {
                    if (item.checked) return;
                    Hidden.drop(item.key);
                    Lampa.Noty.show(Lampa.Lang.translate('shikimori_noty_unhidden'));
                },
                onBack: function () {
                    restoreController(owner);
                }
            });
        }
    }

    // Выбор студий озвучки — мультивыбор галочками.
    //
    // Раньше список строился с полем selected и обработчиком onCheck, но Lampa
    // зовёт onCheck только у пунктов с checkbox: true, а без него срабатывает
    // onSelect, которого не было. Поэтому нажатие не делало ничего: ни одной
    // студии выбрать было нельзя, а окно закрывалось, не вернув управление.
    // Теперь пункты — настоящие чекбоксы, а nohide держит список открытым,
    // чтобы отметить сразу несколько.
    //
    // Вместе с названием запоминаются номера студии в Kodik: по ним лента
    // приходит уже отфильтрованной, и выбор студии действительно меняет то,
    // что считается вышедшим
    function pickStudios(filter) {
        var owner = ownerController();

        // Словарь и студии из ваших данных — в один список, по названию
        function merge(list) {
            var seen = {};
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var item = list[i];
                if (!item || !item.title) continue;
                var rec = seen[item.title];
                if (!rec) {
                    rec = seen[item.title] = { title: item.title, count: item.count || 0, ids: [] };
                    out.push(rec);
                }
                var ids = item.ids || [];
                for (var j = 0; j < ids.length; j++) {
                    if (rec.ids.indexOf(ids[j]) < 0) rec.ids.push(ids[j]);
                }
            }
            return out;
        }

        function save(chosen, all) {
            var ids = {};
            for (var i = 0; i < chosen.length; i++) {
                for (var j = 0; j < all.length; j++) {
                    if (all[j].title == chosen[i] && all[j].ids.length) ids[chosen[i]] = all[j].ids;
                }
            }
            storSet('shikimori_studios', chosen);
            storSet('shikimori_studio_ids', ids);
            // Накопленные серии собраны по прежнему правилу — сбрасываем вместе
            // с местом, до которого прочитана лента: иначе остались бы числа
            // студий, которые больше не в счёт, а серии новых до этой минуты
            // так и не узнались бы
            Kodik.reset();
        }

        function show(all) {
            var chosen = Kodik.studios();
            var needle = String(filter || '').toLowerCase();

            // Выбранное — всегда наверху и всегда в списке, даже если студии
            // сейчас нет в словаре Kodik: иначе снять галочку было бы нечем
            var top = chosen.slice(0);
            var rest = [];
            for (var i = 0; i < all.length; i++) {
                if (chosen.indexOf(all[i].title) >= 0) continue;
                if (needle && all[i].title.toLowerCase().indexOf(needle) < 0) continue;
                rest.push(all[i].title);
            }

            // Студий у Kodik тысячи, и листать их с пульта невозможно: показываем
            // самые ходовые, остальное достаётся поиском по названию
            var hidden_count = Math.max(0, rest.length - TRANSLATIONS_MAX);
            if (hidden_count) rest = rest.slice(0, TRANSLATIONS_MAX);

            var items = [{
                title: Lampa.Lang.translate('shikimori_studios_any'),
                subtitle: chosen.length
                    ? Lampa.Lang.translate('shikimori_studios_chosen') + ': ' + chosen.length
                    : Lampa.Lang.translate('shikimori_studios_none'),
                action: 'any'
            }, {
                title: filter
                    ? Lampa.Lang.translate('shikimori_studios_search') + ': ' + filter
                    : Lampa.Lang.translate('shikimori_studios_search'),
                subtitle: hidden_count
                    ? Lampa.Lang.translate('shikimori_studios_more') + ' ' + hidden_count
                    : Lampa.Lang.translate('shikimori_studios_search_hint'),
                action: 'search'
            }];

            var list = top.concat(rest);
            for (i = 0; i < list.length; i++) {
                items.push({
                    title: list[i],
                    value: list[i],
                    checkbox: true,
                    checked: chosen.indexOf(list[i]) >= 0
                });
            }

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_settings_studios'),
                items: items,
                nohide: true,
                onCheck: function (item) {
                    var current = Kodik.studios();
                    var at = current.indexOf(item.value);
                    if (item.checked && at < 0) current.push(item.value);
                    if (!item.checked && at >= 0) current.splice(at, 1);
                    save(current, all);
                },
                onSelect: function (item) {
                    if (item.action == 'any') {
                        save([], all);
                        Lampa.Noty.show(Lampa.Lang.translate('shikimori_studios_any'));
                        show(all);
                    }
                    if (item.action == 'search') {
                        Lampa.Input.edit({
                            title: Lampa.Lang.translate('shikimori_studios_search'),
                            value: filter || '',
                            free: true,
                            nosave: true
                        }, function (value) {
                            filter = String(value || '').replace(/^\s+|\s+$/g, '');
                            show(all);
                        });
                    }
                },
                onBack: function () {
                    restoreController(owner);
                }
            });
        }

        // Полный словарь Kodik, дополненный тем, что встретилось у вас
        Kodik.translations(background_net, function (rows) {
            var all = merge(rows.concat(Kodik.knownStudios()));
            if (all.length) return show(all);

            // Kodik не отдал словарь и своих данных ещё нет — греем ленту
            Lampa.Noty.show(Lampa.Lang.translate('shikimori_studios_loading'));
            Kodik.feed(background_net, function () {
                show(merge(Kodik.knownStudios()));
            }, function () {
                show(merge(Kodik.knownStudios()));
            });
        });
    }

    // Меню по долгому нажатию на карточке — вместо лишних кнопок на экране
    function cardMenu(data) {
        var items = [];

        // Пункты подписаны по смыслу — иначе с пульта не понять,
        // что меняет прогресс, что метку, а что видимость
        if (data._watched_ep < data._total_ep && data._total_ep) {
            items.push({
                title: Lampa.Lang.translate('shikimori_menu_seen') + ' ' + data._total_ep,
                subtitle: Lampa.Lang.translate('shikimori_group_progress'),
                action: 'seen'
            });
        }

        items.push({
            title: Lampa.Lang.translate('shikimori_menu_seen_all'),
            subtitle: Lampa.Lang.translate('shikimori_group_progress'),
            action: 'seen_all'
        });

        if (Seen.get(cardSid(data))) {
            items.push({
                title: Lampa.Lang.translate('shikimori_menu_unseen'),
                subtitle: Lampa.Lang.translate('shikimori_group_progress'),
                action: 'unseen'
            });
        }

        // Метки Lampa прямо с карточки: тег ставится руками, и раньше ради него
        // приходилось открывать полную карточку
        var marked = {};
        var taggable = !!(data._tmdb_card && data.id);
        if (taggable) {
            try { marked = Lampa.Favorite.check(data) || {}; } catch (e) { taggable = false; }
        }

        for (var t = 0; taggable && t < FAV_TAGS.length; t++) {
            var tag = FAV_TAGS[t];
            items.push({
                title: (marked[tag] ? '✓ ' : '') + Lampa.Lang.translate('title_' + tag),
                subtitle: Lampa.Lang.translate('shikimori_group_tag'),
                action: 'tag',
                tag: tag
            });
        }

        // Скрыть можно всё, у чего есть хоть какой-то идентификатор. Раньше
        // условием был номер из Kodik, поэтому в каталоге и в лентах Shikimori
        // пункта «Не интересует» не было совсем
        if (Hidden.keys(data).length) {
            items.push({
                title: Lampa.Lang.translate(Hidden.hasCard(data) ? 'shikimori_menu_unhide' : 'shikimori_menu_hide'),
                subtitle: Lampa.Lang.translate('shikimori_group_visible'),
                action: 'hide'
            });
        }

        items.push({
            title: Lampa.Lang.translate('shikimori_menu_open'),
            subtitle: Lampa.Lang.translate('shikimori_group_open'),
            action: 'open'
        });

        // Автоматическое сопоставление иногда ошибается, и раньше исправить
        // его можно было только очисткой всего кэша. Теперь карточку TMDB
        // можно выбрать самому — выбор запоминается для этого тайтла
        if (!data._tmdb_card) {
            items.push({
                title: Lampa.Lang.translate('shikimori_menu_rematch'),
                subtitle: Lampa.Lang.translate('shikimori_group_open'),
                action: 'rematch'
            });
        }

        items.push({
            title: Lampa.Lang.translate('shikimori_search_lampa'),
            subtitle: Lampa.Lang.translate('shikimori_group_open'),
            action: 'search'
        });

        var owner = ownerController();

        Lampa.Select.show({
            title: cardView(data).title,
            items: items,
            onSelect: function (item) {
                restoreController(owner);

                if (item.action == 'hide') {
                    var hidden = Hidden.toggleCard(data, cardView(data).title);
                    Lampa.Noty.show(Lampa.Lang.translate(hidden ? 'shikimori_noty_hidden' : 'shikimori_noty_unhidden'));
                    if (hidden) dropCard(data._card_el);
                }

                if (item.action == 'seen') {
                    var written = markSeen(data, data._total_ep, data._season || 1);
                    Seen.mark(cardSid(data), data._total_ep, { h: written });
                    Lampa.Noty.show(Lampa.Lang.translate('shikimori_noty_seen'));
                }

                if (item.action == 'unseen') {
                    unmarkSeen(Seen.take(cardSid(data)));
                    Lampa.Noty.show(Lampa.Lang.translate('shikimori_noty_unseen'));
                }

                if (item.action == 'seen_all') {
                    var undo = { h: markSeen(data, data._season ? cardEpisodes(data) : 0, data._season || 0), v: null };
                    // Отметок мало: если карточка пришла из закладок, ставим ещё
                    // и метку «Просмотрено», иначе тайтл вернётся при следующей серии
                    if (data._tmdb_card && data.id) {
                        try {
                            if (!Lampa.Favorite.check(data).viewed) {
                                Lampa.Favorite.add('viewed', data, 500);
                                undo.v = { id: data.id, name: data.name, title: data.title, source: data.source };
                            }
                        }
                        catch (e) {}
                    }
                    Seen.mark(cardSid(data), cardEpisodes(data), undo);
                    dropCard(data._card_el);
                    Lampa.Noty.show(Lampa.Lang.translate('shikimori_noty_seen'));
                }

                if (item.action == 'tag') {
                    var card = data;
                    try {
                        if (Lampa.Favorite.check(card)[item.tag]) Lampa.Favorite.remove(item.tag, card);
                        else Lampa.Favorite.add(item.tag, card, 500);
                        Lampa.Noty.show(Lampa.Lang.translate('title_' + item.tag) + ': ' +
                            Lampa.Lang.translate(Lampa.Favorite.check(card)[item.tag] ? 'shikimori_tag_on' : 'shikimori_tag_off'));
                    }
                    catch (e) {
                        Lampa.Noty.show(Lampa.Lang.translate('shikimori_tag_fail'));
                    }
                }

                if (item.action == 'open') {
                    openAnime(data);
                }

                if (item.action == 'rematch') Match.rematch(data);
                if (item.action == 'search') searchLampa(cardView(data).title);
            },
            onBack: function () {
                restoreController(owner);
            }
        });
    }

    // Проставить отметки просмотра — для тех, кто досматривал не в Lampa.
    // episodes/seasons = 0 означает «всё, что знаем»: число сезонов и серий
    // берём из карточки TMDB, потому что Kodik про сезоны ничего не говорит
    // Сезон известен (закладка, у которой озвучка вышла в конкретном сезоне
    // TMDB) — отмечаем только его. Имя — настоящее original_name карточки
    // TMDB: им Lampa подписывает отметки, а в закладке бывает ромадзи
    function markSeen(data, episodes, seasons) {
        // Одно имя — то, которым Lampa подписывает отметки: original_name
        // полной карточки TMDB. Раньше писали под каждым из имён, и вторая
        // копия под ромадзи из закладки была мусором, который Lampa не читает,
        // а аккаунт CUB синхронизирует
        var name = data._tmdb_name || data.original_name || data.original_title;
        if (!name) return [];
        var names = [name];

        // Сезон отслеживаемого тайтла не известен наверняка — отметки Lampa не
        // пишем: угаданный сезон потом спорил бы с настоящим, когда TMDB
        // ответит, и тайтл надолго пропадал из «Новых серий». Хватает своей
        // отметки плагина
        if (data._tracked && !data._season) return [];

        var first_season = data._season || 1;
        var last_season = seasons || parseInt(data.number_of_seasons, 10) || 1;
        if (last_season < first_season) last_season = first_season;
        var last_ep = episodes || parseInt(data.number_of_episodes, 10) || data._total_ep || 0;
        if (!last_ep) last_ep = MARK_SEEN_FALLBACK;

        // Сезон TMDB общий с прошлыми частями — серии этой идут после них
        var offset = data._season ? data._offset || 0 : 0;

        // Что включили мы, а не было до нас: только это и откатывается при
        // «Снять отметку» — серии, досмотренные раньше, остаются досмотренными
        var switched = [];
        var written = 0;
        for (var k = 0; k < names.length; k++) {
            for (var season = first_season; season <= last_season && written < MARK_SEEN_LIMIT; season++) {
                for (var ep = offset + 1; ep <= offset + last_ep && written < MARK_SEEN_LIMIT; ep++) {
                    try {
                        var hash = Lampa.Utils.hash([season, season > 10 ? ':' : '', ep, names[k]].join(''));
                        var before = Lampa.Timeline.view ? Lampa.Timeline.view(hash) : null;
                        if (!before || !before.percent) switched.push(hash);
                        Lampa.Timeline.update({ hash: hash, percent: 100, time: 0, duration: 0 });
                        written++;
                    }
                    catch (e) { return switched; }
                }
            }
        }
        return switched;
    }

    // Откатить то, что сделало «Отметить»: наши отметки серий — если их с тех
    // пор не досмотрели по-настоящему — и нашу метку «Просмотрено»
    function unmarkSeen(rec) {
        var undo = rec && rec.u;
        if (!undo) return;
        var list = undo.h || [];
        for (var i = 0; i < list.length; i++) {
            try {
                var now = Lampa.Timeline.view ? Lampa.Timeline.view(list[i]) : null;
                if (now && now.time) continue;
                Lampa.Timeline.update({ hash: list[i], percent: 0, time: 0, duration: 0 });
            }
            catch (e) {}
        }
        if (undo.v && undo.v.id) {
            try { Lampa.Favorite.remove('viewed', undo.v); }
            catch (e) {}
        }
    }

    // Похоже ли на аниме. Закладка Lampa проходит через Utils.clearCard и хранит
    // только поля из белого списка: если тайтл добавляли с полной карточки, там
    // genres:[{id}], а не genre_ids, и жанр в закладке теряется. Поэтому смотрим
    // оба поля, а признаки берём по «или» — окончательно решает маппинг в
    // Shikimori: у не-аниме его просто не найдётся
    function looksLikeAnime(card) {
        var ids = card.genre_ids || [];
        if (!ids.length && card.genres && card.genres.length) {
            ids = [];
            for (var i = 0; i < card.genres.length; i++) {
                if (card.genres[i]) ids.push(card.genres[i].id);
            }
        }
        var animation = ids.indexOf(16) >= 0;
        var jp = card.original_language == 'ja' || (card.origin_country || []).indexOf('JP') >= 0;
        return animation || jp;
    }

    /* ============================================================
     * Прогресс просмотра — по данным самой Lampa
     * ------------------------------------------------------------
     * Отметки лежат в Timeline с ключом hash(сезон + серия + оригинальное
     * название), а «последнее, что включали» онлайн-балансеры пишут в
     * online_watched_last. Знает только то, что смотрели внутри Lampa.
     * ============================================================ */

    var Progress = {
        // До какой серии досмотрено и когда. null — отметок нет.
        // Ключ отметки Lampa — hash(сезон + серия + оригинальное название), но
        // разные балансеры пишут то original_name, то original_title, поэтому
        // проверяем оба и берём максимум. Раньше перебор шёл только по сериям
        // старше 24-й, и обычный случай «досмотрел 12 из 12» не находился вовсе
        // offsets — где в сезоне TMDB начинаются части тайтла: у второй части
        // сплит-кура, которую TMDB нумерует дальше первой, серии идут с 13-й,
        // и сезон, отмеченный только с 13-й, тоже считается начатым
        lastWatched: function (card, max_ep, offsets) {
            var res = this.scan(card, max_ep, offsets);
            return res ? res.last : null;
        },

        // То же, но по всем сезонам: last — где остановился, tops — последняя
        // отмеченная серия каждого начатого сезона TMDB, total — их сумма
        // (сколько всего серий отмечено, если смотрели подряд)
        // seasons — сколько сезонов у тайтла в TMDB, если перебирать надо дальше
        // обычного: у «Ван-Писа» в TMDB за двадцать сезонов-арок
        scan: function (card, max_ep, offsets, seasons) {
            var names = [];
            // Первым — original_name полной карточки TMDB: именно им Lampa
            // подписывает отметки в списке серий, и он бьёт имя из закладки
            if (card._tmdb_name) names.push(card._tmdb_name);
            if (card.original_name && names.indexOf(card.original_name) < 0) names.push(card.original_name);
            if (card.original_title && names.indexOf(card.original_title) < 0) names.push(card.original_title);
            // У карточек Shikimori нет original_*, но отметки Lampa записаны по
            // оригинальному названию TMDB, а это как правило ромадзи из name
            if (card._shiki_name && names.indexOf(card._shiki_name) < 0) names.push(card._shiki_name);
            if (!names.length && card.name) names.push(card.name);
            if (!names.length) return null;

            var episode = 0;
            var season = 0;
            var at = 0;
            var tops = {};
            var total = 0;
            var i, n;

            // 1. Прямая запись «где остановился» от онлайн-балансеров
            try {
                var last = Lampa.Storage.get('online_watched_last', {}) || {};
                for (n = 0; n < names.length; n++) {
                    var filed = last[Lampa.Utils.hash(names[n])];
                    if (!filed || !filed.episode) continue;
                    var ep_num = parseInt(filed.episode, 10) || 0;
                    var se_num = parseInt(filed.season, 10) || 1;
                    if (!ep_num) continue;
                    if (se_num > season || (se_num == season && ep_num > episode)) {
                        season = se_num;
                        episode = ep_num;
                    }
                }
            }
            catch (e) {}

            // 2. Перебор отметок таймлайна ПО СЕЗОНАМ, сверху вниз.
            //
            // Смотрят далеко не всегда первый сезон: у «Рыцаря-скелета»
            // отметки лежат во втором (серии 1–6), и перебор одного лишь
            // первого сезона не находил ничего — ни прогресса, ни счётчика
            // новых серий. Поэтому идём от старшего сезона к младшему и
            // берём первый, где вообще есть отметки: это и есть то, что
            // человек смотрит сейчас. Внутри сезона — сверху вниз, до
            // первой отметки, это последняя просмотренная серия.
            //
            // Перебор ограничен бюджетом обращений: у длинных тайтлов вроде
            // «Ван-Писа» max_ep за тысячу, и полный обход всех сезонов
            // подвесил бы отрисовку строки
            var per_season = Math.min(max_ep || PROGRESS_SCAN_MIN, PROGRESS_SCAN_MAX);
            if (per_season < PROGRESS_SCAN_MIN) per_season = PROGRESS_SCAN_MIN;

            // Число сезонов из закладки — не потолок: закладку сохранили,
            // когда сезон был один, а потом вышел второй. У «Рыцаря-скелета»
            // в закладке так и стоит number_of_seasons: 1, при том что
            // смотрят как раз второй. Поэтому идём до своего предела всегда
            var max_season = parseInt(card.number_of_seasons, 10) || 0;
            if (max_season < PROGRESS_SEASON_MAX) max_season = PROGRESS_SEASON_MAX;
            if (max_season > PROGRESS_SEASON_HARD) max_season = PROGRESS_SEASON_HARD;
            if (seasons > max_season) max_season = Math.min(seasons, PROGRESS_SEASON_SPAN);

            // С каких серий щупать, начат ли сезон: с первой и с начала каждой части
            var heads = [0];
            for (i = 0; offsets && i < offsets.length; i++) {
                var from = parseInt(offsets[i], 10) || 0;
                if (from > 0 && heads.indexOf(from) < 0) heads.push(from);
            }

            var budget = PROGRESS_PROBE_BUDGET;

            function probeEp(se, ep) {
                for (var k = 0; k < names.length; k++) {
                    budget--;
                    var v = Lampa.Timeline.watchedEpisode(
                        { original_name: names[k], original_title: names[k] }, se, ep, true);
                    if (v && v.percent) return v;
                }
                return null;
            }

            // Последняя отмеченная серия сезона. В сезоне, где остановились, —
            // сверху вниз от per_season: так находится и серия после пропуска.
            // Отмечена уже она — тайтл длиннее перебора («Ван-Пис»). Сверху вниз —
            // не дальше окна: у длинной франшизы per_season — сотни серий, и
            // перебор съедал бюджет, не дойдя до отметки на 43-й серии. Ниже окна,
            // в прошлых сезонах и сверх перебора — от начала частей шагаем вверх,
            // удваивая шаг, пока отметки есть, потом делим пополам: обращений к
            // таймлайну — единицы
            function topOf(se, exact) {
                var ep = 0, view, first = null;
                if (exact) {
                    var stop = Math.max(1, per_season - PROGRESS_EXACT_WINDOW + 1);
                    for (ep = per_season; ep >= stop && budget > 0; ep--) {
                        view = probeEp(se, ep);
                        if (view) { first = view; break; }
                    }
                    if (first && ep < per_season) return { ep: ep, view: first };
                }
                if (!first) {
                    for (var k = 0; k < heads.length && !first; k++) {
                        for (var hd = PROGRESS_SEASON_PROBE; hd >= 1 && !first; hd--) {
                            view = probeEp(se, heads[k] + hd);
                            if (view) { first = view; ep = heads[k] + hd; }
                        }
                    }
                    if (!first) return null;
                }
                var lo = ep, step = Math.max(ep, PROGRESS_SEASON_PROBE), hi = 0, last = first;
                while (budget > 0 && step <= PROGRESS_SCAN_HARD) {
                    view = probeEp(se, lo + step);
                    if (!view) { hi = lo + step; break; }
                    lo += step;
                    last = view;
                    step *= 2;
                }
                if (!hi) return { ep: lo, view: last };
                while (hi - lo > 1 && budget > 0) {
                    var mid = Math.floor((lo + hi) / 2);
                    view = probeEp(se, mid);
                    if (view) { lo = mid; last = view; }
                    else hi = mid;
                }
                return { ep: lo, view: last };
            }

            var last_season = 0;
            try {
                for (var se = max_season; se >= 1 && budget > 0; se--) {
                    // Сезонов перебираем много, а смотрели обычно один. Чтобы не
                    // гонять полный обход по пустым сезонам, сначала щупаем первые
                    // серии: не отмечена ни одна — сезон не начинали
                    var touched = false;
                    for (var h = 0; h < heads.length && !touched; h++) {
                        for (var head = 1; head <= PROGRESS_SEASON_PROBE && !touched; head++) {
                            if (probeEp(se, heads[h] + head)) touched = true;
                        }
                    }
                    if (!touched) continue;

                    var top = topOf(se, !last_season);
                    if (!top) continue;
                    tops[se] = top.ep;
                    total += top.ep;

                    // Где остановился — в старшем начатом сезоне
                    if (!last_season) {
                        last_season = se;
                        if (top.view.updated > at) at = top.view.updated;
                        if (se > season || (se == season && top.ep > episode)) {
                            season = se;
                            episode = top.ep;
                        }
                    }
                }
            }
            catch (e) {}

            if (!season) season = 1;

            return {
                last: episode ? { episode: episode, season: season, at: at || 0 } : null,
                tops: tops,
                total: total
            };
        },

        // Что значит отметка Lampa для одного сезона Shikimori.
        // mark — где человек остановился: {season, episode} в нумерации TMDB.
        // entry — сезон Shikimori: season (номер сезона TMDB), offset (серий
        // того же сезона TMDB у частей до него), eps (серий всего), verified
        // (номер сверен с самим TMDB), newest (после него ничего не выходило).
        // Ответ: { watched } или { fresh_season: true } — сезон не начинали
        judge: function (mark, entry, total) {
            var eps = entry.eps || 0;
            var past = { watched: Math.max(total || 0, eps) };

            // Номер сезона неизвестен — верим номеру серии, если он вообще
            // помещается в сезон: «24» у сезона из 12 серий — это прошлый сезон
            if (!entry.season || !mark.season) {
                if (eps && mark.episode > eps && entry.newest) return { fresh_season: true };
                return { watched: mark.episode };
            }

            if (mark.season < entry.season) return { fresh_season: true };

            if (mark.season == entry.season) {
                // Сезон TMDB общий с прошлыми частями — их серии вычитаем
                var ep = mark.episode - (entry.offset || 0);
                if (ep <= 0) return { fresh_season: true };
                if (eps && ep > eps) return past;
                return { watched: ep };
            }

            // Отметки в более позднем сезоне TMDB. Номер сверен с TMDB или
            // это не последний сезон — значит, этот уже позади
            if (entry.verified || !entry.newest) return past;
            // Номер из базы соответствий, а она бывает неправа: пишет сезон 1
            // со сквозной нумерацией там, где у TMDB отдельные сезоны. Тогда
            // отметка в «сезоне 3» и есть этот сезон — если влезает в него
            if (eps && mark.episode > eps) return { fresh_season: true };
            return { watched: mark.episode };
        },

        // Отметки Lampa у тайтла Shikimori. Lampa пишет их, когда серию
        // отмечают в списке серий или досматривают, — по original_name полной
        // карточки TMDB и номеру сезона TMDB. У карточки Shikimori нет ни
        // того ни другого, поэтому отмеченное в Lampa плагин у тайтлов из
        // списка Shikimori и лент не видел никогда. Берём их из сопоставления
        // и запомненной карточки TMDB, сезон сверяем с самим TMDB
        ofShiki: function (anime, total) {
            var sid = anime ? parseInt(anime.malId || anime.id, 10) : 0;
            var hit = sid ? Match.cacheGet(sid) : null;
            // Отметки по сезонам бывают только у сериалов, и не у спецвыпусков
            if (!hit || hit.none || !hit.tmdb || hit.sp || !isSeries(hit, anime.kind)) return null;
            var info = TmdbInfo.get(hit.tmdb, 'tv');
            if (!info || !info.original_name) return null;

            var eps = parseInt(anime.episodes, 10) || 0;
            var aired = parseInt(anime.episodesAired, 10) || 0;
            var entry = {
                season: hit.season || 0,
                offset: 0,
                eps: eps,
                verified: false,
                // Выходит сейчас — значит, последний сезон тайтла
                newest: anime.status == 'ongoing'
            };
            // Премьера совпала с началом сезона TMDB — номер точно этот. Не
            // совпала: база называет сезон позже — TMDB его ещё не завёл, верим
            // базе; иначе тайтл продолжает сезон TMDB, и до него в сезоне — серии
            // прошлых частей. Их мы тут не знаем: TMDB перечисляет либо все
            // серии сезона, либо только вышедшие — пробуем оба смещения
            var offsets = [];
            var one = [{ date: dayOf(anime.airedOn && anime.airedOn.date), kind: anime.kind || 'tv', eps: eps }];
            if (one[0].date && Seasons.place(hit.tmdb, one) && one[0].tseason) {
                if (one[0].texact) {
                    entry.season = one[0].tseason;
                    entry.verified = true;
                }
                else if (!entry.season || entry.season <= one[0].tseason) {
                    entry.season = one[0].tseason;
                    var count = one[0].tcount || 0;
                    if (count > eps && eps) offsets.push(count - eps);
                    if (count > aired && aired && offsets.indexOf(count - aired) < 0) offsets.push(count - aired);
                }
            }

            var widest = offsets.length ? Math.max.apply(Math, offsets) : 0;
            var mark = this.lastWatched({ _tmdb_name: info.original_name }, Math.max(total, eps, aired) + widest, offsets);
            if (!mark) return null;

            // Из возможных смещений — то, при котором отметка правдоподобна:
            // ни раньше начала части, ни дальше вышедшего
            var limit = Math.max(total, aired);
            var judged = null;
            for (var i = 0; i < Math.max(offsets.length, 1); i++) {
                entry.offset = offsets[i] || 0;
                var one_judged = this.judge(mark, entry, total);
                var ep = mark.episode - entry.offset;
                if (!offsets.length || mark.season != entry.season || (ep >= 0 && (!limit || ep <= limit))) {
                    judged = one_judged;
                    break;
                }
            }
            if (!judged || judged.fresh_season) return null;
            // Номер не сверен, а «просмотрено» больше, чем вообще вышло, — отметка
            // от прошлой части или сезона: такой не верим
            if (!entry.verified && limit && judged.watched > limit) return null;
            return { episode: judged.watched, season: mark.season, at: mark.at };
        }
    };

    /* ============================================================
     * Названия: приведение и сравнение
     * ------------------------------------------------------------
     * Один и тот же тайтл называется по-разному: ромадзи у Shikimori,
     * японское оригинальное у TMDB, английское у обоих, а у каждого
     * сезона ещё и свой хвост («2nd Season», «第2期», «2 сезон»).
     * Сравнивать такие строки по словам бессмысленно: в японском нет
     * пробелов, и «葬送のフリーレン» для пословного сравнения — одно слово.
     * Поэтому сравниваем по парам соседних символов
     * ============================================================ */

    var Titles = {
        norm: function (s) {
            s = String(s || '').toLowerCase();
            // Полноширинные цифры и латиница из японских названий — в обычные
            s = s.replace(/[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g, function (c) {
                return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
            });
            s = s.replace(/[āáàâä]/g, 'a').replace(/[ēéèêë]/g, 'e').replace(/[īíìîï]/g, 'i')
                 .replace(/[ōóòôö]/g, 'o').replace(/[ūúùûü]/g, 'u').replace(/ё/g, 'е');
            // Ромадзи пишут то с долгими гласными, то без: Shippuuden и Shippuden
            s = s.replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u');
            s = s.replace(/[\u30fb\uff65]/g, ' ');
            s = s.replace(/[^a-z0-9а-я\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g, ' ');
            return s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        },

        // Название без пометок сезона, части и кура
        base: function (s) {
            s = String(s || '').replace(/[\uff10-\uff19]/g, function (c) {
                return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
            });
            s = s
                .replace(/第\s*[0-9一二三四五六七八九十]+\s*(期|クール|部|章|シーズン|シリーズ)/g, ' ')
                .replace(/[0-9]+\s*(期|クール)/g, ' ')
                .replace(/(前編|後編|前半|後半|最終章|完結編|最終シーズン)/g, ' ')
                .replace(/[\u2160-\u216f]/g, ' ')
                .replace(/\b(the\s+)?final\s+season\b/gi, ' ')
                .replace(/\b\d+(st|nd|rd|th)\s+(season|cour|part)\b/gi, ' ')
                .replace(/\b(season|part|cour)\s*\.?\s*\d+\b/gi, ' ')
                .replace(/(^|\s)\d+(-?(й|ой|ий))?\s+(сезон|часть)(?=\s|$)/gi, ' ')
                .replace(/(^|\s)(сезон|часть)\s+\d+(?=\s|$)/gi, ' ')
                .replace(/(^|\s)тв-?\d+(?=\s|$)/gi, ' ')
                .replace(/[(\[（]\s*(tv|тв|ova|ona|movie|фильм)?[\s\-]*\d*\s*[)\]）]/gi, ' ')
                .replace(/\s+(ii|iii|iv|v|vi|vii|viii|[2-9])\s*$/i, ' ');
            return s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        },

        pairs: function (s) {
            var map = {};
            for (var i = 0; i < s.length - 1; i++) {
                var p = s.substr(i, 2);
                map[p] = (map[p] || 0) + 1;
            }
            return map;
        },

        // Коэффициент Дайса по парам символов, 0..1
        sim: function (a, b) {
            a = this.norm(a).replace(/ /g, '');
            b = this.norm(b).replace(/ /g, '');
            if (!a || !b) return 0;
            if (a == b) return 1;

            var score = 0;
            if (a.length > 1 && b.length > 1) {
                var pa = this.pairs(a);
                var pb = this.pairs(b);
                var common = 0;
                for (var k in pa) if (pb[k]) common += Math.min(pa[k], pb[k]);
                score = 2 * common / (a.length + b.length - 2);
            }

            // Название сезона — это название сериала плюс хвост: «鬼滅の刃
            // 刀鍛冶の里編» начинается с «鬼滅の刃». Совпадение по началу почти
            // всегда означает то же произведение, если начало не слишком
            // короткое: «Another» и «Another World» — разные тайтлы
            var shorter = a.length < b.length ? a : b;
            var longer = a.length < b.length ? b : a;
            var cjk = /[\u3040-\u9fff]/.test(shorter);
            if (longer.indexOf(shorter) === 0 && shorter.length >= (cjk ? 3 : 8)) score = Math.max(score, 0.85);
            return score;
        },

        // Лучшее совпадение двух наборов названий — как есть и без пометок
        // сезона. «Как есть» чуть весомее, иначе «Steins;Gate 0» сливается
        // со «Steins;Gate»
        best: function (ours, theirs) {
            var top = 0;
            var cut_theirs = [];
            for (var j = 0; j < theirs.length; j++) cut_theirs.push(theirs[j] ? this.base(theirs[j]) : '');
            for (var i = 0; i < ours.length; i++) {
                if (!ours[i]) continue;
                var cut_ours = this.base(ours[i]);
                for (j = 0; j < theirs.length; j++) {
                    if (!theirs[j]) continue;
                    var raw = this.sim(ours[i], theirs[j]);
                    if (raw == 1) return 1;
                    var cut = this.sim(cut_ours, cut_theirs[j]) * 0.97;
                    var s = raw > cut ? raw : cut;
                    if (s > top) top = s;
                }
            }
            return top;
        },

        // Все названия тайтла Shikimori: японское первым — оно ближе всего
        // к original_name в TMDB
        of: function (anime) {
            var list = [];
            function add(v) {
                if (Object.prototype.toString.call(v) === '[object Array]') {
                    for (var i = 0; i < v.length; i++) add(v[i]);
                    return;
                }
                if (v && list.indexOf(v) < 0) list.push(v);
            }
            add(anime.japanese);
            add(anime.russian);
            add(anime.english);
            add(anime.name);
            add(anime.synonyms);
            // Синонимов у долгоиграющих бывает десяток — сравнение на
            // телевизоре не бесплатное, хватит первых
            return list.slice(0, 7);
        }
    };

    /* ============================================================
     * TMDB: запросы самого плагина
     * ------------------------------------------------------------
     * Адрес строит Lampa (Lampa.TMDB.api) — с её прокси, если он включён.
     * Не ответил прямой путь — пробуем сквозной TMDB у CUB, тот самый,
     * через который Lampa открывает карточки при источнике CUB. Какой
     * путь ответил, помним до перезапуска: второй раз ждать таймаута незачем
     * ============================================================ */

    var Tmdb = {
        route: 0,

        lang: function () {
            var lang = '';
            try { lang = Lampa.Storage.field('tmdb_lang'); } catch (e) {}
            return lang || storString('language', 'ru');
        },

        url: function (path, route, lang) {
            var query = path + (path.indexOf('?') >= 0 ? '&' : '?') +
                'api_key=' + Lampa.TMDB.key() + '&language=' + (lang || this.lang());
            if (route == 1) {
                var email = '';
                try { email = (Lampa.Storage.get('account', '{}') || {}).email || ''; } catch (e) {}
                return Lampa.Utils.protocol() + 'tmdb.' + (Lampa.Manifest.cub_domain || 'cub.rip') + '/3/' + query +
                    (email ? '&email=' + encodeURIComponent(email) : '');
            }
            return Lampa.TMDB.api(query);
        },

        get: function (net, path, ok, err, lang) {
            var self = this;
            var first = this.route;
            var second = first ? 0 : 1;

            function via(route, done, fail) {
                var url;
                try { url = self.url(path, route, lang); }
                catch (e) { return fail('url'); }
                net.get(url, done, fail, TMDB_TIMEOUT);
            }

            via(first, ok, function (reason) {
                // 404 — ответ по существу: такого номера нет, запасной путь скажет то же
                if (reason == 404) return err(reason);
                via(second, function (json) {
                    self.route = second;
                    ok(json);
                }, function () {
                    err(reason);
                });
            });
        }
    };

    /* ============================================================
     * Настоящие данные карточки TMDB
     * ------------------------------------------------------------
     * Закладка Lampa хранит лишь обрезок карточки, и обрезок бывает
     * кривой: у «Крестьянина 999 уровня» в закладке original_name
     * записано ромадзи «Lv999 no Murabito», тогда как TMDB отдаёт
     * «LV999の村人». Разница решающая: отметки просмотра Lampa пишет
     * хешем от original_name ПОЛНОЙ карточки, поэтому по имени из
     * закладки прогресс не находится никогда. Заодно в закладке
     * обычно нет ни даты выхода, ни оценки.
     *
     * Поэтому недостающее добираем у TMDB по id и кладём в кеш —
     * запрос делается один раз на тайтл за всё время.
     * ============================================================ */

    var TmdbInfo = {
        cache: null,

        load: function () {
            if (!this.cache) {
                try { this.cache = Lampa.Storage.get(TMDB_INFO_KEY, {}) || {}; }
                catch (e) { this.cache = {}; }
            }
            return this.cache;
        },

        // Номера фильмов и сериалов в TMDB пересекаются: у сериала ключ
        // прежний ('i'), у фильма свой. Иначе фильм 1234 получал имя
        // сериала 1234 и терял прогресс и сопоставление
        key: function (id, method) {
            return (method == 'movie' ? 'm' : 'i') + id;
        },

        get: function (id, method) {
            var rec = this.load()[this.key(id, method)] || null;
            if (rec && rec.t && rec.t != (method || 'tv')) return null;
            return rec;
        },

        save: function () {
            try { Lampa.Storage.set(TMDB_INFO_KEY, this.cache || {}); }
            catch (e) {}
        },

        // Сериал или полнометражка: у сериала Lampa кладёт name, у фильма title
        methodOf: function (card) {
            return card.name || card.original_name ? 'tv' : 'movie';
        },

        // Спрашиваем только про те закладки, где данных не хватает:
        // отсутствие даты выхода — верный признак обрезанной карточки.
        // Если в прошлый раз не ответила сеть — спрашиваем снова, но не
        // чаще раза в сутки. Пустые записи прежних версий (без v) могли
        // остаться от такого же сбоя — их переспрашиваем один раз
        needs: function (card) {
            if (!card || !card.id) return false;
            var info = this.get(card.id, this.methodOf(card));
            if (info) {
                if (info.retry) return Date.now() - info.retry > TMDB_INFO_RETRY;
                return !info.v && !info.original_name;
            }
            return !card.first_air_date && !card.release_date;
        },

        // Запись прежних версий: вид в ней не помечен, а под тем же ключом
        // раньше бывало и имя фильма с тем же номером — перепроверяем
        legacy: function (card) {
            if (!card || !card.id || this.methodOf(card) != 'tv') return false;
            var info = this.get(card.id, 'tv');
            return !!info && !info.t && !info.retry;
        },

        fill: function (net, cards, ok) {
            var self = this;
            var queue = [];
            var i;

            // Один номер — один запрос за заход. Между заходами не делим: ответ
            // запроса, отменённого вместе с экраном, не приходит никогда, и
            // общая пометка «уже спрашиваем» залипала до перезапуска
            var queued = {};
            var legacy = 0;
            for (i = 0; i < cards.length && queue.length < TMDB_INFO_MAX; i++) {
                var qkey = self.key(cards[i].id, self.methodOf(cards[i]));
                if (queued[qkey]) continue;
                var stale = !self.needs(cards[i]) && self.legacy(cards[i]) && legacy < TMDB_INFO_LEGACY;
                if (!stale && !self.needs(cards[i])) continue;
                if (stale) legacy++;
                queued[qkey] = true;
                queue.push(cards[i]);
            }

            if (!queue.length) return ok();

            var left = queue.length;
            var running = 0;
            var next = 0;
            var changed = false;
            var seasons = false;

            function done() {
                if (changed) self.save();
                if (seasons) Seasons.save();
                ok();
            }

            function step() {
                while (running < TMDB_INFO_PARALLEL && next < queue.length) {
                    ask(queue[next++]);
                }
            }

            function ask(card) {
                running++;

                var method = self.methodOf(card);
                var key = self.key(card.id, method);

                Tmdb.get(net, method + '/' + card.id, function (json) {
                    // Тот же ответ знает и сезоны — пригодятся для отметок
                    if (method == 'tv' && json && json.seasons) {
                        Seasons.remember(card.id, json.seasons, true);
                        seasons = true;
                    }
                    self.load()[key] = json && json.id ? {
                        v: 2,
                        t: method,
                        original_name: json.original_name || json.original_title || '',
                        year: (json.first_air_date || json.release_date || '').slice(0, 4),
                        score: json.vote_average || 0
                    } : { v: 2, t: method, original_name: '', year: '', score: 0, retry: Date.now() };
                    changed = true;
                    after();
                }, function (reason) {
                    // Номера нет — это ответ, его помним, чтобы не спрашивать снова.
                    // Сеть молчит — это не ответ: раньше и такой случай записывался
                    // пустышкой навсегда, и прогресс у закладки больше не находился.
                    // Что знали раньше, при этом не теряем
                    var prev = self.load()[key] || {};
                    self.load()[key] = reason == 404
                        ? { v: 2, t: method, original_name: '', year: '', score: 0 }
                        : { v: 2, t: method, original_name: prev.original_name || '', year: prev.year || '',
                            score: prev.score || 0, retry: Date.now() };
                    changed = true;
                    after();
                });
            }

            function after() {
                running--;
                left--;
                if (left <= 0) return done();
                step();
            }

            step();
        },

        // Полная карточка TMDB открылась — имя для отметок известно без запроса
        remember: function (movie, method) {
            var name = movie && (movie.original_name || movie.original_title);
            if (!movie || !movie.id || !name) return;
            var have = this.get(movie.id, method);
            if (have && have.original_name == name) return;
            this.load()[this.key(movie.id, method)] = {
                v: 2,
                t: method,
                original_name: name,
                year: (movie.first_air_date || movie.release_date || '').slice(0, 4),
                score: movie.vote_average || 0
            };
            this.save();
        },

        // Сопоставленные тайтлы Shikimori: дозапрашиваем имена TMDB, по
        // которым Lampa пишет отметки серий. Один раз на тайтл, в фоне.
        // Отметки по сезонам бывают только у сериалов; номер с неизвестным
        // видом (OVA, спецвыпуск) мог оказаться фильмом — его не спрашиваем
        // kinds — вид тайтла Shikimori по номеру: у ONA база соответствий вид
        // TMDB часто не знает, а сериалом она почти всегда и оказывается
        names: function (sids, done, kinds) {
            var self = this;
            done = done || function () {};
            if (!sids.length) return done({});
            Match.batch(background_net, sids, function (map) {
                var cards = [];
                for (var k in map) {
                    var hit = map[k];
                    if (!hit || !hit.tmdb || !isSeries(hit, kinds && kinds[k])) continue;
                    // У сериала Lampa кладёт name — по нему fill выбирает tv
                    cards.push({ id: hit.tmdb, name: '-' });
                }
                if (!cards.length) return done(map);
                self.fill(background_net, cards, function () { done(map); });
            });
        },

        // Переносим добранное на карточку
        apply: function (card) {
            var info = this.get(card.id, this.methodOf(card));
            if (!info) return;
            if (info.original_name) card._tmdb_name = info.original_name;
            if (info.year && !card.first_air_date && !card.release_date) card._tmdb_year = info.year;
            if (info.score && !card.vote_average) card._tmdb_score = info.score;
        }
    };

    /* ============================================================
     * Сезоны TMDB
     * ------------------------------------------------------------
     * Lampa отмечает серии по номеру сезона TMDB, а база соответствий
     * знает его не всегда. У «Монолога фармацевта» все три сезона
     * записаны в ней первым сезоном со сквозной нумерацией (второй —
     * серии 25–48), а в TMDB это три отдельных сезона. Отметка
     * «сезон 3, серия 1» не сходилась ни с чем, и просмотренное висело
     * в «Новых сериях». Таких тайтлов в базе десятки: «Фрирен»,
     * «Звёздное дитя», вторые части «Магической битвы».
     *
     * Поэтому там, где решается «новое или нет», сверяемся с самим
     * TMDB: сезон Shikimori — это сезон TMDB, начавшийся в тот же день.
     * Такого нет — тайтл продолжает нумерацию последнего начавшегося до
     * него сезона TMDB (вторая часть сплит-кура), со смещением на серии
     * предыдущих частей. Список сезонов кешируется на неделю и бесплатно
     * обновляется, когда открывают полную карточку
     * ============================================================ */

    var Seasons = {
        memo: null,

        load: function () {
            if (!this.memo) {
                var stored = storGet(SEASONS_KEY, {});
                this.memo = stored && typeof stored == 'object' ? stored : {};
            }
            return this.memo;
        },

        save: function () {
            var all = this.load();
            var keys = [];
            for (var k in all) keys.push(k);
            if (keys.length > SEASONS_MAX) {
                keys.sort(function (a, b) {
                    return Math.max(all[a].t || 0, all[a].f || 0) - Math.max(all[b].t || 0, all[b].f || 0);
                });
                for (var i = 0; i < keys.length - SEASONS_MAX; i++) delete all[keys[i]];
            }
            storSet(SEASONS_KEY, all);
        },

        get: function (id) {
            var rec = id ? this.load()['i' + id] : null;
            return rec && rec.s && rec.s.length ? rec : null;
        },

        // seasons — массив из карточки TMDB: [{season_number, air_date, episode_count}].
        // later — в хранилище запишет тот, кто запрашивал пачку, один раз в конце
        remember: function (id, seasons, later) {
            if (!id || !seasons || !seasons.length) return;
            var list = [];
            for (var i = 0; i < seasons.length; i++) {
                var one = seasons[i] || {};
                var num = parseInt(one.season_number, 10);
                // Нулевой сезон — спецвыпуски, Lampa их в отметках не нумерует
                if (!(num >= 1)) continue;
                list.push([num, dayOf(one.air_date), parseInt(one.episode_count, 10) || 0]);
            }
            if (!list.length) return;
            list.sort(function (a, b) { return a[0] - b[0]; });
            this.load()['i' + id] = { t: Date.now(), s: list };
            if (!later) this.save();
        },

        // Спрашивать ли TMDB: данных нет, они старше недели, или у тайтла
        // начался сезон позже последнего известного TMDB, а спрашивали давно.
        // Не ответил — снова через час: пока сезонов нет, сезон угадывается
        needs: function (id, latest) {
            var rec = this.load()['i' + id];
            if (!rec) return true;
            if (rec.f && Date.now() - rec.f < SEASONS_RETRY) return false;
            if (!rec.t) return true;
            var age = Date.now() - rec.t;
            if (age > SEASONS_TTL) return true;
            // Последний начавшийся сезон: у объявленного, но без даты, её нет
            var last = 0;
            var list = rec.s || [];
            for (var i = 0; i < list.length; i++) if (list[i][1] > last) last = list[i][1];
            return !!latest && latest > last + SEASON_MATCH_DAYS * 86400000 && age > SEASONS_RECHECK;
        },

        fetch: function (net, ids, ok) {
            var self = this;
            var queue = ids.slice(0, SEASONS_FETCH_MAX);
            var next = 0;
            var running = 0;
            var left = queue.length;
            if (!left) return ok();

            function step() {
                while (running < TMDB_INFO_PARALLEL && next < queue.length) ask(queue[next++]);
            }

            function ask(id) {
                running++;
                Tmdb.get(net, 'tv/' + id, function (json) {
                    if (json && json.seasons && json.seasons.length) self.remember(id, json.seasons, true);
                    else self.touch(id, true);
                    after();
                }, function () {
                    // Ответа нет — не спрашиваем снова до следующей проверки
                    self.touch(id, true);
                    after();
                });
            }

            function after() {
                running--;
                left--;
                if (left <= 0) {
                    self.save();
                    return ok();
                }
                step();
            }

            step();
        },

        // Запрос был, сезонов не узнали: прежние данные храним как есть
        touch: function (id, later) {
            var all = this.load();
            if (all['i' + id]) all['i' + id].f = Date.now();
            else all['i' + id] = { t: 0, s: [], f: Date.now() };
            if (!later) this.save();
        },

        // Расставить сезоны TMDB по сезонам Shikimori одного тайтла.
        // family — [{mal, season, date, kind, eps}]; проставляет каждому
        // tseason (сезон TMDB) и toffset (сколько серий этого сезона TMDB
        // приходится на части до него). false — сезонов TMDB не знаем
        place: function (id, family) {
            var rec = this.get(id);
            if (!rec) return false;
            var span = SEASON_MATCH_DAYS * 86400000;
            var list = [];
            var i, j;
            // Только то, что TMDB нумерует: рекап накануне нового сезона иначе
            // занимал его начало, и сам сезон уезжал в «продолжение»
            for (i = 0; i < family.length; i++) {
                if (family[i].date && numbered(family[i])) list.push(family[i]);
            }
            list.sort(function (a, b) { return a.date - b.date; });

            var taken = {};
            var count = {};
            for (i = 0; i < list.length; i++) {
                var f = list[i];
                var exact = null;
                var before = null;
                for (j = 0; j < rec.s.length; j++) {
                    var s = rec.s[j];
                    if (!s[1]) continue;
                    var gap = Math.abs(s[1] - f.date);
                    if (gap <= span && !taken[s[0]] && (!exact || gap < Math.abs(exact[1] - f.date))) exact = s;
                    if (s[1] <= f.date + span && (!before || s[1] > before[1])) before = s;
                }
                var pick = exact || before;
                if (!pick) continue;
                f.tseason = pick[0];
                f.tcount = pick[2] || 0;
                f.texact = !!exact;
                f.toffset = exact ? 0 : (count[pick[0]] || 0);
                if (exact) taken[pick[0]] = true;
                count[pick[0]] = f.toffset + (f.eps || 0);
            }
            return true;
        }
    };

    /* ============================================================
     * Матчинг Shikimori (MAL id) -> TMDB
     * ------------------------------------------------------------
     * 1. Кэш. Выбранное вручную не устаревает никогда
     * 2. ARM — база соответствий. Тип записи в ней — тип MAL, а не TMDB:
     *    у OVA, ONA и спешлов номер TMDB бывает и фильмом, и сериалом,
     *    поэтому в неоднозначных случаях вид уточняется у самого TMDB
     * 3. imdb / tvdb из ARM -> TMDB find
     * 4. Поиск TMDB по всем названиям, каждое — на своём языке, без
     *    фильтра по году: у второго сезона год свой, а сериал в TMDB
     *    начался раньше, и с фильтром TMDB не находил его вовсе
     * 5. Предыдущий сезон: новый сезон почти всегда живёт в том же
     *    сериале TMDB, а в базе соответствий появляется через недели
     * 6. Выбор вручную, в крайнем случае — поиск Lampa по названию
     * ============================================================ */

    var Match = {
        memo: null,
        rev_memo: null,

        cache: function () {
            if (!this.memo) {
                var cache = storGet('shikimori_match', {});
                this.memo = cache && typeof cache == 'object' ? cache : {};
            }
            return this.memo;
        },

        save: function () {
            var cache = this.cache();
            var keys = [];
            for (var k in cache) {
                if (!cache[k].user) keys.push(k);
            }
            if (keys.length > 800) {
                keys.sort(function (a, b) { return (cache[a].time || 0) - (cache[b].time || 0); });
                for (var i = 0; i < keys.length - 800; i++) delete cache[keys[i]];
            }
            storSet('shikimori_match', cache);
        },

        cacheGet: function (mal_id) {
            var hit = this.cache()['m' + mal_id];
            if (!hit) return null;
            if (hit.user) return hit;
            // Найденное по базе живёт месяц, найденное поиском — неделю:
            // когда база узнает о тайтле, её ответ точнее нашей догадки
            var ttl = hit.none ? MATCH_NEG_TTL : (hit.how == 'search' || hit.how == 'prequel' ? 7 * 86400000 : MATCH_TTL);
            if (Date.now() - (hit.time || 0) > ttl) return null;
            return hit;
        },

        cacheSet: function (mal_id, value, later) {
            value.time = Date.now();
            this.cache()['m' + mal_id] = value;
            if (!later) this.save();
        },

        // Вид номера TMDB по ответу ARM. Однозначны лишь два случая:
        // сезон бывает только у сериала, а TV и MOVIE совпадают у MAL и TMDB.
        // Пустая строка — неизвестно, уточним у TMDB при открытии
        armMedia: function (entry) {
            if (entry['themoviedb-season'] != null) return 'tv';
            if (entry.media == 'TV') return 'tv';
            if (entry.media == 'MOVIE') return 'movie';
            return '';
        },

        fromArm: function (entry) {
            var val = {
                tmdb: entry.themoviedb,
                media: this.armMedia(entry),
                season: entry['themoviedb-season'] || 0,
                how: 'arm'
            };
            if (entry['themoviedb-season'] === 0) val.sp = 1;
            return val;
        },

        // Батч-маппинг: [mal,...] -> map mal -> {tmdb, media, season}
        batch: function (net, mal_ids, ok) {
            var result = {};
            var need = [];
            var i;
            for (i = 0; i < mal_ids.length; i++) {
                var hit = this.cacheGet(mal_ids[i]);
                if (hit) {
                    if (!hit.none) result[mal_ids[i]] = hit;
                }
                else need.push(mal_ids[i]);
            }
            if (!need.length) return ok(result);

            var self = this;
            var CHUNK = 80;
            var offset = 0;

            function nextChunk() {
                if (offset >= need.length) {
                    self.save();
                    return ok(result);
                }
                var part = need.slice(offset, offset + CHUNK);
                offset += CHUNK;

                var body = [];
                for (var j = 0; j < part.length; j++) body.push({ myanimelist: part[j] });

                net.post(ARM_BASE + '/api/v2/ids', body, function (list) {
                    if (list && list.length) {
                        for (var j = 0; j < list.length; j++) {
                            var entry = list[j];
                            var mal = part[j];
                            if (entry && entry.themoviedb) {
                                var val = self.fromArm(entry);
                                self.cacheSet(mal, val, true);
                                result[mal] = val;
                            }
                            else self.cacheSet(mal, { none: 1 }, true);
                        }
                    }
                    nextChunk();
                }, function () {
                    // ARM недоступен — работаем с тем, что уже есть
                    self.save();
                    ok(result);
                });
            }

            nextChunk();
        },

        /* ---------- Обратный маппинг: TMDB -> Shikimori ---------- */

        // В TMDB один сериал на все сезоны, а в Shikimori сезон — отдельный
        // тайтл, поэтому ответ — список, по записи на сезон. Ключ — вид плюс
        // номер: номера фильмов и сериалов в TMDB пересекаются
        revCache: function () {
            if (!this.rev_memo) {
                var cache = storGet('shikimori_reverse', {});
                this.rev_memo = cache && typeof cache == 'object' ? cache : {};
            }
            return this.rev_memo;
        },

        reverseGet: function (tmdb, method) {
            var hit = this.revCache()[method + tmdb];
            if (!hit) return null;
            var ttl = hit.mals && hit.mals.length ? REVERSE_TTL : MATCH_NEG_TTL;
            if (Date.now() - (hit.time || 0) > ttl) return null;
            return hit.mals || [];
        },

        // later — записать потом, одним разом (reverseSave): ответы приходят
        // по одному, а хранилище пишется целиком. У списка «Смотрю» на 30
        // тайтлов это было 30 записей подряд
        reverseSet: function (tmdb, method, mals, later) {
            this.revCache()[method + tmdb] = { mals: mals, time: Date.now() };
            if (!later) this.reverseSave();
        },

        reverseSave: function () {
            var cache = this.revCache();
            var keys = [];
            for (var k in cache) keys.push(k);
            if (keys.length > 400) {
                keys.sort(function (a, b) { return (cache[a].time || 0) - (cache[b].time || 0); });
                for (var i = 0; i < keys.length - 400; i++) delete cache[keys[i]];
            }
            storSet('shikimori_reverse', cache);
        },

        // ARM ищет по числу и не спрашивает, фильм это или сериал: сериалу
        // 5555 доставались записи фильма 5555. Берём только то, что по данным
        // ARM подходит к виду закладки
        pickReverse: function (list, method) {
            var mals = [];
            for (var j = 0; j < (list || []).length; j++) {
                var entry = list[j];
                if (!entry || !entry.myanimelist) continue;
                var media = this.armMedia(entry);
                // Вид неизвестен, но есть номер TVDB — это сериал
                if (!media && entry.thetvdb) media = 'tv';
                if (method == 'tv' ? media != 'tv' : media == 'tv') continue;
                var rec = { mal: entry.myanimelist, season: entry['themoviedb-season'] || 0 };
                // Сезон 0 у TMDB — спецвыпуски: в нумерацию обычных сезонов не входят
                if (entry['themoviedb-season'] === 0) rec.sp = 1;
                mals.push(rec);
            }
            return mals;
        },

        // cards: [{id, method, name, original_name, year}]
        reverse: function (net, cards, ok) {
            var self = this;
            var result = {};
            var need = [];
            var searches = [];
            var i;

            for (i = 0; i < cards.length; i++) {
                var hit = this.reverseGet(cards[i].id, cards[i].method);
                if (hit) result[cards[i].id] = hit;
                else need.push(cards[i]);
            }

            need = need.slice(0, REVERSE_MAX);
            if (!need.length) return ok(result);

            var index = 0;
            var alive = Math.min(REVERSE_PARALLEL, need.length);
            var done = alive;
            var dirty = false;

            for (i = 0; i < alive; i++) worker();

            function worker() {
                if (index >= need.length) {
                    done--;
                    if (done <= 0) {
                        if (dirty) self.reverseSave();
                        bySearch();
                    }
                    return;
                }
                var card = need[index++];
                net.get(ARM_BASE + '/api/v2/themoviedb?id=' + card.id, function (list) {
                    var mals = self.pickReverse(list, card.method);
                    if (mals.length) {
                        self.reverseSet(card.id, card.method, mals, true);
                        dirty = true;
                        result[card.id] = mals;
                    }
                    else searches.push(card);
                    worker();
                }, function () {
                    // ARM не ответил — не кэшируем пустоту, попробуем в следующий раз
                    worker();
                });
            }

            // Чего нет в базе соответствий — ищем в Shikimori по названию:
            // для новинки сезона это единственный способ узнать о ней в срок
            function bySearch() {
                self.searchReverse(net, searches.slice(0, REVERSE_SEARCH_MAX), function (found) {
                    for (var id in found) result[id] = found[id];
                    ok(result);
                });
            }
        },

        searchReverse: function (net, cards, ok) {
            var self = this;
            var found = {};
            var index = 0;
            var dirty = false;

            function next() {
                if (index >= cards.length) {
                    if (dirty) self.reverseSave();
                    return ok(found);
                }
                var card = cards[index++];
                var queries = [];
                if (card.original_name) queries.push(Titles.base(card.original_name) || card.original_name);
                if (card.name && card.name != card.original_name) queries.push(Titles.base(card.name) || card.name);
                ask(card, queries, 0);
            }

            function ask(card, queries, at) {
                if (at >= queries.length) {
                    self.reverseSet(card.id, card.method, [], true);
                    dirty = true;
                    return next();
                }
                var kinds = card.method == 'movie' ? 'movie' : 'tv,ona,tv_special,ova,special';
                Shiki.search(net, queries[at], kinds, function (list) {
                    var mals = self.pickSearch(list, card);
                    if (!mals.length) return ask(card, queries, at + 1);
                    self.reverseSet(card.id, card.method, mals, true);
                    dirty = true;
                    found[card.id] = mals;
                    next();
                }, function () {
                    // Shikimori не ответил — пустоту не запоминаем
                    next();
                });
            }

            next();
        },

        // Из выдачи поиска — то, что действительно этот тайтл: название
        // совпадает (без пометок сезона), и вышел он не раньше самого сериала
        pickSearch: function (list, card) {
            var theirs = [card.original_name, card.name];
            var picked = [];
            for (var i = 0; i < (list || []).length; i++) {
                var a = list[i];
                if (card.method == 'tv' && a.kind == 'movie') continue;
                if (Titles.best(Titles.of(a), theirs) < 0.85) continue;
                var year = (a.airedOn && a.airedOn.year) || 0;
                if (card.year && year && year < card.year - 1) continue;
                var mal = parseInt(a.malId || a.id, 10);
                if (mal) picked.push({ mal: mal, season: 0, year: year });
            }
            picked.sort(function (x, y) { return x.year - y.year; });
            var mals = [];
            for (i = 0; i < picked.length; i++) mals.push({ mal: picked[i].mal, season: 0 });
            return mals;
        },

        /* ---------- Прямой маппинг ---------- */

        // Одиночный маппинг с полным фолбэком. ok({id, method}), fail(кандидаты)
        resolve: function (net, anime, ok, fail) {
            var self = this;
            var mal_id = parseInt(anime.malId || anime.id, 10);
            var hit = this.cacheGet(mal_id);
            if (hit && !hit.none) return this.finalize(net, mal_id, hit, anime, ok);

            net.get(ARM_BASE + '/api/v2/ids?source=myanimelist&id=' + mal_id, function (map) {
                if (map && map.themoviedb) {
                    var val = self.fromArm(map);
                    self.cacheSet(mal_id, val);
                    return self.finalize(net, mal_id, val, anime, ok);
                }
                if (map && (map.imdb || map.thetvdb)) {
                    return self.findByExternal(net, mal_id, map, anime, ok, search);
                }
                search();
            }, search, ARM_TIMEOUT);

            function search() {
                self.withTitles(net, anime, function (full) {
                    self.searchTmdb(net, full, false, function (best, list) {
                        if (best) {
                            self.cacheSet(mal_id, { tmdb: best.id, media: best._type, season: 0, how: 'search' });
                            return ok({ id: best.id, method: best._type });
                        }
                        if (full.kind == 'movie') return nothing(list);
                        // Уверенного совпадения нет — спросим у предыдущего сезона
                        self.viaPrequel(net, full, function (found) {
                            self.cacheSet(mal_id, { tmdb: found.id, media: 'tv', season: 0, how: 'prequel' });
                            ok(found);
                        }, function () {
                            nothing(list);
                        });
                    });
                });
            }

            function nothing(list) {
                // «Не найдено» помним, только когда и выбрать было не из чего
                if (!list.length) self.cacheSet(mal_id, { none: 1 });
                fail(list);
            }
        },

        // Номер известен, вид — нет: уточняем у TMDB и запоминаем ответ
        finalize: function (net, mal_id, val, anime, ok) {
            if (val.media) return ok({ id: val.tmdb, method: val.media });
            var self = this;
            this.verifyMedia(net, val.tmdb, anime, function (media, sure) {
                if (sure) {
                    val.media = media;
                    self.cacheSet(mal_id, val);
                }
                ok({ id: val.tmdb, method: media });
            });
        },

        // Сериал это или фильм — смотрим, какой из двух вариантов похож на
        // наше аниме. Первым пробуем более вероятный по типу тайтла
        verifyMedia: function (net, tmdb_id, anime, done) {
            var self = this;
            var first = anime && anime.kind == 'movie' ? 'movie' : 'tv';
            var second = first == 'tv' ? 'movie' : 'tv';
            var ours = Titles.of(anime || {});

            function probe(method, next) {
                Tmdb.get(net, method + '/' + tmdb_id, function (json) {
                    next(!!(json && json.id) && self.plausible(json, ours));
                }, function (reason) {
                    // Такого номера нет — это ответ. Молчит сеть — второй запрос
                    // простоит тот же таймаут, поэтому решаем по типу тайтла
                    if (reason == 404) next(false);
                    else done(first, false);
                });
            }

            probe(first, function (good) {
                if (good) return done(first, true);
                probe(second, function (good2) {
                    if (good2) return done(second, true);
                    // Ни один не похож или TMDB молчит — остаёмся при типе тайтла
                    done(first, false);
                });
            });
        },

        plausible: function (json, ours) {
            var anim = (json.genre_ids || []).indexOf(16) >= 0;
            var genres = json.genres || [];
            for (var i = 0; i < genres.length; i++) {
                if (genres[i] && genres[i].id == 16) anim = true;
            }
            var jp = json.original_language == 'ja' || (json.origin_country || []).indexOf('JP') >= 0;
            if (!anim && !jp) return false;
            if (!ours.length) return true;
            return Titles.best(ours, [json.name, json.original_name, json.title, json.original_title]) >= 0.5;
        },

        findByExternal: function (net, mal_id, map, anime, ok, fail) {
            var self = this;
            var ext = map.imdb ? map.imdb : map.thetvdb;
            var src = map.imdb ? 'imdb_id' : 'tvdb_id';
            Tmdb.get(net, 'find/' + ext + '?external_source=' + src, function (found) {
                var tv = (found && found.tv_results) || [];
                var mv = (found && found.movie_results) || [];
                var movie_first = anime.kind == 'movie';
                var pick = movie_first ? (mv[0] ? ['movie', mv[0]] : tv[0] ? ['tv', tv[0]] : null)
                                       : (tv[0] ? ['tv', tv[0]] : mv[0] ? ['movie', mv[0]] : null);
                if (!pick) return fail();
                self.cacheSet(mal_id, { tmdb: pick[1].id, media: pick[0], season: 0, how: 'find' });
                ok({ id: pick[1].id, method: pick[0] });
            }, function () {
                fail();
            });
        },

        // У карточек календаря и ленты Kodik нет английского и японского
        // названий, а для поиска нужны именно они — дозапрашиваем
        withTitles: function (net, anime, done) {
            if (anime.japanese && anime.related) return done(anime);
            var mal_id = parseInt(anime.malId || anime.id, 10);
            Shiki.titles(net, mal_id, function (full) {
                if (!full) return done(anime);
                var merged = {};
                for (var k in anime) merged[k] = anime[k];
                for (k in full) {
                    if (full[k] !== null && full[k] !== undefined && full[k] !== '') merged[k] = full[k];
                }
                done(merged);
            }, function () {
                done(anime);
            });
        },

        // Сиквел ли это: есть предыдущий сезон или в названии пометка сезона
        isSequel: function (anime) {
            var rel = anime.related || [];
            for (var i = 0; i < rel.length; i++) {
                if (rel[i] && rel[i].relationKind == 'prequel') return true;
            }
            var names = Titles.of(anime);
            for (i = 0; i < names.length; i++) {
                if (Titles.norm(Titles.base(names[i])) != Titles.norm(names[i])) return true;
            }
            return false;
        },

        judge: function (c, ours, year, sequel) {
            var anim = (c.genre_ids || []).indexOf(16) >= 0;
            var jp = c.original_language == 'ja' || (c.origin_country || []).indexOf('JP') >= 0;
            // Только анимация или японское: в TMDB у новинки жанр бывает ещё не проставлен
            if (!anim && !jp) return null;
            var sim = Titles.best(ours, [c.name, c.original_name, c.title, c.original_title]);
            if (sim < 0.5) return null;

            var cyear = parseInt(String(c.first_air_date || c.release_date || '').slice(0, 4), 10) || 0;
            var ys = 0;
            if (year && cyear) {
                if (cyear > year + 1) ys = -2;               // вышло позже нашего тайтла — точно не он
                else if (sequel) ys = cyear <= year ? 0.5 : 0; // сериал начался раньше сезона — так и должно быть
                else ys = Math.abs(cyear - year) <= 1 ? 1 : -0.5;
            }
            return {
                sim: sim,
                val: 3 * sim + ys + (anim ? 0.5 : 0) + (jp ? 0.5 : 0) + Math.min(c.popularity || 0, 100) / 1000
            };
        },

        // Поиск в TMDB по всем названиям. done(уверенный или null, кандидаты).
        // Каждое название ищем на его языке: тогда и название кандидата
        // приходит на том же языке, и сравнение имеет смысл. Раньше
        // английское и ромадзи сравнивались с русскими названиями TMDB,
        // а японское не использовалось вовсе
        searchTmdb: function (net, anime, exhaustive, done) {
            var self = this;
            var kind = anime.kind || 'tv';
            var types = kind == 'movie' ? ['movie', 'tv'] : (kind == 'tv' || kind == 'tv_special' ? ['tv'] : ['tv', 'movie']);
            var year = anime.airedOn && anime.airedOn.year ? anime.airedOn.year : (anime.aired_on ? parseInt(anime.aired_on, 10) : 0);
            var ours = Titles.of(anime);
            var sequel = this.isSequel(anime);

            var english = anime.english;
            if (Object.prototype.toString.call(english) === '[object Array]') english = english[0];

            var queries = [];
            function addQuery(title, lang) {
                var q = Titles.base(title);
                if (!q) return;
                for (var i = 0; i < queries.length; i++) if (queries[i].q == q) return;
                queries.push({ q: q, lang: lang });
            }
            addQuery(anime.japanese, Tmdb.lang());
            addQuery(anime.russian, 'ru');
            addQuery(english, 'en-US');
            addQuery(anime.name, 'en-US');

            if (!queries.length) return done(null, []);

            var seen = {};
            var scored = [];
            var t = 0;
            var q = 0;

            function add(c, type) {
                var judged = self.judge(c, ours, year, sequel);
                if (!judged) return;
                var key = type + c.id;
                if (seen[key]) {
                    if (judged.val > seen[key]._judge.val) seen[key]._judge = judged;
                    return;
                }
                c._type = type;
                c._judge = judged;
                seen[key] = c;
                scored.push(c);
            }

            function confident() {
                scored.sort(function (a, b) { return b._judge.val - a._judge.val; });
                var top = scored[0];
                var second = scored[1];
                if (!top) return null;
                var gap = second ? top._judge.val - second._judge.val : 99;
                if (top._judge.sim >= 0.9 && gap >= 0.5) return top;
                if (top._judge.sim >= 0.75 && gap >= 1.2) return top;
                return null;
            }

            function next() {
                if (q >= queries.length) {
                    t++;
                    q = 0;
                    // Первый вид дал уверенный ответ — второй не нужен
                    if (!exhaustive && confident()) return finish();
                }
                if (t >= types.length) return finish();

                var query = queries[q++];
                var type = types[t];
                Tmdb.get(net, 'search/' + type + '?query=' + encodeURIComponent(query.q) + '&include_adult=false', function (resp) {
                    var results = (resp && resp.results) || [];
                    for (var i = 0; i < results.length; i++) add(results[i], type);
                    if (!exhaustive && confident()) return finish();
                    next();
                }, function () {
                    // Не ответили оба пути — TMDB сейчас недоступен, и остальные
                    // запросы простоят тот же таймаут. Решаем по тому, что есть
                    finish();
                }, query.lang);
            }

            function finish() {
                var best = confident();
                done(exhaustive ? null : best, scored.slice(0, 10));
            }

            next();
        },

        // Новый сезон почти всегда живёт в TMDB внутри того же сериала, что
        // и прошлый, а в базе соответствий появляется с опозданием в недели.
        // Поэтому, если прямого соответствия нет, идём к предыдущему сезону
        viaPrequel: function (net, anime, ok, fail) {
            var self = this;
            var seen = {};
            var depth = 0;

            function prequels(entry) {
                var list = [];
                var rel = (entry && entry.related) || [];
                for (var i = 0; i < rel.length; i++) {
                    var r = rel[i];
                    if (!r || r.relationKind != 'prequel' || !r.anime || r.anime.kind == 'movie') continue;
                    var id = parseInt(r.anime.id, 10);
                    if (id && !seen[id]) {
                        seen[id] = true;
                        list.push(id);
                    }
                }
                return list;
            }

            function step(ids) {
                if (!ids.length || depth++ >= SEQUEL_DEPTH) return fail();
                self.batch(net, ids, function (map) {
                    for (var i = 0; i < ids.length; i++) {
                        var m = map[ids[i]];
                        if (m && m.media != 'movie') return ok({ id: m.tmdb, method: 'tv' });
                    }
                    Shiki.related(net, ids, function (rel) {
                        var more = [];
                        for (var k = 0; k < ids.length; k++) more = more.concat(prequels(rel[ids[k]]));
                        step(more);
                    }, fail);
                });
            }

            step(prequels(anime));
        },

        // То же для тайтлов из списка Shikimori, которых нет в базе: новый
        // сезон смотрят с первой серии, а база узнаёт о нём через недели.
        // Без сопоставления отметки Lampa у него не прочесть, и просмотренное
        // висело в «Новых сериях» целиком. Прошлого сезона нет (первый сезон,
        // новый сериал) — ищем в TMDB по названиям, как при открытии карточки.
        // Найденное запоминаем — со следующего показа такой тайтл считается
        // по семье сезонов, как закладка. Не нашли — не ищем до следующего
        // ответа базы, чтобы не спрашивать TMDB при каждом показе
        lostBatch: function (net, sids, done) {
            var self = this;
            var left = 0;
            var found = [];
            var dirty = false;
            if (!sids.length) return done();

            Shiki.related(net, sids, function (info) {
                var pre = [];
                for (var i = 0; i < sids.length; i++) {
                    var rel = (info[sids[i]] && info[sids[i]].related) || [];
                    if (info[sids[i]]) left++;
                    for (var r = 0; r < rel.length; r++) {
                        var a = rel[r] && rel[r].relationKind == 'prequel' && rel[r].anime;
                        var pid = a && a.kind != 'movie' ? parseInt(a.id, 10) : 0;
                        if (pid && pre.indexOf(pid) < 0) pre.push(pid);
                    }
                }
                if (!left) return done();
                // Прошлые сезоны всех тайтлов — одним запросом к базе: дальше
                // viaPrequel берёт их из кеша, а не спрашивает по одному
                self.batch(net, pre, function () {
                    for (var j = 0; j < sids.length; j++) {
                        if (info[sids[j]]) one(sids[j], info[sids[j]]);
                    }
                });
            }, function () {
                done();
            });

            function one(sid, entry) {
                self.viaPrequel(net, entry, function (hit) {
                    remember(sid, { tmdb: hit.id, media: 'tv', season: 0, how: 'prequel' }, hit.id);
                }, function () {
                    self.withTitles(net, entry, function (full) {
                        self.searchTmdb(net, full, false, function (best) {
                            if (best && best._type == 'tv') return remember(sid, { tmdb: best.id, media: 'tv', season: 0, how: 'search' }, best.id);
                            remember(sid, { none: 1, tried: 1 }, 0);
                        });
                    });
                });
            }

            // Пока искали, тайтл могли сопоставить: выбрали карточку вручную
            // или ответила база. Их ответ точнее нашей догадки — не трогаем
            function remember(sid, value, tmdb) {
                var now = self.cache()['m' + sid];
                if (!now || now.none) {
                    self.cacheSet(sid, value, true);
                    dirty = true;
                    if (tmdb && found.indexOf(tmdb) < 0) found.push(tmdb);
                }
                settle();
            }

            function settle() {
                if (--left > 0) return;
                if (dirty) self.save();
                if (!found.length) return done();
                var cards = [];
                for (var i = 0; i < found.length; i++) cards.push({ id: found[i], name: '-' });
                TmdbInfo.fill(net, cards, done);
            }
        },

        // Полный сценарий: открыть карточку TMDB по аниме Shikimori
        openCard: function (anime) {
            var loading = true;
            try {
                Lampa.Loading.start(function () {
                    loading = false;
                    background_net.clear();
                });
            } catch (e) {}

            function stop() {
                try { Lampa.Loading.stop(); } catch (e) {}
            }

            Match.resolve(background_net, anime, function (found) {
                stop();
                if (loading) openTmdb(found, anime);
            }, function (list) {
                stop();
                if (loading) Match.offer(anime, list);
            });
        },

        // Сопоставление ошиблось — выбрать карточку самому. Показываем всех
        // правдоподобных кандидатов, без порога уверенности
        rematch: function (anime) {
            var self = this;
            var loading = true;
            try {
                Lampa.Loading.start(function () {
                    loading = false;
                    background_net.clear();
                });
            } catch (e) {}

            this.withTitles(background_net, anime, function (full) {
                self.searchTmdb(background_net, full, true, function (best, list) {
                    try { Lampa.Loading.stop(); } catch (e) {}
                    if (loading) self.offer(full, list, true);
                });
            });
        },

        // Несколько похожих или ни одного уверенного — даём выбрать.
        // Выбранное запоминается навсегда: второй раз спрашивать незачем.
        // Не нашлось ничего — открываем поиск Lampa с названием: раньше
        // здесь был тупик «Не найдено в TMDB»
        offer: function (anime, candidates, always) {
            var mal_id = parseInt(anime.malId || anime.id, 10);
            var title = anime.russian || anime.name || '';

            if (!candidates.length && !always) {
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_not_found') + ': ' + title);
                return searchLampa(title);
            }

            var owner = ownerController();
            var items = [];
            for (var j = 0; j < Math.min(candidates.length, 8); j++) {
                var c = candidates[j];
                var year = String(c.first_air_date || c.release_date || '').slice(0, 4);
                var orig = c.original_name || c.original_title || '';
                var name = c.name || c.title || orig || '?';
                items.push({
                    title: name + (year ? ' (' + year + ')' : ''),
                    subtitle: Lampa.Lang.translate(c._type == 'movie' ? 'shikimori_kind_movie' : 'shikimori_kind_tv') +
                        (orig && orig != name ? ' · ' + orig : ''),
                    candidate: c
                });
            }
            items.push({
                title: Lampa.Lang.translate('shikimori_search_lampa'),
                subtitle: title,
                action: 'search'
            });

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_pick_title'),
                items: items,
                onSelect: function (item) {
                    restoreController(owner);
                    if (item.action == 'search') return searchLampa(title);
                    var pick = item.candidate;
                    Match.cacheSet(mal_id, { tmdb: pick.id, media: pick._type, season: 0, how: 'user', user: 1 });
                    openTmdb({ id: pick.id, method: pick._type }, anime);
                },
                onBack: function () {
                    restoreController(owner);
                }
            });
        }
    };

    // Источник, через который Lampa загрузит карточку. У закладки он свой —
    // его и берём; иначе выбранный в настройках, если он работает с номерами
    // TMDB. CUB раздаёт TMDB через свои зеркала и открывается там, где прямой
    // TMDB заблокирован
    function tmdbSource(card) {
        var own = card && card._tmdb_card ? card.source : '';
        if (own) return own;
        var source = '';
        try { source = Lampa.Storage.field('source'); } catch (e) {}
        return source == 'cub' ? 'cub' : 'tmdb';
    }

    // Открыть карточку TMDB. Саму карточку не запрашиваем: её загрузит
    // компонент full тем же путём, что и любую карточку Lampa, — через
    // выбранный источник, прокси TMDB и зеркала CUB. Раньше плагин сперва
    // сам тянул tv/{id} напрямую, и если TMDB в эту минуту не отвечал,
    // человек видел «Не найдено в TMDB» там, где Lampa открыла бы карточку
    // без труда
    function openTmdb(found, hint) {
        var method = found.method == 'movie' ? 'movie' : 'tv';
        var source = tmdbSource(hint);
        var card;

        if (hint && hint._tmdb_card && hint.id == found.id) {
            card = {};
            for (var k in hint) {
                if (k.charAt(0) != '_') card[k] = hint[k];
            }
        }
        else {
            card = { id: found.id };
            var title = hint ? (hint.russian || hint.name || '') : '';
            if (method == 'tv') card.name = title;
            else card.title = title;
        }
        card.source = source;

        Lampa.Activity.push({
            url: '',
            component: 'full',
            id: found.id,
            method: method,
            card: card,
            source: source
        });
    }

    // Поиск самой Lampa с названием тайтла — последний шаг, когда
    // сопоставить автоматически не вышло
    function searchLampa(query) {
        try { Lampa.Search.open({ input: query }); }
        catch (e) {}
    }

    /* ============================================================
     * Пользовательские данные: списки + календарь + закладки Lampa
     * ============================================================ */

    var UserData = {
        rates_cache: null,
        rates_time: 0,

        // Списки пользователя (кэш 10 минут):
        // 1) плоский REST v2 со всеми статусами -> membership-карта mals
        // 2) GraphQL animes(ids:) -> карточки для «Я смотрю»
        rates: function (net, ok, err) {
            var nick = storString('shikimori_user', '');
            if (!nick) return err('no_user');
            var self = this;
            if (this.rates_cache && Date.now() - this.rates_time < RATES_TTL) return ok(this.rates_cache);

            Shiki.userId(net, nick, function (user_id) {
                Shiki.userRatesFlat(net, user_id, function (flat) {
                    var mals = {};
                    var watching_ids = [];
                    for (var i = 0; i < flat.length; i++) {
                        var rate = flat[i];
                        if (!rate || !rate.target_id || rate.status == 'dropped') continue;
                        mals[rate.target_id] = { id: rate.id, status: rate.status, episodes: rate.episodes || 0, score: rate.score || 0 };
                        if (rate.status == 'watching' || rate.status == 'rewatching') watching_ids.push(rate.target_id);
                    }

                    Shiki.animesByIds(net, watching_ids, function (animes) {
                        var watching = [];
                        for (var i = 0; i < animes.length; i++) {
                            var item = animes[i];
                            var rate = mals[parseInt(item.malId || item.id, 10)];
                            if (rate) {
                                item._rate_status = rate.status;
                                item._rate_episodes = rate.episodes;
                                item._rate_score = rate.score;
                            }
                            watching.push(item);
                        }
                        var result = { watching: watching, mals: mals };
                        self.rates_cache = result;
                        self.rates_time = Date.now();
                        ok(result);
                    }, err);
                }, err);
            }, err);
        },

        dropRatesCache: function () {
            this.rates_cache = null;
            this.rates_time = 0;
        },

        // Карточки закладок Lampa/CUB, похожие на аниме.
        // Категорию запоминаем: «Смотрю» отличается от остальных
        lampaFavorites: function () {
            var cards = [];
            var seen = {};
            var groups = ['wath', 'book', 'like', 'look', 'scheduled', 'continued', 'viewed'];
            for (var i = 0; i < groups.length; i++) {
                var list = [];
                try { list = Lampa.Favorite.get({ type: groups[i] }) || []; } catch (e) {}
                for (var j = 0; j < list.length; j++) {
                    var card = list[j];
                    if (!card || !card.id) continue;
                    // Закладки других источников (Кинопоиск и т.п.) нумеруются
                    // по-своему: их номер — не номер TMDB, сопоставлять нечего
                    if (card.source && card.source != 'tmdb' && card.source != 'cub') continue;
                    if (seen['f' + card.id]) {
                        seen['f' + card.id]._fav_groups[groups[i]] = true;
                        continue;
                    }
                    if (!looksLikeAnime(card)) continue;
                    card._fav_groups = {};
                    card._fav_groups[groups[i]] = true;
                    seen['f' + card.id] = card;
                    cards.push(card);
                }
            }
            return cards;
        },

        // При включённом аккаунте закладки приезжают асинхронно: сперва из кэша,
        // потом с сервера. Если на момент сборки их ещё нет — ждём событие,
        // но недолго, иначе экран будет пустым у тех, у кого закладок правда нет
        favorites: function (ok) {
            var self = this;
            var list = this.lampaFavorites();
            if (list.length) return ok(list);

            var logged = false;
            try {
                logged = !!(Lampa.Account &&
                    ((typeof Lampa.Account.logged == 'function' && Lampa.Account.logged()) ||
                     (Lampa.Account.Permit && Lampa.Account.Permit.sync)));
            }
            catch (e) {}
            if (!logged) return ok(list);

            var done = false;
            var timer = setTimeout(finish, FAVORITES_WAIT);

            function listener(e) {
                if (e && e.target == 'favorite') finish();
            }

            try { Lampa.Listener.follow('state:changed', listener); }
            catch (e) { return finish(); }

            function finish() {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { Lampa.Listener.remove('state:changed', listener); } catch (e) {}
                ok(self.lampaFavorites());
            }
        },

        // Всё, за чем следит пользователь: избранное Lampa любой категории плюс
        // списки Shikimori. Прогресс — из самой Lampa, доступные серии — из Kodik.
        // background — пересчёт счётчика в меню: экрана, который ждал бы,
        // нет, поэтому и обрезать ответы по времени незачем
        tracked: function (net, rates, ok, background) {
            var lookup_wait = background ? BACKGROUND_WAIT : KODIK_LOOKUP_WAIT;
            var seasons_wait = background ? BACKGROUND_WAIT : SEASONS_WAIT;
            var favorites = [];
            var mals = (rates && rates.mals) || {};
            var watching = (rates && rates.watching) || [];

            var rev_map = {};      // tmdb -> [{mal, season}]
            var methods = {};      // tmdb -> tv | movie
            var shiki_info = {};   // 's' + mal -> тайтл Shikimori (статус, серии, связи)
            var lonely = {};       // tmdb -> семья тайтла из списка — только он сам

            // Лента Kodik от закладок не зависит — грузим её сразу, параллельно
            // с сопоставлением. Раньше она ждала, пока сопоставятся все закладки
            var feed_rows = null;
            var feed_wait = null;
            if (Kodik.enabled()) {
                Kodik.feed(net, gotFeed, function () { gotFeed([]); });
            }

            // Подготовка, которую сборка ждёт не дольше SEASONS_WAIT сверх
            // остального: имена и сезоны TMDB. Без них отметки Lampa не
            // сопоставить с сезонами Shikimori. Что не успело — учтётся
            // при следующем показе, ответы запоминаются
            var pending = 0;
            var pending_go = null;

            function hold() {
                pending++;
            }

            function release() {
                pending--;
                if (pending <= 0 && pending_go) {
                    var go = pending_go;
                    pending_go = null;
                    go();
                }
            }

            // Номер TMDB попадает сюда и из списка, и из семьи закладки — пока
            // первый запрос в пути, второй его повторял бы
            var seasons_asked = {};
            function loadSeasons(ids) {
                var ask = [];
                for (var a = 0; a < ids.length; a++) {
                    if (seasons_asked[ids[a]]) continue;
                    seasons_asked[ids[a]] = true;
                    ask.push(ids[a]);
                }
                if (!ask.length) return;
                hold();
                Seasons.fetch(background_net, ask, release);
            }

            // Выходит сейчас или озвучка свежая — тут и решается «новое или нет»
            function isHot(sid, info) {
                if (info && info.status == 'ongoing') return true;
                var rec = Kodik.known(sid);
                return !!rec && rec.at >= Date.now() - KODIK_FRESH_DAYS * 86400000;
            }

            // Имена TMDB для списков Shikimori — чтобы видеть отмеченное в Lampa,
            // и сезоны TMDB для того из них, что выходит сейчас
            var watch_sids = [];
            var watch_hot = {};
            var watch_kinds = {};
            for (var w = 0; w < watching.length; w++) {
                var wsid = parseInt(watching[w].malId || watching[w].id, 10);
                if (!wsid) continue;
                watch_sids.push(wsid);
                watch_kinds[wsid] = watching[w].kind;
                if (isHot(wsid, watching[w])) watch_hot[wsid] = dayOf(watching[w].airedOn && watching[w].airedOn.date) || 1;
            }
            if (watch_sids.length) {
                hold();
                TmdbInfo.names(watch_sids, function (map) {
                    var ids = [];
                    for (var k in map) {
                        var hit = map[k];
                        if (!hit || !hit.tmdb || !isSeries(hit, watch_kinds[k]) || !watch_hot[k]) continue;
                        if (ids.indexOf(hit.tmdb) < 0 && Seasons.needs(hit.tmdb, watch_hot[k])) ids.push(hit.tmdb);
                    }
                    loadSeasons(ids);
                    // Чего нет в базе соответствий — ищем через прошлый сезон или
                    // по названиям, в фоне: сборка этого не ждёт. Только если база
                    // ответила «не знаю»: недоступна — её ответ ещё придёт, и неделю
                    // перекрывать его догадкой незачем
                    var lost = [];
                    for (var n = 0; n < watch_sids.length && lost.length < LOST_MATCH_MAX; n++) {
                        var lsid = watch_sids[n];
                        var lhit = Match.cacheGet(lsid);
                        if (lhit && lhit.none && !lhit.tried && watch_hot[lsid] && SERIES_KINDS.indexOf(watch_kinds[lsid]) >= 0) lost.push(lsid);
                    }
                    if (lost.length) Match.lostBatch(background_net, lost, function () {});
                    release();
                }, watch_kinds);
            }

            function gotFeed(rows) {
                feed_rows = rows || [];
                if (feed_wait) {
                    var go = feed_wait;
                    feed_wait = null;
                    go();
                }
            }

            // Тайтлы из списка Shikimori с уже известной карточкой TMDB: семью
            // сезонов собираем и для них — прогресс по отметкам Lampa тогда
            // считается так же, как у закладок, а не по одному тайтлу вслепую
            function listCards() {
                var out = [];
                for (var w = 0; w < watching.length; w++) {
                    var lsid = parseInt(watching[w].malId || watching[w].id, 10);
                    var lhit = lsid ? Match.cacheGet(lsid) : null;
                    if (!lhit || lhit.none || !lhit.tmdb || !isSeries(lhit, watching[w].kind)) continue;
                    var linfo = TmdbInfo.get(lhit.tmdb, 'tv');
                    out.push({
                        id: lhit.tmdb,
                        method: 'tv',
                        sid: lsid,
                        season: lhit.season || 0,
                        sp: lhit.sp ? 1 : 0,
                        name: watching[w].russian || watching[w].name || '',
                        original_name: (linfo && linfo.original_name) || watching[w].japanese || watching[w].name || '',
                        year: (watching[w].airedOn && watching[w].airedOn.year) || 0
                    });
                }
                return out;
            }

            // Сопоставление закладок идёт первым: без id Shikimori мы не можем
            // спросить Kodik про избранное, а раньше и не спрашивали — про
            // онгоинг из «Позже» узнавали, только если он попадал в суточную ленту
            this.favorites(function (list) {
                favorites = list;
                var virtual = listCards();

                if (!favorites.length && !virtual.length) return feed();

                // Сначала добираем недостающее у TMDB: без настоящего
                // original_name отметки просмотра не найти, и по нему же
                // ищем в Shikimori то, чего нет в базе соответствий
                TmdbInfo.fill(net, favorites, function () {
                    var cards = [];
                    for (var i = 0; i < favorites.length; i++) {
                        var card = favorites[i];
                        TmdbInfo.apply(card);
                        var method = card.name || card.original_name ? 'tv' : 'movie';
                        methods[card.id] = method;
                        cards.push({
                            id: card.id,
                            method: method,
                            name: card.name || card.title || '',
                            original_name: card._tmdb_name || card.original_name || card.original_title || '',
                            year: parseInt(String(card.first_air_date || card.release_date || card._tmdb_year || '').slice(0, 4), 10) || 0
                        });
                    }
                    var vcards = [];
                    for (i = 0; i < virtual.length; i++) {
                        if (methods[virtual[i].id]) continue;   // уже в закладках
                        methods[virtual[i].id] = 'tv';
                        vcards.push(virtual[i]);
                    }

                    // Закладки ждут базу соответствий, как и раньше. Тайтлы списка —
                    // не дольше lookup_wait: без закладок главная базу не ждала
                    // вовсе, и зависшая база стоила бы им всех личных строк.
                    // Не дождались — семья из кеша, ответ базы запомнится к
                    // следующему показу
                    var rev_books = null;
                    var rev_list = null;
                    var list_timer = setTimeout(function () {
                        if (rev_list) return;
                        rev_list = {};
                        for (var c = 0; c < vcards.length; c++) {
                            var cached = Match.reverseGet(vcards[c].id, 'tv');
                            if (cached) rev_list[vcards[c].id] = cached;
                        }
                        joined();
                    }, lookup_wait);
                    Match.reverse(net, cards, function (rev) {
                        rev_books = rev || {};
                        joined();
                    });
                    Match.reverse(net, vcards, function (rev) {
                        if (rev_list) return;
                        clearTimeout(list_timer);
                        rev_list = rev || {};
                        joined();
                    });

                    function joined() {
                        if (!rev_books || !rev_list) return;
                        // Копии: семьи ниже дополняются, а Lampa отдаёт из хранилища
                        // тот же объект — дополнения уезжали в кеш соответствий
                        rev_map = {};
                        var key;
                        for (key in rev_books) rev_map[key] = rev_books[key].slice();
                        for (key in rev_list) rev_map[key] = rev_list[key].slice();
                        // Сам тайтл из списка — в семье, даже если база соответствий
                        // знает его только в одну сторону. Номер TMDB занят фильмом
                        // из закладок — это не его семья: номера фильмов и сериалов
                        // в TMDB пересекаются
                        for (var v = 0; v < virtual.length; v++) {
                            if (methods[virtual[v].id] != 'tv') continue;
                            // Ответа базы нет (не успела, сбой, лимит запросов) — семья
                            // из одного тайтла: вторая часть сплит-кура без первой
                            // считалась бы с нулевым смещением и пряталась. Такие —
                            // по одному тайтлу, как раньше (Progress.ofShiki)
                            if (!rev_map[virtual[v].id]) lonely[virtual[v].id] = true;
                            var fam = rev_map[virtual[v].id] || (rev_map[virtual[v].id] = []);
                            var found = false;
                            for (var f = 0; f < fam.length; f++) if (fam[f].mal == virtual[v].sid) found = true;
                            if (!found) fam.push({ mal: virtual[v].sid, season: virtual[v].season, sp: virtual[v].sp });
                        }
                        sequels();
                    }
                });
            });

            // Новые сезоны закладок. База соответствий узнаёт о них через недели,
            // а смотреть их начинают в день выхода: у закладки на «Фрирен» был
            // только первый сезон, и о сериях второго плагин не знал вовсе.
            // Идём от известных сезонов по связи «продолжение»; тем же запросом
            // берём у Shikimori статус и число вышедших серий
            function sequels() {
                var ids = [];
                for (var key in rev_map) {
                    var seasons = rev_map[key] || [];
                    for (var i = 0; i < seasons.length; i++) {
                        if (ids.indexOf(seasons[i].mal) < 0) ids.push(seasons[i].mal);
                    }
                }
                if (!ids.length) return feed();

                var depth = 0;
                walk(ids.slice(0, 150));

                function walk(batch) {
                    Shiki.related(net, batch, function (info) {
                        for (var id in info) shiki_info['s' + id] = info[id];

                        var more = [];
                        for (var tmdb in rev_map) {
                            if (methods[tmdb] != 'tv') continue;
                            var list = rev_map[tmdb];
                            for (var i = 0; i < list.length; i++) {
                                var entry = shiki_info['s' + list[i].mal];
                                var rel = (entry && entry.related) || [];
                                for (var j = 0; j < rel.length; j++) {
                                    var r = rel[j];
                                    if (!r || r.relationKind != 'sequel' || !r.anime) continue;
                                    if (SERIES_KINDS.indexOf(r.anime.kind) < 0) continue;
                                    var sid = parseInt(r.anime.id, 10);
                                    if (!sid || has(list, sid)) continue;
                                    // «Part 2» в TMDB обычно продолжает тот же сезон,
                                    // «2nd Season» — следующий
                                    // Спецвыпуск сезон не продвигает: рекап между сезонами — не сезон
                                    var part = PART_RE.test(r.anime.name || '') || r.anime.kind == 'tv_special';
                                    var season = list[i].season ? list[i].season + (part ? 0 : 1) : 0;
                                    list.push({ mal: sid, season: season, sequel: true });
                                    if (!shiki_info['s' + sid] && more.indexOf(sid) < 0) more.push(sid);
                                }
                            }
                        }

                        if (more.length && ++depth < SEQUEL_DEPTH) return walk(more.slice(0, 50));
                        related();
                    }, function () {
                        related();
                    });
                }

                // Связи известны — у того, что выходит сейчас, сверяем сезоны с TMDB
                function related() {
                    var hot_ids = [];
                    for (var tmdb in rev_map) {
                        if (methods[tmdb] != 'tv') continue;
                        var list = rev_map[tmdb] || [];
                        var hot = false;
                        var latest = 0;
                        for (var i = 0; i < list.length; i++) {
                            var info = shiki_info['s' + list[i].mal];
                            if (isHot(list[i].mal, info)) hot = true;
                            var start = info && info.status != 'anons' ? dayOf(info.airedOn && info.airedOn.date) : 0;
                            if (start > latest) latest = start;
                        }
                        if (hot && Seasons.needs(tmdb, latest)) hot_ids.push(tmdb);
                    }
                    loadSeasons(hot_ids);
                    feed();
                }

                function has(list, sid) {
                    for (var i = 0; i < list.length; i++) if (list[i].mal == sid) return true;
                    return false;
                }
            }

            function feed() {
                if (!Kodik.enabled()) return finish();

                function go() {
                    lookup(Kodik.mergeRows(feed_rows));
                }
                if (feed_rows) go();
                else feed_wait = go;
            }

            // Точечно спрашиваем Kodik об отслеживаемом: о неизвестном — всегда,
            // об известном — когда давно не проверяли. Раньше известное не
            // перепроверялось никогда: серия, которую лента не застала (скажем,
            // вышла днём, а приложение открыли вечером), так и не становилась
            // новой. И спрашивали только про онгоинги, а последние серии сезона
            // озвучивают уже после того, как эфир в Японии закончился
            function lookup(fresh) {
                var store = Kodik.store();
                var now = Date.now();
                var year = new Date().getFullYear();
                var wanted = [];
                var seen = {};
                var i;

                function consider(sid, info) {
                    if (!sid || seen[sid] || fresh['s' + sid]) return;
                    seen[sid] = true;
                    var status = info ? info.status : '';
                    if (status == 'anons') return;

                    var rec = store['s' + sid];
                    var checked = rec ? (rec.checked || 0) : 0;
                    var total = info ? parseInt(info.episodes, 10) || 0 : 0;
                    var rank;

                    if (status == 'released') {
                        // Вышло целиком и озвучено целиком — новостей не будет
                        if (rec && rec.ep && total && rec.ep >= total) return;
                        if (rec && now - checked < KODIK_RECHECK_DONE) return;
                        var recent = info && info.airedOn && info.airedOn.year >= year - 1;
                        rank = !rec && recent ? 0 : 2;
                    }
                    else {
                        if (rec && now - checked < KODIK_RECHECK && !Kodik.gap) return;
                        rank = rec ? 1 : 0;
                    }
                    wanted.push({ sid: sid, rank: rank, checked: checked });
                }

                for (i = 0; i < watching.length; i++) {
                    consider(parseInt(watching[i].malId || watching[i].id, 10), watching[i]);
                }
                for (var key in rev_map) {
                    var seasons = rev_map[key] || [];
                    for (i = 0; i < seasons.length; i++) consider(seasons[i].mal, shiki_info['s' + seasons[i].mal]);
                }

                wanted.sort(function (a, b) {
                    return a.rank != b.rank ? a.rank - b.rank : a.checked - b.checked;
                });
                // Пропуск в ленте закрыт этой перепроверкой — второй раз не нужно
                Kodik.gap = false;

                var ids = [];
                for (i = 0; i < wanted.length; i++) ids.push(wanted[i].sid);

                if (!ids.length) {
                    Kodik.remember(fresh, []);
                    return finish();
                }

                // Главную точечные запросы задерживают не дольше KODIK_LOOKUP_WAIT:
                // раньше экран ждал все двадцать с лишним ответов Kodik подряд.
                // Не успевшие дорабатывают в фоне — их ответы запомнятся и
                // попадут в следующий показ и в счётчик меню
                var settled = false;
                var progress = null;
                var timer = setTimeout(function () {
                    if (settled) return;
                    settled = true;
                    var partial = {};
                    for (var p in fresh) partial[p] = fresh[p];
                    for (var q in progress.result) partial[q] = progress.result[q];
                    Kodik.remember(partial, progress.checked.slice(0));
                    finish();
                }, lookup_wait);

                progress = Kodik.lookup(background_net, ids, function (found, checked) {
                    for (var k in found) fresh[k] = found[k];
                    Kodik.remember(fresh, checked);
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    finish();
                });
            }

            // Семья тайтла — сезоны Shikimori одной карточки TMDB, с тем, что
            // о них знает Shikimori и база соответствий
            function familyOf(list) {
                var family = [];
                for (var j = 0; j < list.length; j++) {
                    var info = shiki_info['s' + list[j].mal] || {};
                    var released = info.status == 'released';
                    family.push({
                        mal: list[j].mal,
                        season: list[j].season || 0,
                        sp: !!list[j].sp,
                        sequel: !!list[j].sequel,
                        name: info.name || '',
                        date: dayOf(info.airedOn && info.airedOn.date),
                        year: (info.airedOn && info.airedOn.year) || 0,
                        kind: info.kind || 'tv',
                        status: info.status || '',
                        eps: parseInt(info.episodes, 10) || (released ? parseInt(info.episodesAired, 10) || 0 : 0),
                        aired: parseInt(info.episodesAired, 10) || 0
                    });
                }
                return family;
            }

            // Что известно о месте сезона Shikimori в нумерации TMDB:
            // tmdb — по самому TMDB (verified — премьера совпала с началом сезона),
            // db — по базе соответствий (её сезон и сквозная нумерация),
            // before / after — сколько серий у частей до и после него
            function placeSeason(tmdb, list, sid) {
                var family = familyOf(list);
                var mine = null;
                var j;
                for (j = 0; j < family.length; j++) if (family[j].mal == sid) mine = family[j];
                if (!mine) return null;

                var place = { eps: mine.eps, newest: true, tmdb: null, db: null, before: 0, after: 0, tmdb_last: 0, numbered: numbered(mine) };

                if (Seasons.place(tmdb, family) && mine.tseason) {
                    place.tmdb = { season: mine.tseason, offset: mine.toffset || 0, verified: !!mine.texact };
                }
                var known = Seasons.get(tmdb);
                place.counts = {};
                if (known) {
                    place.tmdb_last = known.s[known.s.length - 1][0];
                    place.tmdb_last_day = known.s[known.s.length - 1][1] || 0;
                    for (j = 0; j < known.s.length; j++) place.counts[known.s[j][0]] = known.s[j][2] || 0;
                }
                place.day = mine.date;

                if (mine.season && !mine.sp) {
                    var offset = 0;
                    for (j = 0; j < family.length; j++) {
                        var o = family[j];
                        if (o === mine || o.season != mine.season || !numbered(o)) continue;
                        if (airedBefore(o, mine)) offset += o.eps;
                    }
                    // derived — номер выведен обходом продолжений, а не взят из базы
                    place.db = { season: mine.season, offset: offset, derived: mine.sequel };
                }

                for (j = 0; j < family.length; j++) {
                    var x = family[j];
                    if (x === mine || x.status == 'anons' || !numbered(x)) continue;
                    if (airedBefore(x, mine)) place.before += x.eps;
                    else if (airedBefore(mine, x)) {
                        place.after += x.eps;
                        place.newest = false;
                    }
                }
                // Одна запись Shikimori на несколько сезонов TMDB: «Ван-Пис» и
                // «Детектив Конан» у Shikimori — один тайтл на тысячу серий, а TMDB
                // режет их на сезоны по аркам. Вышло больше, чем в сезоне TMDB, с
                // которого тайтл начался, и после него частей нет — значит, он
                // продолжается в следующих сезонах TMDB
                place.spans = !!(place.tmdb && place.tmdb.verified && !place.after &&
                    mine.tcount && mine.aired > mine.tcount);
                return place;
            }

            // Сколько серий сезона Shikimori видели по отметкам Lampa.
            // 1. Сезон сверен с TMDB по премьере — считаем внутри него. Тайтл на
            //    несколько сезонов TMDB («Ван-Пис») — по числу серий в них.
            // 2. TMDB сезон знает (продолжение сезона) — внутри него же. По сумме
            //    тут считать нельзя: серии, которые TMDB держит в прошлых сезонах,
            //    а Shikimori не считает (рекап, «нулевая» серия), прибавлялись к
            //    этой части, и новые серии пропадали.
            // 3. Сезонов TMDB нет — по сумме: все отмеченные серии минус серии
            //    частей до этой. Тут неважно, как TMDB нарезал сезоны — раздельно,
            //    сквозь или две части в одном («Клинок»: «Бесконечный поезд» и
            //    «Квартал красных фонарей» — один сезон TMDB), лишь бы прошлые
            //    части смотрели в Lampa. Сумма, которая не влезает в сезон, —
            //    признак неполной семьи: тогда ей не верим.
            // 4. Иначе — внутри сезона по базе соответствий.
            // Ответ — как у Progress.judge, плюс season/offset: где сезон лежит в
            // нумерации TMDB, и sure — известно ли это наверняка
            function decide(place, scan, total) {
                var mark = scan && scan.last;
                if (!mark) return null;
                var res;
                var entry = { season: 0, offset: 0, eps: place.eps, newest: place.newest, verified: false };

                if (place.tmdb && place.tmdb.verified) {
                    entry.season = place.tmdb.season;
                    entry.offset = place.tmdb.offset;
                    entry.verified = true;
                    if (place.spans && mark.season > entry.season) {
                        var abs = mark.episode - entry.offset;
                        for (var ts = entry.season; ts < mark.season; ts++) {
                            if (!place.counts[ts]) { abs = 0; break; }
                            abs += place.counts[ts];
                        }
                        // Сезон между ними TMDB не знает — сквозной номер не сложить
                        if (abs > 0) return { watched: abs, season: 0, offset: 0, sure: false };
                    }
                    res = Progress.judge(mark, entry, total);
                    res.season = entry.season;
                    res.offset = entry.offset;
                    res.sure = true;
                    return res;
                }

                var watched = scan.total - place.before;
                var room = place.eps ? place.eps + place.after : 0;
                // Отметок таймлайна нет, только «где остановился» балансера, — суммы нет
                if (!place.tmdb && scan.total > 0 && scan.total >= place.before && (!room || watched <= room)) {
                    if (watched <= 0) res = { fresh_season: true };
                    else if (place.eps && watched > place.eps) res = { watched: Math.max(total, place.eps) };
                    else res = { watched: watched };
                    var start = alignStart(scan, place.before);
                    if (start) {
                        res.season = start.season;
                        res.offset = start.offset;
                        res.sure = true;
                    }
                    return res;
                }

                var use = place.tmdb || place.db;
                if (use) {
                    entry.season = use.season;
                    entry.offset = use.offset;
                }
                res = Progress.judge(mark, entry, total);
                res.season = entry.season;
                res.offset = entry.offset;
                res.sure = false;
                return res;
            }

            // Куда «Отметить» может писать отметки Lampa, если отметки сами место
            // не подсказали: сезон сверен с TMDB, или база называет сезон, которого
            // TMDB ещё не завёл («Фрирен 2» при одном сезоне в TMDB). Угадывать
            // нельзя: угаданный сезон потом спорит с настоящим
            function writable(place) {
                if (place.spans) return null;
                if (place.tmdb && place.tmdb.verified) return place.tmdb;
                // Номер базы — только для сезона, вышедшего через год и больше после
                // последнего сезона TMDB. Ближе — это продолжение того же сезона:
                // база нумерует по TVDB («Клинок»: «Квартал красных фонарей» — её
                // сезон 3, у TMDB — второй), и отметки «сезон 3» потом занимали
                // настоящий третий сезон TMDB, пряча его серии
                if (place.db && !place.db.derived && place.tmdb_last && place.db.season > place.tmdb_last &&
                    place.day && place.tmdb_last_day && place.day - place.tmdb_last_day > 365 * 86400000) return place.db;
                return null;
            }

            // С какого сезона и серии TMDB начинается часть, до которой отмечено
            // before серий: идём по начатым сезонам по порядку. Не начата —
            // где она начнётся, отметки не говорят
            function alignStart(scan, before) {
                var list = [];
                for (var s in scan.tops) list.push(parseInt(s, 10));
                list.sort(function (a, b) { return a - b; });
                var cum = 0;
                for (var i = 0; i < list.length; i++) {
                    var top = scan.tops[list[i]];
                    if (cum + top > before) return { season: list[i], offset: before - cum };
                    cum += top;
                }
                return null;
            }

            // Сколько серий перебирать и с каких серий щупать сезон — с запасом
            // под любое место части: по TMDB, по базе и по сумме
            function placeScan(place, total) {
                var offsets = [];
                var widest = place.before;
                var all = [place.tmdb, place.db];
                for (var j = 0; j < all.length; j++) {
                    if (!all[j] || !all[j].offset) continue;
                    offsets.push(all[j].offset);
                    if (all[j].offset > widest) widest = all[j].offset;
                }
                return { max_ep: Math.max(total, place.eps || 0) + widest, offsets: offsets,
                         seasons: place.spans ? place.tmdb_last : 0 };
            }

            function airedBefore(a, b) {
                if (a.date && b.date) return a.date < b.date;
                return (a.year || 0) < (b.year || 0);
            }

            function finish() {
                if (pending <= 0) return build();
                pending_go = build;
                setTimeout(function () {
                    if (!pending_go) return;
                    var go = pending_go;
                    pending_go = null;
                    go();
                }, seasons_wait);
            }

            function build() {
                var known = Kodik.store();
                var now = Date.now();
                var items = [];
                var used = {};
                var i, j;

                // 1. Закладки Lampa — прогресс берём из отметок самой Lampa
                for (i = 0; i < favorites.length; i++) {
                    var card = favorites[i];
                    TmdbInfo.apply(card);
                    var seasons = rev_map[card.id] || [];
                    var best = null;

                    // Из всех сезонов берём тот, где озвучка обновлялась позже — это текущий
                    for (j = 0; j < seasons.length; j++) {
                        var known_season = known['s' + seasons[j].mal];
                        if (!known_season || !known_season.ep) continue;
                        if (!best || (known_season.at || 0) > (best.info.at || 0)) {
                            best = { info: known_season, season: seasons[j].season, sid: seasons[j].mal };
                        }
                        used['s' + seasons[j].mal] = true;
                    }

                    var sids = [];
                    for (j = 0; j < seasons.length; j++) sids.push(seasons[j].mal);

                    // Чего нет в закладке — берём у Shikimori. Ромадзи важно
                    // отдельно: отметки просмотра Lampa записаны по оригинальному
                    // названию, и без него искать прогресс просто нечем
                    for (j = 0; j < sids.length; j++) {
                        var info_j = shiki_info['s' + sids[j]];
                        if (!info_j) continue;
                        if (!card.first_air_date && info_j.airedOn && info_j.airedOn.year) card._shiki_year = info_j.airedOn.year;
                        if (!card.vote_average && info_j.score) card._shiki_score = info_j.score;
                        if (!card._shiki_name && info_j.name) card._shiki_name = info_j.name;
                        break;
                    }

                    var best_info = best ? shiki_info['s' + best.sid] : null;
                    var total = best ? countAvailable(best.info, best_info ? best_info.episodesAired : 0) : 0;
                    var place = best ? placeSeason(card.id, seasons, best.sid) : null;
                    // При сквозной нумерации серии этого сезона идут после прошлых
                    // частей: третий сезон «Монолога» по базе — серии 49 и дальше
                    var range = place ? placeScan(place, total) : { max_ep: total, offsets: [] };
                    var scan = Progress.scan(card, range.max_ep, range.offsets, range.seasons);
                    var mark = scan ? scan.last : null;
                    var where = place ? decide(place, scan, total) : null;
                    var spot = where && where.sure ? where : (place ? writable(place) : null);
                    var watched = 0;
                    var season_new = false;

                    // Отметки Lampa — по номеру сезона TMDB. Смотрели прошлый
                    // сезон, а озвучку получает следующий — значит, из него
                    // не видели ничего: все его серии новые. Раньше в этом
                    // случае число не считалось вовсе, и начавшийся сезон
                    // закладки в «Новые серии» не попадал. Отметка в сезоне
                    // ПОЗЖЕ нашего раньше означала «ничего не видели»: так
                    // просмотренный третий сезон «Монолога фармацевта», который
                    // база записала первым, висел в «Новых сериях»
                    if (mark) {
                        var judged = where || { watched: mark.episode };
                        if (judged.fresh_season) season_new = true;
                        else watched = judged.watched;
                    }
                    var progress = !!mark && !season_new;

                    // Отмечено в плагине «просмотрено» — столько серий видели
                    var seen_ep = best ? Seen.get(best.sid) : 0;
                    if (seen_ep > watched) {
                        watched = seen_ep;
                        progress = true;
                        season_new = false;
                    }

                    // Тайтл может быть и в закладках, и в списке Shikimori.
                    // Точное число из списка берём по тому же сезону, что
                    // и озвучку: раньше брался максимум по всем сезонам,
                    // и 28 серий первого перекрывали три серии второго
                    var rate_sids = best ? [best.sid] : sids;
                    for (j = 0; j < rate_sids.length; j++) {
                        var rate_here = mals[rate_sids[j]];
                        if (rate_here && (rate_here.episodes || 0) > watched) {
                            watched = rate_here.episodes;
                            progress = true;
                        }
                    }

                    var fresh = 0;
                    var airing = false;

                    if (best) {
                        // Число «+N» означает «столько вы не смотрели». Нет прогресса —
                        // нет числа, тайтл просто помечается выходящим
                        fresh = progress || season_new ? total - watched : 0;
                        if (fresh < 0) fresh = 0;

                        // Показывать тайтл и показывать число — разные вопросы.
                        // Свежая озвучка означает, что смотреть есть что, даже если
                        // непросмотренных полторы тысячи, как у долгоиграющих
                        airing = best.info.at >= now - KODIK_FRESH_DAYS * 86400000 && (!progress || fresh > 0);
                    }

                    var fav_status = '';
                    for (j = 0; j < sids.length; j++) {
                        if (mals[sids[j]] && mals[sids[j]].status) fav_status = mals[sids[j]].status;
                    }

                    items.push({
                        card: card,
                        tmdb: { id: card.id, method: methods[card.id] || (card.name || card.original_name ? 'tv' : 'movie') },
                        groups: card._fav_groups || {},
                        sids: sids,
                        status: fav_status,
                        kodik: best ? best.info : null,
                        total: total,
                        watched: watched,
                        watched_at: mark ? mark.at : 0,
                        fresh: fresh,
                        airing: airing,
                        season: spot ? spot.season : 0,
                        offset: spot ? spot.offset : 0,
                        at: best ? best.info.at : 0
                    });
                }

                // 2. Списки Shikimori — то, чего в закладках нет
                for (i = 0; i < watching.length; i++) {
                    var anime = watching[i];
                    var sid = parseInt(anime.malId || anime.id, 10);
                    if (!sid || used['s' + sid]) continue;

                    var info = known['s' + sid];
                    if (info && !info.ep) info = null;
                    var rate = mals[sid];
                    var status = rate ? rate.status : '';
                    var have = info ? countAvailable(info, anime.episodesAired) : (anime.episodesAired || 0);
                    // Серии, отмеченные в самой Lampa, — тоже просмотр. Семья сезонов
                    // известна — считаем по ней, как у закладок; нет — по одному тайтлу
                    var lampa_ep = 0;
                    var fhit = Match.cacheGet(sid);
                    // Номер TMDB занят фильмом из закладок — семья не его.
                    // Спецвыпуск (сезон 0 у TMDB) по сериям сезонов не считаем
                    var fam_list = fhit && fhit.tmdb && !fhit.sp && methods[fhit.tmdb] == 'tv' && !lonely[fhit.tmdb] ? rev_map[fhit.tmdb] : null;
                    var fam_name = fam_list ? TmdbInfo.get(fhit.tmdb, 'tv') : null;
                    if (fam_list && fam_name && fam_name.original_name) {
                        var lplace = placeSeason(fhit.tmdb, fam_list, sid);
                        // В нумерацию серий сезонов не входит (спецвыпуск без сезона
                        // в базе) — отметки сезонов о нём ничего не говорят
                        if (lplace && !lplace.numbered) lplace = null;
                        var lrange = lplace ? placeScan(lplace, have) : null;
                        var lscan = lrange ? Progress.scan({ _tmdb_name: fam_name.original_name }, lrange.max_ep, lrange.offsets, lrange.seasons) : null;
                        var lres = lplace ? decide(lplace, lscan, have) : null;
                        if (lres && !lres.fresh_season) lampa_ep = lres.watched || 0;
                    }
                    else {
                        var in_lampa = Progress.ofShiki(anime, have);
                        lampa_ep = in_lampa ? in_lampa.episode : 0;
                    }
                    var seen = Math.max(rate ? (rate.episodes || 0) : 0, Seen.get(sid), lampa_ep);

                    // Списки Shikimori кормят «Новые серии», но в строки закладок
                    // не попадают: там строго то, что лежит в избранном Lampa
                    items.push({
                        card: anime,
                        tmdb: null,
                        groups: {},
                        status: status,
                        kodik: info || null,
                        total: have,
                        watched: seen,
                        fresh: have > seen ? have - seen : 0,
                        at: info ? info.at : 0
                    });
                }

                ok(items);
            }
        },

        // Что вышло с озвучкой за последние полтора дня — не только из закладок.
        // Берём из накопленного, а не из последней ленты: лента теперь
        // дочитывается с места прошлой сверки, и в ней может быть пара строк
        released: function (net, ok) {
            if (!Kodik.enabled()) return ok([]);

            Kodik.feed(net, fromStore, fromStore);

            function fromStore() {
                var store = Kodik.store();
                var since = Date.now() - KODIK_RELEASED_HOURS * 3600000;
                var list = [];
                for (var key in store) {
                    var rec = store[key];
                    if (rec && rec.ep && rec.at >= since && !Hidden.has(rec.sid)) list.push(rec);
                }
                if (!list.length) return ok([]);

                list.sort(function (a, b) { return b.at - a.at; });
                list = list.slice(0, 30);

                var ids = [];
                for (var i = 0; i < list.length; i++) ids.push(list[i].sid);

                Shiki.animesByIds(net, ids, function (animes) {
                    var by_id = {};
                    for (var j = 0; j < animes.length; j++) {
                        by_id['s' + parseInt(animes[j].malId || animes[j].id, 10)] = animes[j];
                    }
                    var cards = [];
                    for (j = 0; j < list.length; j++) {
                        var anime = by_id['s' + list[j].sid];
                        if (!anime) continue;
                        anime._kodik = list[j];
                        cards.push(anime);
                    }
                    ok(cards);
                }, function () {
                    ok([]);
                });
            }
        },

        // Карточка для отрисовки: прогресс и данные Kodik переносим на объект карточки.
        // Каждой строке — своя копия: Lampa помечает отрисованный объект `ready`
        // и во второй строке молча его пропускает (interaction/items/old/line.js).
        // show_kodik — в метке показать вышедшую серию и студию, а не прогресс:
        // в «Новых сериях» важно, что именно вышло и в чьей озвучке
        decorate: function (item, show_kodik) {
            var card = {};
            for (var key in item.card) card[key] = item.card[key];

            card._kodik = item.kodik || null;
            card._sids = item.sids || null;   // по ним карточку закладки можно скрыть
            card._kodik_new = item.fresh || 0;
            card._watched_ep = item.watched || 0;
            card._total_ep = item.total || 0;
            card._season = item.season || 0;
            card._offset = item.offset || 0;   // серии прошлых частей в том же сезоне TMDB
            card._tracked = true;              // прогресс посчитан с учётом сезонов — не пересчитывать
            if (show_kodik) card._show_kodik = true;
            if (item.tmdb) {
                card._direct_tmdb = item.tmdb;
                card._tmdb_card = true;
            }
            return card;
        },

        // Календарь: серии в ближайшие N дней по моим спискам и закладкам
        upcoming: function (net, ok, err) {
            var self = this;
            Shiki.calendar(net, function (calendar) {
                var now = Date.now();
                var horizon = now + CALENDAR_DAYS * 86400000;
                var entries = [];
                for (var i = 0; i < calendar.length; i++) {
                    var e = calendar[i];
                    if (e.at && e.at >= now - 6 * 3600000 && e.at <= horizon) entries.push(e);
                }
                entries.sort(function (a, b) { return a.at - b.at; });

                var mal_ids = [];
                for (i = 0; i < entries.length; i++) mal_ids.push(parseInt(entries[i].anime.id, 10));

                // Списки пользователя (может не быть — не считаем ошибкой)
                self.rates(net, function (rates) {
                    finish(rates);
                }, function () {
                    finish(null);
                });

                function finish(rates) {
                    var my_mals = {};
                    var watching_map = {};
                    if (rates) {
                        for (var mal in rates.mals) my_mals['m' + mal] = rates.mals[mal];
                        for (var i = 0; i < rates.watching.length; i++) {
                            watching_map['m' + (rates.watching[i].malId || rates.watching[i].id)] = rates.watching[i];
                        }
                    }

                    var favorites = self.lampaFavorites();
                    var fav_tmdb = {};
                    for (i = 0; i < favorites.length; i++) fav_tmdb['t' + favorites[i].id] = favorites[i];

                    // Постеры из REST-календаря часто заглушки — берём нормальные из GraphQL
                    var posters = {};
                    Shiki.animesByIds(net, mal_ids.slice(0, 100), function (animes) {
                        for (var i = 0; i < animes.length; i++) {
                            var poster = animes[i].poster;
                            if (poster && poster.mainUrl) posters['m' + (animes[i].malId || animes[i].id)] = poster.mainUrl;
                        }
                        withPosters();
                    }, withPosters);

                    function withPosters() {
                        for (var i = 0; i < entries.length; i++) {
                            var url = posters['m' + parseInt(entries[i].anime.id, 10)];
                            if (url) entries[i].anime.poster_url = url;
                        }
                        mapAll();
                    }

                    // Батч-маппинг всех календарных тайтлов (нужен для пересечения с закладками)
                    function mapAll() {
                    Match.batch(net, mal_ids, function (map) {
                        var result = [];
                        for (var i = 0; i < entries.length; i++) {
                            var entry = entries[i];
                            var mal = parseInt(entry.anime.id, 10);
                            var mapped = map[mal];
                            var mine = my_mals['m' + mal];
                            var fav = mapped && fav_tmdb['t' + mapped.tmdb];

                            entry.tmdb = mapped || null;
                            entry.my = !!(mine || fav);
                            entry.rate = watching_map['m' + mal] || null;
                            entry.fav_card = fav || null;
                            result.push(entry);
                        }
                        ok(result);
                    });
                    }
                }
            }, err);
        }
    };

    /* ============================================================
     * Карточки
     * ============================================================ */

    // Стиль карточек: native (как в Lampa, по умолчанию) | compact | poster
    // Скелетон: пока данные едут, на экране уже стоит будущая раскладка.
    // Крутилка на пустом экране не отвечает на вопрос «сколько ждать»,
    // а решётка плиток отвечает — и экран не выглядит сломанным
    // Приходили ли вообще события visible. Нужен для страховки ниже: если
    // механизм слоёв в этом контейнере не работает, карточки должны показать
    // постеры сами — но пока он работает, лезть вперёд него нельзя, иначе
    // ленивая загрузка превращается в обычную, только с задержкой
    var layer_alive = false;

    function skeletonCard() {
        var cell = document.createElement('div');
        cell.className = 'card shikimori-card shikimori-skeleton';
        cell.appendChild(document.createElement('div')).className = 'card__view';
        cell.appendChild(document.createElement('div')).className = 'shikimori-skeleton__line';
        return cell;
    }

    function skeletonGrid(count) {
        var box = document.createDocumentFragment();
        for (var i = 0; i < count; i++) box.appendChild(skeletonCard());
        return box;
    }

    function skeletonRows(rows, per_row) {
        var box = document.createElement('div');
        box.className = 'shikimori-skeleton-rows';
        for (var r = 0; r < rows; r++) {
            var row = document.createElement('div');
            row.className = 'shikimori-skeleton-row';
            row.appendChild(document.createElement('div')).className = 'shikimori-skeleton__head';

            var strip = document.createElement('div');
            strip.className = 'shikimori-skeleton__strip';
            for (var i = 0; i < per_row; i++) strip.appendChild(skeletonCard());
            row.appendChild(strip);
            box.appendChild(row);
        }
        return box;
    }

    function skeletonClear(root) {
        if (!root) return;
        var list = root.querySelectorAll('.shikimori-skeleton,.shikimori-skeleton-rows');
        for (var i = 0; i < list.length; i++) {
            if (list[i].parentNode) list[i].parentNode.removeChild(list[i]);
        }
    }

    // Анимации отключаются в настройках Lampa — на слабых телевизорах это
    // делают первым делом. Класс no--animation ставит сама Lampa, и наши
    // движения обязаны его слушаться так же, как штатные
    // Наше движение включается классом на body. Отдельный выключатель нужен,
    // потому что отключать ради него все анимации Lampa — слишком крупная мера:
    // скелетоны и проявление постера могут остаться, а масштаб — уйти
    function applyMotion() {
        try {
            if (storBool(MOTION_KEY, true)) document.body.classList.add('shiki-motion');
            else document.body.classList.remove('shiki-motion');
        }
        catch (e) {}
    }

    function motionOn() {
        return storBool(MOTION_KEY, true) && animationsOn();
    }

    function animationsOn() {
        try {
            return !document.body.classList.contains('no--animation');
        }
        catch (e) {}
        return true;
    }

    // Фон под интерфейсом по карточке в фокусе. Именно этим витрины Netflix
    // и Кинопоиска отличаются от плоского списка: экран реагирует на то,
    // где вы стоите. Свой дебаунс не нужен — Lampa ждёт секунду сама,
    // сама же молчит, если фон выключен в настройках или включён light-режим
    function ambience(data) {
        if (!storBool(AMBIENCE_KEY, true)) return;
        try {
            var url = '';
            // Горизонтальный кадр лучше портрета: он и задуман как фон
            if (data.backdrop_path) url = Lampa.TMDB.image('t/p/w500' + data.backdrop_path);
            if (!url) url = cardView(data).poster;
            if (url) Lampa.Background.change(url);
        }
        catch (e) {}
    }

    function cardStyle() {
        var style = storString('shikimori_card_style', 'native');
        return ['native', 'compact', 'poster'].indexOf(style) >= 0 ? style : 'native';
    }

    // Одна карточка на весь плагин: данные приходят и от Shikimori, и от TMDB/CUB,
    // поэтому поля сводим к общему виду, а разметка всегда штатная разметка Lampa
    function cardView(data) {
        var tmdb = isTmdbCard(data);
        var title, poster, score, year;

        if (tmdb) {
            title = data.name || data.title || data.original_name || data.original_title || '';
            poster = data.img || (data.poster_path ? Lampa.TMDB.image('t/p/w300' + data.poster_path) : '');
            // Закладка Lampa часто сохранена без года и оценки — подставляем
            // значения, взятые у Shikimori по сопоставленному тайтлу
            score = parseFloat(data.vote_average || data._tmdb_score || data._shiki_score || 0);
            year = (data.first_air_date || data.release_date || '').slice(0, 4) ||
                   (data._tmdb_year || data._shiki_year || '');
        }
        else {
            title = data.russian || data.name || '';
            poster = Shiki.posterUrl(data);
            score = data.score ? parseFloat(data.score) : 0;
            year = data.airedOn && data.airedOn.year ? data.airedOn.year : '';
        }

        return {
            title: title,
            poster: poster,
            score: score ? score.toFixed(1) : '',
            year: year || '',
            kind: tmdb ? '' : data.kind
        };
    }

    // Карточка аниме — на штатной разметке Lampa (.card / .card__vote / .card__new-episode)
    function ShikiCard(data) {
        var self = this;

        this.build = function () {
            var style = cardStyle();
            var view = cardView(data);
            var poster = view.poster;
            var title = view.title;
            var score = view.score;
            var year = view.year;

            this.card = Lampa.Template.js('shikimori_card');
            this.card.classList.add('shikimori-card--' + style);

            // Год ушёл на постер отдельным бейджем: строкой под названием он
            // отрывался от коротких названий, а в самой строке названия съедал
            // место у длинных
            this.card.querySelector('.card__title').innerText = title;
            this.card.querySelector('.card__age').innerText = '';

            var year_el = this.card.querySelector('.shikimori-year');
            if (year) year_el.innerText = year;
            else {
                year_el.classList.add('hide');
                // Без года тип поднимается в его слот, иначе повиснет в пустоте
                this.card.classList.add('shikimori-card--noyear');
            }
            this.card.querySelector('.card__promo-title').innerText = title;

            // Постер — только когда карточка попала в кадр.
            //
            // Раньше src проставлялся при сборке, и каталог из 36 карточек
            // разом просил 36 картинок: на телевизоре это забивает и сеть,
            // и декодер, а видно из них штуки четыре. Штатная карточка Lampa
            // делает ровно так же — грузит в onVisible
            var img = this.card.querySelector('.card__img');
            var fav_img = data._fav_img || '';
            var card_el = this.card;
            img.onerror = function () {
                if (fav_img && img.src.indexOf(fav_img) == -1) img.src = fav_img;
                else {
                    img.src = './img/img_broken.svg';
                    card_el.classList.remove('shikimori-card--loading');
                }
            };
            this.poster = poster;

            var vote = this.card.querySelector('.card__vote');
            if (score) vote.innerText = score;
            else vote.classList.add('hide');

            // Тип показываем только когда это не обычный сериал — иначе бейдж на каждой карточке
            var kind = this.card.querySelector('.card__type');
            var kind_text = Lampa.Lang.translate('shikimori_kind_' + view.kind);
            if (view.kind && view.kind != 'tv' && kind_text.indexOf('shikimori_kind') == -1) kind.innerText = kind_text;
            else kind.classList.add('hide');

            // Зелёная плашка «+N серий» — штатный бейдж новой серии Lampa.
            // Данные Kodik важнее: там серия уже с озвучкой, а не просто вышла в Японии
            var fresh = this.card.querySelector('.card__new-episode');
            var unwatched = 0;
            // Число на бейдже должно быть обозримым: «+1154 серии» ничего не
            // сообщает, кроме того, что сериал длинный. Сам тайтл при этом
            // остаётся в строке, просто без числа
            if (data._kodik_new > 0 && data._kodik_new <= FRESH_SANE_MAX) {
                unwatched = data._kodik_new;
            }
            else if (typeof data._rate_episodes == 'number' && data.episodesAired) {
                unwatched = data.episodesAired - data._rate_episodes;
            }
            if (unwatched > 0) {
                fresh.querySelector('div').innerText = '+' + unwatched + ' ' + plural(unwatched, [
                    Lampa.Lang.translate('shikimori_ep_1'),
                    Lampa.Lang.translate('shikimori_ep_2'),
                    Lampa.Lang.translate('shikimori_ep_5')
                ]);
            }
            else fresh.classList.add('hide');

            // Прогресс раньше считался только для избранного и списков Shikimori,
            // поэтому в лентах его не было даже у просмотренного. Отметки лежат
            // локально, сеть не нужна — считаем для любой карточки
            if (!data._watched_ep && !data._tracked) {
                // Номер карточки TMDB — не номер Shikimori: у TMDB-карточки
                // своего тайтла в хранилище Kodik нет, а совпавший номер — чужой
                var known = Kodik.known(cardSid(data));
                var total = data._total_ep || (known ? known.ep : 0) ||
                    parseInt(data.episodesAired, 10) || parseInt(data.episodes, 10) ||
                    parseInt(data.number_of_episodes, 10) || 0;

                var mark = Progress.lastWatched(data, total);
                if (!isTmdbCard(data)) {
                    var in_lampa = Progress.ofShiki(data, total);
                    if (in_lampa && (!mark || in_lampa.episode > mark.episode)) mark = in_lampa;
                }
                var seen_here = Seen.get(cardSid(data));
                if (seen_here && (!mark || seen_here > mark.episode)) mark = { episode: seen_here, season: 1, at: 0 };
                if (mark) {
                    data._watched_ep = mark.episode;
                    if (total >= mark.episode) data._total_ep = total;
                    // Сколько осталось — только когда числа правдоподобны:
                    // нумерация Kodik и отметок Lampa совпадает не всегда
                    var left = total - mark.episode;
                    if (!data._kodik_new && left > 0 && left <= FRESH_SANE_MAX) data._kodik_new = left;
                }
            }

            // Полоса прогресса по нижней кромке постера. Доля просмотренного читается
            // мгновенно и не зависит от того, двузначный номер серии или четырёхзначный
            var bar = this.card.querySelector('.shikimori-progress');
            if (data._watched_ep && data._total_ep) {
                var share = Math.round(data._watched_ep / data._total_ep * 100);
                // Пока есть недосмотренные серии, полоса не должна выглядеть полной:
                // у длинных тайтлов 1170 из 1173 округляется ровно в 100%
                if (data._watched_ep < data._total_ep) share = Math.min(share, 97);
                share = Math.min(100, share);
                bar.querySelector('i').style.width = share + '%';
                this.card.classList.add('shikimori-card--progress');
            }
            else bar.classList.add('hide');

            // Метка снизу слева. Приоритет: где остановился, затем вышедшая серия
            // со студией, затем дата ближайшего эфира. В «Новых сериях» — сразу
            // серия и студия: там вопрос «что вышло и в чьей озвучке», а доля
            // просмотренного и так видна по полосе прогресса. Раньше студию
            // здесь было не увидеть, и нельзя было проверить, что засчитана
            // именно выбранная озвучка
            var marker = this.card.querySelector('.card__marker');
            if (data._kodik && (data._show_kodik || !data._watched_ep)) {
                var studio = data._kodik.studio ? ' · ' + data._kodik.studio : '';
                var subs = data._kodik.voice ? '' : ' · ' + Lampa.Lang.translate('shikimori_subtitles');
                marker.querySelector('span').innerText = data._kodik.ep + ' ' +
                    Lampa.Lang.translate('shikimori_ep') + (subs || studio);
            }
            else if (data._watched_ep) {
                marker.querySelector('span').innerText = data._total_ep > data._watched_ep
                    ? data._watched_ep + ' / ' + data._total_ep
                    : Lampa.Lang.translate('shikimori_seen_all');
            }
            // В каталоге прогресса нет, но мы можем знать, что озвучка уже есть —
            // листая список, сразу видно, что реально можно включить
            else if (Kodik.known(cardSid(data))) {
                var have = Kodik.known(cardSid(data));
                marker.querySelector('span').innerText = have.ep + ' ' +
                    Lampa.Lang.translate('shikimori_ep') + ' ' + Lampa.Lang.translate('shikimori_dubbed');
            }
            else if (data._next_at) {
                marker.querySelector('span').innerText = formatDate(data._next_at) +
                    (data._next_episode ? ' · ' + data._next_episode + ' ' + Lampa.Lang.translate('shikimori_ep') : '');
            }
            else marker.classList.add('hide');
        };

        // Показать постер. Вызывается по событию visible, но подстраховываемся
        // таймером: в некоторых контейнерах Lampa событие не приходит вовсе,
        // а карточка без постера — хуже, чем лишний запрос
        this.showPoster = function () {
            if (this.shown || !this.card) return;
            this.shown = true;
            clearTimeout(this.poster_timer);

            var img = this.card.querySelector('.card__img');
            if (!img || !this.poster) return;

            // Класс ставим до src: пока картинка едет, на месте постера ровный
            // тёмный прямоугольник, а приехав, она проявляется. Подмена картинки
            // рывком — ровно в момент перевода фокуса — читается как дёрганье
            var card = this.card;
            card.classList.add('shikimori-card--loading');
            img.onload = function () {
                card.classList.remove('shikimori-card--loading');
            };
            img.src = this.poster;
        };

        this.create = function () {
            this.build();

            this.poster_timer = setTimeout(function () {
                if (!layer_alive) self.showPoster();
            }, POSTER_LAZY_FALLBACK);

            this.card.addEventListener('hover:focus', function () {
                ambience(data);
                if (self.onFocus) self.onFocus(self.card, data);
            });

            // Отклик на нажатие: карточка коротко проседает, как кнопка.
            // Пульт не даёт тактильной отдачи, и без этого непонятно,
            // засчиталось нажатие или нет
            this.card.addEventListener('hover:enter', function () {
                if (!motionOn()) return;
                self.card.classList.add('shikimori-card--press');
                setTimeout(function () {
                    if (self.card) self.card.classList.remove('shikimori-card--press');
                }, 180);
            });

            this.card.addEventListener('hover:touch', function () {
                if (self.onTouch) self.onTouch(self.card, data);
            });

            this.card.addEventListener('hover:enter', function () {
                if (self.onEnter) self.onEnter(self.card, data);
            });

            // Без этого карточки, дорисованные лентой при прокрутке, не попадают
            // в коллекцию Navigator: Line вешает onVisible именно на это событие,
            // и с пульта фокус упирается в последнюю изначально отрисованную карточку
            this.card.addEventListener('visible', function () {
                layer_alive = true;
                self.showPoster();
                if (self.onVisible) self.onVisible(self.card, data);
            });

            // Долгое нажатие — контекстное меню карточки (штатный жест Lampa)
            data._card_el = this.card;
            this.card.addEventListener('hover:long', function () {
                cardMenu(data);
            });
        };

        this.render = function (js) {
            return js ? this.card : $(this.card);
        };

        this.destroy = function () {
            clearTimeout(this.poster_timer);
            if (this.card) {
                var img = this.card.querySelector('.card__img');
                if (img) { img.onerror = null; img.src = ''; }
                this.card.remove();
            }
            this.card = null;
        };
    }

    // Кнопка-действие в шапке главного экрана (штатная simple-button)
    function ActionCard(data) {
        var self = this;

        this.create = function () {
            this.card = Lampa.Template.js('shikimori_action');
            this.card.querySelector('.shikimori-action__icon').innerHTML = data.icon || '';
            this.card.querySelector('.shikimori-action__title').innerText = data.title || '';

            this.card.addEventListener('hover:focus', function () {
                if (self.onFocus) self.onFocus(self.card, data);
            });

            this.card.addEventListener('hover:enter', function () {
                if (self.onEnter) self.onEnter(self.card, data);
            });
        };

        this.render = function (js) {
            return js ? this.card : $(this.card);
        };

        this.destroy = function () {
            if (this.card) this.card.remove();
            this.card = null;
        };
    }

    /* ============================================================
     * Главный экран (хаб)
     * ============================================================ */

    function MainComponent(object) {
        var comp = new Lampa.InteractionMain(object);
        var net = new NetPool();

        comp.create = function () {
            var self = this;
            this.activity.loader(true);

            // Главная собирается из пяти источников сразу, и до их прихода
            // экран был пустым. Показываем скелет строк — снимется он в
            // buildLines, прямо перед отрисовкой настоящих
            try { this.render(true).appendChild(skeletonRows(3, 6)); }
            catch (e) {}

            var lines = {};
            var built = false;

            // Строим, когда пришли все пять источников, но не позже MAIN_WAIT:
            // один зависший запрос не должен держать пустой экран
            function build() {
                if (built) return;
                built = true;
                clearTimeout(wait);
                self.buildLines(lines);
            }
            var join = makeJoin(5, build);
            var wait = setTimeout(build, MAIN_WAIT);
            comp.cancelWait = function () {
                built = true;
                clearTimeout(wait);
            };

            // 1. Списки Shikimori (если указан ник), а следом — всё отслеживаемое:
            // закладки Lampa, прогресс просмотра и доступные серии
            UserData.rates(net, function (rates) {
                join();
                track(rates);
            }, function () {
                join();
                track(null);
            });

            function track(rates) {
                UserData.tracked(net, rates, function (items) {
                    lines.tracked = items;
                    join();


                    // Лента Kodik уже прогрета — общая строка идёт следом без запроса
                    UserData.released(net, function (cards) {
                        lines.released = cards;
                        join();
                    });
                });
            }

            // Календарь на главной не собираем: он про дату эфира в Японии, а
            // на главной важно то, что уже можно смотреть. Экран календаря
            // остался — он открывается кнопкой и грузится только по запросу

            // 2. «Сейчас смотрят в Lampa» (CUB), фолбэк TMDB
            this.loadPopular(function (cards, from_cub) {
                lines.popular = cards;
                lines.popular_cub = from_cub;
                join();
            });

            // 3. Ленты Shikimori одним запросом
            Shiki.multiCatalog(net, [
                { alias: 'ongoing', params: { status: 'ongoing', order: 'popularity', limit: 20 } },
                { alias: 'season', params: { season: currentSeason(0), order: 'ranked', limit: 20 } },
                { alias: 'anons', params: { status: 'anons', order: 'popularity', limit: 20 } }
            ], function (data) {
                lines.ongoing = data.ongoing || [];
                lines.season = data.season || [];
                lines.anons = data.anons || [];
                join();
            }, function () {
                join();
            });

            return this.render();
        };

        comp.loadPopular = function (done) {
            var email = storGet('account_email', '');
            var url = Lampa.Utils.protocol() + 'tmdb.' + (Lampa.Manifest.cub_domain || 'cub.rip') +
                '/?sort=now_playing&cat=anime&page=1' + (email ? '&email=' + encodeURIComponent(email) : '');

            // Карточки пришли от CUB — и открываться будут через CUB, как у
            // самой Lampa: так они откроются и там, где прямой TMDB недоступен
            net.get(url, function (json) {
                var results = (json && json.results) || [];
                if (results.length) {
                    for (var i = 0; i < results.length; i++) results[i].source = 'cub';
                    done(results, true);
                }
                else fallback();
            }, fallback);

            function fallback() {
                Tmdb.get(net, 'discover/tv?with_keywords=210024&with_origin_country=JP&sort_by=popularity.desc&page=1', function (json) {
                    var results = (json && json.results) || [];
                    for (var i = 0; i < results.length; i++) results[i].source = 'tmdb';
                    done(results, false);
                }, function () {
                    done([], false);
                });
            }
        };

        comp.buildLines = function (lines) {
            skeletonClear(this.render(true));

            var data = [];
            var nick = storString('shikimori_user', '');

            // Строка-меню
            var actions = [
                { action: 'search', icon: ICON_SEARCH, title: Lampa.Lang.translate('shikimori_action_search') },
                { action: 'catalog', icon: ICON_CATALOG, title: Lampa.Lang.translate('shikimori_action_catalog') },
                { action: 'calendar', icon: ICON_CALENDAR, title: Lampa.Lang.translate('shikimori_action_calendar') },
                { action: 'account', icon: ICON_USER,
                  title: nick ? nick : Lampa.Lang.translate('shikimori_action_account') }
            ];

            data.push({
                title: '',
                results: actions,
                line_type: 'actions',
                shiki_actions: true,
                nomore: true,
                noimage: true,
                cardClass: function (elem) { return new ActionCard(elem); }
            });

            var tracked = lines.tracked || [];
            var i;

            // Экран открыт — данные свежие, счётчик в меню обновляем заодно.
            // Только если они пришли: экран мог собраться по таймеру без них,
            // и тогда пустой список обнулил бы счётчик до следующего пересчёта
            if (lines.tracked) updateMenuBadge(tracked);

            // Новые серии — доступны с озвучкой, не просмотрены и появились недавно
            var fresh = [];
            for (i = 0; i < tracked.length; i++) {
                if (isFresh(tracked[i])) fresh.push(tracked[i]);
            }
            fresh.sort(function (a, b) { return b.at - a.at; });

            if (fresh.length) {
                var fresh_cards = [];
                for (i = 0; i < Math.min(fresh.length, 30); i++) fresh_cards.push(UserData.decorate(fresh[i], true));
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_fresh'),
                    results: fresh_cards,
                    shiki: true,
                    line_type: 'shiki',
                    noimage: true,
                    nomore: true,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Я смотрю: сперва помеченные тегом «Смотрю», следом — вычисленные
            // по факту (есть прогресс и есть что смотреть дальше). Так видно,
            // что тег пропускает, и при этом ничего помеченного не теряется
            var watching = favoriteRow(tracked, 'look').concat(watchingNow(tracked));

            if (watching.length) {
                var watching_cards = [];
                for (i = 0; i < watching.length; i++) watching_cards.push(UserData.decorate(watching[i]));
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_watching'),
                    results: watching_cards,
                    shiki: true,
                    line_type: 'shiki',
                    noimage: true,
                    onMore: nick ? function () { openCatalog({ mode: 'mylist' }); } : null,
                    nomore: !nick,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Есть что посмотреть — всё остальное, где остались непросмотренные
            // серии. «Я смотрю» уже забрала то, что вы ведёте; здесь то, что
            // лежит в избранном под другими метками и ждёт своей очереди
            var shown = {};
            for (i = 0; i < watching.length; i++) shown[itemKey(watching[i])] = true;

            var backlog = [];
            for (i = 0; i < tracked.length; i++) {
                var item = tracked[i];
                if (!visible(item) || shown[itemKey(item)]) continue;
                if (!(item.total > item.watched) && !item.airing) continue;
                backlog.push(item);
            }
            backlog.sort(function (a, b) { return b.at - a.at; });
            backlog = backlog.slice(0, 30);

            if (backlog.length) {
                var backlog_cards = [];
                for (i = 0; i < backlog.length; i++) backlog_cards.push(UserData.decorate(backlog[i]));
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_backlog'),
                    results: backlog_cards,
                    shiki: true,
                    line_type: 'shiki',
                    noimage: true,
                    nomore: true,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Свежая озвучка — всё, что вышло за сутки, независимо от закладок
            if (lines.released && lines.released.length) {
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_released'),
                    results: lines.released,
                    shiki: true,
                    line_type: 'shiki',
                    noimage: true,
                    nomore: true,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Сейчас смотрят в Lampa. Карточки TMDB, но рисуем их своим классом:
            // на одном экране все строки должны выглядеть одинаково
            if (lines.popular && lines.popular.length) {
                for (i = 0; i < lines.popular.length; i++) {
                    lines.popular[i]._tmdb_card = true;
                    lines.popular[i]._direct_tmdb = {
                        id: lines.popular[i].id,
                        method: lines.popular[i].name || lines.popular[i].original_name ? 'tv' : 'movie'
                    };
                }
                data.push({
                    title: Lampa.Lang.translate(lines.popular_cub ? 'shikimori_title_popular_cub' : 'shikimori_title_popular_tmdb'),
                    results: lines.popular,
                    shiki: true,
                    line_type: 'shiki',
                    noimage: true,
                    nomore: true,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Ленты Shikimori
            var shiki_lines = [
                { key: 'ongoing', title: Lampa.Lang.translate('shikimori_title_ongoing'), params: { status: 'ongoing', order: 'popularity' } },
                { key: 'season', title: Lampa.Lang.translate('shikimori_title_season') + ' · ' + seasonTitle(currentSeason(0)), params: { season: currentSeason(0), order: 'ranked' } },
                { key: 'anons', title: Lampa.Lang.translate('shikimori_title_anons'), params: { status: 'anons', order: 'popularity' } }
            ];
            for (i = 0; i < shiki_lines.length; i++) {
                (function (line) {
                    if (lines[line.key] && lines[line.key].length) {
                        data.push({
                            title: line.title,
                            results: lines[line.key],
                            shiki: true,
                            line_type: 'shiki',
                            noimage: true,
                            onMore: function () { openCatalog({ filters: line.params }); },
                            cardClass: function (elem) { return new ShikiCard(elem); }
                        });
                    }
                })(shiki_lines[i]);
            }

            // Позже — категория «Позже» из избранного Lampa (`wath`).
            // Внизу экрана: это отложенное, а не то, что смотрят сейчас
            var later = favoriteRow(tracked, 'wath');

            if (later.length) {
                var later_cards = [];
                for (i = 0; i < later.length; i++) later_cards.push(UserData.decorate(later[i]));
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_later'),
                    results: later_cards,
                    shiki: true,
                    line_type: 'shiki',
                    noimage: true,
                    nomore: true,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            this.build(data);
            watchScrollable();

            // Соответствия TMDB для карточек лент — заранее, чтобы открывались сразу
            prefetchMatches([].concat(lines.released || [], lines.ongoing || [], lines.season || [], lines.anons || []));
        };

        // Перехват кликов по карточкам Shikimori и действиям
        comp.onAppend = function (item, element) {
            if (element.shiki) {
                item.onSelect = function (target, card_data) {
                    openAnime(card_data);
                };
            }
            if (element.shiki_actions) {
                item.onSelect = function (target, card_data) {
                    if (card_data.action == 'search') openCatalog({ open_search: true });
                    if (card_data.action == 'catalog') openCatalog({});
                    if (card_data.action == 'calendar') openCatalog({ mode: 'calendar' });
                    if (card_data.action == 'settings') accountScreen();
                    if (card_data.action == 'login') accountScreen();
                    if (card_data.action == 'account') accountScreen();
                };
            }
        };

        comp.onDestroy = function () {
            if (comp.cancelWait) comp.cancelWait();
            net.clear();
        };

        return comp;
    }

    // Сколько серий реально доступно. Kodik сообщает номер последней серии у
    // студии, и больше, чем вышло в эфир, быть не может. Но счётчик эфира и у
    // Kodik, и у Shikimori обновляется с опозданием: серия уже вышла с озвучкой,
    // а счётчик ещё нет — и раньше она пряталась до его обновления. Поэтому
    // на одну серию вперёд верим Kodik, а заметно больше — это другая нумерация
    // (второй сезон, пронумерованный с 13-й серии), и тогда верим эфиру
    function countAvailable(info, aired) {
        var ep = info.ep || 0;
        var cap = Math.max(info.aired || 0, parseInt(aired, 10) || 0);
        if (cap > 0 && ep > cap + 1) return cap;
        return ep;
    }

    // Затемнение у края имеет смысл только там, где есть что прокручивать.
    // Карточки догружаются асинхронно, поэтому проверяем не один раз
    function markScrollable() {
        var lines = document.querySelectorAll('.items-line--type-shiki');
        for (var i = 0; i < lines.length; i++) {
            var body = lines[i].querySelector('.items-line__body');
            var track = lines[i].querySelector('.scroll__content') || lines[i].querySelector('.scroll__body');
            if (!body || !track) continue;

            if (track.scrollWidth > body.clientWidth + 4) lines[i].classList.add('shikimori-scrollable');
            else lines[i].classList.remove('shikimori-scrollable');
        }
    }

    var scroll_timer = null;
    var scroll_listening = false;

    function watchScrollable() {
        setTimeout(markScrollable, 300);
        setTimeout(markScrollable, 1200);

        // Лента дорисовывает карточки на ходу, поэтому ширина трека меняется
        // уже после сборки экрана — пересчитываем при переходах фокуса.
        // Слушатель один на всё приложение: раньше каждый показ главной
        // добавлял ещё один, и за вечер их набирались десятки
        if (scroll_listening) return;
        scroll_listening = true;
        try {
            document.addEventListener('hover:focus', function () {
                clearTimeout(scroll_timer);
                scroll_timer = setTimeout(markScrollable, 200);
            }, true);
        }
        catch (e) {}
    }

    function itemKey(item) {
        if (item.tmdb && item.tmdb.id) return 't' + item.tmdb.id;
        return 's' + ((item.kodik && item.kodik.sid) || 0);
    }

    // Что не показываем в личных строках: убранное через «Не интересует»,
    // а также помеченное в Lampa как просмотренное или брошенное — там решение
    // уже принято, и новая серия ничего не меняет
    function visible(item) {
        // Проверяем тайтл всеми его идентификаторами: скрыть могли карточку
        // из каталога, а тот же тайтл лежит в закладках под номером TMDB
        if (Hidden.hasCard({
            _kodik: item.kodik,
            _sids: item.sids,
            _tmdb_card: !!item.tmdb,
            id: item.tmdb ? item.tmdb.id : (item.card && item.card.id)
        })) return false;
        if (item.groups && (item.groups.viewed || item.groups.thrown)) return false;
        return true;
    }

    // Что реально смотрится: есть прогресс и есть непросмотренное. Тег этого
    // не знает — его ставят один раз и не снимают, поэтому досмотренное
    // висит в «Смотрю» месяцами
    function watchingNow(tracked) {
        var recent = Date.now() - WATCHING_RECENT_DAYS * 86400000;
        var picked = [];

        for (var i = 0; i < tracked.length; i++) {
            var item = tracked[i];
            if (item.groups && item.groups.look) continue;  // помеченные идут отдельно, выше
            if (!visible(item)) continue;
            if (!item.watched || item.total <= item.watched) continue;

            // «Веду прямо сейчас» — это статус на Shikimori либо недавний просмотр
            // в Lampa. Всё остальное с непросмотренными сериями — это отложенное,
            // и ему место в отдельной строке, а не здесь
            var active = item.status == 'watching' || item.status == 'rewatching' ||
                (item.watched_at && item.watched_at >= recent);
            if (!active) continue;

            picked.push(item);
        }

        picked.sort(function (a, b) { return b.watched_at - a.watched_at; });
        return picked;
    }

    // Одна категория избранного Lampa -> строка. Порядок как в «Продолжить
    // просмотр»: что включали последним — то и сверху. Дальше начатое, потом
    // то, где есть новые серии, и в конце нетронутое
    function favoriteRow(tracked, group) {
        var picked = [];
        for (var i = 0; i < tracked.length; i++) {
            if (tracked[i].groups && tracked[i].groups[group] && visible(tracked[i])) picked.push(tracked[i]);
        }
        picked.sort(function (a, b) {
            if (a.watched_at != b.watched_at) return b.watched_at - a.watched_at;
            if ((b.watched > 0 ? 1 : 0) != (a.watched > 0 ? 1 : 0)) return (b.watched > 0 ? 1 : 0) - (a.watched > 0 ? 1 : 0);
            if ((b.fresh > 0 ? 1 : 0) != (a.fresh > 0 ? 1 : 0)) return (b.fresh > 0 ? 1 : 0) - (a.fresh > 0 ? 1 : 0);
            return b.at - a.at;
        });
        return picked;
    }

    // Календарная запись -> данные для ShikiCard
    function upcomingToCard(entry) {
        var anime = {
            id: entry.anime.id,
            malId: entry.anime.id,
            name: entry.anime.name,
            russian: entry.anime.russian,
            image: entry.anime.image,
            kind: entry.anime.kind,
            score: entry.anime.score,
            status: entry.anime.status,
            episodes: entry.anime.episodes,
            episodesAired: entry.anime.episodes_aired,
            poster_url: entry.anime.poster_url || '',
            _next_at: entry.at,
            _next_episode: entry.episode
        };
        if (entry.rate) {
            anime._rate_episodes = entry.rate._rate_episodes;
            anime.poster = entry.rate.poster;
        }
        if (entry.tmdb) anime._direct_tmdb = { id: entry.tmdb.tmdb, method: entry.tmdb.media || '' };
        if (entry.fav_card && entry.fav_card.img) anime._fav_img = entry.fav_card.img;
        return anime;
    }

    // Соответствия TMDB для карточек на экране — одним запросом заранее.
    // Тогда нажатие открывает карточку сразу, без похода в базу соответствий.
    // Имена TMDB, по которым видны отметки серий из Lampa, — только у того,
    // что выходит сейчас: каждое имя — это запрос к TMDB, а страница
    // каталога — три десятка карточек, большинство из которых не откроют
    function prefetchMatches(cards) {
        var ids = [];
        var airing = [];
        var kinds = {};
        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            if (!card || isTmdbCard(card) || card._direct_tmdb) continue;
            var id = parseInt(card.malId || card.id, 10);
            if (!id || ids.indexOf(id) >= 0) continue;
            ids.push(id);
            kinds[id] = card.kind;
            if (card.status == 'ongoing' && airing.length < PREFETCH_NAMES_MAX) airing.push(id);
        }
        if (!ids.length) return;
        Match.batch(background_net, ids, function () {
            if (airing.length) TmdbInfo.names(airing, null, kinds);
        });
    }

    // Открыть тайтл из любой строки: у карточки TMDB номер уже есть,
    // тайтл Shikimori сперва сопоставляется. Вид номера у календаря бывает
    // неизвестен (так отвечает база соответствий) — тогда тоже через
    // сопоставление: оно уточнит, сериал это или фильм
    function openAnime(card) {
        if (card._direct_tmdb && card._direct_tmdb.method) openTmdb(card._direct_tmdb, card);
        else Match.openCard(card);
    }

    function openCatalog(params) {
        Lampa.Activity.push({
            url: '',
            title: Lampa.Lang.translate(params.mode == 'calendar' ? 'shikimori_action_calendar' :
                params.mode == 'mylist' ? 'shikimori_title_watching' : 'shikimori_action_catalog'),
            component: PLUGIN + '_catalog',
            page: 1,
            mode: params.mode || 'catalog',
            filters: params.filters || {},
            open_search: params.open_search || false
        });
    }

    // Быстрый ввод ника с главного экрана
    function askNickname() {
        Lampa.Input.edit({
            title: Lampa.Lang.translate('shikimori_settings_user'),
            value: storString('shikimori_user', ''),
            free: true,
            nosave: true
        }, function (value) {
            value = String(value || '').replace(/^\s+|\s+$/g, '');
            Lampa.Controller.toggle('content');
            if (!value) return;

            storSet('shikimori_user', value);
            storSet('shikimori_user_id', null);
            UserData.dropRatesCache();

            // Раньше ник молча сохранялся, и выглядело это как «ничего не
            // произошло». Теперь профиль сразу проверяется, и мы говорим,
            // что именно нашли — или почему не нашли
            Lampa.Noty.show(Lampa.Lang.translate('shikimori_nick_checking'));

            UserData.rates(background_net, function (rates) {
                var total = 0;
                for (var key in rates.mals) total++;

                if (!total) Lampa.Noty.show(Lampa.Lang.translate('shikimori_nick_empty'));
                else Lampa.Noty.show(Lampa.Lang.translate('shikimori_nick_ok') + ' ' + total + ' · ' +
                    Lampa.Lang.translate('shikimori_nick_watching') + ' ' + rates.watching.length);

                Lampa.Activity.push({
                    url: '',
                    title: manifest.name,
                    component: PLUGIN + '_main',
                    page: 1
                });
            }, function () {
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_nick_fail'));
            });
        });
    }

    /* ============================================================
     * Каталог: фильтры + сетка + пагинация
     * ============================================================ */

    var FILTER_KINDS = ['tv', 'movie', 'ova', 'ona', 'special', 'tv_special'];
    var FILTER_STATUSES = ['ongoing', 'anons', 'released'];
    var FILTER_ORDERS = ['popularity', 'ranked', 'aired_on', 'name', 'random'];
    var FILTER_DURATIONS = ['S', 'D', 'F'];   // до 10 минут, до 30, свыше
    var FILTER_RATINGS = ['g', 'pg', 'pg_13', 'r', 'r_plus'];
    var FILTER_SCORES = [9, 8, 7, 6];

    function CatalogComponent(object) {
        var self = this;
        var net = new NetPool();
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250, end_ratio: 2 });
        var items = [];
        var html = document.createElement('div');
        var head = null;
        var genres = [];
        var head_el = null;
        var body = null;
        var last = null;
        var waitload = false;
        var has_more = true;
        var reload_id = 0;

        // Активные фильтры (копия из object, чтобы жить при back)
        object.filters = object.filters || {};

        this.create = function () {
            this.activity.loader(true);
            scroll.minus();

            body = document.createElement('div');
            body.className = 'category-full shikimori-catalog';

            if (object.mode == 'catalog') {
                head = this.buildHead();
                // Шапка ВНЕ прокрутки. Внутри неё position:sticky не работает:
                // Lampa двигает содержимое трансформацией, а трансформированный
                // предок отменяет прилипание. Поэтому шапка стоит отдельным
                // блоком над списком и не уезжает вообще
                html.appendChild(head);
                scroll.minus(head);
            }

            scroll.append(body);
            html.appendChild(scroll.render(true));

            scroll.onEnd = this.next.bind(this);
            scroll.onWheel = function (step) {
                if (!Lampa.Controller.own(self)) self.start();
                if (step > 0) Navigator.move('down');
                else Navigator.move('up');
            };

            // Пока едет первая страница, на месте сетки стоит её скелет
            body.appendChild(skeletonGrid(object.mode == 'catalog' ? 12 : 8));

            if (object.open_search) {
                // Первую загрузку запускает сама клавиатура. Иначе ответ приходит,
                // пока клавиатура открыта, и ready() -> activity.toggle() забирает
                // у неё фокус: дальше стрелки управляют сеткой, а оверлей уже не
                // закрыть. Задержку убирать нельзя — Activity.push() сразу после
                // create() синхронно делает Controller.toggle('content')
                object.open_search = false;
                setTimeout(function () { self.searchInput(); }, 300);
            }
            else this.load(true);

            return this.render();
        };

        /* ---------- Шапка: штатный фильтр Lampa ---------- */

        /* ---------- Шапка: та же строка кнопок, что на главной ---------- */

        // Штатный Lampa.Filter рассчитан на торренты: его поиск ведёт в уточнение
        // раздач, а набор полей фиксирован. Здесь своя строка кнопок — ровно те же
        // .shikimori-action, что на главном экране, и каждая открывает свой список
        this.buildHead = function () {
            head_el = document.createElement('div');
            head_el.className = 'shikimori-head';

            // Фоновым пулом, а не своим: reload() очищает свой пул, и вместе
            // с сеткой обрывался запрос жанров — после первой же смены фильтра
            // список жанров оставался пустым до перезахода на экран
            self.loadGenres(function () { self.updateHead(); });

            this.updateHead();
            return head_el;
        };

        this.loadGenres = function (done) {
            if (genres.length) return done();
            Shiki.genresAll(background_net, function (list) {
                genres = list;
                done();
            }, function () {
                done();
            });
        };

        // Три кнопки, как в родном каталоге Lampa: поиск, сортировка, фильтр.
        // Одиннадцать кнопок в строку — это десять нажатий пультом до последней,
        // и все они одного веса. Категории фильтра живут внутри одного списка,
        // где выбранное значение видно подписью
        this.filterButtons = function () {
            var f = object.filters;
            var list = [
                { key: 'search', icon: ICON_SEARCH, title: Lampa.Lang.translate('shikimori_chip_search'), value: f.search },
                { key: 'order', icon: ICON_SORT, title: Lampa.Lang.translate('shikimori_chip_order'),
                  value: f.order ? Lampa.Lang.translate('shikimori_order_' + f.order) : '' },
                { key: 'filter', icon: ICON_FILTER, title: Lampa.Lang.translate('shikimori_chip_filter'),
                  value: this.activeCount() ? String(this.activeCount()) : '' }
            ];

            if (this.activeCount() || f.search || f.order) {
                list.push({ key: 'reset', title: Lampa.Lang.translate('shikimori_chip_reset') });
            }
            return list;
        };

        // Сколько условий выставлено — это число и стоит на кнопке «Фильтр»
        this.activeCount = function () {
            var keys = ['genre', 'theme', 'demographic', 'kind', 'status', 'season', 'score', 'duration', 'rating'];
            var n = 0;
            for (var i = 0; i < keys.length; i++) {
                var v = object.filters[keys[i]];
                if (!v) continue;
                n += (keys[i] == 'genre' || keys[i] == 'theme' || keys[i] == 'demographic')
                    ? String(v).split(',').filter(function (x) { return x; }).length
                    : 1;
            }
            return n;
        };

        this.filterCategories = function () {
            return [
                { key: 'genre', title: Lampa.Lang.translate('shikimori_chip_genre'), value: this.genreLabel('genre') },
                { key: 'theme', title: Lampa.Lang.translate('shikimori_chip_theme'), value: this.genreLabel('theme') },
                { key: 'demographic', title: Lampa.Lang.translate('shikimori_chip_demographic'), value: this.genreLabel('demographic') },
                { key: 'kind', title: Lampa.Lang.translate('shikimori_chip_kind'), value: this.enumLabel('kind', FILTER_KINDS, 'shikimori_kind_') },
                { key: 'status', title: Lampa.Lang.translate('shikimori_chip_status'), value: this.enumLabel('status', FILTER_STATUSES, 'shikimori_status_filter_') },
                { key: 'season', title: Lampa.Lang.translate('shikimori_chip_season'), value: this.seasonLabel() },
                { key: 'score', title: Lampa.Lang.translate('shikimori_chip_score'),
                  value: object.filters.score ? (Lampa.Lang.translate('shikimori_score_from') + ' ' + object.filters.score) : '' },
                { key: 'duration', title: Lampa.Lang.translate('shikimori_chip_duration'), value: this.enumLabel('duration', FILTER_DURATIONS, 'shikimori_duration_') },
                { key: 'rating', title: Lampa.Lang.translate('shikimori_chip_rating'), value: this.enumLabel('rating', FILTER_RATINGS, 'shikimori_rating_') }
            ];
        };

        // Список категорий: подпись под каждой — что выбрано сейчас
        this.openFilterMenu = function () {
            var owner = ownerController();
            var cats = this.filterCategories();
            var items = [];
            var any = Lampa.Lang.translate('shikimori_any');

            for (var i = 0; i < cats.length; i++) {
                items.push({
                    title: cats[i].title,
                    subtitle: cats[i].value || any,
                    key: cats[i].key
                });
            }

            if (this.activeCount()) {
                items.push({
                    title: Lampa.Lang.translate('shikimori_chip_reset_filters'),
                    subtitle: Lampa.Lang.translate('shikimori_chip_reset_hint'),
                    key: 'reset_filters'
                });
            }

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_chip_filter'),
                items: items,
                onSelect: function (item) {
                    if (item.key == 'reset_filters') {
                        var keys = ['genre', 'theme', 'demographic', 'kind', 'status', 'season', 'score', 'duration', 'rating'];
                        for (var j = 0; j < keys.length; j++) object.filters[keys[j]] = '';
                        restoreController(owner);
                        self.updateHead();
                        self.reload();
                        return;
                    }
                    // Из категории возвращаемся обратно в список, а не наружу
                    self.openFilter(item.key, function () { self.openFilterMenu(); });
                },
                onBack: function () { restoreController(owner); }
            });
        };

        this.updateHead = function () {
            if (!head_el) return;

            head_el.innerHTML = '';
            var buttons = this.filterButtons();

            for (var i = 0; i < buttons.length; i++) {
                (function (btn) {
                    var el = Lampa.Template.js('shikimori_action');
                    el.querySelector('.shikimori-action__icon').innerHTML = btn.icon || '';
                    if (!btn.icon) el.querySelector('.shikimori-action__icon').style.display = 'none';

                    // Выбранное значение видно прямо на кнопке, как в родном фильтре
                    el.querySelector('.shikimori-action__title').innerText = btn.value
                        ? (btn.title + ': ' + btn.value)
                        : btn.title;

                    if (btn.value) el.classList.add('shikimori-action--active');

                    el.addEventListener('hover:enter', function () {
                        self.openFilter(btn.key);
                    });

                    head_el.appendChild(el);
                })(buttons[i]);
            }
        };

        this.genreLabel = function (kind) {
            var chosen = String(object.filters[kind] || '').split(',');
            var names = [];
            for (var i = 0; i < genres.length; i++) {
                if (genres[i].kind == kind && chosen.indexOf(String(genres[i].id)) >= 0) names.push(genres[i].title);
            }
            if (!names.length) return '';
            return names.length > 2 ? (names.length + ' ' + Lampa.Lang.translate('shikimori_chosen')) : names.join(', ');
        };

        this.enumLabel = function (key, values, prefix) {
            var v = object.filters[key];
            if (!v) return '';
            for (var i = 0; i < values.length; i++) {
                if (values[i] == v) return Lampa.Lang.translate(prefix + v);
            }
            return v;
        };

        this.seasonLabel = function () {
            var v = object.filters.season;
            if (!v) return '';
            var list = this.seasonValues();
            for (var i = 0; i < list.length; i++) if (list[i].v == v) return list[i].t;
            return v;
        };

        this.openFilter = function (key, back) {
            var owner = ownerController();

            if (key == 'search') return this.searchInput();
            if (key == 'filter') return this.openFilterMenu();

            if (key == 'reset') {
                object.filters = { search: '' };
                this.updateHead();
                this.reload();
                return;
            }

            if (key == 'genre' || key == 'theme' || key == 'demographic') return this.openGenres(key, back);

            var items = [];
            var current = object.filters[key];
            var i;

            items.push({
                title: Lampa.Lang.translate(key == 'order' ? 'shikimori_order_default' : 'shikimori_any'),
                value: '',
                selected: !current
            });

            if (key == 'season') {
                var list = this.seasonValues();
                for (i = 0; i < list.length; i++) items.push({ title: list[i].t, value: list[i].v, selected: current == list[i].v });
            }
            else if (key == 'score') {
                for (i = 0; i < FILTER_SCORES.length; i++) {
                    items.push({
                        title: Lampa.Lang.translate('shikimori_score_from') + ' ' + FILTER_SCORES[i],
                        value: FILTER_SCORES[i],
                        selected: current == FILTER_SCORES[i]
                    });
                }
            }
            else {
                var map = { kind: [FILTER_KINDS, 'shikimori_kind_'], status: [FILTER_STATUSES, 'shikimori_status_filter_'],
                            duration: [FILTER_DURATIONS, 'shikimori_duration_'], rating: [FILTER_RATINGS, 'shikimori_rating_'],
                            order: [FILTER_ORDERS, 'shikimori_order_'] };
                var pair = map[key];
                if (!pair) return;
                for (i = 0; i < pair[0].length; i++) {
                    items.push({
                        title: Lampa.Lang.translate(pair[1] + pair[0][i]),
                        value: pair[0][i],
                        selected: current == pair[0][i]
                    });
                }
            }

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_chip_' + (key == 'order' ? 'order' : key)),
                items: items,
                onSelect: function (item) {
                    object.filters[key] = item.value;
                    self.updateHead();
                    self.reload();
                    if (back) back();
                    else restoreController(owner);
                },
                onBack: function () {
                    if (back) back();
                    else restoreController(owner);
                }
            });
        };

        // Жанры, темы и демография — мультивыбор: у Shikimori это один параметр,
        // различаются только идентификаторы. Отмечаются галочками, список при
        // этом не закрывается (nohide), поэтому выбрать можно сразу несколько.
        // Раньше здесь был обход через переоткрытие списка: считалось, что
        // onCheck не вызывается. Вызывается — но только у пунктов с checkbox
        this.openGenres = function (kind, back) {
            var owner = ownerController();

            // Справочник мог не успеть загрузиться — дожидаемся его,
            // вместо того чтобы показывать «ошибка API» на пустом списке
            if (!genres.length) {
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_genres_loading'));
                return this.loadGenres(function () {
                    if (genres.length) self.openGenres(kind, back);
                    else Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_api'));
                });
            }

            var chosen = String(object.filters[kind] || '').split(',').filter(function (v) { return v; });
            var items = [{
                title: Lampa.Lang.translate('shikimori_any'),
                subtitle: chosen.length
                    ? Lampa.Lang.translate('shikimori_chosen') + ': ' + chosen.length
                    : '',
                action: 'any'
            }];

            for (var i = 0; i < genres.length; i++) {
                if (genres[i].kind != kind) continue;
                var id = String(genres[i].id);
                items.push({
                    title: genres[i].title,
                    value: id,
                    checkbox: true,
                    checked: chosen.indexOf(id) >= 0
                });
            }

            if (items.length < 2) return Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_api'));

            function close() {
                self.reload();
                if (back) back();
                else restoreController(owner);
            }

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_chip_' + kind),
                items: items,
                nohide: true,
                onCheck: function (item) {
                    var list = String(object.filters[kind] || '').split(',').filter(function (v) { return v; });
                    var at = list.indexOf(item.value);
                    if (item.checked && at < 0) list.push(item.value);
                    if (!item.checked && at >= 0) list.splice(at, 1);
                    object.filters[kind] = list.join(',');
                    self.updateHead();
                },
                onSelect: function (item) {
                    if (item.action != 'any') return;
                    // Список остаётся открытым (nohide), поэтому не закрываемся,
                    // а перерисовываем его уже без галочек
                    object.filters[kind] = '';
                    self.updateHead();
                    self.openGenres(kind, back);
                },
                onBack: close
            });
        };

        this.seasonValues = function () {
            var list = [];
            for (var i = 0; i < 8; i++) list.push({ v: currentSeason(-i), t: seasonTitle(currentSeason(-i)) });
            var year = new Date().getFullYear();
            for (i = 0; i < 6; i++) list.push({ v: String(year - i), t: String(year - i) });
            list.push({ v: '1990_1999', t: '1990-е' });
            list.push({ v: '1980_1989', t: '1980-е' });
            return list;
        };

        this.searchInput = function () {
            Lampa.Input.edit({
                title: Lampa.Lang.translate('shikimori_chip_search'),
                value: object.filters.search || '',
                free: true,
                nosave: true
            }, function (value) {
                object.filters.search = value || '';
                self.updateHead();
                self.reload();
                self.start();
            });
        };

        /* ---------- Данные ---------- */

        this.requestParams = function () {
            var f = object.filters;

            // У Shikimori жанры, темы и демография — один параметр genre,
            // различаются только идентификаторы. Собираем их вместе
            var ids = [];
            var kinds = ['genre', 'theme', 'demographic'];
            for (var i = 0; i < kinds.length; i++) {
                if (f[kinds[i]]) ids.push(f[kinds[i]]);
            }

            var params = {
                page: object.page,
                limit: 36,
                kind: f.kind,
                status: f.status,
                season: f.season,
                genre: ids.join(','),
                score: f.score,
                duration: f.duration,
                rating: f.rating,
                search: f.search
            };
            if (f.order) params.order = f.order;
            else if (!f.search) params.order = 'popularity';
            return params;
        };

        // Поиск у Shikimori отдаёт результаты по релевантности и параметр order
        // при этом не применяет: выбранная сортировка просто не срабатывала.
        // Сортируем такую выдачу сами — по тому же полю, что выбрано в шапке
        this.ordered = function (list) {
            var order = object.filters.order;
            if (!object.filters.search || !order || order == 'random') return list;

            var sorted = list.slice(0);
            sorted.sort(function (a, b) {
                if (order == 'ranked') return (parseFloat(b.score) || 0) - (parseFloat(a.score) || 0);
                if (order == 'aired_on') {
                    return ((b.airedOn && b.airedOn.year) || 0) - ((a.airedOn && a.airedOn.year) || 0);
                }
                if (order == 'name') {
                    var an = (a.russian || a.name || '').toLowerCase();
                    var bn = (b.russian || b.name || '').toLowerCase();
                    return an > bn ? 1 : (an < bn ? -1 : 0);
                }
                return 0;
            });
            return sorted;
        };

        this.load = function (first) {
            if (object.mode == 'mylist') return this.loadMylist(first);
            if (object.mode == 'calendar') return this.loadCalendar(first);

            Shiki.catalog(net, this.requestParams(), function (list) {
                has_more = list.length >= 36;
                self.append(self.ordered(list));
                if (first) self.ready(list.length);
                waitload = false;
            }, function (reason) {
                waitload = false;
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_api') + (reason ? ' · ' + reason : ''));
                if (first) self.empty();
            });
        };

        this.loadMylist = function (first) {
            has_more = false;
            UserData.rates(net, function (rates) {
                var list = rates.watching.slice(0);
                list.sort(function (a, b) {
                    var an = (a.episodesAired || 0) - (a._rate_episodes || 0);
                    var bn = (b.episodesAired || 0) - (b._rate_episodes || 0);
                    return (bn > 0 ? 1 : 0) - (an > 0 ? 1 : 0);
                });
                self.append(list);
                if (first) self.ready(list.length);
            }, function () {
                if (first) self.empty();
            });
        };

        // Календарь: карточки сгруппированы по дням выхода
        this.loadCalendar = function (first) {
            has_more = false;
            UserData.upcoming(net, function (upcoming) {
                var groups = [];
                var index = {};
                for (var i = 0; i < upcoming.length; i++) {
                    var entry = upcoming[i];
                    var key = dayKey(entry.at);
                    if (!index[key]) {
                        index[key] = { title: dayTitle(entry.at), cards: [] };
                        groups.push(index[key]);
                    }
                    index[key].cards.push(upcomingToCard(entry));
                }

                if (first) self.appendWeek(upcoming);

                var total = 0;
                for (i = 0; i < groups.length; i++) {
                    self.appendDay(groups[i].title);
                    self.append(groups[i].cards);
                    total += groups[i].cards.length;
                }
                if (first) self.ready(total);
            }, function (reason) {
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_calendar') + (reason ? ' · ' + reason : ''));
                if (first) self.empty();
            });
        };

        // Заголовок дня внутри сетки
        // Неделя одной полосой: сколько серий в каждый из ближайших семи дней.
        // Отвечает на «что сегодня» без прокрутки. Намеренно не фокусируется —
        // это сводка, а не элемент управления, и она не должна ломать пульт
        this.appendWeek = function (entries) {
            var counts = {};
            for (var i = 0; i < entries.length; i++) {
                var key = dayKey(entries[i].at);
                counts[key] = (counts[key] || 0) + 1;
            }

            var week = document.createElement('div');
            week.className = 'shikimori-week';
            var today = new Date();

            for (i = 0; i < 7; i++) {
                var day = new Date(today.getTime() + i * 86400000);
                var count = counts[dayKey(day.getTime())] || 0;

                var cell = document.createElement('div');
                cell.className = 'shikimori-week__day' +
                    (i === 0 ? ' shikimori-week__day--today' : '') +
                    (count ? '' : ' shikimori-week__day--empty');

                var name = document.createElement('div');
                name.className = 'shikimori-week__name';
                name.innerText = WEEKDAYS_SHORT[day.getDay()];

                var date = document.createElement('div');
                date.className = 'shikimori-week__date';
                date.innerText = day.getDate();

                var num = document.createElement('div');
                num.className = 'shikimori-week__count';
                num.innerText = count ? count : '—';

                cell.appendChild(name);
                cell.appendChild(date);
                cell.appendChild(num);
                week.appendChild(cell);
            }

            body.appendChild(week);
        };

        this.appendDay = function (title) {
            var head_el = document.createElement('div');
            head_el.className = 'shikimori-day';
            head_el.innerText = title;
            body.appendChild(head_el);
        };

        this.next = function () {
            if (waitload || !has_more || object.mode != 'catalog') return;
            waitload = true;
            object.page++;
            this.load(false);
        };

        // Перезагрузка сетки. Фокус не трогаем: панель фильтра может быть открыта
        this.reload = function () {
            object.page = 1;
            has_more = true;
            last = null;
            reload_id++;
            var my_id = reload_id;

            for (var i = 0; i < items.length; i++) items[i].destroy();
            items = [];
            while (body.firstChild) body.removeChild(body.firstChild);
            body.appendChild(skeletonGrid(12));

            net.clear();
            this.activity.loader(true);

            Shiki.catalog(net, this.requestParams(), function (list) {
                if (my_id != reload_id) return;
                has_more = list.length >= 36;
                self.append(self.ordered(list));
                self.activity.loader(false);
                if (!list.length) Lampa.Noty.show(Lampa.Lang.translate('shikimori_empty'));
            }, function (reason) {
                if (my_id != reload_id) return;
                skeletonClear(body);
                self.activity.loader(false);
                // Причину показываем прямо на экране: «просто пусто» после смены
                // сортировки — это не ответ, а с пульта в консоль не заглянешь
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_api') +
                    (reason ? ' · ' + reason : ''));
            });
        };

        this.append = function (list) {
            skeletonClear(body);

            for (var i = 0; i < list.length; i++) {
                // «Не интересует» должно работать и здесь: раньше скрытое
                // отфильтровывалось только в личных строках на главной,
                // а в каталоге и календаре тайтл возвращался как ни в чём не бывало
                if (Hidden.hasCard(list[i])) continue;
                (function (anime) {
                    var card = new ShikiCard(anime);
                    card.create();

                    card.onFocus = function (target) {
                        last = target;
                        scroll.update(target);
                    };
                    card.onTouch = function (target) {
                        last = target;
                    };
                    card.onEnter = function (target, card_data) {
                        last = target;
                        openAnime(card_data);
                    };

                    body.appendChild(card.render(true));
                    items.push(card);

                    if (Lampa.Controller.own(self)) Lampa.Controller.collectionAppend(card.render(true));
                })(list[i]);
            }

            prefetchMatches(list);

            // Постеры теперь ждут события visible — просим Lampa пересчитать,
            // что попало в кадр. Дальше это делает сама прокрутка
            try { Lampa.Layer.visible(scroll.render(true)); }
            catch (e) {}
        };

        this.ready = function (count) {
            skeletonClear(body);
            this.updateHead();
            this.activity.loader(false);
            this.activity.toggle();
            if (!count) Lampa.Noty.show(Lampa.Lang.translate('shikimori_empty'));
        };

        this.empty = function () {
            skeletonClear(body);
            var empty = new Lampa.Empty();
            html.appendChild(empty.render(true));
            this.start = empty.start.bind(empty);
            this.activity.loader(false);
            this.activity.toggle();
        };

        /* ---------- Жизненный цикл ---------- */

        this.start = function () {
            Lampa.Controller.add('content', {
                link: this,
                toggle: function () {
                    // Собираем весь экран, а не только прокрутку: кнопки шапки
                    // теперь снаружи, и иначе они выпадут из навигации
                    Lampa.Controller.collectionSet(html);
                    Lampa.Controller.collectionFocus(last || false, html);
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () {
                    Navigator.move('right');
                },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () {
                    if (Navigator.canmove('down')) Navigator.move('down');
                },
                back: function () {
                    Lampa.Activity.backward();
                }
            });
            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};

        this.render = function (js) {
            return js ? html : $(html);
        };

        this.destroy = function () {
            net.clear();
            for (var i = 0; i < items.length; i++) items[i].destroy();
            items = [];
            head_el = null;
            scroll.destroy();
            html.remove();
        };
    }

    /* ============================================================
     * Обогащение полной карточки (рейтинг Shikimori + след. серия)
     * ============================================================ */

    function setupFullCardEnrichment() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type != 'complite') return;
            try {
                var movie = e.data.movie;
                if (!movie || !movie.id) return;

                var animation = (movie.genres || []).some ?
                    (movie.genres || []).some(function (g) { return g.id == 16; }) :
                    false;
                if (!animation) {
                    var gids = movie.genre_ids || [];
                    animation = gids.indexOf(16) >= 0;
                }
                var jp = movie.original_language == 'ja' || (movie.origin_country || []).indexOf('JP') >= 0;
                if (!animation || !jp) return;

                var source = e.object.source || movie.source;
                if (source && source != 'tmdb' && source != 'cub') return;

                var render = e.object.activity.render();
                var method = e.object.method || (movie.first_air_date || movie.number_of_seasons ? 'tv' : 'movie');

                TmdbInfo.remember(movie, method);

                // Сезоны из открытой карточки — самые свежие, и без запроса
                if (method == 'tv' && movie.seasons) Seasons.remember(movie.id, movie.seasons);

                // Тот же обратный маппинг, что у закладок: с разделением фильмов
                // и сериалов, поиском по названию и новыми сезонами. Раньше
                // брался первый попавшийся сезон, и у сериала с идущим вторым
                // сезоном «Следующая серия» не показывалась никогда — у первого
                // сезона её просто нет
                Match.reverse(background_net, [{
                    id: movie.id,
                    method: method,
                    name: movie.name || movie.title || '',
                    original_name: movie.original_name || movie.original_title || '',
                    year: parseInt(String(movie.first_air_date || movie.release_date || '').slice(0, 4), 10) || 0
                }], function (rev) {
                    var seasons = rev[movie.id] || [];
                    var ids = [];
                    for (var i = 0; i < seasons.length; i++) ids.push(seasons[i].mal);
                    if (ids.length) current(ids.slice(0, 50), 0, null);
                });

                function year(a) {
                    return (a && a.airedOn && a.airedOn.year) || 0;
                }

                // Текущий сезон: выходящий, если есть, иначе самый поздний.
                // Вышел и он — смотрим, нет ли у него продолжения
                function current(ids, depth, fallback) {
                    Shiki.related(background_net, ids, function (info) {
                        var pick = null;
                        for (var i = 0; i < ids.length; i++) {
                            var a = info[ids[i]];
                            if (!a) continue;
                            if (a.status == 'ongoing') { pick = a; break; }
                            if (!pick || year(a) >= year(pick)) pick = a;
                        }
                        if (!pick) return fallback ? show(fallback) : null;

                        if (pick.status != 'ongoing' && method == 'tv' && depth < SEQUEL_DEPTH) {
                            var next = [];
                            var rel = pick.related || [];
                            for (var j = 0; j < rel.length; j++) {
                                var r = rel[j];
                                if (r && r.relationKind == 'sequel' && r.anime && SERIES_KINDS.indexOf(r.anime.kind) >= 0 &&
                                    r.anime.status != 'anons') next.push(parseInt(r.anime.id, 10));
                            }
                            if (next.length) return current(next, depth + 1, pick);
                        }
                        show(pick);
                    }, function () {
                        if (fallback) show(fallback);
                    });
                }

                function show(anime) {
                    try {
                        var rate_line = render.find('.full-start-new__rate-line');
                        if (rate_line.length && parseFloat(anime.score) && !rate_line.find('.shikimori-rate').length) {
                            var badge = $('<div class="full-start__rate shikimori-rate"><div>' + parseFloat(anime.score).toFixed(1) + '</div><div class="source--name">Shikimori</div></div>');
                            rate_line.prepend(badge);
                        }
                        if (anime.nextEpisodeAt && parseISO(anime.nextEpisodeAt) > Date.now()) {
                            var at = parseISO(anime.nextEpisodeAt);
                            var num = (parseInt(anime.episodesAired, 10) || 0) + 1;
                            var text = Lampa.Lang.translate('shikimori_next_episode') + ': ' + num + ' ' + Lampa.Lang.translate('shikimori_ep') + ' · ' + formatDate(at);
                            var details_block = render.find('.full-start-new__details');
                            if (details_block.length && at) details_block.append('<span class="shikimori-next">' + text + '</span>');
                        }
                    } catch (err) {}
                }
            } catch (err) {}
        });
    }

    /* ============================================================
     * Настройки
     * ============================================================ */

    // Одна точка входа для всех параметров.
    //
    // Lampa рисует в колонку значения то, что лежит в Storage, а если там
    // пусто — подставляет placeholder, взятый из param.placeholder. Мы его не
    // задавали, и в разметку уезжала строка "undefined": именно она и висела
    // в настройках у пустого ника, токена и прокси
    function settingsParam(data) {
        data.component = 'shikimori';
        if (data.param.type == 'input' && !data.param.placeholder) {
            data.param.placeholder = Lampa.Lang.translate('shikimori_value_empty');
        }

        var onRender = data.onRender;
        data.onRender = function (item) {
            try {
                var value = item.find('.settings-param__value');
                if (value.text() == 'undefined') value.text('');
            }
            catch (e) {}
            if (onRender) onRender(item);
        };

        Lampa.SettingsApi.addParam(data);
    }

    function setupSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'shikimori',
            icon: ICON_MENU,
            name: manifest.name
        });

        // Версия первой строкой: единственный способ с пульта понять, какая
        // сборка реально загрузилась — плагин внедряется один раз при старте
        settingsParam({
            param: {
                name: 'shikimori_version',
                type: 'static'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_version') + ': ' + VERSION,
                description: Lampa.Lang.translate('shikimori_settings_version_descr')
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_user',
                type: 'input',
                values: '',
                default: '',
                placeholder: Lampa.Lang.translate('shikimori_value_no_nick')
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_user'),
                description: Lampa.Lang.translate('shikimori_settings_user_descr')
            },
            onChange: function () {
                storSet('shikimori_user_id', null);
                UserData.dropRatesCache();
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_card_style',
                type: 'select',
                values: {
                    native: Lampa.Lang.translate('shikimori_style_native'),
                    compact: Lampa.Lang.translate('shikimori_style_compact'),
                    poster: Lampa.Lang.translate('shikimori_style_poster')
                },
                default: 'native'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_style'),
                description: Lampa.Lang.translate('shikimori_settings_style_descr')
            }
        });

        settingsParam({
            param: {
                name: MOTION_KEY,
                type: 'trigger',
                default: true
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_motion'),
                description: Lampa.Lang.translate('shikimori_settings_motion_descr')
            },
            onChange: function () {
                applyMotion();
            }
        });

        settingsParam({
            param: {
                name: AMBIENCE_KEY,
                type: 'trigger',
                default: true
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_ambience'),
                description: Lampa.Lang.translate('shikimori_settings_ambience_descr')
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_uncensored',
                type: 'trigger',
                default: false
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_uncensored'),
                description: Lampa.Lang.translate('shikimori_settings_uncensored_descr')
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_kodik',
                type: 'trigger',
                default: true
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_kodik'),
                description: Lampa.Lang.translate('shikimori_settings_kodik_descr')
            },
            onChange: function () {
                Kodik.dropCache();
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_kodik_subs',
                type: 'trigger',
                default: false
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_kodik_subs'),
                description: Lampa.Lang.translate('shikimori_settings_kodik_subs_descr')
            },
            onChange: function () {
                Kodik.dropCache();
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_hidden_pick',
                type: 'button'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_hidden'),
                description: Lampa.Lang.translate('shikimori_settings_hidden_descr')
            },
            onChange: function () {
                pickHidden();
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_studios_pick',
                type: 'button'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_studios'),
                description: Lampa.Lang.translate('shikimori_settings_studios_descr')
            },
            onChange: function () {
                pickStudios();
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_kodik_host',
                type: 'input',
                values: '',
                default: KODIK_HOST
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_kodik_host'),
                description: Lampa.Lang.translate('shikimori_settings_kodik_host_descr')
            },
            onChange: function () {
                Kodik.dropCache();
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_kodik_token',
                type: 'input',
                values: '',
                default: '',
                placeholder: Lampa.Lang.translate('shikimori_value_builtin')
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_kodik_token'),
                description: Lampa.Lang.translate('shikimori_settings_kodik_token_descr')
            },
            onChange: function () {
                Kodik.dropCache();
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_proxy',
                type: 'input',
                values: '',
                default: '',
                placeholder: Lampa.Lang.translate('shikimori_value_no_proxy')
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_proxy'),
                description: Lampa.Lang.translate('shikimori_settings_proxy_descr')
            }
        });

        settingsParam({
            param: {
                name: 'shikimori_clear_cache',
                type: 'button'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_clear_cache'),
                description: Lampa.Lang.translate('shikimori_settings_clear_cache_descr')
            },
            onChange: function () {
                // Карточки TMDB, выбранные вручную, — не кэш, а ваше решение:
                // их оставляем, остальные соответствия сбрасываем
                var picked = {};
                var match = Match.cache();
                for (var key in match) {
                    if (match[key] && match[key].user) picked[key] = match[key];
                }
                storSet('shikimori_match', picked);
                Match.memo = null;
                storSet('shikimori_reverse', {});
                Match.rev_memo = null;
                storSet('shikimori_calendar_cache', null);
                storSet('shikimori_genres_cache', null);
                storSet('shikimori_user_id', null);
                Hidden.save({});
                storSet('shikimori_translations', null);
                storSet(TMDB_INFO_KEY, {});
                TmdbInfo.cache = null;
                storSet(SEASONS_KEY, {});
                Seasons.memo = null;
                Seen.reset();
                Kodik.reset();
                UserData.dropRatesCache();
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_settings_cache_cleared'));
            }
        });
    }

    /* ============================================================
     * Переводы
     * ============================================================ */

    function setupLang() {
        Lampa.Lang.add({
            shikimori_menu: { ru: 'Аниме', en: 'Anime', uk: 'Аніме' },
            shikimori_today: { ru: 'сегодня', en: 'today', uk: 'сьогодні' },
            shikimori_tomorrow: { ru: 'завтра', en: 'tomorrow', uk: 'завтра' },
            shikimori_today_full: { ru: 'Сегодня', en: 'Today', uk: 'Сьогодні' },
            shikimori_tomorrow_full: { ru: 'Завтра', en: 'Tomorrow', uk: 'Завтра' },
            shikimori_ep: { ru: 'серия', en: 'ep', uk: 'серія' },
            shikimori_ep_1: { ru: 'серия', en: 'ep', uk: 'серія' },
            shikimori_ep_2: { ru: 'серии', en: 'eps', uk: 'серії' },
            shikimori_ep_5: { ru: 'серий', en: 'eps', uk: 'серій' },
            shikimori_not_found: { ru: 'Не найдено в TMDB', en: 'Not found in TMDB', uk: 'Не знайдено в TMDB' },
            shikimori_pick_title: { ru: 'Какая это карточка TMDB?', en: 'Which TMDB card is it?', uk: 'Яка це картка TMDB?' },
            shikimori_empty: { ru: 'Ничего не найдено', en: 'Nothing found', uk: 'Нічого не знайдено' },
            shikimori_error_api: { ru: 'Не удалось загрузить', en: 'Could not load', uk: 'Не вдалося завантажити' },
            shikimori_any: { ru: 'Любой', en: 'Any', uk: 'Будь-який' },
            shikimori_next_episode: { ru: 'Следующая серия', en: 'Next episode', uk: 'Наступна серія' },

            shikimori_title_menu: { ru: 'Меню', en: 'Menu', uk: 'Меню' },
            shikimori_title_watching: { ru: 'Я смотрю', en: 'Watching', uk: 'Я дивлюсь' },
            shikimori_title_later: { ru: 'Позже', en: 'Later', uk: 'Пізніше' },
            shikimori_title_released: { ru: 'Свежая озвучка', en: 'Just dubbed', uk: 'Свіже озвучення' },
            shikimori_title_backlog: { ru: 'Есть что посмотреть', en: 'Ready to watch', uk: 'Є що подивитись' },

            shikimori_group_progress: { ru: 'Прогресс просмотра', en: 'Watch progress', uk: 'Прогрес перегляду' },
            shikimori_group_tag: { ru: 'Метка в избранном Lampa', en: 'Lampa bookmark tag', uk: 'Мітка в обраному Lampa' },
            shikimori_group_visible: { ru: 'Видимость в подборках', en: 'Visibility in rows', uk: 'Видимість у добірках' },
            shikimori_group_open: { ru: 'Переход', en: 'Navigate', uk: 'Перехід' },
            shikimori_menu_hide: { ru: 'Не интересует', en: 'Not interested', uk: 'Не цікавить' },
            shikimori_menu_unhide: { ru: 'Показывать снова', en: 'Show again', uk: 'Показувати знову' },
            shikimori_settings_hidden: { ru: 'Скрытые тайтлы', en: 'Hidden titles', uk: 'Приховані тайтли' },
            shikimori_settings_hidden_descr: { ru: 'Что вы убрали через «Не интересует». Выберите тайтл, чтобы вернуть его в строки', en: 'What you dismissed; pick a title to bring it back', uk: 'Що ви прибрали; оберіть тайтл, щоб повернути' },
            shikimori_hidden_empty: { ru: 'Ничего не скрыто', en: 'Nothing hidden', uk: 'Нічого не приховано' },
            shikimori_menu_seen: { ru: 'Отметить просмотренным до серии', en: 'Mark watched up to episode', uk: 'Позначити переглянутим до серії' },
            shikimori_menu_seen_all: { ru: 'Отметить все серии просмотренными', en: 'Mark every episode watched', uk: 'Позначити всі серії переглянутими' },
            shikimori_tag_on: { ru: 'метка поставлена', en: 'tagged', uk: 'мітку поставлено' },
            shikimori_tag_off: { ru: 'метка снята', en: 'untagged', uk: 'мітку знято' },
            shikimori_tag_fail: { ru: 'Не удалось изменить метку', en: 'Could not change the tag', uk: 'Не вдалося змінити мітку' },
            shikimori_menu_open: { ru: 'Открыть карточку', en: 'Open card', uk: 'Відкрити картку' },
            shikimori_menu_rematch: { ru: 'Выбрать другую карточку TMDB', en: 'Pick another TMDB card', uk: 'Обрати іншу картку TMDB' },
            shikimori_search_lampa: { ru: 'Искать в Lampa', en: 'Search in Lampa', uk: 'Шукати в Lampa' },
            shikimori_noty_hidden: { ru: 'Убрали. Вернуть можно в настройках', en: 'Dismissed. Restore it in settings', uk: 'Прибрали. Повернути можна в налаштуваннях' },
            shikimori_noty_unhidden: { ru: 'Вернули в строки', en: 'Back in the rows', uk: 'Повернули' },
            shikimori_noty_seen: { ru: 'Отмечено просмотренным', en: 'Marked as watched', uk: 'Позначено переглянутим' },
            shikimori_menu_unseen: { ru: 'Снять отметку «просмотрено»', en: 'Remove the “watched” mark', uk: 'Зняти позначку «переглянуто»' },
            shikimori_noty_unseen: { ru: 'Отметка снята — прогресс снова по Lampa и Shikimori', en: 'Mark removed — progress comes from Lampa and Shikimori again', uk: 'Позначку знято' },
            shikimori_title_fresh: { ru: 'Новые серии', en: 'New episodes', uk: 'Нові серії' },
            shikimori_title_upcoming: { ru: 'Скоро выйдут', en: 'Airing soon', uk: 'Скоро вийдуть' },
            shikimori_title_popular_cub: { ru: 'Сейчас смотрят в Lampa', en: 'Now watching in Lampa', uk: 'Зараз дивляться в Lampa' },
            shikimori_title_popular_tmdb: { ru: 'Популярное сейчас', en: 'Popular now', uk: 'Популярне зараз' },
            shikimori_title_ongoing: { ru: 'Популярные онгоинги', en: 'Popular ongoing', uk: 'Популярні онгоінги' },
            shikimori_title_season: { ru: 'Лучшее сезона', en: 'Best of season', uk: 'Найкраще сезону' },
            shikimori_title_anons: { ru: 'Ожидаемые анонсы', en: 'Upcoming anime', uk: 'Очікувані анонси' },

            shikimori_action_search: { ru: 'Поиск', en: 'Search', uk: 'Пошук' },
            shikimori_action_catalog: { ru: 'Каталог', en: 'Catalog', uk: 'Каталог' },
            shikimori_action_calendar: { ru: 'Календарь', en: 'Calendar', uk: 'Календар' },
            shikimori_action_set_user: { ru: 'Указать ник Shikimori', en: 'Set Shikimori username', uk: 'Вказати нік Shikimori' },
            shikimori_action_login: { ru: 'Войти по QR', en: 'Sign in with QR', uk: 'Увійти за QR' },

            shikimori_chip_search: { ru: 'Поиск', en: 'Search', uk: 'Пошук' },
            shikimori_chip_filter: { ru: 'Фильтр', en: 'Filter', uk: 'Фільтр' },
            shikimori_chip_reset_filters: { ru: 'Сбросить фильтры', en: 'Clear filters', uk: 'Скинути фільтри' },
            shikimori_chip_reset_hint: { ru: 'Вернуть все условия к «любой»', en: 'Set every condition back to any', uk: 'Повернути всі умови до «будь-який»' },
            shikimori_chip_theme: { ru: 'Тема', en: 'Theme', uk: 'Тема' },
            shikimori_chip_demographic: { ru: 'Аудитория', en: 'Demographic', uk: 'Аудиторія' },
            shikimori_chip_duration: { ru: 'Длительность', en: 'Duration', uk: 'Тривалість' },
            shikimori_chip_rating: { ru: 'Возраст', en: 'Rating', uk: 'Вік' },
            shikimori_chosen: { ru: 'выбрано', en: 'selected', uk: 'обрано' },
            shikimori_duration_S: { ru: 'До 10 минут', en: 'Under 10 min', uk: 'До 10 хвилин' },
            shikimori_duration_D: { ru: 'До 30 минут', en: 'Under 30 min', uk: 'До 30 хвилин' },
            shikimori_duration_F: { ru: 'Более 30 минут', en: 'Over 30 min', uk: 'Понад 30 хвилин' },
            shikimori_rating_g: { ru: 'G — без ограничений', en: 'G', uk: 'G' },
            shikimori_rating_pg: { ru: 'PG — детям', en: 'PG', uk: 'PG' },
            shikimori_rating_pg_13: { ru: 'PG-13 — с 13 лет', en: 'PG-13', uk: 'PG-13' },
            shikimori_rating_r: { ru: 'R — с 17 лет', en: 'R', uk: 'R' },
            shikimori_rating_r_plus: { ru: 'R+ — откровенное', en: 'R+', uk: 'R+' },
            shikimori_chip_genre: { ru: 'Жанр', en: 'Genre', uk: 'Жанр' },
            shikimori_chip_kind: { ru: 'Тип', en: 'Type', uk: 'Тип' },
            shikimori_chip_status: { ru: 'Статус', en: 'Status', uk: 'Статус' },
            shikimori_chip_season: { ru: 'Сезон', en: 'Season', uk: 'Сезон' },
            shikimori_chip_score: { ru: 'Оценка', en: 'Score', uk: 'Оцінка' },
            shikimori_chip_order: { ru: 'Сортировка', en: 'Sort', uk: 'Сортування' },
            shikimori_chip_reset: { ru: 'Сброс', en: 'Reset', uk: 'Скинути' },
            shikimori_score_from: { ru: 'от', en: 'from', uk: 'від' },

            shikimori_kind_tv: { ru: 'Сериал', en: 'TV', uk: 'Серіал' },
            shikimori_kind_movie: { ru: 'Фильм', en: 'Movie', uk: 'Фільм' },
            shikimori_kind_ova: { ru: 'OVA', en: 'OVA', uk: 'OVA' },
            shikimori_kind_ona: { ru: 'ONA', en: 'ONA', uk: 'ONA' },
            shikimori_kind_special: { ru: 'Спешл', en: 'Special', uk: 'Спешл' },
            shikimori_kind_tv_special: { ru: 'TV Спешл', en: 'TV Special', uk: 'TV Спешл' },
            shikimori_kind_music: { ru: 'Клип', en: 'Music', uk: 'Кліп' },
            shikimori_kind_pv: { ru: 'PV', en: 'PV', uk: 'PV' },
            shikimori_kind_cm: { ru: 'CM', en: 'CM', uk: 'CM' },

            shikimori_status_ongoing: { ru: 'Онгоинг', en: 'Ongoing', uk: 'Онгоінг' },
            shikimori_status_anons: { ru: 'Анонс', en: 'Anons', uk: 'Анонс' },
            shikimori_status_filter_ongoing: { ru: 'Онгоинг', en: 'Ongoing', uk: 'Онгоінг' },
            shikimori_status_filter_anons: { ru: 'Анонс', en: 'Anons', uk: 'Анонс' },
            shikimori_status_filter_released: { ru: 'Вышло', en: 'Released', uk: 'Вийшло' },

            shikimori_order_popularity: { ru: 'По популярности', en: 'By popularity', uk: 'За популярністю' },
            shikimori_order_ranked: { ru: 'По рейтингу', en: 'By rating', uk: 'За рейтингом' },
            shikimori_order_aired_on: { ru: 'По дате выхода', en: 'By air date', uk: 'За датою виходу' },
            shikimori_order_name: { ru: 'По названию', en: 'By name', uk: 'За назвою' },
            shikimori_order_random: { ru: 'Случайно', en: 'Random', uk: 'Випадково' },

            shikimori_settings_user: { ru: 'Ник на Shikimori', en: 'Shikimori username', uk: 'Нік на Shikimori' },
            shikimori_settings_user_descr: { ru: 'Даёт точный прогресс: сколько серий вы отметили в своём списке. Без ника прогресс берётся только из отметок Lampa. Списки профиля должны быть открыты в настройках приватности Shikimori', en: 'Gives exact progress from your public Shikimori lists', uk: 'Дає точний прогрес зі списків Shikimori' },
            shikimori_settings_style: { ru: 'Вид карточек', en: 'Card style', uk: 'Вигляд карток' },
            shikimori_settings_style_descr: { ru: 'Плотность сетки и оформление постеров', en: 'Grid density and poster look', uk: 'Щільність сітки та оформлення' },
            shikimori_style_native: { ru: 'Как в Lampa', en: 'Lampa native', uk: 'Як у Lampa' },
            shikimori_style_compact: { ru: 'Компактный', en: 'Compact', uk: 'Компактний' },
            shikimori_style_poster: { ru: 'Крупные постеры', en: 'Large posters', uk: 'Великі постери' },
            shikimori_settings_motion: { ru: 'Движение карточек', en: 'Card motion', uk: 'Рух карток' },
            shikimori_settings_motion_descr: { ru: 'Карточка в фокусе слегка увеличивается, нажатие даёт отклик. Выключите, если на вашем телевизоре движение выглядит рваным', en: 'The focused card scales slightly and a press responds', uk: 'Картка у фокусі трохи збільшується, натискання дає відгук' },
            shikimori_settings_ambience: { ru: 'Фон по карточке', en: 'Ambient background', uk: 'Фон за карткою' },
            shikimori_settings_ambience_descr: { ru: 'Фон меняется на кадр из тайтла, на котором стоит фокус. Работает, если в настройках Lampa включён фон', en: 'Background follows the focused title', uk: 'Фон змінюється за карткою у фокусі' },
            shikimori_settings_uncensored: { ru: 'Показывать 18+', en: 'Show 18+', uk: 'Показувати 18+' },
            shikimori_settings_uncensored_descr: { ru: 'Отключает фильтр цензуры в каталоге', en: 'Disables the catalogue censorship filter', uk: 'Вимикає фільтр цензури в каталозі' },
            shikimori_seen_all: { ru: 'Просмотрено', en: 'Watched', uk: 'Переглянуто' },
            shikimori_subtitles: { ru: 'субтитры', en: 'subtitles', uk: 'субтитри' },
            shikimori_dubbed: { ru: 'с озвучкой', en: 'dubbed', uk: 'з озвученням' },
            shikimori_settings_kodik: { ru: 'Строка «Новые серии»', en: 'New episodes row', uk: 'Рядок «Нові серії»' },
            shikimori_settings_kodik_descr: { ru: 'Серии, которые уже вышли с озвучкой (данные Kodik). Выключено — останутся только даты эфира в Японии', en: 'Episodes already released with a dub (Kodik). Off — Japanese air dates only', uk: 'Серії, що вже вийшли з озвучкою (Kodik)' },
            shikimori_settings_kodik_subs: { ru: 'Засчитывать субтитры', en: 'Count subtitles', uk: 'Зараховувати субтитри' },
            shikimori_settings_kodik_subs_descr: { ru: 'Показывать серию новой, если вышла только с субтитрами, без озвучки', en: 'Treat subtitle-only releases as new episodes', uk: 'Показувати серію новою, якщо вийшла лише із субтитрами' },
            shikimori_settings_version: { ru: 'Версия плагина', en: 'Plugin version', uk: 'Версія плагіна' },
            shikimori_settings_version_descr: { ru: 'Обновляется при перезапуске Lampa. Если версия старая — закройте приложение полностью и откройте заново', en: 'Updates when Lampa restarts', uk: 'Оновлюється під час перезапуску Lampa' },
            shikimori_action_account: { ru: 'Мой профиль', en: 'My profile', uk: 'Мій профіль' },

            shikimori_nick_checking: { ru: 'Проверяем профиль…', en: 'Checking the profile…', uk: 'Перевіряємо профіль…' },
            shikimori_nick_ok: { ru: 'Нашли тайтлов:', en: 'Titles found:', uk: 'Знайдено тайтлів:' },
            shikimori_nick_watching: { ru: 'смотрю:', en: 'watching:', uk: 'дивлюсь:' },
            shikimori_nick_empty: { ru: 'Профиль найден, но списки пусты или закрыты в настройках приватности', en: 'Profile found, but the lists are empty or private', uk: 'Профіль знайдено, але списки порожні або закриті' },
            shikimori_nick_fail: { ru: 'Профиль не найден. Проверьте написание ника', en: 'Profile not found, check the spelling', uk: 'Профіль не знайдено' },
            shikimori_settings_studios: { ru: 'Студии озвучки', en: 'Dub studios', uk: 'Студії озвучення' },
            shikimori_settings_studios_descr: { ru: 'Считать серию вышедшей только когда её озвучили выбранные студии. Не выбрано — засчитывается любая озвучка', en: 'Count an episode as out only when your studios dubbed it', uk: 'Зараховувати серію лише від обраних студій' },
            shikimori_studios_any: { ru: 'Любая озвучка', en: 'Any studio', uk: 'Будь-яка озвучка' },
            shikimori_studios_loading: { ru: 'Собираем список студий…', en: 'Collecting studios…', uk: 'Збираємо список студій…' },
            shikimori_studios_chosen: { ru: 'Выбрано', en: 'Chosen', uk: 'Обрано' },
            shikimori_studios_none: { ru: 'Сейчас засчитывается любая озвучка', en: 'Any dub counts right now', uk: 'Зараз зараховується будь-яка озвучка' },
            shikimori_studios_search: { ru: 'Найти студию', en: 'Find a studio', uk: 'Знайти студію' },
            shikimori_studios_more: { ru: 'Показаны не все, осталось ещё', en: 'Not all shown, more left', uk: 'Показані не всі, лишилось ще' },
            shikimori_studios_search_hint: { ru: 'Часть названия — список сократится', en: 'Part of the name filters the list', uk: 'Частина назви — список скоротиться' },
            shikimori_hidden_unknown: { ru: 'Тайтл', en: 'Title', uk: 'Тайтл' },
            shikimori_value_empty: { ru: 'Не задано', en: 'Not set', uk: 'Не задано' },
            shikimori_value_no_nick: { ru: 'Не указан', en: 'Not set', uk: 'Не вказано' },
            shikimori_value_builtin: { ru: 'Встроенные', en: 'Built-in', uk: 'Вбудовані' },
            shikimori_value_no_proxy: { ru: 'Без прокси', en: 'No proxy', uk: 'Без проксі' },
            shikimori_order_default: { ru: 'По умолчанию', en: 'Default', uk: 'За умовчанням' },
            shikimori_genres_loading: { ru: 'Загружаем жанры…', en: 'Loading genres…', uk: 'Завантажуємо жанри…' },
            shikimori_error_calendar: { ru: 'Календарь не загрузился', en: 'Calendar failed to load', uk: 'Календар не завантажився' },
            shikimori_settings_kodik_host: { ru: 'Адрес Kodik API', en: 'Kodik API host', uk: 'Адреса Kodik API' },
            shikimori_settings_kodik_host_descr: { ru: 'По умолчанию kodik-api.com. Менять, если домен снова переедет', en: 'Defaults to kodik-api.com. Change if the domain moves again', uk: 'За замовчуванням kodik-api.com' },
            shikimori_settings_kodik_token: { ru: 'Токен Kodik', en: 'Kodik token', uk: 'Токен Kodik' },
            shikimori_settings_kodik_token_descr: { ru: 'Свой токен, если встроенные перестали работать. Пустое поле — используются встроенные', en: 'Your own token if the built-in ones stop working', uk: 'Власний токен, якщо вбудовані перестали працювати' },
            shikimori_settings_proxy: { ru: 'CORS-прокси (опционально)', en: 'CORS proxy (optional)', uk: 'CORS-проксі (опціонально)' },
            shikimori_settings_proxy_descr: { ru: 'Например: https://mycorsproxy.example/ — подставляется перед адресом Shikimori, если прямой доступ заблокирован', en: 'Prefix before Shikimori URL if direct access is blocked', uk: 'Префікс перед адресою Shikimori' },
            shikimori_settings_clear_cache: { ru: 'Очистить кэш', en: 'Clear cache', uk: 'Очистити кеш' },
            shikimori_settings_clear_cache_descr: { ru: 'Сбросить кэш соответствий и сезонов TMDB, календаря, списков и известных серий, скрытые тайтлы и отметки «просмотрено» плагина. Карточки TMDB, выбранные вручную, останутся', en: 'Reset TMDB matching and seasons, calendar, lists, known episodes, hidden titles and the plugin’s “watched” marks. Manually picked TMDB cards stay', uk: 'Скинути кеш, приховані тайтли й позначки «переглянуто». Вручну обрані картки TMDB залишаться' },
            shikimori_settings_cache_cleared: { ru: 'Кэш очищен', en: 'Cache cleared', uk: 'Кеш очищено' }
        });
    }

    /* ============================================================
     * Шаблоны и стили
     * ============================================================ */

    var ICON_MENU = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M3 4.5C6 5.6 9 6 12 6C15 6 18 5.6 21 4.5L20.4 8H18.5L17.7 20H15.7L15 8H9L8.3 20H6.3L5.5 8H3.6L3 4.5Z" fill="currentColor"/>' +
        '<rect x="8" y="11" width="8" height="1.8" rx="0.5" fill="currentColor"/></svg>';

    var ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M16 16L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    var ICON_CATALOG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor"/>' +
        '<rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor"/>' +
        '<rect x="3" y="13" width="8" height="8" rx="1.5" fill="currentColor"/>' +
        '<rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';

    var ICON_SORT = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M4 7H20M7 12H17M10 17H14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    var ICON_FILTER = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M3 5H21L14 13V19L10 21V13L3 5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

    var ICON_CALENDAR = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M3 9H21" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M8 3V6M16 3V6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    var ICON_USER = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="12" cy="8" r="4" fill="currentColor"/>' +
        '<path d="M4 20C4 16.7 7.6 14 12 14C16.4 14 20 16.7 20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    function setupTemplates() {
        // Разметка карточки — штатные классы Lampa, чтобы совпадать с темой и скинами
        Lampa.Template.add('shikimori_card',
            '<div class="card selector layer--visible layer--render shikimori-card">' +
                '<div class="card__view">' +
                    '<img src="./img/img_load.svg" class="card__img" />' +
                    '<div class="shikimori-year"></div>' +
                    '<div class="card__type"></div>' +
                    '<div class="card__vote"></div>' +
                    '<div class="card__marker"><span></span></div>' +
                    '<div class="card__new-episode"><div></div></div>' +
                    '<div class="shikimori-progress"><i></i></div>' +
                    '<div class="card__promo"><div class="card__promo-title"></div></div>' +
                '</div>' +
                '<div class="card__title"></div>' +
                '<div class="card__age"></div>' +
            '</div>');

        Lampa.Template.add('shikimori_action',
            '<div class="simple-button selector shikimori-action">' +
                '<span class="shikimori-action__icon"></span>' +
                '<span class="shikimori-action__title"></span>' +
            '</div>');

        /* ================================================================
         * ПРАВИЛА ВЁРСТКИ
         * ----------------------------------------------------------------
         * Шкала отступов, от неё выводится всё:
         *   s1 0.3em · s2 0.6em · s3 1em · s4 1.5em · s5 2.25em · s6 3.4em
         * Значение вне шкалы допустимо только как производное и подписывается.
         *
         * Бейдж на постере — ОДИН набор метрик для всех четырёх углов.
         * Взят из чипов самой Lampa (.card__type, .card__quality):
         *   кегль 0.8em · поля 0.4em 0.5em · от угла s2
         *
         * Радиус вложенного элемента — не произвольный. Концентричность:
         *   радиус внутреннего = радиус внешнего − расстояние между ними
         * Постер скруглён на 1em, бейдж отстоит от угла на 0.6em, значит его
         * радиус равен 0.4em КАРТОЧКИ. Бейдж набран 0.8em, поэтому в его
         * собственных единицах это 0.5em. Раньше стояло 0.3em его кегля —
         * то есть 0.24em карточки, вчетверо острее постера, и угол выглядел
         * вырубленным. Меняешь отступ от угла — пересчитывай радиус.
         * Отличаются бейджи только цветом:
         *   нейтральный  rgba(0,0,0,.6) + #fff   — год, маркер, оценка
         *   выделенный   #fff + #000             — тип (редкий, потому громкий)
         *   акцентный    #D9A21B + #2A1C00       — новые серии и прогресс
         * Акцент раньше был голубым (#5DBFF5): на постере, который почти всегда
         * тёмный и цветной, он терялся, а тонкая полоса прогресса на подложке
         * rgba(0,0,0,.5) не читалась вовсе. Тёмно-жёлтый заметно контрастнее
         * и не спорит с зелёной плашкой самой Lampa
         * Рейтинг Lampa рисует пилюлей 1.3em/радиус 1em, но на нашей карточке
         * рядом три других бейджа, и разнобой заметнее, чем расхождение с Lampa.
         *
         * Самостоятельные поверхности (кнопки, плитки недели, панель QR) ни во
 * что не вложены — там радиус свой: кнопки берут его у Lampa.
 *
 * Элемент тоньше двойного радиуса не может его выдержать: браузер ужимает
 * скругление до половины стороны. Тонким полоскам радиус не задают — их
 * обрезают контуром родителя.
         * ================================================================ */

        Lampa.Template.add('shikimori_style',
            '<style>' +

            /* --- Карточка: базовый вид --- */
            '.shikimori-card--native .card__promo{display:none}' +
            '.shikimori-card .card__title{-webkit-line-clamp:2;line-clamp:2;height:2.4em}' +
            '.shikimori-card .card__age{display:none}' +

            /* --- Бейджи: единая геометрия для всех четырёх углов --- */
            '.shikimori-card .card__vote,' +
            '.shikimori-card .card__type,' +
            '.shikimori-card .card__marker,' +
            '.shikimori-card .shikimori-year,' +
            '.shikimori-card .card__new-episode>div{' +
                'font-size:0.8em;line-height:1.2;padding:0.4em 0.5em;' +
                '-webkit-border-radius:0.5em;border-radius:0.5em;' +
                'font-weight:400;z-index:1}' +

            /* Цветовые роли */
            '.shikimori-card .card__vote,' +
            '.shikimori-card .card__marker,' +
            '.shikimori-card .shikimori-year{background:rgba(0,0,0,0.6);color:#fff}' +
            '.shikimori-card .card__type{background:#fff;color:#000}' +
            '.shikimori-card .card__new-episode>div{background-color:#D9A21B;color:#2A1C00}' +

            /* Раскладка по углам. ВАЖНО: смещения задаются на элементе, у которого
               кегль 0.8em, поэтому в его единицах 0.6em карточки — это 0.75em.
               Тот же пересчёт, что и у радиуса. Исключение — .card__new-episode:
               кегль стоит на вложенном div, а смещения на самом контейнере */
            '.shikimori-card .shikimori-year{position:absolute;left:0.75em;top:0.75em}' +
            '.shikimori-card .card__type{position:absolute;left:0.75em;top:3.55em;right:auto;bottom:auto}' +
            '.shikimori-card--noyear .card__type{top:0.75em}' +
            '.shikimori-card .card__new-episode{left:auto;right:0.6em;top:0.6em;bottom:auto;text-align:right}' +
            '.shikimori-card .card__vote{right:0.75em;bottom:0.75em;left:auto;top:auto}' +
            '.shikimori-card .card__marker{left:0.75em;bottom:0.75em;right:auto;top:auto}' +
            /* Точка перед маркером — индикатор категории закладок Lampa, у нас её нет */
            '.shikimori-card .card__marker:before{display:none}' +
            /* Штатный маркер режет текст на 5em, а «1175 серия · Amazing Dubbing» длиннее */
            '.shikimori-card .card__marker>span{font-size:1em;max-width:11em}' +

            /* Прогресс вписан в нижнюю кромку постера, а не висит отдельной
               плашкой: он свойство карточки, а не ещё один плавающий объект.
               Раз это сама кромка, расстояния между ним и постером нет,
               и по концентричности радиус равен радиусу постера — 1em снизу */
            /* Своего радиуса у полосы нет и быть не может: она высотой 0.4em,
               а браузер обязан ужать скругление до половины стороны — 1em
               превратился бы в 0.4em и с постером не совпал. Поэтому форму
               задаёт постер, а полоса просто обрезается его контуром */
            '.shikimori-card .card__view{-webkit-border-radius:1em;border-radius:1em;overflow:hidden}' +
            '.shikimori-progress{position:absolute;left:0;right:0;bottom:0;height:0.4em;' +
                'background:rgba(0,0,0,0.5);z-index:2}' +
            '.shikimori-progress i{display:block;height:100%;width:0;background:#D9A21B}' +
            /* Нижние бейджи поднимаются над кромкой: 0.4em полосы + 0.6em зазора
               = 1em карточки, в единицах бейджа это 1.25em */
            '.shikimori-card--progress .card__vote,' +
            '.shikimori-card--progress .card__marker{bottom:1.25em}' +

            /* --- Фокус: своя рамка, потому что штатная у нас не видна ---
               Lampa рисует обводку фокуса как .card__view::after со смещением
               -0.5em наружу. Но нам на .card__view нужен overflow:hidden —
               им обрезается полоса прогресса по нижней кромке постера, — и он
               же срезает эту обводку целиком: карточка в фокусе выглядела
               ровно как соседние. Рисуем рамку внутрь бокса, там её ничто
               не режет, и она не спорит с формой постера */
            /* Рамка появляется сразу, без перехода по цвету. Замер в Chromium:
               плавный border-color на скруглённой рамке заставлял перерисовывать
               её каждый кадр — 216 перерисовок за семь переводов фокуса против
               21 без него. Именно это и читалось как «анимация скачет»:
               плавным было только намерение, а кадров не хватало */
            '.shikimori-card .card__view:before{content:"";position:absolute;top:0;left:0;right:0;bottom:0;' +
                'border:0.25em solid transparent;-webkit-border-radius:1em;border-radius:1em;' +
                'z-index:3;pointer-events:none}' +
            '.shikimori-card.focus .card__view:before{border-color:#fff}' +
            '.shikimori-card.hover .card__view:before{border-color:rgba(255,255,255,0.5)}' +

            /* --- Движение: карточка отзывается, а не только подсвечивается ---
               Штатная анимация Lampa (animation-card-focus) живёт под
               body.advanced--animation, а он включён по умолчанию только на
               Apple TV, в браузере и на десктопе: на телевизоре карточки не
               двигались вообще. Своё движение делаем на transform — он не
               пересчитывает раскладку и тянется даже слабой панелью.
               Всё под body:not(.no--animation): выключенные анимации
               выключают и это */
            /* Двигаем САМУ карточку, а не .card__view.
               У .card уже стоит will-change:transform — Lampa подняла её в
               отдельный слой, и масштаб такого слоя видеокарта делает без
               единой перерисовки. А вот .card__view лежит внутри этого слоя,
               на нём border-radius и overflow:hidden, и его масштабирование
               заставляло перерисовывать скруглённую маску вместе с постером:
               замер показал 28 перерисовок картинки и 14 пересчётов раскладки
               там, где у .card — ноль и ноль */
            '.shikimori-card{-webkit-transition:-webkit-transform 0.2s ease-out;' +
                '-o-transition:-o-transform 0.2s ease-out;transition:transform 0.2s ease-out}' +
            '.shikimori-card.focus,.shikimori-card.hover{z-index:2}' +
            'body.shiki-motion:not(.no--animation) .shikimori-card.focus,' +
            'body.shiki-motion:not(.no--animation) .shikimori-card.hover{' +
                '-webkit-transform:scale(1.06);-ms-transform:scale(1.06);transform:scale(1.06)}' +
            /* Нажатие: короткая просадка вместо тактильной отдачи, которой у пульта нет.
               Селектор с .focus — чтобы перебить правило фокуса, а не спорить с ним */
            'body.shiki-motion:not(.no--animation) .shikimori-card--press.focus,' +
            'body.shiki-motion:not(.no--animation) .shikimori-card--press{' +
                '-webkit-transform:scale(0.97);-ms-transform:scale(0.97);transform:scale(0.97)}' +
            /* Штатный «подскок» Lampa на наших карточках выключаем: он двигает
               .card__view вверх на 1em ровно тогда же, когда мы масштабируем
               карточку. Два движения друг поверх друга и выглядят рывком */
            'body.advanced--animation .shikimori-card .card__view{-webkit-animation:none;animation:none}' +

            /* Постер проявляется, а не возникает: он грузится лениво и может
               приехать ровно в момент перевода фокуса — подмена картинки
               рывком читается как дёрганая анимация */
            '.shikimori-card .card__img{-webkit-transition:opacity 0.25s ease;transition:opacity 0.25s ease}' +
            'body:not(.no--animation) .shikimori-card--loading .card__img{opacity:0}' +

            /* --- Скелетоны: будущая раскладка вместо крутилки ---
               Пустой экран со спиннером читается как «зависло»: сколько ждать,
               по нему не понять. Решётка плиток отвечает на этот вопрос сразу */
            '.shikimori-skeleton .card__view{background:rgba(255,255,255,0.08);' +
                '-webkit-border-radius:1em;border-radius:1em;overflow:hidden;position:relative}' +
            '.shikimori-skeleton__line{height:0.8em;margin-top:0.1em;width:70%;' +
                'background:rgba(255,255,255,0.08);-webkit-border-radius:0.4em;border-radius:0.4em}' +
            '.shikimori-skeleton-row{margin-bottom:1.5em}' +
            '.shikimori-skeleton__head{height:1.2em;width:12em;margin-bottom:0.6em;' +
                'background:rgba(255,255,255,0.08);-webkit-border-radius:0.4em;border-radius:0.4em}' +
            '.shikimori-skeleton__strip{display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;' +
                'overflow:hidden}' +
            '.shikimori-skeleton__strip .shikimori-skeleton{margin-right:1em;-webkit-flex-shrink:0;' +
                '-ms-flex-negative:0;flex-shrink:0}' +
            'body:not(.no--animation) .shikimori-skeleton .card__view:after{content:"";position:absolute;' +
                'top:0;left:0;height:100%;width:100%;' +
                'background:-webkit-linear-gradient(left,rgba(255,255,255,0),rgba(255,255,255,0.07),rgba(255,255,255,0));' +
                'background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,0.07),rgba(255,255,255,0));' +
                '-webkit-animation:shikimori-shimmer 1.3s infinite;animation:shikimori-shimmer 1.3s infinite}' +
            '@-webkit-keyframes shikimori-shimmer{0%{-webkit-transform:translate3d(-100%,0,0)}' +
                '100%{-webkit-transform:translate3d(100%,0,0)}}' +
            '@keyframes shikimori-shimmer{0%{transform:translate3d(-100%,0,0)}' +
                '100%{transform:translate3d(100%,0,0)}}' +

            /* --- Варианты плотности --- */
            '.shikimori-card--compact{width:9.5em}' +
            '.shikimori-card--compact .card__title{font-size:1.05em;-webkit-line-clamp:1;line-clamp:1;height:1.4em}' +
            '.shikimori-card--poster{width:15em}' +
            '.shikimori-card--poster .card__title{display:none}' +
            '.shikimori-card--poster .card__view{margin-bottom:0}' +
            '.shikimori-card--poster .card__promo{padding:2em 0.8em 0.8em 0.8em}' +
            '.shikimori-card--poster .card__promo-title{font-size:1.2em}' +

            /* --- Ритм строк: один набор правил на все строки плагина --- */
            '.items-line--type-shiki{padding-top:0;padding-bottom:1.5em}' +
            '.items-line--type-shiki .items-line__head{margin-bottom:0.6em}' +
            '.items-line--type-shiki .items-line__body{position:relative;margin:0}' +
            /* Затемнение только там, где действительно есть прокрутка */
            '.items-line--type-shiki.shikimori-scrollable .items-line__body:after{content:"";position:absolute;' +
                'top:0;bottom:0;right:0;width:1.5em;pointer-events:none;' +
                'background:-webkit-linear-gradient(left,rgba(0,0,0,0),rgba(0,0,0,0.28));' +
                'background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,0.28))}' +

            /* --- Строка кнопок: тот же ритм, что у строк с карточками --- */
            '.items-line--type-actions{padding-top:0;padding-bottom:1.5em}' +
            '.items-line--type-actions .items-line__head{display:none}' +
            '.items-line--type-actions .items-line__body{margin:0}' +
            '.shikimori-action{margin-left:0;margin-right:0.8em;padding:0 1.2em;height:3.4em;' +
                'display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;' +
                '-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;' +
                '-webkit-box-sizing:border-box;box-sizing:border-box}' +
            '.shikimori-action__icon{display:block;width:1.4em;height:1.4em;margin-right:0.6em;' +
                '-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0}' +
            '.shikimori-action__icon svg{display:block;width:100%;height:100%}' +
            '.shikimori-action__title{white-space:nowrap;background:none!important;padding:0!important}' +

            /* --- Шапка каталога --- */
            /* Кнопки стояли вплотную к краю, а карточки — с отступом сетки:
               выравниваем по одной линии. Закрепление сверху не даёт шапке
               уехать при прокрутке; где sticky нет, она просто прокрутится */
            /* Строка, а не столбик: без display:flex кнопки — блоки во всю ширину.
               Прокручивается по горизонтали, если не помещаются */
            '.shikimori-head{display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;' +
                '-webkit-box-orient:horizontal;-webkit-box-align:center;-webkit-align-items:center;' +
                '-ms-flex-align:center;align-items:center;-webkit-flex-wrap:nowrap;-ms-flex-wrap:nowrap;flex-wrap:nowrap;' +
                'overflow-x:auto;overflow-y:hidden;padding:0 1em 1em 1em}' +
            '.shikimori-head .shikimori-action{-webkit-box-flex:0;-webkit-flex:0 0 auto;-ms-flex:0 0 auto;flex:0 0 auto;' +
                'margin-bottom:0;width:auto}' +

            /* --- Каталог: тот же шаг, что в строках, ширина от контейнера --- */
            '.shikimori-catalog{-webkit-box-pack:start!important;-webkit-justify-content:flex-start!important;' +
                '-ms-flex-pack:start!important;justify-content:flex-start!important}' +
            '.shikimori-catalog>.card{margin-right:1em;margin-bottom:1.5em;' +
                'width:-webkit-calc((100% - 5em) / 6);width:calc((100% - 5em) / 6)}' +
            '.shikimori-catalog>.card:nth-child(6n){margin-right:0}' +
            '.shiki-tier--tablet .shikimori-catalog>.card{width:-webkit-calc((100% - 3em) / 4);width:calc((100% - 3em) / 4)}' +
            '.shiki-tier--tablet .shikimori-catalog>.card:nth-child(6n){margin-right:1em}' +
            '.shiki-tier--tablet .shikimori-catalog>.card:nth-child(4n){margin-right:0}' +
            '.shiki-tier--phone .shikimori-catalog>.card{width:-webkit-calc((100% - 1em) / 2);width:calc((100% - 1em) / 2)}' +
            '.shiki-tier--phone .shikimori-catalog>.card:nth-child(6n){margin-right:1em}' +
            '.shiki-tier--phone .shikimori-catalog>.card:nth-child(2n){margin-right:0}' +
            '.shiki-tier--tv .shikimori-catalog>.card{width:-webkit-calc((100% - 4em) / 5);width:calc((100% - 4em) / 5)}' +
            '.shiki-tier--tv .shikimori-catalog>.card:nth-child(6n){margin-right:1em}' +
            '.shiki-tier--tv .shikimori-catalog>.card:nth-child(5n){margin-right:0}' +

            /* --- Календарь --- */
            '.shikimori-week{width:100%;-webkit-flex-basis:100%;-ms-flex-preferred-size:100%;flex-basis:100%;' +
                'display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;margin:0 0 1.5em 0}' +
            '.shikimori-week__day{-webkit-box-flex:1;-webkit-flex:1 1 0;-ms-flex:1 1 0;flex:1 1 0;text-align:center;' +
                'padding:0.6em 0.3em;margin-right:0.6em;-webkit-border-radius:0.6em;border-radius:0.6em;' +
                'background:rgba(255,255,255,0.08)}' +
            '.shikimori-week__day:last-child{margin-right:0}' +
            '.shikimori-week__day--today{background:rgba(255,255,255,0.18)}' +
            '.shikimori-week__day--empty{opacity:0.4}' +
            '.shikimori-week__name{font-size:0.9em;opacity:0.7;text-transform:uppercase}' +
            '.shikimori-week__date{font-size:1.3em;line-height:1.3}' +
            '.shikimori-week__count{font-size:1.1em;font-weight:700;color:#D9A21B}' +
            '.shikimori-week__day--empty .shikimori-week__count{color:inherit;font-weight:400}' +
            '.shikimori-day{width:100%;-webkit-flex-basis:100%;-ms-flex-preferred-size:100%;flex-basis:100%;' +
                'font-size:1.4em;margin:0 0 0.6em 0;opacity:0.75}' +

            /* --- Тиры: телевизор медиазапросом не определяется, класс ставит JS --- */
            '.shiki-tier--phone .shikimori-card .card__vote,' +
            '.shiki-tier--phone .shikimori-card .card__marker{display:none}' +
            '.shiki-tier--phone .shikimori-card .shikimori-year,' +
            '.shiki-tier--phone .shikimori-card .card__new-episode>div{font-size:0.95em}' +
            '.shiki-tier--phone .shikimori-progress{height:0.4em}' +
            /* Телевизор смотрят с трёх метров: мелкий бейдж там не читается.
               Раньше на ТВ-тире кегль наоборот уменьшался до 0.9em — чинить
               это важнее, чем экономить место на постере */
            '.shiki-tier--tv .shikimori-card .card__vote,' +
            '.shiki-tier--tv .shikimori-card .card__type,' +
            '.shiki-tier--tv .shikimori-card .card__marker,' +
            '.shiki-tier--tv .shikimori-card .shikimori-year,' +
            '.shiki-tier--tv .shikimori-card .card__new-episode>div{font-size:1em}' +
            '.shiki-tier--tv .shikimori-card .card__title{font-size:1.1em;height:2.6em}' +
            '.shiki-tier--tv .shikimori-day{font-size:1.5em}' +

            /* --- Счётчик на пункте меню --- */
            '.menu__item .shikimori-badge{margin-left:auto;background:#D9A21B;color:#2A1C00;font-size:0.8em;' +
                'font-weight:700;min-width:1.7em;height:1.7em;line-height:1.7em;text-align:center;' +
                '-webkit-border-radius:1em;border-radius:1em;padding:0 0.4em;' +
                '-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0}' +

            /* --- Окно подключения аккаунта --- */
            '.shikimori-auth{text-align:center;padding:1.5em 0}' +
            '.shikimori-auth__text{font-size:1.1em;margin:0.6em 0;opacity:0.9}' +
            '.shikimori-auth__qr{display:inline-block;background:#fff;padding:0.6em;' +
                '-webkit-border-radius:0.8em;border-radius:0.8em;margin:0.6em 0}' +
            '.shikimori-auth__qr img,.shikimori-auth__qr canvas,.shikimori-auth__qr svg{display:block;width:14em;height:14em}' +
            '.shikimori-auth__url{font-size:0.8em;opacity:0.55;word-break:break-all;margin:0.6em 2.25em}' +
            '.shikimori-auth__lead{font-size:1.05em;opacity:0.85;margin:0 2.25em 1em 2.25em;line-height:1.4}' +
            '.shikimori-steps{text-align:left;margin:1em 2.25em 0 2.25em;padding-left:1.2em;line-height:1.5}' +
            '.shikimori-steps li{margin-bottom:0.6em;word-break:break-word}' +

            /* --- Полная карточка --- */
            '.shikimori-rate{background:rgba(255,255,255,0.12)}' +
            '.shikimori-next{margin-left:0.6em;color:#D9A21B}' +
            '</style>');

        $('body').append(Lampa.Template.get('shikimori_style', {}, true));
    }

    /* ============================================================
     * Меню и запуск
     * ============================================================ */

    function addMenuButton() {
        var button = $('<li class="menu__item selector" data-action="shikimori">' +
            '<div class="menu__ico">' + ICON_MENU + '</div>' +
            '<div class="menu__text">' + Lampa.Lang.translate('shikimori_menu') + '</div>' +
            '<div class="shikimori-badge hide"></div>' +
        '</li>');

        button.on('hover:enter', function () {
            Lampa.Activity.push({
                url: '',
                title: manifest.name,
                component: PLUGIN + '_main',
                page: 1
            });
        });

        $('.menu .menu__list').eq(0).append(button);

        // Показываем последнее известное число сразу, не дожидаясь сети
        paintMenuBadge(parseInt(storGet('shikimori_badge', 0), 10) || 0);
        setTimeout(refreshMenuBadge, BADGE_DELAY);
        setInterval(refreshMenuBadge, BADGE_REFRESH);
    }

    // Сколько новых серий ждёт — прямо на пункте меню, как непрочитанные в почте
    function paintMenuBadge(count) {
        var badge = $('.menu__item[data-action="shikimori"] .shikimori-badge');
        if (!badge.length) return;
        if (count > 0) badge.removeClass('hide').text(count > 99 ? '99+' : count);
        else badge.addClass('hide').text('');
    }

    // Новое и не скрытое — этим живут и строка «Новые серии», и счётчик в меню.
    // Либо мы знаем, сколько серий не просмотрено, либо просто знаем, что
    // озвучка вышла на днях — для избранного без прогресса это единственный сигнал
    function isFresh(item) {
        // Досмотрено до конца доступного — новостей нет по определению
        if (item.total && item.watched >= item.total) return false;
        if (!(item.fresh > 0) && !item.airing) return false;
        if (item.at < Date.now() - KODIK_FRESH_DAYS * 86400000) return false;
        return visible(item);
    }

    function countFresh(items) {
        var count = 0;
        for (var i = 0; i < items.length; i++) {
            if (isFresh(items[i])) count++;
        }
        return count;
    }

    function updateMenuBadge(items) {
        var count = countFresh(items);
        storSet('shikimori_badge', count);
        paintMenuBadge(count);
    }

    // Фоновый пересчёт: экран плагина мог и не открываться. Повторяется,
    // пока приложение открыто: телевизор с Lampa бывает включён весь вечер,
    // и серия, вышедшая за это время, должна появиться на счётчике сама.
    // Пересчёт мог оборваться вместе с фоновыми запросами (их чистит отмена
    // загрузки) — поэтому не флаг «идёт», а время начала
    var badge_started = 0;

    function refreshMenuBadge() {
        if (!Kodik.enabled()) return;
        if (Date.now() - badge_started < 5 * 60 * 1000) return;
        badge_started = Date.now();

        function done(items) {
            badge_started = 0;
            updateMenuBadge(items);
        }

        UserData.rates(background_net, function (rates) {
            UserData.tracked(background_net, rates, done, true);
        }, function () {
            UserData.tracked(background_net, null, done, true);
        });
    }

    // Ключи приложения можно передать прямо в адресе плагина:
    // .../shikimori.js?cid=...&cs=... — иначе их пришлось бы набирать с пульта.
    // Плагин ставится один раз на компьютере, а на телевизор приезжает
    // синхронизацией аккаунта Lampa вместе с параметрами
    function readSelfParams() {
        var src = '';
        try {
            if (document.currentScript && document.currentScript.src) src = document.currentScript.src;
            if (!src) {
                var list = document.getElementsByTagName('script');
                for (var i = list.length - 1; i >= 0; i--) {
                    if (list[i].src && list[i].src.indexOf('shikimori') >= 0) { src = list[i].src; break; }
                }
            }
        }
        catch (e) {}
        if (!src || src.indexOf('?') < 0) return;

        var query = src.split('?')[1].split('#')[0].split('&');
        var params = {};
        for (var j = 0; j < query.length; j++) {
            var pair = query[j].split('=');
            if (pair[0]) params[pair[0]] = decodeURIComponent(pair[1] || '');
        }

        if (params.nick && !storString('shikimori_user', '')) storSet('shikimori_user', params.nick);
    }

    // Размерный тир: сколько em влезает по ширине. Именно em, а не пиксели —
    // Lampa масштабирует корневой кегль вместе с экраном, поэтому пиксельные
    // брейкпоинты тут не значат ничего. Телевизор медиазапросом не определяется
    function currentTier() {
        var w = window.innerWidth || document.documentElement.clientWidth || 1280;
        var root = 16;
        try { root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; }
        catch (e) {}

        var tv = false;
        try { tv = !!(Lampa.Platform && Lampa.Platform.tv && Lampa.Platform.tv()); }
        catch (e) {}
        if (!tv) tv = /Tizen|Web0S|webOS|NetCast|Orsay|SmartTV|SMART-TV|HbbTV|BRAVIA|VIDAA|AFT/i.test(navigator.userAgent || '');
        if (tv) return 'tv';

        var em = w / root;
        if (em < 45) return 'phone';
        if (em < 66) return 'tablet';
        return 'desktop';
    }

    function applyTier() {
        var tier = currentTier();
        var body = document.body;
        if (!body) return;
        var tiers = ['phone', 'tablet', 'desktop', 'tv'];
        for (var i = 0; i < tiers.length; i++) {
            if (tiers[i] != tier) body.classList.remove('shiki-tier--' + tiers[i]);
        }
        body.classList.add('shiki-tier--' + tier);
    }

    function watchTier() {
        var timer = null;
        applyTier();
        function later() {
            clearTimeout(timer);
            timer = setTimeout(applyTier, 150);
        }
        try {
            window.addEventListener('resize', later);
            window.addEventListener('orientationchange', later);
        }
        catch (e) {}
    }

    function startPlugin() {
        Lampa.Manifest.plugins = manifest;

        readSelfParams();

        // Прежний кэш обратного маппинга не различал фильмы и сериалы и
        // держал «не найдено» по месяцу — он заменён новым, старый убираем
        if (storGet('shikimori_rev_match', null)) storSet('shikimori_rev_match', null);

        setupLang();
        setupTemplates();
        setupSettings();
        setupFullCardEnrichment();

        Lampa.Component.add(PLUGIN + '_main', MainComponent);
        Lampa.Component.add(PLUGIN + '_catalog', CatalogComponent);

        watchTier();
        applyMotion();

        if (window.appready) addMenuButton();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type == 'ready') addMenuButton();
            });
        }
    }

    if (!window.plugin_shikimori_anime_ready) {
        window.plugin_shikimori_anime_ready = true;
        startPlugin();
    }
})();
