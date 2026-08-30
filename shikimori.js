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
    var VERSION = '1.7.0';

    var SHIKI_BASE = 'https://shikimori.io';
    var ARM_BASE = 'https://arm.haglund.dev';
    var CALENDAR_DAYS = 30;
    var CALENDAR_TTL = 60 * 60 * 1000;        // кэш календаря: 1 час
    var RATES_TTL = 10 * 60 * 1000;           // кэш списков пользователя: 10 минут
    var MATCH_TTL = 30 * 24 * 60 * 60 * 1000; // кэш маппинга mal->tmdb: 30 дней
    var MATCH_NEG_TTL = 3 * 24 * 60 * 60 * 1000; // отрицательный кэш: 3 дня
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
    var KODIK_TTL = 30 * 60 * 1000;           // кэш ленты Kodik: 30 минут
    var KODIK_PAGES = 2;                      // 2 страницы по 100 строк ~ сутки релизов
    var KODIK_LOOKUP_MAX = 12;                // точечных запросов за обновление — не больше
    var KODIK_FRESH_DAYS = 14;                // «новой» серия считается столько дней
    var REVERSE_MAX = 40;                     // обратных запросов TMDB->MAL за обновление
    var REVERSE_PARALLEL = 4;                 // и сколько из них одновременно
    var FAVORITES_WAIT = 2500;                // ждём синхронизацию закладок аккаунта, мс
    var BADGE_DELAY = 6000;                   // пересчёт счётчика в меню — после загрузки приложения
    var SEQUELS_MAX = 40;                     // сколько досмотренных тайтлов проверяем на продолжения
    var OAUTH_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'; // код показывается на странице, сервер не нужен
    var FAV_TAGS = ['look', 'wath', 'book', 'viewed', 'thrown'];  // метки Lampa: Смотрю, Позже, Закладки, Просмотрено, Брошено
    var MARK_SEEN_LIMIT = 2000;               // потолок отметок за одно нажатие
    var MARK_SEEN_FALLBACK = 24;              // если число серий неизвестно
    var WATCHING_RECENT_DAYS = 30;            // сколько дней просмотр считается активным
    var FRESH_SANE_MAX = 26;                  // больше кура непросмотренного — значит нумерация разошлась
    var SYNC_MAX = 20;                        // сколько записей прогресса отправляем за раз

    var manifest = {
        type: 'video',
        version: VERSION,
        name: 'Аниме Shikimori',
        description: 'Каталог, списки и календарь аниме с Shikimori',
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
    }

    NetPool.prototype.req = function (method, url, body, headers, ok, err, timeout) {
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

    NetPool.prototype.get = function (url, ok, err) {
        return this.req('GET', url, null, null, ok, err);
    };

    NetPool.prototype.post = function (url, body, ok, err) {
        return this.req('POST', url, body, { 'Content-Type': 'application/json' }, ok, err);
    };

    // OAuth Shikimori принимает только форму, не JSON
    NetPool.prototype.postForm = function (url, params, ok, err) {
        var body = [];
        for (var key in params) {
            body.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        }
        return this.req('POST', url, body.join('&'), { 'Content-Type': 'application/x-www-form-urlencoded' }, ok, err);
    };

    // Запрос от имени пользователя
    NetPool.prototype.authed = function (method, url, token, body, ok, err) {
        var headers = { 'Authorization': 'Bearer ' + token };
        if (body) headers['Content-Type'] = 'application/json';
        return this.req(method, url, body, headers, ok, err);
    };

    NetPool.prototype.clear = function () {
        for (var i = 0; i < this.list.length; i++) {
            try { this.list[i].abort(); } catch (e) {}
        }
        this.list = [];
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
                if (json && json.data) ok(json.data);
                else err('graphql');
            }, err);
        },

        animeFields: function () {
            return 'id malId name russian english japanese kind score status episodes episodesAired nextEpisodeAt season airedOn { year } poster { originalUrl mainUrl }';
        },

        // Урезанный набор — для запросов по 50 id, чтобы не упереться в лимит сложности GraphQL
        animeFieldsSlim: function () {
            return 'id malId name russian kind score status episodes episodesAired airedOn { year } poster { mainUrl }';
        },

        // Аргументы animes(...) из объекта фильтров
        animesArgs: function (params) {
            var args = [];
            args.push('limit: ' + (params.limit || 36));
            args.push('page: ' + (params.page || 1));
            if (params.order) args.push('order: ' + params.order); // enum, из белого списка
            if (params.kind) args.push('kind: ' + JSON.stringify(params.kind));
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
            var cached = storGet('shikimori_calendar_cache', null);
            if (cached && cached.time && Date.now() - cached.time < CALENDAR_TTL && cached.data && cached.data.length) {
                return ok(cached.data);
            }
            net.get(this.base() + '/api/calendar', function (list) {
                if (!list || !list.length) return err('calendar');
                // Храним только нужное — календарь большой
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
                storSet('shikimori_calendar_cache', { time: Date.now(), data: slim });
                ok(slim);
            }, err);
        },

        genres: function (net, ok, err) {
            var cached = storGet('shikimori_genres_cache', null);
            if (cached && cached.time && Date.now() - cached.time < GENRES_TTL && cached.data && cached.data.length) {
                return ok(cached.data);
            }
            net.get(this.base() + '/api/genres', function (list) {
                if (!list || !list.length) return err('genres');
                var anime = [];
                for (var i = 0; i < list.length; i++) {
                    if (list[i].entry_type == 'Anime') anime.push({ id: list[i].id, title: list[i].russian || list[i].name });
                }
                anime.sort(function (a, b) { return a.title < b.title ? -1 : 1; });
                storSet('shikimori_genres_cache', { time: Date.now(), data: anime });
                ok(anime);
            }, err);
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
     * Авторизация Shikimori (OAuth, поток для ТВ)
     * ------------------------------------------------------------
     * Ключи приложения не вшиты: их вписывают в настройки, потому что
     * client_secret в публичном плагине не спрятать (PKCE у Shikimori нет).
     * Поток «oob»: код показывается на странице, пользователь переносит его
     * в приложение руками — колбэк-сервер для ТВ не нужен.
     * Проверено живьём: и /oauth/token, и запись user_rates отдают CORS,
     * а preflight пропускает Authorization.
     * ============================================================ */

    var Auth = {
        clientId: function () {
            return storString('shikimori_client_id', '');
        },

        clientSecret: function () {
            return storString('shikimori_client_secret', '');
        },

        configured: function () {
            return !!(this.clientId() && this.clientSecret());
        },

        data: function () {
            var d = storGet('shikimori_oauth', {});
            return d && typeof d == 'object' ? d : {};
        },

        save: function (d) {
            storSet('shikimori_oauth', d);
        },

        connected: function () {
            var d = this.data();
            return !!(d.access_token && d.user_id);
        },

        nickname: function () {
            return this.data().nickname || '';
        },

        logout: function () {
            this.save({});
        },

        authorizeUrl: function () {
            return SHIKI_BASE + '/oauth/authorize' +
                '?client_id=' + encodeURIComponent(this.clientId()) +
                '&redirect_uri=' + encodeURIComponent(OAUTH_REDIRECT) +
                '&response_type=code&scope=user_rates';
        },

        // Код с сайта -> токены
        exchange: function (net, code, ok, err) {
            var self = this;
            net.postForm(SHIKI_BASE + '/oauth/token', {
                grant_type: 'authorization_code',
                client_id: this.clientId(),
                client_secret: this.clientSecret(),
                code: code,
                redirect_uri: OAUTH_REDIRECT
            }, function (json) {
                if (!json || !json.access_token) return err(json && json.error_description);
                self.store(json);
                self.identify(net, ok, err);
            }, function () {
                err('network');
            });
        },

        // Токен живёт сутки, refresh при этом тоже меняется — сохраняем оба
        refresh: function (net, ok, err) {
            var self = this;
            var d = this.data();
            if (!d.refresh_token) return err('no_refresh');

            net.postForm(SHIKI_BASE + '/oauth/token', {
                grant_type: 'refresh_token',
                client_id: this.clientId(),
                client_secret: this.clientSecret(),
                refresh_token: d.refresh_token
            }, function (json) {
                if (!json || !json.access_token) return err(json && json.error_description);
                self.store(json);
                ok(self.data().access_token);
            }, function () {
                err('network');
            });
        },

        store: function (json) {
            var d = this.data();
            d.access_token = json.access_token;
            d.refresh_token = json.refresh_token || d.refresh_token;
            d.expires_at = Date.now() + ((json.expires_in || 86400) * 1000);
            this.save(d);
        },

        identify: function (net, ok, err) {
            var self = this;
            var d = this.data();
            net.authed('GET', SHIKI_BASE + '/api/users/whoami', d.access_token, null, function (user) {
                // Без токена этот метод отвечает 200 и null — проверяем содержимое
                if (!user || !user.id) return err('whoami');
                d.user_id = user.id;
                d.nickname = user.nickname || '';
                self.save(d);
                ok(d);
            }, function () {
                err('whoami');
            });
        },

        // Отдаёт живой токен, обновляя его при необходимости
        token: function (net, ok, err) {
            var d = this.data();
            if (!d.access_token) return err('no_token');
            if (d.expires_at && Date.now() < d.expires_at - 60000) return ok(d.access_token);
            this.refresh(net, ok, err);
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
     *   - limit жёстко ограничен сотней, next_page — готовый абсолютный адрес.
     * ============================================================ */

    var Kodik = {
        feed_cache: null,
        feed_time: 0,
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

        // Предпочитаемые студии. Пусто — засчитываем любую озвучку
        studios: function () {
            var list = storGet('shikimori_studios', []);
            return Object.prototype.toString.call(list) == '[object Array]' ? list : [];
        },

        studioAllowed: function (title) {
            var list = this.studios();
            if (!list.length) return true;
            for (var i = 0; i < list.length; i++) {
                if (list[i] == title) return true;
            }
            return false;
        },

        // Студии, которые реально встречаются в ваших данных — из них и выбираем.
        // Полный словарь Kodik это тысячи строк, листать их с пульта невозможно
        knownStudios: function () {
            var seen = {};
            var rows = this.feed_cache || [];
            for (var i = 0; i < rows.length; i++) {
                var name = rows[i].translation && rows[i].translation.title;
                if (name) seen[name] = true;
            }
            var store = this.store();
            for (var key in store) {
                if (store[key] && store[key].studio) seen[store[key].studio] = true;
            }
            var chosen = this.studios();
            for (i = 0; i < chosen.length; i++) seen[chosen[i]] = true;

            var list = [];
            for (var name2 in seen) list.push(name2);
            list.sort();
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

        // Лента обновлений: KODIK_PAGES страниц по 100 строк
        feed: function (net, ok, err) {
            var self = this;
            if (this.feed_cache && Date.now() - this.feed_time < KODIK_TTL) return ok(this.feed_cache);

            var rows = [];
            var params = '&types=anime-serial&anime_status=ongoing&sort=updated_at&limit=100&with_material_data=true' +
                (this.withSubtitles() ? '' : '&translation_type=voice');

            this.request(net, '/list', params, function (json) {
                rows = rows.concat(json.results || []);
                page(json.next_page, 1);
            }, err);

            function page(next_url, depth) {
                if (!next_url || depth >= KODIK_PAGES) return finish();
                if (next_url.indexOf('token=') == -1 && self.active_token) {
                    next_url += '&token=' + encodeURIComponent(self.active_token);
                }
                net.get(next_url, function (json) {
                    if (json && json.results) rows = rows.concat(json.results);
                    // дальше не идём: следующая страница уходит за сутки
                    finish();
                }, finish);
            }

            function finish() {
                self.feed_cache = rows;
                self.feed_time = Date.now();
                ok(rows);
            }
        },

        // Точечный запрос по конкретным тайтлам — чтобы узнать про то,
        // что не попало в суточную ленту. Количество запросов ограничено.
        lookup: function (net, ids, ok) {
            var self = this;
            var result = {};
            var index = 0;
            var limit = Math.min(ids.length, KODIK_LOOKUP_MAX);

            function next() {
                if (index >= limit) return ok(result);
                var sid = ids[index++];
                var params = '&shikimori_id=' + sid + '&with_material_data=true' +
                    (self.withSubtitles() ? '' : '&translation_type=voice');
                self.request(net, '/search', params, function (json) {
                    var merged = self.mergeRows(json.results || []);
                    for (var key in merged) result[key] = merged[key];
                    next();
                }, next);
            }

            next();
        },

        // Строка Kodik = (тайтл × студия). Схлопываем в одну запись на тайтл:
        // больше серий важнее, при равенстве озвучка важнее субтитров.
        mergeRows: function (rows) {
            var map = {};
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var sid = parseInt(row.shikimori_id, 10);
                // episodes_count — сколько серий у студии, а не номер серии; нужен last_episode
                var ep = parseInt(row.last_episode, 10) || 0;
                if (!sid || !ep) continue;

                var studio = (row.translation && row.translation.title) || '';
                if (!this.studioAllowed(studio)) continue;

                var voice = !row.translation || row.translation.type != 'subtitles';
                // Лента спрашивается с translation_type=voice, а точечный поиск раньше — нет,
                // поэтому субтитровая раздача с большим числом серий выигрывала у озвучки
                if (!voice && !this.withSubtitles()) continue;

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
                    at: parseISO(row.updated_at),
                    aired: (row.material_data && parseInt(row.material_data.episodes_aired, 10)) || 0
                };
            }
            return map;
        },

        // Постоянное хранилище: что мы уже знали про каждый тайтл.
        // base — сколько серий было при первой встрече; для закладок без списка
        // Shikimori только по нему и можно понять, что серия именно новая.
        // Читается на каждой карточке каталога, поэтому держим разобранным
        store_memo: null,

        store: function () {
            if (this.store_memo) return this.store_memo;
            var store = storGet('shikimori_kodik_eps', {});
            this.store_memo = store && typeof store == 'object' ? store : {};
            return this.store_memo;
        },

        // Что известно про конкретный тайтл: null, если ещё не встречали
        known: function (sid) {
            return sid ? (this.store()['s' + sid] || null) : null;
        },

        remember: function (fresh) {
            var store = this.store();
            var changed = false;

            for (var key in fresh) {
                var next = fresh[key];
                var prev = store[key];
                // at — момент, когда серий стало больше. Переоцифровка тайтла тоже
                // двигает updated_at, но новой серией это не является
                if (prev && next.ep <= prev.ep) continue;
                store[key] = {
                    sid: next.sid,
                    ep: next.ep,
                    base: prev ? prev.base : next.ep,
                    studio: next.studio,
                    voice: next.voice,
                    at: next.at,
                    aired: next.aired
                };
                changed = true;
            }

            var keys = [];
            for (var k in store) keys.push(k);
            if (keys.length > 400) {
                keys.sort(function (a, b) { return (store[a].at || 0) - (store[b].at || 0); });
                for (var i = 0; i < keys.length - 400; i++) delete store[keys[i]];
                changed = true;
            }

            if (changed) storSet('shikimori_kodik_eps', store);
            this.store_memo = store;
            return store;
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
        all: function () {
            var map = storGet('shikimori_hidden', {});
            return map && typeof map == 'object' ? map : {};
        },

        has: function (sid) {
            return !!this.all()['s' + sid];
        },

        toggle: function (sid) {
            var map = this.all();
            if (map['s' + sid]) delete map['s' + sid];
            else map['s' + sid] = Date.now();
            storSet('shikimori_hidden', map);
            return !!map['s' + sid];
        }
    };

    /* ============================================================
     * Отправка прогресса в Shikimori
     * ============================================================ */

    var Sync = {
        enabled: function () {
            return storBool('shikimori_sync', false) && Auth.connected();
        },

        // Прогресс двигаем только вперёд и не трогаем статусы с оценками:
        // испортить чужой список плагин не должен даже при своей ошибке
        push: function (net, tracked, rates, done) {
            if (!this.enabled()) return done(0);

            var mals = (rates && rates.mals) || {};
            var queue = [];

            for (var i = 0; i < tracked.length; i++) {
                var item = tracked[i];
                var sid = item.kodik && item.kodik.sid;
                if (!sid || !item.watched) continue;

                var rate = mals[sid];
                var seen = rate ? (rate.episodes || 0) : 0;
                if (item.watched <= seen) continue;

                queue.push({ sid: sid, episodes: item.watched, rate: rate });
            }

            if (!queue.length) return done(0);
            queue = queue.slice(0, SYNC_MAX);

            Auth.token(net, function (token) {
                var index = 0;
                var sent = 0;

                function next() {
                    if (index >= queue.length) return done(sent);
                    var job = queue[index++];
                    var method, url, body;

                    if (job.rate && job.rate.id) {
                        method = 'PATCH';
                        url = SHIKI_BASE + '/api/v2/user_rates/' + job.rate.id;
                        body = { user_rate: { episodes: job.episodes } };
                    }
                    else {
                        method = 'POST';
                        url = SHIKI_BASE + '/api/v2/user_rates';
                        body = {
                            user_rate: {
                                user_id: Auth.data().user_id,
                                target_id: job.sid,
                                target_type: 'Anime',
                                episodes: job.episodes,
                                status: 'watching'
                            }
                        };
                    }

                    net.authed(method, url, token, body, function () {
                        sent++;
                        next();
                    }, next);
                }

                next();
            }, function () {
                done(0);
            });
        }
    };

    // Подключение аккаунта: QR на экран, код вводится руками — колбэка на ТВ нет
    function connectShikimori() {
        var enabled = Lampa.Controller.enabled().name;

        // Ключей нет — с пульта их не набрать, поэтому показываем QR на страницу
        // регистрации приложения и оставляем ник как простой запасной путь
        if (!Auth.configured()) {
            return Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_auth_need_keys'),
                items: [
                    { title: Lampa.Lang.translate('shikimori_auth_howto'), action: 'howto' },
                    { title: Lampa.Lang.translate('shikimori_action_set_user'), action: 'nick' }
                ],
                onSelect: function (item) {
                    Lampa.Controller.toggle(enabled);
                    if (item.action == 'nick') return askNickname();
                    showQr(SHIKI_BASE + '/oauth/applications',
                        Lampa.Lang.translate('shikimori_auth_apps'),
                        Lampa.Lang.translate('shikimori_auth_apps_hint'),
                        enabled, null);
                },
                onBack: function () { Lampa.Controller.toggle(enabled); }
            });
        }

        if (Auth.connected()) {
            return Lampa.Select.show({
                title: Auth.nickname() || Lampa.Lang.translate('shikimori_auth_connected'),
                items: [{ title: Lampa.Lang.translate('shikimori_auth_logout'), action: 'logout' }],
                onSelect: function () {
                    Lampa.Controller.toggle(enabled);
                    Auth.logout();
                    Lampa.Noty.show(Lampa.Lang.translate('shikimori_auth_logged_out'));
                },
                onBack: function () { Lampa.Controller.toggle(enabled); }
            });
        }

        showQr(Auth.authorizeUrl(),
            Lampa.Lang.translate('shikimori_auth_scan'),
            Lampa.Lang.translate('shikimori_auth_then_code'),
            enabled,
            function () { askAuthCode(enabled); });
    }

    function showQr(url, head, hint, enabled, after) {
        var html = $('<div class="shikimori-auth">' +
            '<div class="shikimori-auth__text">' + head + '</div>' +
            '<div class="shikimori-auth__qr"></div>' +
            '<div class="shikimori-auth__url"></div>' +
            '<div class="shikimori-auth__text">' + hint + '</div>' +
        '</div>');

        html.find('.shikimori-auth__url').text(url);

        // qrcode(text, element) рисует SVG внутрь узла и ничего не возвращает
        try { Lampa.Utils.qrcode(url, html.find('.shikimori-auth__qr')[0]); }
        catch (e) { html.find('.shikimori-auth__qr').remove(); }

        Lampa.Modal.open({
            title: Lampa.Lang.translate('shikimori_auth_title'),
            html: html,
            onBack: function () {
                Lampa.Modal.close();
                Lampa.Controller.toggle(enabled);
                if (after) after();
            }
        });
    }

    function askAuthCode(enabled) {
        Lampa.Input.edit({
            title: Lampa.Lang.translate('shikimori_auth_code'),
            value: '',
            free: true,
            nosave: true
        }, function (code) {
            Lampa.Controller.toggle(enabled);
            code = String(code || '').replace(/\s+/g, '');
            if (!code) return;

            Lampa.Noty.show(Lampa.Lang.translate('shikimori_auth_checking'));
            Auth.exchange(background_net, code, function (data) {
                storSet('shikimori_user', data.nickname || storString('shikimori_user', ''));
                UserData.dropRatesCache();
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_auth_ok') + ' ' + (data.nickname || ''));
            }, function (reason) {
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_auth_fail') + (reason ? ': ' + reason : ''));
            });
        });
    }

    // Скрытые тайтлы: карточки в строках больше нет, значит и долгим нажатием
    // её не вернуть — список нужен отдельным экраном в настройках
    function pickHidden() {
        var map = Hidden.all();
        var sids = [];
        for (var key in map) {
            var sid = parseInt(String(key).replace('s', ''), 10);
            if (sid) sids.push(sid);
        }

        if (!sids.length) return Lampa.Noty.show(Lampa.Lang.translate('shikimori_hidden_empty'));

        var enabled = Lampa.Controller.enabled().name;

        Shiki.animesByIds(background_net, sids.slice(0, 100), function (animes) {
            var items = [];
            for (var i = 0; i < animes.length; i++) {
                items.push({
                    title: animes[i].russian || animes[i].name,
                    sid: parseInt(animes[i].malId || animes[i].id, 10)
                });
            }
            if (!items.length) return Lampa.Noty.show(Lampa.Lang.translate('shikimori_hidden_empty'));

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_settings_hidden'),
                items: items,
                onSelect: function (item) {
                    Lampa.Controller.toggle(enabled);
                    Hidden.toggle(item.sid);
                    Lampa.Noty.show(Lampa.Lang.translate('shikimori_noty_unhidden'));
                },
                onBack: function () {
                    Lampa.Controller.toggle(enabled);
                }
            });
        }, function () {
            Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_api'));
        });
    }

    // Выбор студий озвучки. Список собираем из тех, что встречаются в ваших
    // тайтлах: полный словарь Kodik — тысячи строк, с пульта это нелистаемо
    function pickStudios() {
        var enabled = Lampa.Controller.enabled().name;

        function show(names) {
            var chosen = Kodik.studios();
            var items = [{
                title: Lampa.Lang.translate('shikimori_studios_any'),
                value: '',
                selected: !chosen.length
            }];

            for (var i = 0; i < names.length; i++) {
                items.push({
                    title: names[i],
                    value: names[i],
                    selected: chosen.indexOf(names[i]) >= 0
                });
            }

            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_settings_studios'),
                items: items,
                onCheck: function (item) {
                    if (!item.value) {
                        storSet('shikimori_studios', []);
                        item.selected = true;
                    }
                    else {
                        var list = Kodik.studios();
                        var at = list.indexOf(item.value);
                        if (at >= 0) list.splice(at, 1);
                        else list.push(item.value);
                        storSet('shikimori_studios', list);
                        item.selected = at < 0;
                    }
                    // Накопленные серии собраны по прежнему правилу — сбрасываем,
                    // иначе останутся числа от студий, которые больше не в счёт
                    storSet('shikimori_kodik_eps', {});
                    Kodik.dropCache();
                },
                onBack: function () {
                    Lampa.Controller.toggle(enabled);
                }
            });
        }

        var known = Kodik.knownStudios();
        if (known.length) return show(known);

        // Ещё ничего не знаем — подтянем ленту, чтобы было из чего выбирать
        Lampa.Noty.show(Lampa.Lang.translate('shikimori_studios_loading'));
        Kodik.feed(background_net, function () {
            show(Kodik.knownStudios());
        }, function () {
            show([]);
        });
    }

    // Меню по долгому нажатию на карточке — вместо лишних кнопок на экране
    function cardMenu(data) {
        var sid = data._kodik && data._kodik.sid;
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

        if (sid) {
            items.push({
                title: Lampa.Lang.translate(Hidden.has(sid) ? 'shikimori_menu_unhide' : 'shikimori_menu_hide'),
                subtitle: Lampa.Lang.translate('shikimori_group_visible'),
                action: 'hide'
            });
        }

        items.push({
            title: Lampa.Lang.translate('shikimori_menu_open'),
            subtitle: Lampa.Lang.translate('shikimori_group_open'),
            action: 'open'
        });

        var enabled = Lampa.Controller.enabled().name;

        Lampa.Select.show({
            title: cardView(data).title,
            items: items,
            onSelect: function (item) {
                Lampa.Controller.toggle(enabled);

                if (item.action == 'hide') {
                    var hidden = Hidden.toggle(sid);
                    Lampa.Noty.show(Lampa.Lang.translate(hidden ? 'shikimori_noty_hidden' : 'shikimori_noty_unhidden'));
                    if (hidden && data._card_el && data._card_el.parentNode) data._card_el.style.display = 'none';
                }

                if (item.action == 'seen') {
                    markSeen(data, data._total_ep, 1);
                    Lampa.Noty.show(Lampa.Lang.translate('shikimori_noty_seen'));
                }

                if (item.action == 'seen_all') {
                    markSeen(data, 0, 0);
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
                    if (data._direct_tmdb) openTmdbDirect(data._direct_tmdb);
                    else Match.openCard(data);
                }
            },
            onBack: function () {
                Lampa.Controller.toggle(enabled);
            }
        });
    }

    // Проставить отметки просмотра — для тех, кто досматривал не в Lampa.
    // episodes/seasons = 0 означает «всё, что знаем»: число сезонов и серий
    // берём из карточки TMDB, потому что Kodik про сезоны ничего не говорит
    function markSeen(data, episodes, seasons) {
        var name = data.original_name || data.original_title || '';
        if (!name) return;

        var last_season = seasons || parseInt(data.number_of_seasons, 10) || 1;
        var last_ep = episodes || parseInt(data.number_of_episodes, 10) || data._total_ep || 0;
        if (!last_ep) last_ep = MARK_SEEN_FALLBACK;

        var written = 0;
        for (var season = 1; season <= last_season && written < MARK_SEEN_LIMIT; season++) {
            for (var ep = 1; ep <= last_ep && written < MARK_SEEN_LIMIT; ep++) {
                try {
                    var hash = Lampa.Utils.hash([season, season > 10 ? ':' : '', ep, name].join(''));
                    Lampa.Timeline.update({ hash: hash, percent: 100, time: 0, duration: 0 });
                    written++;
                }
                catch (e) { return; }
            }
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
        // До какой серии досмотрено и когда. null — отметок нет
        lastWatched: function (card, max_ep) {
            var name = card.original_name || card.original_title || '';
            if (!name) return null;

            var episode = 0;
            var season = 1;
            var at = 0;

            // 1. Прямая запись «где остановился» от онлайн-балансеров
            try {
                var last = Lampa.Storage.get('online_watched_last', {}) || {};
                var filed = last[Lampa.Utils.hash(card.original_title || name)];
                if (filed && filed.episode) {
                    episode = parseInt(filed.episode, 10) || 0;
                    season = parseInt(filed.season, 10) || 1;
                }
            }
            catch (e) {}

            // 2. Отметки таймлайна — штатный обход серий первого сезона
            try {
                var marks = Lampa.Timeline.watched(card, true);
                if (marks && marks.length) {
                    var top = marks[marks.length - 1];
                    if (top && top.ep > episode) { episode = top.ep; season = 1; }
                    // Когда включали в последний раз — по самой свежей отметке
                    for (var m = 0; m < marks.length; m++) {
                        var upd = marks[m].view && marks[m].view.updated;
                        if (upd > at) at = upd;
                    }
                }
            }
            catch (e) {}

            // 3. Timeline.watched обходит только серии 1..24 первого сезона.
            // Если серий заведомо больше — досматриваем хвост точечно
            if (max_ep > 24) {
                try {
                    for (var ep = max_ep; ep > episode && ep > 24; ep--) {
                        var view = Lampa.Timeline.watchedEpisode(card, season, ep, true);
                        if (view && view.percent) {
                            episode = ep;
                            if (view.updated > at) at = view.updated;
                            break;
                        }
                    }
                }
                catch (e) {}
            }

            return episode ? { episode: episode, season: season, at: at || 0 } : null;
        }
    };

    /* ============================================================
     * Матчинг Shikimori (MAL id) -> TMDB
     * ============================================================ */

    var Match = {
        cacheGet: function (mal_id) {
            var cache = storGet('shikimori_match', {});
            var hit = cache['m' + mal_id];
            if (!hit) return null;
            var ttl = hit.none ? MATCH_NEG_TTL : MATCH_TTL;
            if (Date.now() - (hit.time || 0) > ttl) return null;
            return hit;
        },

        cacheSet: function (mal_id, value) {
            var cache = storGet('shikimori_match', {});
            value.time = Date.now();
            cache['m' + mal_id] = value;
            // Обрезаем кэш до 600 записей
            var keys = [];
            for (var k in cache) keys.push(k);
            if (keys.length > 600) {
                keys.sort(function (a, b) { return (cache[a].time || 0) - (cache[b].time || 0); });
                for (var i = 0; i < keys.length - 600; i++) delete cache[keys[i]];
            }
            storSet('shikimori_match', cache);
        },

        // Батч-маппинг: [{mal:1},...] -> map mal -> {tmdb, media, season}
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
                if (offset >= need.length) return ok(result);
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
                                var val = {
                                    tmdb: entry.themoviedb,
                                    media: entry.media == 'MOVIE' ? 'movie' : 'tv',
                                    season: entry['themoviedb-season'] || 0
                                };
                                self.cacheSet(mal, val);
                                result[mal] = val;
                            }
                            else {
                                self.cacheSet(mal, { none: 1 });
                            }
                        }
                    }
                    nextChunk();
                }, function () {
                    // ARM недоступен — работаем с тем, что уже есть
                    ok(result);
                });
            }

            nextChunk();
        },

        // Обратный маппинг TMDB -> Shikimori. У ARM для этого отдельный эндпоинт:
        // в TMDB один сериал на все сезоны, а в Shikimori сезон — отдельный тайтл,
        // поэтому ответ — список (по записи на сезон)
        reverseGet: function (tmdb) {
            var cache = storGet('shikimori_rev_match', {});
            var hit = cache['t' + tmdb];
            if (!hit || Date.now() - (hit.time || 0) > MATCH_TTL) return null;
            return hit.mals || [];
        },

        reverseSet: function (tmdb, mals) {
            var cache = storGet('shikimori_rev_match', {});
            cache['t' + tmdb] = { mals: mals, time: Date.now() };
            var keys = [];
            for (var k in cache) keys.push(k);
            if (keys.length > 400) {
                keys.sort(function (a, b) { return (cache[a].time || 0) - (cache[b].time || 0); });
                for (var i = 0; i < keys.length - 400; i++) delete cache[keys[i]];
            }
            storSet('shikimori_rev_match', cache);
        },

        reverse: function (net, tmdb_ids, ok) {
            var self = this;
            var result = {};
            var need = [];

            for (var i = 0; i < tmdb_ids.length; i++) {
                var hit = this.reverseGet(tmdb_ids[i]);
                if (hit) result[tmdb_ids[i]] = hit;
                else need.push(tmdb_ids[i]);
            }

            need = need.slice(0, REVERSE_MAX);
            if (!need.length) return ok(result);

            var index = 0;
            var alive = Math.min(REVERSE_PARALLEL, need.length);
            var done = alive;

            for (i = 0; i < alive; i++) worker();

            function worker() {
                if (index >= need.length) {
                    done--;
                    if (done <= 0) ok(result);
                    return;
                }
                var tmdb = need[index++];
                net.get(ARM_BASE + '/api/v2/themoviedb?id=' + tmdb, function (list) {
                    var mals = [];
                    for (var j = 0; j < (list || []).length; j++) {
                        var entry = list[j];
                        if (entry && entry.myanimelist) {
                            mals.push({ mal: entry.myanimelist, season: entry['themoviedb-season'] || 0 });
                        }
                    }
                    self.reverseSet(tmdb, mals);
                    result[tmdb] = mals;
                    worker();
                }, function () {
                    // ARM не ответил — не кэшируем пустоту, попробуем в следующий раз
                    worker();
                });
            }
        },

        // Одиночный маппинг с полным фолбэком: ARM -> TMDB find -> TMDB search
        resolve: function (net, anime, ok, fail) {
            var mal_id = parseInt(anime.malId || anime.id, 10);
            var hit = this.cacheGet(mal_id);
            if (hit && !hit.none) return ok({ id: hit.tmdb, method: hit.media || 'tv' });

            var self = this;
            net.get(ARM_BASE + '/api/v2/ids?source=myanimelist&id=' + mal_id, function (map) {
                if (map && map.themoviedb) {
                    var val = { tmdb: map.themoviedb, media: map.media == 'MOVIE' ? 'movie' : 'tv', season: map['themoviedb-season'] || 0 };
                    self.cacheSet(mal_id, val);
                    return ok({ id: val.tmdb, method: val.media });
                }
                if (map && (map.imdb || map.thetvdb)) {
                    return self.findByExternal(net, mal_id, map, ok, function () {
                        self.searchTmdb(net, mal_id, anime, ok, fail);
                    });
                }
                self.searchTmdb(net, mal_id, anime, ok, fail);
            }, function () {
                self.searchTmdb(net, mal_id, anime, ok, fail);
            });
        },

        findByExternal: function (net, mal_id, map, ok, fail) {
            var self = this;
            var ext = map.imdb ? map.imdb : map.thetvdb;
            var src = map.imdb ? 'imdb_id' : 'tvdb_id';
            var url = Lampa.TMDB.api('find/' + ext + '?external_source=' + src + '&api_key=' + Lampa.TMDB.key() + '&language=' + storString('language', 'ru'));
            net.get(url, function (found) {
                var tv = (found && found.tv_results) || [];
                var mv = (found && found.movie_results) || [];
                if (tv.length) {
                    self.cacheSet(mal_id, { tmdb: tv[0].id, media: 'tv' });
                    ok({ id: tv[0].id, method: 'tv' });
                }
                else if (mv.length) {
                    self.cacheSet(mal_id, { tmdb: mv[0].id, media: 'movie' });
                    ok({ id: mv[0].id, method: 'movie' });
                }
                else fail();
            }, fail);
        },

        cleanTitle: function (title) {
            return String(title || '')
                .replace(/\b(Season|Part|Cour)\s*\d+\b/gi, '')
                .replace(/\b\d+(st|nd|rd|th)\s+Season\b/gi, '')
                .replace(/\s*\(TV\)\s*/gi, ' ')
                .replace(/\s{2,}/g, ' ')
                .replace(/^\s+|\s+$/g, '');
        },

        normalize: function (s) {
            return String(s || '').toLowerCase().replace(/[^a-zа-я0-9぀-ヿ一-鿿 ]+/gi, ' ').replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
        },

        similarity: function (a, b) {
            a = this.normalize(a);
            b = this.normalize(b);
            if (!a || !b) return 0;
            if (a === b) return 1;
            var ta = a.split(' ');
            var tb = b.split(' ');
            var common = 0;
            for (var i = 0; i < ta.length; i++) {
                if (tb.indexOf(ta[i]) >= 0) common++;
            }
            return (2 * common) / (ta.length + tb.length);
        },

        // Поиск по названию в TMDB с оценкой кандидатов
        searchTmdb: function (net, mal_id, anime, ok, fail) {
            var self = this;
            var kind = anime.kind || 'tv';
            var type = kind == 'movie' ? 'movie' : 'tv';
            var year = anime.airedOn && anime.airedOn.year ? anime.airedOn.year : (anime.aired_on ? parseInt(anime.aired_on, 10) : 0);

            var titles = [];
            var eng = anime.english;
            if (Object.prototype.toString.call(eng) === '[object Array]') eng = eng[0];
            if (eng) titles.push(eng);
            if (anime.name) titles.push(anime.name);
            if (anime.russian) titles.push(anime.russian);
            if (!titles.length) return fail();

            var candidates = [];
            var step = 0;

            function score(c) {
                var names = [c.name, c.original_name, c.title, c.original_title];
                var best = 0;
                for (var i = 0; i < names.length; i++) {
                    for (var j = 0; j < titles.length; j++) {
                        var s = self.similarity(names[i], self.cleanTitle(titles[j]));
                        if (s > best) best = s;
                    }
                }
                var cyear = parseInt(c.first_air_date || c.release_date || '0', 10);
                var yscore = 0;
                if (year && cyear) {
                    var dy = Math.abs(cyear - year);
                    yscore = dy === 0 ? 1 : (dy === 1 ? 0.5 : 0);
                }
                var anim = (c.genre_ids || []).indexOf(16) >= 0 ? 1 : 0;
                var jp = (c.original_language == 'ja' || (c.origin_country || []).indexOf('JP') >= 0) ? 1 : 0;
                return { sim: best, val: 3 * best + 2 * yscore + anim + jp, anim: anim };
            }

            function done() {
                var seen = {};
                var scored = [];
                for (var i = 0; i < candidates.length; i++) {
                    var c = candidates[i];
                    if (seen['c' + c.id]) continue;
                    seen['c' + c.id] = true;
                    var s = score(c);
                    if (!s.anim) continue; // только анимация
                    if (s.sim < 0.5) continue;
                    c._score = s;
                    scored.push(c);
                }
                scored.sort(function (a, b) { return b._score.val - a._score.val; });

                if (!scored.length) {
                    self.cacheSet(mal_id, { none: 1 });
                    return fail();
                }

                var top = scored[0];
                if (top._score.sim >= 0.75 && (scored.length == 1 || top._score.val - scored[1]._score.val > 0.7)) {
                    self.cacheSet(mal_id, { tmdb: top.id, media: type });
                    return ok({ id: top.id, method: type });
                }

                // Несколько похожих — убираем спиннер и даём выбрать
                try { Lampa.Loading.stop(); } catch (e) {}
                var items = [];
                for (var j = 0; j < Math.min(scored.length, 8); j++) {
                    var cc = scored[j];
                    items.push({
                        title: (cc.name || cc.title || '?') + ' (' + String(cc.first_air_date || cc.release_date || '').slice(0, 4) + ')',
                        candidate: cc
                    });
                }
                var enabled = Lampa.Controller.enabled().name;
                Lampa.Select.show({
                    title: Lampa.Lang.translate('shikimori_pick_title'),
                    items: items,
                    onSelect: function (item) {
                        Lampa.Controller.toggle(enabled);
                        self.cacheSet(mal_id, { tmdb: item.candidate.id, media: type });
                        ok({ id: item.candidate.id, method: type });
                    },
                    onBack: function () {
                        Lampa.Controller.toggle(enabled);
                    }
                });
            }

            function query() {
                if (step >= titles.length) return done();
                var title = self.cleanTitle(titles[step]);
                step++;
                if (!title) return query();
                var url = Lampa.TMDB.api('search/' + type + '?query=' + encodeURIComponent(title) +
                    (year ? (type == 'tv' ? '&first_air_date_year=' : '&year=') + year : '') +
                    '&api_key=' + Lampa.TMDB.key() + '&language=' + storString('language', 'ru'));
                net.get(url, function (resp) {
                    var results = (resp && resp.results) || [];
                    for (var i = 0; i < results.length; i++) candidates.push(results[i]);
                    if (candidates.length >= 3) done();
                    else query();
                }, function () {
                    query();
                });
            }

            query();
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

            function stopLoading() {
                try { Lampa.Loading.stop(); } catch (e) {}
            }

            function push(found) {
                var url = Lampa.TMDB.api(found.method + '/' + found.id + '?api_key=' + Lampa.TMDB.key() + '&language=' + storString('language', 'ru'));
                background_net.get(url, function (card) {
                    stopLoading();
                    if (!loading) return;
                    if (!card || !card.id) return notFound();
                    card.source = 'tmdb';
                    Lampa.Activity.push({
                        url: '',
                        component: 'full',
                        id: card.id,
                        method: found.method,
                        card: card,
                        source: 'tmdb'
                    });
                }, function () {
                    stopLoading();
                    if (loading) notFound();
                });
            }

            function notFound() {
                stopLoading();
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_not_found') + ': ' + (anime.russian || anime.name));
            }

            Match.resolve(background_net, anime, function (found) {
                if (loading) push(found);
            }, notFound);
        }
    };

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
        tracked: function (net, rates, ok) {
            var self = this;
            var favorites = [];
            var mals = (rates && rates.mals) || {};
            var watching = (rates && rates.watching) || [];

            var rev_map = {};

            // Сопоставление закладок идёт первым: без id Shikimori мы не можем
            // спросить Kodik про избранное, а раньше и не спрашивали — про
            // онгоинг из «Позже» узнавали, только если он попадал в суточную ленту
            this.favorites(function (list) {
                favorites = list;

                if (!favorites.length) return feed({});

                var ids = [];
                for (var i = 0; i < favorites.length; i++) ids.push(favorites[i].id);
                Match.reverse(net, ids, feed);
            });

            function feed(rev) {
                rev_map = rev || {};

                if (!Kodik.enabled()) return finish({}, rev_map);

                Kodik.feed(net, function (rows) {
                    lookup(Kodik.mergeRows(rows));
                }, function () {
                    lookup({});
                });
            }

            // Точечно добираем то, чего не было в суточной ленте: и списки
            // Shikimori, и закладки. У закладок статус неизвестен, поэтому
            // сперва узнаём его одним запросом и спрашиваем только про онгоинги
            function lookup(fresh) {
                var store = Kodik.store();
                var unknown = [];
                var candidates = [];
                var i, sid;

                function isNew(id) {
                    return id && !fresh['s' + id] && !store['s' + id];
                }

                for (i = 0; i < watching.length; i++) {
                    sid = parseInt(watching[i].malId || watching[i].id, 10);
                    if (watching[i].status == 'ongoing' && isNew(sid)) unknown.push(sid);
                }

                for (var key in rev_map) {
                    var seasons = rev_map[key] || [];
                    for (i = 0; i < seasons.length; i++) {
                        sid = seasons[i].mal;
                        if (isNew(sid) && candidates.indexOf(sid) < 0) candidates.push(sid);
                    }
                }

                if (!candidates.length) return ask(unknown);

                Shiki.animesByIds(net, candidates.slice(0, 100), function (animes) {
                    for (var j = 0; j < animes.length; j++) {
                        if (animes[j].status != 'ongoing') continue;
                        var id = parseInt(animes[j].malId || animes[j].id, 10);
                        if (id && unknown.indexOf(id) < 0) unknown.push(id);
                    }
                    ask(unknown);
                }, function () {
                    ask(unknown);
                });

                function ask(ids) {
                    if (!ids.length) return finish(Kodik.remember(fresh), rev_map);
                    Kodik.lookup(net, ids, function (found) {
                        for (var k in found) fresh[k] = found[k];
                        finish(Kodik.remember(fresh), rev_map);
                    });
                }
            }

            function finish(known, rev) {
                var items = [];
                var used = {};
                var i, j;

                // 1. Закладки Lampa — прогресс берём из отметок самой Lampa
                for (i = 0; i < favorites.length; i++) {
                    var card = favorites[i];
                    var seasons = rev[card.id] || [];
                    var best = null;

                    // Из всех сезонов берём тот, где озвучка обновлялась позже — это текущий
                    for (j = 0; j < seasons.length; j++) {
                        var known_season = known['s' + seasons[j].mal];
                        if (!known_season) continue;
                        if (!best || (known_season.at || 0) > (best.info.at || 0)) {
                            best = { info: known_season, season: seasons[j].season };
                        }
                        used['s' + seasons[j].mal] = true;
                    }

                    // Озвучка не может опережать эфир: если Kodik насчитал больше,
                    // чем вышло в Японии, верить надо меньшему числу
                    var total = best ? countAvailable(best.info) : 0;
                    var mark = Progress.lastWatched(card, total);
                    var watched = mark ? mark.episode : 0;
                    var fresh = 0;
                    var airing = false;

                    if (best) {
                        var aligned = !best.season || !mark || mark.season == best.season;
                        fresh = (watched && aligned) ? total - watched : total - (best.info.base || total);

                        // Прогресс из отметок Lampa идёт в нумерации TMDB, а Kodik
                        // считает серии подряд по всему тайтлу. У длинных сериалов
                        // это расходится на сотни, поэтому неправдоподобной разнице
                        // мы не верим и показываем тайтл без числа
                        if (fresh > FRESH_SANE_MAX) fresh = 0;
                        if (watched > total) fresh = 0;

                        // Прогресса нет вовсе — сравнивать не с чем, и база первой
                        // встречи молчит до следующей серии. Но если озвучка вышла
                        // на днях, это ровно та новость, ради которой тайтл в избранном
                        airing = (!watched || !fresh) && best.info.at >= Date.now() - KODIK_FRESH_DAYS * 86400000;
                    }

                    var sids = [];
                    for (j = 0; j < seasons.length; j++) sids.push(seasons[j].mal);

                    var fav_status = '';
                    for (j = 0; j < sids.length; j++) {
                        if (mals[sids[j]] && mals[sids[j]].status) fav_status = mals[sids[j]].status;
                    }

                    items.push({
                        card: card,
                        tmdb: { id: card.id, method: card.name || card.original_name ? 'tv' : 'movie' },
                        groups: card._fav_groups || {},
                        sids: sids,
                        status: fav_status,
                        kodik: best ? best.info : null,
                        total: total,
                        watched: watched,
                        watched_at: mark ? mark.at : 0,
                        fresh: fresh > 0 ? fresh : 0,
                        airing: airing,
                        at: best ? best.info.at : 0
                    });
                }

                // 2. Списки Shikimori — то, чего в закладках нет
                for (i = 0; i < watching.length; i++) {
                    var anime = watching[i];
                    var sid = parseInt(anime.malId || anime.id, 10);
                    if (!sid || used['s' + sid]) continue;

                    var info = known['s' + sid];
                    var rate = mals[sid];
                    var seen = rate ? (rate.episodes || 0) : 0;
                    var status = rate ? rate.status : '';
                    var have = info ? countAvailable(info) : (anime.episodesAired || 0);
                    if (anime.episodesAired && have > anime.episodesAired) have = anime.episodesAired;

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

        // Что вообще вышло с озвучкой за последние сутки — не только из закладок.
        // Лента Kodik уже в кэше после tracked(), второго запроса не будет
        released: function (net, ok) {
            if (!Kodik.enabled()) return ok([]);

            Kodik.feed(net, function (rows) {
                var merged = Kodik.mergeRows(rows);
                var list = [];
                for (var key in merged) {
                    if (!Hidden.has(merged[key].sid)) list.push(merged[key]);
                }
                if (!list.length) return ok([]);

                list.sort(function (a, b) { return b.at - a.at; });
                list = list.slice(0, 20);

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
            }, function () {
                ok([]);
            });
        },

        // Карточка для отрисовки: прогресс и данные Kodik переносим на объект карточки.
        // Каждой строке — своя копия: Lampa помечает отрисованный объект `ready`
        // и во второй строке молча его пропускает (interaction/items/old/line.js)
        decorate: function (item) {
            var card = {};
            for (var key in item.card) card[key] = item.card[key];

            card._kodik = item.kodik || null;
            card._kodik_new = item.fresh || 0;
            card._watched_ep = item.watched || 0;
            card._total_ep = item.total || 0;
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
    function cardStyle() {
        var style = storString('shikimori_card_style', 'native');
        return ['native', 'compact', 'poster'].indexOf(style) >= 0 ? style : 'native';
    }

    // Одна карточка на весь плагин: данные приходят и от Shikimori, и от TMDB/CUB,
    // поэтому поля сводим к общему виду, а разметка всегда штатная разметка Lampa
    function cardView(data) {
        var tmdb = !!(data.poster_path || data.backdrop_path || data.first_air_date || data.release_date || data._tmdb_card);
        var title, poster, score, year;

        if (tmdb) {
            title = data.name || data.title || data.original_name || data.original_title || '';
            poster = data.img || (data.poster_path ? Lampa.TMDB.image('t/p/w300' + data.poster_path) : '');
            score = data.vote_average ? parseFloat(data.vote_average) : 0;
            year = (data.first_air_date || data.release_date || '').slice(0, 4);
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

            var img = this.card.querySelector('.card__img');
            var fav_img = data._fav_img || '';
            img.onerror = function () {
                if (fav_img && img.src.indexOf(fav_img) == -1) img.src = fav_img;
                else img.src = './img/img_broken.svg';
            };
            img.src = poster;

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
            if (data._kodik_new > 0) {
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
            // со студией, затем дата ближайшего эфира
            var marker = this.card.querySelector('.card__marker');
            if (data._watched_ep) {
                marker.querySelector('span').innerText = data._total_ep > data._watched_ep
                    ? data._watched_ep + ' / ' + data._total_ep
                    : data._watched_ep + ' ' + Lampa.Lang.translate('shikimori_ep');
            }
            else if (data._kodik) {
                var studio = data._kodik.studio ? ' · ' + data._kodik.studio : '';
                var subs = data._kodik.voice ? '' : ' · ' + Lampa.Lang.translate('shikimori_subtitles');
                marker.querySelector('span').innerText = data._kodik.ep + ' ' +
                    Lampa.Lang.translate('shikimori_ep') + (subs || studio);
            }
            // В каталоге прогресса нет, но мы можем знать, что озвучка уже есть —
            // листая список, сразу видно, что реально можно включить
            else if (Kodik.known(parseInt(data.malId || data.id, 10))) {
                var have = Kodik.known(parseInt(data.malId || data.id, 10));
                marker.querySelector('span').innerText = have.ep + ' ' +
                    Lampa.Lang.translate('shikimori_ep') + ' ' + Lampa.Lang.translate('shikimori_dubbed');
            }
            else if (data._next_at) {
                marker.querySelector('span').innerText = formatDate(data._next_at) +
                    (data._next_episode ? ' · ' + data._next_episode + ' ' + Lampa.Lang.translate('shikimori_ep') : '');
            }
            else marker.classList.add('hide');
        };

        this.create = function () {
            this.build();

            this.card.addEventListener('hover:focus', function () {
                if (self.onFocus) self.onFocus(self.card, data);
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

            var lines = {};
            var join = makeJoin(5, function () {
                self.buildLines(lines);
            });

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

                    // Прогресс, набранный в Lampa, уезжает в список Shikimori
                    Sync.push(net, items, rates, function (sent) {
                        if (sent) Lampa.Noty.show(Lampa.Lang.translate('shikimori_sync_done') + ': ' + sent);
                    });


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

            net.get(url, function (json) {
                var results = (json && json.results) || [];
                if (results.length) {
                    for (var i = 0; i < results.length; i++) results[i].source = 'tmdb';
                    done(results, true);
                }
                else fallback();
            }, fallback);

            function fallback() {
                var url = Lampa.TMDB.api('discover/tv?with_keywords=210024&with_origin_country=JP&sort_by=popularity.desc' +
                    '&api_key=' + Lampa.TMDB.key() + '&language=' + storString('language', 'ru') + '&page=1');
                net.get(url, function (json) {
                    var results = (json && json.results) || [];
                    for (var i = 0; i < results.length; i++) results[i].source = 'tmdb';
                    done(results, false);
                }, function () {
                    done([], false);
                });
            }
        };

        comp.buildLines = function (lines) {
            var data = [];
            var nick = storString('shikimori_user', '');

            // Строка-меню
            var actions = [
                { action: 'search', icon: ICON_SEARCH, title: Lampa.Lang.translate('shikimori_action_search') },
                { action: 'catalog', icon: ICON_CATALOG, title: Lampa.Lang.translate('shikimori_action_catalog') },
                { action: 'calendar', icon: ICON_CALENDAR, title: Lampa.Lang.translate('shikimori_action_calendar') },
                Auth.connected()
                    ? { action: 'account', icon: ICON_USER, title: Auth.nickname() || nick || Lampa.Lang.translate('shikimori_auth_connected') }
                    : { action: 'login', icon: ICON_USER, title: Lampa.Lang.translate('shikimori_action_login') }
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

            // Экран открыт — данные свежие, счётчик в меню обновляем заодно
            updateMenuBadge(tracked);

            // Новые серии — доступны с озвучкой, не просмотрены и появились недавно
            var fresh = [];
            for (i = 0; i < tracked.length; i++) {
                if (isFresh(tracked[i])) fresh.push(tracked[i]);
            }
            fresh.sort(function (a, b) { return b.at - a.at; });

            if (fresh.length) {
                var fresh_cards = [];
                for (i = 0; i < Math.min(fresh.length, 30); i++) fresh_cards.push(UserData.decorate(fresh[i]));
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
        };

        // Перехват кликов по карточкам Shikimori и действиям
        comp.onAppend = function (item, element) {
            if (element.shiki) {
                item.onSelect = function (target, card_data) {
                    if (card_data._direct_tmdb) {
                        openTmdbDirect(card_data._direct_tmdb);
                    }
                    else Match.openCard(card_data);
                };
            }
            if (element.shiki_actions) {
                item.onSelect = function (target, card_data) {
                    if (card_data.action == 'search') openCatalog({ open_search: true });
                    if (card_data.action == 'catalog') openCatalog({});
                    if (card_data.action == 'calendar') openCatalog({ mode: 'calendar' });
                    if (card_data.action == 'settings') askNickname();
                    if (card_data.action == 'login') connectShikimori();
                    if (card_data.action == 'account') connectShikimori();
                };
            }
        };

        comp.onDestroy = function () {
            net.clear();
        };

        return comp;
    }

    // Сколько серий реально доступно: Kodik сообщает номер последней серии у
    // студии, но у него бывает опережение, а больше, чем вышло в эфир, быть не может
    function countAvailable(info) {
        var ep = info.ep || 0;
        if (info.aired && info.aired > 0 && ep > info.aired) return info.aired;
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

    function watchScrollable() {
        setTimeout(markScrollable, 300);
        setTimeout(markScrollable, 1200);

        // Лента дорисовывает карточки на ходу, поэтому ширина трека меняется
        // уже после сборки экрана — пересчитываем при переходах фокуса
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

    // Скрытое «Не интересует» не показываем ни в одной личной строке
    function visible(item) {
        return !(item.kodik && Hidden.has(item.kodik.sid));
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
        if (entry.tmdb) anime._direct_tmdb = { id: entry.tmdb.tmdb, method: entry.tmdb.media || 'tv' };
        if (entry.fav_card && entry.fav_card.img) anime._fav_img = entry.fav_card.img;
        return anime;
    }

    function openTmdbDirect(found) {
        var url = Lampa.TMDB.api(found.method + '/' + found.id + '?api_key=' + Lampa.TMDB.key() + '&language=' + storString('language', 'ru'));
        try { Lampa.Loading.start(function () { background_net.clear(); }); } catch (e) {}
        background_net.get(url, function (card) {
            try { Lampa.Loading.stop(); } catch (e) {}
            if (!card || !card.id) return;
            card.source = 'tmdb';
            Lampa.Activity.push({
                url: '',
                component: 'full',
                id: card.id,
                method: found.method,
                card: card,
                source: 'tmdb'
            });
        }, function () {
            try { Lampa.Loading.stop(); } catch (e) {}
            Lampa.Noty.show(Lampa.Lang.translate('shikimori_not_found'));
        });
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
            if (value) {
                storSet('shikimori_user', value);
                storSet('shikimori_user_id', null);
                UserData.dropRatesCache();
                Lampa.Activity.push({
                    url: '',
                    title: manifest.name,
                    component: PLUGIN + '_main',
                    page: 1
                });
            }
            else Lampa.Controller.toggle('content');
        });
    }

    /* ============================================================
     * Каталог: фильтры + сетка + пагинация
     * ============================================================ */

    var FILTER_KINDS = ['tv', 'movie', 'ova', 'ona', 'special', 'tv_special'];
    var FILTER_STATUSES = ['ongoing', 'anons', 'released'];
    var FILTER_ORDERS = ['popularity', 'ranked', 'aired_on', 'name', 'random'];
    var FILTER_SCORES = [9, 8, 7, 6];

    function CatalogComponent(object) {
        var self = this;
        var net = new NetPool();
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250, end_ratio: 2 });
        var items = [];
        var html = document.createElement('div');
        var head = null;
        var filter = null;
        var genres = [];
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

            if (object.mode == 'catalog' && Lampa.Filter) {
                head = this.buildHead();
                scroll.append(head);
            }

            scroll.append(body);
            html.appendChild(scroll.render(true));

            scroll.onEnd = this.next.bind(this);
            scroll.onWheel = function (step) {
                if (!Lampa.Controller.own(self)) self.start();
                if (step > 0) Navigator.move('down');
                else Navigator.move('up');
            };

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

        this.buildHead = function () {
            filter = new Lampa.Filter({});

            filter.onBack = function () {
                self.start();
            };

            filter.onSelect = function (type, a, b) {
                self.onFilterSelect(type, a, b);
            };

            // Штатная кнопка поиска ведёт в уточнение торрентов — перевешиваем на свой ввод
            filter.render().find('.filter--search').off('hover:enter').on('hover:enter', function () {
                self.searchInput();
            });

            // Жанры нужны для меню фильтра — подгружаем заранее
            Shiki.genres(net, function (list) {
                genres = list;
                self.updateHead();
            }, function () {});

            this.updateHead();

            return filter.render()[0];
        };

        this.enumItems = function (values, key, titleFn) {
            var list = [{
                title: Lampa.Lang.translate('shikimori_any'),
                value: '',
                selected: !object.filters[key]
            }];
            for (var i = 0; i < values.length; i++) {
                list.push({
                    title: titleFn(values[i]),
                    value: values[i],
                    selected: String(object.filters[key]) == String(values[i])
                });
            }
            return list;
        };

        this.seasonValues = function () {
            var values = [];
            var i;
            values.push(currentSeason(1));
            for (i = 0; i > -8; i--) values.push(currentSeason(i));
            var out = [];
            for (i = 0; i < values.length; i++) out.push({ v: values[i], t: seasonTitle(values[i]) });
            var year = new Date().getFullYear();
            for (i = year - 2; i >= 2000; i--) out.push({ v: String(i), t: String(i) });
            out.push({ v: '199x', t: '1990-е' });
            out.push({ v: '198x', t: '1980-е' });
            return out;
        };

        this.genreItems = function () {
            var selected = object.filters.genre ? String(object.filters.genre).split(',') : [];
            var list = [{
                title: Lampa.Lang.translate('shikimori_any'),
                value: '',
                selected: !selected.length
            }];
            for (var i = 0; i < genres.length; i++) {
                list.push({
                    title: genres[i].title,
                    value: String(genres[i].id),
                    g_title: genres[i].title,
                    selected: selected.indexOf(String(genres[i].id)) >= 0
                });
            }
            return list;
        };

        // Текущее значение фильтра словами
        this.filterLabel = function (key) {
            var f = object.filters;
            if (key == 'genre') return f.genre_titles || '';
            if (key == 'kind') return f.kind ? Lampa.Lang.translate('shikimori_kind_' + f.kind) : '';
            if (key == 'status') return f.status ? Lampa.Lang.translate('shikimori_status_filter_' + f.status) : '';
            if (key == 'season') return f.season ? seasonTitle(f.season) : '';
            if (key == 'score') return f.score ? (Lampa.Lang.translate('shikimori_score_from') + ' ' + f.score) : '';
            return '';
        };

        this.updateHead = function () {
            if (!filter) return;

            var any = Lampa.Lang.translate('shikimori_any');
            var seasons = this.seasonValues();
            var season_values = [];
            var i;
            for (i = 0; i < seasons.length; i++) season_values.push(seasons[i].v);

            var groups = [
                {
                    key: 'genre',
                    title: Lampa.Lang.translate('shikimori_chip_genre'),
                    items: this.genreItems()
                },
                {
                    key: 'kind',
                    title: Lampa.Lang.translate('shikimori_chip_kind'),
                    items: this.enumItems(FILTER_KINDS, 'kind', function (v) { return Lampa.Lang.translate('shikimori_kind_' + v); })
                },
                {
                    key: 'status',
                    title: Lampa.Lang.translate('shikimori_chip_status'),
                    items: this.enumItems(FILTER_STATUSES, 'status', function (v) { return Lampa.Lang.translate('shikimori_status_filter_' + v); })
                },
                {
                    key: 'season',
                    title: Lampa.Lang.translate('shikimori_chip_season'),
                    items: this.enumItems(season_values, 'season', function (v) {
                        for (var j = 0; j < seasons.length; j++) if (seasons[j].v == v) return seasons[j].t;
                        return v;
                    })
                },
                {
                    key: 'score',
                    title: Lampa.Lang.translate('shikimori_chip_score'),
                    items: this.enumItems(FILTER_SCORES, 'score', function (v) { return Lampa.Lang.translate('shikimori_score_from') + ' ' + v; })
                }
            ];

            var filter_items = [];
            var chosen = [];
            for (i = 0; i < groups.length; i++) {
                var label = this.filterLabel(groups[i].key);
                filter_items.push({
                    title: groups[i].title,
                    subtitle: label || any,
                    key: groups[i].key,
                    noselect: true,
                    items: groups[i].items
                });
                if (label) chosen.push(label);
            }
            filter_items.push({
                title: Lampa.Lang.translate('shikimori_chip_reset'),
                reset: true,
                noselect: true
            });

            var sort_items = [];
            var order = object.filters.order || 'popularity';
            for (i = 0; i < FILTER_ORDERS.length; i++) {
                sort_items.push({
                    title: Lampa.Lang.translate('shikimori_order_' + FILTER_ORDERS[i]),
                    sort: FILTER_ORDERS[i],
                    selected: FILTER_ORDERS[i] == order
                });
            }

            filter.set('filter', filter_items);
            filter.set('sort', sort_items);
            filter.chosen('filter', chosen);
            filter.chosen('sort', [Lampa.Lang.translate('shikimori_order_' + order)]);

            var search_btn = filter.render().find('.filter--search');
            if (object.filters.search) search_btn.find('div').text(Lampa.Utils.shortText(object.filters.search, 20)).removeClass('hide');
            else search_btn.find('div').text('').addClass('hide');
        };

        this.onFilterSelect = function (type, a, b) {
            var f = object.filters;

            if (type == 'sort') {
                f.order = a.sort;
                this.updateHead();
                return this.reload();
            }

            if (a.reset) {
                object.filters = { order: f.order };
                this.updateHead();
                return this.reload();
            }

            if (!b) return;

            if (a.key == 'genre') {
                if (!b.value) {
                    delete f.genre;
                    delete f.genre_titles;
                }
                else {
                    var current = f.genre ? String(f.genre).split(',') : [];
                    var titles = f.genre_titles ? f.genre_titles.split(', ') : [];
                    var idx = current.indexOf(b.value);
                    if (idx >= 0) {
                        current.splice(idx, 1);
                        titles.splice(idx, 1);
                    }
                    else {
                        current.push(b.value);
                        titles.push(b.g_title);
                    }
                    if (current.length) {
                        f.genre = current.join(',');
                        f.genre_titles = titles.join(', ');
                    }
                    else {
                        delete f.genre;
                        delete f.genre_titles;
                    }
                }
            }
            else {
                if (b.value === '' || typeof b.value == 'undefined') delete f[a.key];
                else f[a.key] = b.value;
            }

            this.updateHead();
            this.reload();
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
            var params = {
                page: object.page,
                limit: 36,
                kind: f.kind,
                status: f.status,
                season: f.season,
                genre: f.genre,
                score: f.score,
                search: f.search
            };
            if (f.order) params.order = f.order;
            else if (!f.search) params.order = 'popularity';
            return params;
        };

        this.load = function (first) {
            if (object.mode == 'mylist') return this.loadMylist(first);
            if (object.mode == 'calendar') return this.loadCalendar(first);

            Shiki.catalog(net, this.requestParams(), function (list) {
                has_more = list.length >= 36;
                self.append(list);
                if (first) self.ready(list.length);
                waitload = false;
            }, function () {
                waitload = false;
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
            }, function () {
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

            net.clear();
            this.activity.loader(true);

            Shiki.catalog(net, this.requestParams(), function (list) {
                if (my_id != reload_id) return;
                has_more = list.length >= 36;
                self.append(list);
                self.activity.loader(false);
                if (!list.length) Lampa.Noty.show(Lampa.Lang.translate('shikimori_empty'));
            }, function () {
                if (my_id != reload_id) return;
                self.activity.loader(false);
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_api'));
            });
        };

        this.append = function (list) {
            for (var i = 0; i < list.length; i++) {
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
                        if (card_data._direct_tmdb) openTmdbDirect(card_data._direct_tmdb);
                        else Match.openCard(card_data);
                    };

                    body.appendChild(card.render(true));
                    items.push(card);

                    if (Lampa.Controller.own(self)) Lampa.Controller.collectionAppend(card.render(true));
                })(list[i]);
            }
        };

        this.ready = function (count) {
            this.updateHead();
            this.activity.loader(false);
            this.activity.toggle();
            if (!count) Lampa.Noty.show(Lampa.Lang.translate('shikimori_empty'));
        };

        this.empty = function () {
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
                    Lampa.Controller.collectionSet(scroll.render(true));
                    Lampa.Controller.collectionFocus(last || false, scroll.render(true));
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
            if (filter) filter.destroy();
            filter = null;
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

                var render = e.object.activity.render();

                // Обратный маппинг TMDB -> MAL
                var rev_cache = storGet('shikimori_rev_match', {});
                var rev_key = 'r' + movie.id;
                var cached = rev_cache[rev_key];

                if (cached && Date.now() - (cached.time || 0) < MATCH_TTL) {
                    if (cached.mal) enrich(cached.mal);
                    return;
                }

                background_net.get(ARM_BASE + '/api/v2/themoviedb?id=' + movie.id, function (list) {
                    var mal = 0;
                    if (list && list.length) {
                        for (var i = 0; i < list.length; i++) {
                            if (list[i] && list[i].myanimelist) { mal = list[i].myanimelist; break; }
                        }
                    }
                    rev_cache = storGet('shikimori_rev_match', {});
                    rev_cache[rev_key] = { mal: mal, time: Date.now() };
                    var keys = [];
                    for (var k in rev_cache) keys.push(k);
                    if (keys.length > 300) {
                        keys.sort(function (a, b) { return (rev_cache[a].time || 0) - (rev_cache[b].time || 0); });
                        for (var d = 0; d < keys.length - 300; d++) delete rev_cache[keys[d]];
                    }
                    storSet('shikimori_rev_match', rev_cache);
                    if (mal) enrich(mal);
                }, function () {});

                function enrich(mal_id) {
                    background_net.get(Shiki.base() + '/api/animes/' + mal_id, function (details) {
                        if (!details || !details.id) return;
                        try {
                            var rate_line = render.find('.full-start-new__rate-line');
                            if (rate_line.length && parseFloat(details.score)) {
                                var badge = $('<div class="full-start__rate shikimori-rate"><div>' + parseFloat(details.score).toFixed(1) + '</div><div class="source--name">Shikimori</div></div>');
                                rate_line.prepend(badge);
                            }
                            if (details.next_episode_at) {
                                var at = parseISO(details.next_episode_at);
                                var num = (details.episodes_aired || 0) + 1;
                                var text = Lampa.Lang.translate('shikimori_next_episode') + ': ' + num + ' ' + Lampa.Lang.translate('shikimori_ep') + ' · ' + formatDate(at);
                                var details_block = render.find('.full-start-new__details');
                                if (details_block.length) details_block.append('<span class="shikimori-next">' + text + '</span>');
                            }
                        } catch (err) {}
                    }, function () {});
                }
            } catch (err) {}
        });
    }

    /* ============================================================
     * Настройки
     * ============================================================ */

    function setupSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'shikimori',
            icon: ICON_MENU,
            name: manifest.name
        });

        // Версия первой строкой: единственный способ с пульта понять, какая
        // сборка реально загрузилась — плагин внедряется один раз при старте
        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_version',
                type: 'static'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_version') + ': ' + VERSION,
                description: Lampa.Lang.translate('shikimori_settings_version_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_user',
                type: 'input',
                values: '',
                default: ''
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_client_id',
                type: 'input',
                values: '',
                default: ''
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_client_id'),
                description: Lampa.Lang.translate('shikimori_settings_client_id_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_client_secret',
                type: 'input',
                values: '',
                default: ''
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_client_secret'),
                description: Lampa.Lang.translate('shikimori_settings_client_secret_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_connect',
                type: 'button'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_connect'),
                description: Lampa.Lang.translate('shikimori_settings_connect_descr')
            },
            onChange: function () {
                connectShikimori();
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_sync',
                type: 'trigger',
                default: false
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_sync'),
                description: Lampa.Lang.translate('shikimori_settings_sync_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
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

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_kodik_token',
                type: 'input',
                values: '',
                default: ''
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_kodik_token'),
                description: Lampa.Lang.translate('shikimori_settings_kodik_token_descr')
            },
            onChange: function () {
                Kodik.dropCache();
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_proxy',
                type: 'input',
                values: '',
                default: ''
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_proxy'),
                description: Lampa.Lang.translate('shikimori_settings_proxy_descr')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'shikimori',
            param: {
                name: 'shikimori_clear_cache',
                type: 'button'
            },
            field: {
                name: Lampa.Lang.translate('shikimori_settings_clear_cache'),
                description: Lampa.Lang.translate('shikimori_settings_clear_cache_descr')
            },
            onChange: function () {
                storSet('shikimori_match', {});
                storSet('shikimori_rev_match', {});
                storSet('shikimori_calendar_cache', null);
                storSet('shikimori_genres_cache', null);
                storSet('shikimori_user_id', null);
                storSet('shikimori_kodik_eps', {});
                storSet('shikimori_hidden', {});
                Kodik.dropCache();
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
            shikimori_pick_title: { ru: 'Выберите тайтл', en: 'Pick a title', uk: 'Оберіть тайтл' },
            shikimori_empty: { ru: 'Ничего не найдено', en: 'Nothing found', uk: 'Нічого не знайдено' },
            shikimori_error_api: { ru: 'Ошибка Shikimori API', en: 'Shikimori API error', uk: 'Помилка Shikimori API' },
            shikimori_any: { ru: 'Любой', en: 'Any', uk: 'Будь-який' },
            shikimori_next_episode: { ru: 'Следующая серия', en: 'Next episode', uk: 'Наступна серія' },

            shikimori_title_menu: { ru: 'Меню', en: 'Menu', uk: 'Меню' },
            shikimori_title_watching: { ru: 'Я смотрю', en: 'Watching', uk: 'Я дивлюсь' },
            shikimori_title_later: { ru: 'Позже', en: 'Later', uk: 'Пізніше' },
            shikimori_title_released: { ru: 'Свежая озвучка', en: 'Just dubbed', uk: 'Свіже озвучення' },
            shikimori_title_backlog: { ru: 'Есть что посмотреть', en: 'Ready to watch', uk: 'Є що подивитись' },

            shikimori_group_progress: { ru: 'Прогресс просмотра', en: 'Watch progress', uk: 'Прогрес перегляду' },
            shikimori_group_tag: { ru: 'Метка в избранном Lampa', en: 'Lampa bookmark tag', uk: 'Мітка в обраному Lampa' },
            shikimori_group_visible: { ru: 'Видимость в строках плагина', en: 'Visibility in plugin rows', uk: 'Видимість у рядках плагіна' },
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
            shikimori_noty_hidden: { ru: 'Убрали. Вернуть можно в настройках', en: 'Dismissed. Restore it in settings', uk: 'Прибрали. Повернути можна в налаштуваннях' },
            shikimori_noty_unhidden: { ru: 'Вернули в строки', en: 'Back in the rows', uk: 'Повернули' },
            shikimori_noty_seen: { ru: 'Отмечено просмотренным', en: 'Marked as watched', uk: 'Позначено переглянутим' },
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
            shikimori_settings_uncensored: { ru: 'Показывать 18+', en: 'Show 18+', uk: 'Показувати 18+' },
            shikimori_settings_uncensored_descr: { ru: 'Отключает фильтр цензуры Shikimori', en: 'Disables Shikimori censorship filter', uk: 'Вимикає фільтр цензури Shikimori' },
            shikimori_subtitles: { ru: 'субтитры', en: 'subtitles', uk: 'субтитри' },
            shikimori_dubbed: { ru: 'с озвучкой', en: 'dubbed', uk: 'з озвученням' },
            shikimori_settings_kodik: { ru: 'Строка «Новые серии»', en: 'New episodes row', uk: 'Рядок «Нові серії»' },
            shikimori_settings_kodik_descr: { ru: 'Серии, которые уже вышли с озвучкой (данные Kodik). Выключено — останутся только даты эфира в Японии', en: 'Episodes already released with a dub (Kodik). Off — Japanese air dates only', uk: 'Серії, що вже вийшли з озвучкою (Kodik)' },
            shikimori_settings_kodik_subs: { ru: 'Засчитывать субтитры', en: 'Count subtitles', uk: 'Зараховувати субтитри' },
            shikimori_settings_kodik_subs_descr: { ru: 'Показывать серию новой, если вышла только с субтитрами, без озвучки', en: 'Treat subtitle-only releases as new episodes', uk: 'Показувати серію новою, якщо вийшла лише із субтитрами' },
            shikimori_settings_version: { ru: 'Версия плагина', en: 'Plugin version', uk: 'Версія плагіна' },
            shikimori_settings_version_descr: { ru: 'Обновляется при перезапуске Lampa. Если версия старая — закройте приложение полностью и откройте заново', en: 'Updates when Lampa restarts', uk: 'Оновлюється під час перезапуску Lampa' },
            shikimori_settings_client_id: { ru: 'Client ID приложения Shikimori', en: 'Shikimori Client ID', uk: 'Client ID застосунку Shikimori' },
            shikimori_settings_client_id_descr: { ru: 'Создаётся на shikimori.io/oauth/applications, Redirect URI — urn:ietf:wg:oauth:2.0:oob, права user_rates', en: 'Create at shikimori.io/oauth/applications', uk: 'Створюється на shikimori.io/oauth/applications' },
            shikimori_settings_client_secret: { ru: 'Client Secret', en: 'Client Secret', uk: 'Client Secret' },
            shikimori_settings_client_secret_descr: { ru: 'Хранится только на этом устройстве и никуда не отправляется, кроме самого Shikimori', en: 'Kept on this device only', uk: 'Зберігається лише на цьому пристрої' },
            shikimori_settings_connect: { ru: 'Подключить Shikimori', en: 'Connect Shikimori', uk: 'Підключити Shikimori' },
            shikimori_settings_connect_descr: { ru: 'Покажем QR-код: подтверждаете вход с телефона и вводите код с экрана', en: 'Scan a QR on your phone and type the code back', uk: 'Покажемо QR-код' },
            shikimori_settings_sync: { ru: 'Отправлять прогресс в Shikimori', en: 'Push progress to Shikimori', uk: 'Надсилати прогрес у Shikimori' },
            shikimori_settings_sync_descr: { ru: 'Просмотренное в Lampa проставляется в вашем списке. Прогресс только увеличивается, статусы и оценки не трогаются', en: 'What you watch in Lampa is written to your list; progress only moves forward', uk: 'Переглянуте в Lampa проставляється у вашому списку' },
            shikimori_auth_title: { ru: 'Подключение Shikimori', en: 'Connect Shikimori', uk: 'Підключення Shikimori' },
            shikimori_auth_scan: { ru: 'Отсканируйте код телефоном и подтвердите вход', en: 'Scan with your phone and confirm', uk: 'Відскануйте код телефоном' },
            shikimori_auth_then_code: { ru: 'Затем нажмите «Назад» — попросим ввести код с сайта', en: 'Then press Back and enter the code', uk: 'Потім натисніть «Назад»' },
            shikimori_auth_code: { ru: 'Код с сайта Shikimori', en: 'Code from Shikimori', uk: 'Код із сайту Shikimori' },
            shikimori_auth_checking: { ru: 'Проверяем код…', en: 'Checking…', uk: 'Перевіряємо код…' },
            shikimori_auth_ok: { ru: 'Подключено:', en: 'Connected:', uk: 'Підключено:' },
            shikimori_auth_fail: { ru: 'Не получилось подключить', en: 'Connection failed', uk: 'Не вдалося підключити' },
            shikimori_auth_need_keys: { ru: 'Аккаунт Shikimori не подключён', en: 'Shikimori account not connected', uk: 'Обліковий запис не підключено' },
            shikimori_auth_howto: { ru: 'Как подключить аккаунт', en: 'How to connect', uk: 'Як підключити' },
            shikimori_auth_apps: { ru: 'Создайте приложение на телефоне', en: 'Create an application on your phone', uk: 'Створіть застосунок на телефоні' },
            shikimori_auth_apps_hint: { ru: 'Redirect URI: urn:ietf:wg:oauth:2.0:oob, права user_rates. Затем переустановите плагин по адресу с ?cid=…&cs=… — ключи подхватятся сами', en: 'Then reinstall the plugin with ?cid=...&cs=... in the URL', uk: 'Потім перевстановіть плагін з ?cid=…&cs=…' },
            shikimori_auth_connected: { ru: 'Аккаунт подключён', en: 'Account connected', uk: 'Обліковий запис підключено' },
            shikimori_auth_logout: { ru: 'Отключить аккаунт', en: 'Disconnect', uk: 'Відключити' },
            shikimori_auth_logged_out: { ru: 'Аккаунт отключён', en: 'Disconnected', uk: 'Відключено' },
            shikimori_sync_done: { ru: 'Отправлено в Shikimori', en: 'Pushed to Shikimori', uk: 'Надіслано в Shikimori' },
            shikimori_settings_studios: { ru: 'Студии озвучки', en: 'Dub studios', uk: 'Студії озвучення' },
            shikimori_settings_studios_descr: { ru: 'Считать серию вышедшей только когда её озвучили выбранные студии. Не выбрано — засчитывается любая озвучка', en: 'Count an episode as out only when your studios dubbed it', uk: 'Зараховувати серію лише від обраних студій' },
            shikimori_studios_any: { ru: 'Любая озвучка', en: 'Any studio', uk: 'Будь-яка озвучка' },
            shikimori_studios_loading: { ru: 'Собираем список студий…', en: 'Collecting studios…', uk: 'Збираємо список студій…' },
            shikimori_settings_kodik_host: { ru: 'Адрес Kodik API', en: 'Kodik API host', uk: 'Адреса Kodik API' },
            shikimori_settings_kodik_host_descr: { ru: 'По умолчанию kodik-api.com. Менять, если домен снова переедет', en: 'Defaults to kodik-api.com. Change if the domain moves again', uk: 'За замовчуванням kodik-api.com' },
            shikimori_settings_kodik_token: { ru: 'Токен Kodik', en: 'Kodik token', uk: 'Токен Kodik' },
            shikimori_settings_kodik_token_descr: { ru: 'Свой токен, если встроенные перестали работать. Пустое поле — используются встроенные', en: 'Your own token if the built-in ones stop working', uk: 'Власний токен, якщо вбудовані перестали працювати' },
            shikimori_settings_proxy: { ru: 'CORS-прокси (опционально)', en: 'CORS proxy (optional)', uk: 'CORS-проксі (опціонально)' },
            shikimori_settings_proxy_descr: { ru: 'Например: https://mycorsproxy.example/ — подставляется перед адресом Shikimori, если прямой доступ заблокирован', en: 'Prefix before Shikimori URL if direct access is blocked', uk: 'Префікс перед адресою Shikimori' },
            shikimori_settings_clear_cache: { ru: 'Очистить кэш', en: 'Clear cache', uk: 'Очистити кеш' },
            shikimori_settings_clear_cache_descr: { ru: 'Сбросить кэш соответствий TMDB, календаря и списков', en: 'Reset TMDB matching, calendar and lists cache', uk: 'Скинути кеш' },
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

        Lampa.Template.add('shikimori_style',
            '<style>' +
            /* Шкала отступов, из неё выведено всё остальное:
               s1 0.3em · s2 0.6em · s3 1em · s4 1.5em · s5 2.25em · s6 3.4em
               Значения вне шкалы допустимы только как производные:
               0.9em = s2+s1 (бейдж над полосой прогресса) */

            // Сетка каталога. space-between раздавал остаток ширины между
            // карточками, поэтому в каждом ряду зазоры были разные, а последний
            // неполный ряд растягивался во всю ширину. Фиксированный шаг ровно
            // такой же, как в горизонтальных строках
            '.shikimori-catalog{-webkit-box-pack:start!important;-webkit-justify-content:flex-start!important;-ms-flex-pack:start!important;justify-content:flex-start!important}' +
            '.shikimori-catalog>.card{margin-right:1em;margin-bottom:1.5em}' +
            // Ширина считается от контейнера, иначе справа оставалась пустая
            // полоса: фиксированная карточка не знает, сколько её соседей влезло
            '.shikimori-catalog>.card{width:-webkit-calc((100% - 5em) / 6);width:calc((100% - 5em) / 6)}' +
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
            // окно подключения аккаунта
            '.shikimori-auth{text-align:center;padding:1em 0}' +
            '.shikimori-auth__text{font-size:1.1em;margin:0.6em 0;opacity:0.9}' +
            '.shikimori-auth__qr{display:inline-block;background:#fff;padding:0.8em;border-radius:0.5em;margin:0.8em 0}' +
            '.shikimori-auth__qr img,.shikimori-auth__qr canvas,.shikimori-auth__qr svg{display:block;width:14em;height:14em}' +
            '.shikimori-auth__url{font-size:0.8em;opacity:0.55;word-break:break-all;margin:0.6em 2em}' +
            // Размерные тиры. Медиазапросы про телевизор ничего не знают,
            // поэтому класс ставится из JS по ширине экрана в em
            '.shiki-tier--phone .shikimori-catalog>.card,.shiki-tier--phone .items-line .card{margin-right:1em}' +
            '.shiki-tier--tv .shikimori-action{height:3.4em;padding:0 1.5em}' +
            // На телефоне четыре бейджа на постере в 135px — это шум.
            // Оставляем только самый важный и полосу прогресса
            '.shiki-tier--phone .shikimori-card .card__vote,.shiki-tier--phone .shikimori-card .card__marker{display:none}' +
            '.shiki-tier--phone .shikimori-year{font-size:0.95em}' +
            '.shiki-tier--phone .shikimori-progress{height:0.4em}' +
            // счётчик новых серий на пункте меню
            '.menu__item .shikimori-badge{margin-left:auto;background:#5DBFF5;color:#06283A;font-size:0.8em;font-weight:700;min-width:1.7em;height:1.7em;line-height:1.7em;text-align:center;border-radius:1em;padding:0 0.4em;-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0}' +
            // неделя в шапке календаря
            '.shikimori-week{width:100%;-webkit-flex-basis:100%;-ms-flex-preferred-size:100%;flex-basis:100%;display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;margin:0 0 1.5em 0}' +
            '.shikimori-week__day{-webkit-box-flex:1;-webkit-flex:1 1 0;-ms-flex:1 1 0;flex:1 1 0;text-align:center;padding:0.6em 0.3em;margin-right:0.6em;border-radius:0.3em;background:rgba(255,255,255,0.08)}' +
            '.shikimori-week__day:last-child{margin-right:0}' +
            '.shikimori-week__day--today{background:rgba(255,255,255,0.18)}' +
            '.shikimori-week__day--empty{opacity:0.4}' +
            '.shikimori-week__name{font-size:0.9em;opacity:0.7;text-transform:uppercase}' +
            '.shikimori-week__date{font-size:1.3em;line-height:1.3}' +
            '.shikimori-week__count{font-size:1.1em;font-weight:700;color:#5DBFF5}' +
            '.shikimori-week__day--empty .shikimori-week__count{color:inherit;font-weight:400}' +
            // заголовок дня в календаре — разрывает flex-строку
            '.shikimori-day{width:100%;-webkit-flex-basis:100%;-ms-flex-preferred-size:100%;flex-basis:100%;font-size:1.4em;margin:0.6em 0 0.6em 0;opacity:0.75}' +
            // строка кнопок вместо ряда «Меню»
            '.items-line--type-actions .items-line__title{display:none}' +
            '.items-line--type-actions .items-line__head{display:none}' +
            '.items-line--type-actions .items-line__body{margin:0}' +
            '.items-line--type-actions{padding-top:0;padding-bottom:0}' +
            // Lampa вешает на элементы строки отступ с обеих сторон, поэтому зазор
            // между кнопками выходил вдвое больше, чем между карточками. Левый снимаем,
            // правый считаем от собственного кегля кнопки (1.3em): 0.8em ≈ 1em обычного текста
            '.shikimori-action{margin-left:0;margin-right:0.8em;padding:0 1.2em;height:3.4em;display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;-webkit-box-sizing:border-box;box-sizing:border-box;-webkit-border-radius:0.3em;border-radius:0.3em}' +
            '.shikimori-action__icon{display:block;width:1.4em;height:1.4em;margin-right:0.6em;-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0}' +
            '.shikimori-action__icon svg{display:block;width:100%;height:100%}' +
            '.shikimori-action__title{white-space:nowrap;background:none!important;padding:0!important}' +
            // Вид по умолчанию — ровно штатная карточка Lampa: размеры не трогаем,
            // чтобы строки плагина и строки приложения совпадали.
            // .card__promo — элемент самого плагина, он нужен только крупным постерам
            '.shikimori-card--native .card__promo{display:none}' +
            // Углы постера — четыре независимых слота: они не могут пересечься.
            // Штатный «+N» растянут во всю ширину по низу и налезает на маркер с рейтингом
            '.shikimori-card .card__new-episode{left:auto;right:0.6em;bottom:auto;top:0.6em;text-align:right}' +
            // Левый верх — стопка: год сверху, тип под ним. Год есть почти всегда,
            // тип редко, поэтому громкая белая плашка Lampa достаётся именно типу,
            // а год держится тише — тёмный чип, как у оценки и маркера
            '.shikimori-year{position:absolute;left:0.6em;top:0.6em;z-index:1;font-size:0.8em;line-height:1.2;padding:0.3em 0.55em;background:rgba(0,0,0,0.78);color:rgba(255,255,255,0.92);-webkit-border-radius:0.3em;border-radius:0.3em;border:0.08em solid rgba(255,255,255,0.18)}' +
            '.shikimori-card .card__type{left:0.6em;top:2.95em;right:auto;font-size:0.8em;padding:0.3em 0.55em;-webkit-border-radius:0.3em;border-radius:0.3em}' +
            '.shikimori-card--noyear .card__type{top:0.6em}' +
            // Строка года под названием больше не нужна — год на постере
            '.shikimori-card .card__age{display:none}' +
            // #57F570 — штатный цвет Lampa, но на постере он кислотный.
            // Берём её же палитру маркеров: голубой «смотрю»
            '.shikimori-card .card__new-episode>div{background-color:#5DBFF5;color:#06283A;padding:0.35em 0.7em;font-size:0.9em}' +
            '.shikimori-card .card__vote{right:0.6em;bottom:0.6em}' +
            '.shikimori-card .card__marker{left:0.6em;bottom:0.6em;padding-right:0.7em}' +
            // Точка перед текстом — индикатор категории закладок Lampa;
            // у нас там прогресс и студия, категории нет
            '.shikimori-card .card__marker:before{display:none}' +
            // Штатный маркер обрезает текст на 5em, а «1175 серия · Amazing Dubbing» длиннее
            '.shikimori-card .card__marker>span{max-width:11em}' +
            // Блок заголовка ровно в две строки — фиксированной высоты, а не по
            // содержимому. Иначе год у соседних карточек стоит на разной высоте
            // и строка выглядит несобранной. Выровненность и «год вплотную»
            // несовместимы при разной длине названий: выбран первый вариант,
            // цена — одна пустая строка у коротких названий. Три строки, как в
            // Lampa, брать нельзя — там цена уже две пустые
            '.shikimori-card .card__title{-webkit-line-clamp:2;line-clamp:2;height:2.4em}' +
            // Подсказка, что строка прокручивается. Штатную «выглядывающую»
            // карточку сделать нельзя: сколько карточек рисовать, Lampa решает
            // сама, а InteractionMain пробрасывает в строку фиксированный набор
            // параметров без нужного рычага. Затемнение у края даёт тот же сигнал
            // и не трогает геометрию
            '.items-line--type-shiki .items-line__body{position:relative}' +
            // Затемнение включается только когда строка правда прокручивается,
            // и заметно мягче: раньше оно висело на каждой строке, включая короткие
            '.items-line--type-shiki.shikimori-scrollable .items-line__body:after{content:"";position:absolute;top:0;bottom:0;right:0;width:1.5em;pointer-events:none;background:-webkit-linear-gradient(left,rgba(0,0,0,0),rgba(0,0,0,0.28));background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,0.28))}' +
            // Прогресс просмотра
            // Дорожка светлая: тёмная на тёмном постере не читалась, и заполнение
            // выглядело случайной полоской в углу, а не прогрессом
            '.shikimori-progress{position:absolute;left:0.6em;right:0.6em;bottom:0.6em;height:0.4em;background:rgba(255,255,255,0.25);-webkit-border-radius:0.4em;border-radius:0.4em;overflow:hidden;z-index:2}' +
            '.shikimori-progress i{display:block;height:100%;width:0;background:#5DBFF5}' +
            '.shikimori-card--progress .card__vote,.shikimori-card--progress .card__marker{bottom:1.4em}' +
            '.shikimori-card--compact{width:9.5em}' +
            '.shikimori-card--compact .card__title{font-size:1.05em;-webkit-line-clamp:1;line-clamp:1;max-height:1.4em;min-height:1.4em}' +
            '.shikimori-card--compact .card__age{display:none}' +
            '.shikimori-card--compact .card__promo{display:none}' +
            '.shikimori-card--compact .card__vote{font-size:1em}' +
            '.shikimori-card--compact .card__marker>span{font-size:0.7em}' +
            '.shikimori-card--poster{width:15em}' +
            '.shikimori-card--poster .card__title,.shikimori-card--poster .card__age{display:none}' +
            '.shikimori-card--poster .card__view{margin-bottom:0}' +
            '.shikimori-card--poster .card__promo{padding:2em 0.8em 0.8em 0.8em}' +
            '.shikimori-card--poster .card__promo-title{font-size:1.2em}' +
            '.shikimori-card--poster .card__marker{bottom:auto;top:0.6em;left:0.6em}' +
            // рейтинг Shikimori и строка следующей серии в полной карточке
            '.shikimori-rate{background:rgba(255,255,255,0.12)}' +
            '.shikimori-next{margin-left:0.5em;color:#5DBFF5}' +
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
        if (!(item.fresh > 0) && !item.airing) return false;
        if (item.at < Date.now() - KODIK_FRESH_DAYS * 86400000) return false;
        return !(item.kodik && Hidden.has(item.kodik.sid));
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

    // Фоновый пересчёт: экран плагина мог и не открываться
    function refreshMenuBadge() {
        if (!Kodik.enabled()) return;
        UserData.rates(background_net, function (rates) {
            UserData.tracked(background_net, rates, updateMenuBadge);
        }, function () {
            UserData.tracked(background_net, null, updateMenuBadge);
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

        if (params.cid && !storString('shikimori_client_id', '')) storSet('shikimori_client_id', params.cid);
        if (params.cs && !storString('shikimori_client_secret', '')) storSet('shikimori_client_secret', params.cs);
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

        setupLang();
        setupTemplates();
        setupSettings();
        setupFullCardEnrichment();

        Lampa.Component.add(PLUGIN + '_main', MainComponent);
        Lampa.Component.add(PLUGIN + '_catalog', CatalogComponent);

        watchTier();

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
