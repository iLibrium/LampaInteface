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
    var VERSION = '1.0.0';

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
    var KODIK_LOOKUP_MAX = 8;                 // точечных запросов за обновление — не больше
    var KODIK_FRESH_DAYS = 14;                // «новой» серия считается столько дней
    var REVERSE_MAX = 40;                     // обратных запросов TMDB->MAL за обновление
    var REVERSE_PARALLEL = 4;                 // и сколько из них одновременно
    var FAVORITES_WAIT = 2500;                // ждём синхронизацию закладок аккаунта, мс

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
            xhr.send(body ? JSON.stringify(body) : null);
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
                self.request(net, '/search', '&shikimori_id=' + sid + '&with_material_data=true', function (json) {
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

                var voice = !row.translation || row.translation.type != 'subtitles';
                var key = 's' + sid;
                var prev = map[key];
                if (prev && !(ep > prev.ep || (ep == prev.ep && voice && !prev.voice))) continue;

                map[key] = {
                    sid: sid,
                    ep: ep,
                    voice: voice,
                    studio: (row.translation && row.translation.title) || '',
                    at: parseISO(row.updated_at),
                    aired: (row.material_data && parseInt(row.material_data.episodes_aired, 10)) || 0
                };
            }
            return map;
        },

        // Постоянное хранилище: что мы уже знали про каждый тайтл.
        // base — сколько серий было при первой встрече; для закладок без списка
        // Shikimori только по нему и можно понять, что серия именно новая.
        store: function () {
            var store = storGet('shikimori_kodik_eps', {});
            return store && typeof store == 'object' ? store : {};
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
            return store;
        },

        dropCache: function () {
            this.feed_cache = null;
            this.feed_time = 0;
        }
    };

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
        // До какой серии досмотрено. null — отметок нет
        lastWatched: function (card, max_ep) {
            var name = card.original_name || card.original_title || '';
            if (!name) return null;

            var episode = 0;
            var season = 1;

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
                }
            }
            catch (e) {}

            // 3. Timeline.watched обходит только серии 1..24 первого сезона.
            // Если серий заведомо больше — досматриваем хвост точечно
            if (max_ep > 24) {
                try {
                    for (var ep = max_ep; ep > episode && ep > 24; ep--) {
                        var view = Lampa.Timeline.watchedEpisode(card, season, ep, true);
                        if (view && view.percent) { episode = ep; break; }
                    }
                }
                catch (e) {}
            }

            return episode ? { episode: episode, season: season } : null;
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
                        mals[rate.target_id] = { status: rate.status, episodes: rate.episodes || 0, score: rate.score || 0 };
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

            this.favorites(function (list) {
                favorites = list;

                if (!Kodik.enabled()) return reverse({});

                Kodik.feed(net, function (rows) {
                    lookup(Kodik.mergeRows(rows));
                }, function () {
                    lookup({});
                });
            });

            // Точечно добираем онгоинги из «Я смотрю», которых не было в суточной ленте
            function lookup(fresh) {
                var store = Kodik.store();
                var unknown = [];
                for (var i = 0; i < watching.length; i++) {
                    var sid = parseInt(watching[i].malId || watching[i].id, 10);
                    if (!sid || watching[i].status != 'ongoing') continue;
                    if (!fresh['s' + sid] && !store['s' + sid]) unknown.push(sid);
                }
                if (!unknown.length) return reverse(Kodik.remember(fresh));
                Kodik.lookup(net, unknown, function (found) {
                    for (var key in found) fresh[key] = found[key];
                    reverse(Kodik.remember(fresh));
                });
            }

            // Закладки -> id Shikimori: в TMDB один сериал на все сезоны,
            // а в Shikimori каждый сезон — отдельный тайтл
            function reverse(known) {
                if (!favorites.length) return finish(known, {});
                var ids = [];
                for (var i = 0; i < favorites.length; i++) ids.push(favorites[i].id);
                Match.reverse(net, ids, function (map) {
                    finish(known, map);
                });
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

                    var total = best ? best.info.ep : 0;
                    var mark = Progress.lastWatched(card, total);
                    var watched = mark ? mark.episode : 0;
                    var fresh = 0;

                    if (best) {
                        // Точный счёт возможен, только когда нумерация сезона Lampa
                        // совпадает с нумерацией Shikimori. Иначе — от базы первой встречи
                        var aligned = !best.season || !mark || mark.season == best.season;
                        fresh = (watched && aligned) ? total - watched : total - (best.info.base || total);
                    }

                    items.push({
                        card: card,
                        tmdb: { id: card.id, method: card.name || card.original_name ? 'tv' : 'movie' },
                        groups: card._fav_groups || {},
                        kodik: best ? best.info : null,
                        total: total,
                        watched: watched,
                        fresh: fresh > 0 ? fresh : 0,
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
                    var have = info ? info.ep : (anime.episodesAired || 0);

                    // Списки Shikimori кормят «Новые серии», но в строки закладок
                    // не попадают: там строго то, что лежит в избранном Lampa
                    items.push({
                        card: anime,
                        tmdb: null,
                        groups: {},
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

            this.card.querySelector('.card__title').innerText = title;
            this.card.querySelector('.card__age').innerText = year || '';
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
                });
            }

            // 2. Календарь (списки + закладки)
            UserData.upcoming(net, function (upcoming) {
                var mine = [];
                for (var i = 0; i < upcoming.length; i++) {
                    if (upcoming[i].my) mine.push(upcoming[i]);
                }
                lines.upcoming = mine;
                join();
            }, function () {
                join();
            });

            // 3. «Сейчас смотрят в Lampa» (CUB), фолбэк TMDB
            this.loadPopular(function (cards, from_cub) {
                lines.popular = cards;
                lines.popular_cub = from_cub;
                join();
            });

            // 4. Ленты Shikimori одним запросом
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
                { action: 'settings', icon: ICON_USER, title: nick ? nick : Lampa.Lang.translate('shikimori_action_set_user') }
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

            // Новые серии — доступны с озвучкой, не просмотрены и появились недавно
            var fresh_after = Date.now() - KODIK_FRESH_DAYS * 86400000;
            var fresh = [];
            for (i = 0; i < tracked.length; i++) {
                if (tracked[i].fresh > 0 && tracked[i].at >= fresh_after) fresh.push(tracked[i]);
            }
            fresh.sort(function (a, b) { return b.at - a.at; });

            if (fresh.length) {
                var fresh_cards = [];
                for (i = 0; i < Math.min(fresh.length, 30); i++) fresh_cards.push(UserData.decorate(fresh[i]));
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_fresh'),
                    results: fresh_cards,
                    shiki: true,
                    noimage: true,
                    nomore: true,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Я смотрю — ровно категория «Смотрю» из избранного Lampa (`look`).
            // Сверху то, где есть новые серии, дальше — по свежести
            var watching = favoriteRow(tracked, 'look');

            if (watching.length) {
                var watching_cards = [];
                for (i = 0; i < watching.length; i++) watching_cards.push(UserData.decorate(watching[i]));
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_watching'),
                    results: watching_cards,
                    shiki: true,
                    noimage: true,
                    onMore: nick ? function () { openCatalog({ mode: 'mylist' }); } : null,
                    nomore: !nick,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Скоро выйдут
            if (lines.upcoming && lines.upcoming.length) {
                var upcoming_cards = [];
                for (i = 0; i < lines.upcoming.length; i++) {
                    upcoming_cards.push(upcomingToCard(lines.upcoming[i]));
                }
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_upcoming'),
                    results: upcoming_cards,
                    shiki: true,
                    noimage: true,
                    onMore: function () { openCatalog({ mode: 'calendar' }); },
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
                    noimage: true,
                    nomore: true,
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            this.build(data);
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
                };
            }
        };

        comp.onDestroy = function () {
            net.clear();
        };

        return comp;
    }

    // Одна категория избранного Lampa -> строка. Сверху то, где есть новые
    // серии, дальше по свежести, начатое выше нетронутого
    function favoriteRow(tracked, group) {
        var picked = [];
        for (var i = 0; i < tracked.length; i++) {
            if (tracked[i].groups && tracked[i].groups[group]) picked.push(tracked[i]);
        }
        picked.sort(function (a, b) {
            if ((b.fresh > 0 ? 1 : 0) != (a.fresh > 0 ? 1 : 0)) return (b.fresh > 0 ? 1 : 0) - (a.fresh > 0 ? 1 : 0);
            if (b.at != a.at) return b.at - a.at;
            return (b.watched > 0 ? 1 : 0) - (a.watched > 0 ? 1 : 0);
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
            shikimori_settings_user_descr: { ru: 'Списки профиля должны быть открытыми (настройки приватности Shikimori)', en: 'Profile lists must be public', uk: 'Списки профілю мають бути відкритими' },
            shikimori_settings_style: { ru: 'Вид карточек', en: 'Card style', uk: 'Вигляд карток' },
            shikimori_settings_style_descr: { ru: 'Плотность сетки и оформление постеров', en: 'Grid density and poster look', uk: 'Щільність сітки та оформлення' },
            shikimori_style_native: { ru: 'Как в Lampa', en: 'Lampa native', uk: 'Як у Lampa' },
            shikimori_style_compact: { ru: 'Компактный', en: 'Compact', uk: 'Компактний' },
            shikimori_style_poster: { ru: 'Крупные постеры', en: 'Large posters', uk: 'Великі постери' },
            shikimori_settings_uncensored: { ru: 'Показывать 18+', en: 'Show 18+', uk: 'Показувати 18+' },
            shikimori_settings_uncensored_descr: { ru: 'Отключает фильтр цензуры Shikimori', en: 'Disables Shikimori censorship filter', uk: 'Вимикає фільтр цензури Shikimori' },
            shikimori_subtitles: { ru: 'субтитры', en: 'subtitles', uk: 'субтитри' },
            shikimori_settings_kodik: { ru: 'Строка «Новые серии»', en: 'New episodes row', uk: 'Рядок «Нові серії»' },
            shikimori_settings_kodik_descr: { ru: 'Серии, которые уже вышли с озвучкой (данные Kodik). Выключено — останутся только даты эфира в Японии', en: 'Episodes already released with a dub (Kodik). Off — Japanese air dates only', uk: 'Серії, що вже вийшли з озвучкою (Kodik)' },
            shikimori_settings_kodik_subs: { ru: 'Засчитывать субтитры', en: 'Count subtitles', uk: 'Зараховувати субтитри' },
            shikimori_settings_kodik_subs_descr: { ru: 'Показывать серию новой, если вышла только с субтитрами, без озвучки', en: 'Treat subtitle-only releases as new episodes', uk: 'Показувати серію новою, якщо вийшла лише із субтитрами' },
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
            // сетка каталога
            '.shikimori-catalog{-webkit-box-pack:justify!important;-webkit-justify-content:space-between!important;-ms-flex-pack:justify!important;justify-content:space-between!important}' +
            // заголовок дня в календаре — разрывает flex-строку
            '.shikimori-day{width:100%;-webkit-flex-basis:100%;-ms-flex-preferred-size:100%;flex-basis:100%;font-size:1.4em;margin:0.6em 0 0.8em 0;opacity:0.75}' +
            // строка кнопок вместо ряда «Меню»
            '.items-line--type-actions .items-line__title{display:none}' +
            '.items-line--type-actions .items-line__head{display:none}' +
            '.items-line--type-actions .items-line__body{margin:0}' +
            '.items-line--type-actions{padding-top:0;padding-bottom:0}' +
            '.shikimori-action{margin-right:1em;display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center}' +
            '.shikimori-action__icon{display:block;width:1.4em;height:1.4em;margin-right:0.7em;-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0}' +
            '.shikimori-action__icon svg{display:block;width:100%;height:100%}' +
            '.shikimori-action__title{white-space:nowrap;background:none!important;padding:0!important}' +
            // Вид по умолчанию — ровно штатная карточка Lampa: размеры не трогаем,
            // чтобы строки плагина и строки приложения совпадали.
            // .card__promo — элемент самого плагина, он нужен только крупным постерам
            '.shikimori-card--native .card__promo{display:none}' +
            // Углы постера — четыре независимых слота: они не могут пересечься.
            // Штатный «+N» растянут во всю ширину по низу и налезает на маркер с рейтингом
            '.shikimori-card .card__new-episode{left:auto;right:0.4em;bottom:auto;top:0.5em;text-align:right}' +
            // Заголовок в две строки вместо трёх. Резервировать место под три
            // нельзя: у коротких названий год отъезжает от заголовка на две
            // пустые строки — особенно заметно на телефоне, где переносов больше.
            // Две строки и без резерва: год всегда вплотную, а разброс высоты
            // падает с трёх строк до одной
            '.shikimori-card .card__title{-webkit-line-clamp:2;line-clamp:2;max-height:2.4em}' +
            // Год резервирует только свою строку — это не отрывает его от названия,
            // но выравнивает карточки, у которых года нет
            '.shikimori-card .card__age{min-height:1.2em}' +
            // Прогресс просмотра
            '.shikimori-progress{position:absolute;left:0;right:0;bottom:0;height:0.35em;background:rgba(0,0,0,0.55);border-radius:0 0 1em 1em;overflow:hidden;z-index:1}' +
            '.shikimori-progress i{display:block;height:100%;width:0;background:#57F570}' +
            '.shikimori-card--progress .card__vote,.shikimori-card--progress .card__marker{bottom:0.75em}' +
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
            '.shikimori-card--poster .card__marker{bottom:auto;top:0.4em;left:0.4em}' +
            // рейтинг Shikimori и строка следующей серии в полной карточке
            '.shikimori-rate{background:rgba(255,255,255,0.12)}' +
            '.shikimori-next{margin-left:0.5em;color:#57F570}' +
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
    }

    function startPlugin() {
        Lampa.Manifest.plugins = manifest;

        setupLang();
        setupTemplates();
        setupSettings();
        setupFullCardEnrichment();

        Lampa.Component.add(PLUGIN + '_main', MainComponent);
        Lampa.Component.add(PLUGIN + '_catalog', CatalogComponent);

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
