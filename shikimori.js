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
            var proxy = storGet('shikimori_proxy', '');
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
            if (!storGet('shikimori_uncensored', false)) args.push('censored: true');
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

        // Все нужные списки пользователя одним запросом
        userRates: function (net, user_id, ok, err) {
            var fields = 'id status episodes score anime { ' + this.animeFields() + ' }';
            var statuses = ['watching', 'rewatching', 'planned', 'on_hold', 'completed'];
            var parts = [];
            for (var i = 0; i < statuses.length; i++) {
                var st = statuses[i];
                parts.push(st + ': userRates(userId: ' + parseInt(user_id, 10) + ', targetType: Anime, status: ' + st +
                    ', limit: 50, page: 1, order: { field: updated_at, order: desc }) { ' + fields + ' }');
            }
            this.graphql(net, '{ ' + parts.join(' ') + ' }', ok, err);
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
            var url = Lampa.TMDB.api('find/' + ext + '?external_source=' + src + '&api_key=' + Lampa.TMDB.key() + '&language=' + storGet('language', 'ru'));
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
                    '&api_key=' + Lampa.TMDB.key() + '&language=' + storGet('language', 'ru'));
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
                var url = Lampa.TMDB.api(found.method + '/' + found.id + '?api_key=' + Lampa.TMDB.key() + '&language=' + storGet('language', 'ru'));
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

        // Все списки пользователя (кэш 10 минут)
        rates: function (net, ok, err) {
            var nick = storGet('shikimori_user', '');
            if (!nick) return err('no_user');
            var self = this;
            if (this.rates_cache && Date.now() - this.rates_time < RATES_TTL) return ok(this.rates_cache);

            Shiki.userId(net, nick, function (user_id) {
                Shiki.userRates(net, user_id, function (data) {
                    var result = { watching: [], planned: [], other: [] };
                    var statuses = ['watching', 'rewatching', 'planned', 'on_hold', 'completed'];
                    for (var i = 0; i < statuses.length; i++) {
                        var list = data[statuses[i]] || [];
                        for (var j = 0; j < list.length; j++) {
                            var rate = list[j];
                            if (!rate || !rate.anime) continue;
                            var item = rate.anime;
                            item._rate_status = rate.status || statuses[i];
                            item._rate_episodes = rate.episodes || 0;
                            item._rate_score = rate.score || 0;
                            if (statuses[i] == 'watching' || statuses[i] == 'rewatching') result.watching.push(item);
                            else if (statuses[i] == 'planned') result.planned.push(item);
                            else result.other.push(item);
                        }
                    }
                    self.rates_cache = result;
                    self.rates_time = Date.now();
                    ok(result);
                }, err);
            }, err);
        },

        dropRatesCache: function () {
            this.rates_cache = null;
            this.rates_time = 0;
        },

        // Карточки закладок Lampa/CUB, похожие на аниме
        lampaFavorites: function () {
            var cards = [];
            var seen = {};
            var groups = ['wath', 'book', 'like', 'look', 'scheduled', 'continued', 'viewed'];
            for (var i = 0; i < groups.length; i++) {
                var list = [];
                try { list = Lampa.Favorite.get({ type: groups[i] }) || []; } catch (e) {}
                for (var j = 0; j < list.length; j++) {
                    var card = list[j];
                    if (!card || !card.id || seen['f' + card.id]) continue;
                    seen['f' + card.id] = true;
                    var animation = (card.genre_ids || []).indexOf(16) >= 0;
                    var jp = card.original_language == 'ja' || (card.origin_country || []).indexOf('JP') >= 0;
                    if (animation && jp) cards.push(card);
                }
            }
            return cards;
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
                    if (rates) {
                        var all = rates.watching.concat(rates.planned).concat(rates.other);
                        for (var i = 0; i < all.length; i++) {
                            my_mals['m' + (all[i].malId || all[i].id)] = all[i];
                        }
                    }

                    var favorites = self.lampaFavorites();
                    var fav_tmdb = {};
                    for (i = 0; i < favorites.length; i++) fav_tmdb['t' + favorites[i].id] = favorites[i];

                    // Батч-маппинг всех календарных тайтлов (нужен для пересечения с закладками)
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
                            entry.rate = mine || null;
                            entry.fav_card = fav || null;
                            result.push(entry);
                        }
                        ok(result);
                    });
                }
            }, err);
        }
    };

    /* ============================================================
     * Карточки
     * ============================================================ */

    // Карточка аниме Shikimori (постер + бейджи)
    function ShikiCard(data) {
        var self = this;

        this.build = function () {
            var poster = Shiki.posterUrl(data);
            var title = data.russian || data.name || '';
            var score = data.score && parseFloat(data.score) ? parseFloat(data.score).toFixed(1) : '';

            this.card = Lampa.Template.js('shikimori_card');
            this.card.querySelector('.shikimori-card__title').innerText = title;

            var img = this.card.querySelector('.card__img');
            var fav_img = data._fav_img || '';
            img.onerror = function () {
                if (fav_img && img.src.indexOf(fav_img) == -1) img.src = fav_img;
                else img.src = './img/img_broken.svg';
            };
            img.src = poster;

            var vote = this.card.querySelector('.shikimori-card__vote');
            if (score) vote.innerText = score;
            else vote.classList.add('hide');

            var kind = this.card.querySelector('.shikimori-card__type');
            var kind_text = Lampa.Lang.translate('shikimori_kind_' + data.kind);
            if (data.kind && kind_text.indexOf('shikimori_kind') == -1) kind.innerText = kind_text;
            else kind.classList.add('hide');

            var status = this.card.querySelector('.shikimori-card__status');
            if (data.status == 'ongoing') status.innerText = Lampa.Lang.translate('shikimori_status_ongoing');
            else if (data.status == 'anons') status.innerText = Lampa.Lang.translate('shikimori_status_anons');
            else status.classList.add('hide');

            // Бейдж «+N новых серий»
            var fresh = this.card.querySelector('.shikimori-card__new');
            var unwatched = 0;
            if (typeof data._rate_episodes == 'number' && data.episodesAired) {
                unwatched = data.episodesAired - data._rate_episodes;
            }
            if (unwatched > 0) fresh.innerText = '+' + unwatched;
            else fresh.classList.add('hide');

            // Бейдж даты выхода серии
            var date = this.card.querySelector('.shikimori-card__date');
            if (data._next_at) {
                date.innerText = formatDate(data._next_at) + (data._next_episode ? ' · ' + data._next_episode + ' ' + Lampa.Lang.translate('shikimori_ep') : '');
            }
            else date.classList.add('hide');
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

    // Карточка-действие (кнопка в строке «Меню»)
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
            var join = makeJoin(4, function () {
                self.buildLines(lines);
            });

            // 1. Списки пользователя
            UserData.rates(net, function (rates) {
                lines.watching = rates.watching;
                join();
            }, function () {
                join();
            });

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
                    '&api_key=' + Lampa.TMDB.key() + '&language=' + storGet('language', 'ru') + '&page=1');
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
            var nick = storGet('shikimori_user', '');

            // Строка-меню
            var actions = [
                { action: 'search', icon: ICON_SEARCH, title: Lampa.Lang.translate('shikimori_action_search') },
                { action: 'catalog', icon: ICON_CATALOG, title: Lampa.Lang.translate('shikimori_action_catalog') },
                { action: 'calendar', icon: ICON_CALENDAR, title: Lampa.Lang.translate('shikimori_action_calendar') }
            ];
            if (!nick) actions.push({ action: 'settings', icon: ICON_USER, title: Lampa.Lang.translate('shikimori_action_set_user') });

            data.push({
                title: Lampa.Lang.translate('shikimori_title_menu'),
                results: actions,
                shiki_actions: true,
                nomore: true,
                noimage: true,
                cardClass: function (elem) { return new ActionCard(elem); }
            });

            // Я смотрю
            if (lines.watching && lines.watching.length) {
                var watching = lines.watching.slice(0);
                watching.sort(function (a, b) {
                    var an = (a.episodesAired || 0) - (a._rate_episodes || 0);
                    var bn = (b.episodesAired || 0) - (b._rate_episodes || 0);
                    return (bn > 0 ? 1 : 0) - (an > 0 ? 1 : 0);
                });
                data.push({
                    title: Lampa.Lang.translate('shikimori_title_watching'),
                    results: watching,
                    shiki: true,
                    noimage: true,
                    onMore: function () { openCatalog({ mode: 'mylist' }); },
                    cardClass: function (elem) { return new ShikiCard(elem); }
                });
            }

            // Скоро новые серии
            if (lines.upcoming && lines.upcoming.length) {
                var upcoming_cards = [];
                for (var i = 0; i < lines.upcoming.length; i++) {
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

            // Сейчас смотрят в Lampa (стандартные TMDB-карточки)
            if (lines.popular && lines.popular.length) {
                data.push({
                    title: Lampa.Lang.translate(lines.popular_cub ? 'shikimori_title_popular_cub' : 'shikimori_title_popular_tmdb'),
                    results: lines.popular,
                    nomore: true
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
        var url = Lampa.TMDB.api(found.method + '/' + found.id + '?api_key=' + Lampa.TMDB.key() + '&language=' + storGet('language', 'ru'));
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
            value: storGet('shikimori_user', ''),
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
        var body = null;
        var last = null;
        var waitload = false;
        var has_more = true;

        // Активные фильтры (копия из object, чтобы жить при back)
        object.filters = object.filters || {};

        this.create = function () {
            this.activity.loader(true);
            scroll.minus();

            body = document.createElement('div');
            body.className = 'category-full shikimori-catalog';

            if (object.mode == 'catalog') {
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

            this.load(true);

            if (object.open_search) {
                object.open_search = false;
                setTimeout(function () { self.searchInput(); }, 300);
            }

            return this.render();
        };

        /* ---------- Шапка с фильтрами-чипсами ---------- */

        this.buildHead = function () {
            var wrap = document.createElement('div');
            wrap.className = 'shikimori-head';

            var chips = [
                { key: 'search', title: Lampa.Lang.translate('shikimori_chip_search') },
                { key: 'genre', title: Lampa.Lang.translate('shikimori_chip_genre') },
                { key: 'kind', title: Lampa.Lang.translate('shikimori_chip_kind') },
                { key: 'status', title: Lampa.Lang.translate('shikimori_chip_status') },
                { key: 'season', title: Lampa.Lang.translate('shikimori_chip_season') },
                { key: 'score', title: Lampa.Lang.translate('shikimori_chip_score') },
                { key: 'order', title: Lampa.Lang.translate('shikimori_chip_order') },
                { key: 'reset', title: Lampa.Lang.translate('shikimori_chip_reset') }
            ];

            for (var i = 0; i < chips.length; i++) {
                (function (chip) {
                    var el = document.createElement('div');
                    el.className = 'shikimori-chip selector';
                    el.setAttribute('data-chip', chip.key);
                    el.innerText = chip.title;
                    el.addEventListener('hover:enter', function () {
                        self.onChip(chip.key);
                    });
                    el.addEventListener('hover:focus', function () {
                        last = el;
                        scroll.update(el);
                    });
                    wrap.appendChild(el);
                })(chips[i]);
            }

            return wrap;
        };

        this.updateHead = function () {
            if (!head) return;
            var f = object.filters;
            var labels = {
                search: f.search || '',
                genre: f.genre_titles || '',
                kind: f.kind ? Lampa.Lang.translate('shikimori_kind_' + f.kind) : '',
                status: f.status ? Lampa.Lang.translate('shikimori_status_filter_' + f.status) : '',
                season: f.season ? seasonTitle(f.season) : '',
                score: f.score ? ('≥ ' + f.score) : '',
                order: f.order ? Lampa.Lang.translate('shikimori_order_' + f.order) : ''
            };
            var base = {
                search: Lampa.Lang.translate('shikimori_chip_search'),
                genre: Lampa.Lang.translate('shikimori_chip_genre'),
                kind: Lampa.Lang.translate('shikimori_chip_kind'),
                status: Lampa.Lang.translate('shikimori_chip_status'),
                season: Lampa.Lang.translate('shikimori_chip_season'),
                score: Lampa.Lang.translate('shikimori_chip_score'),
                order: Lampa.Lang.translate('shikimori_chip_order')
            };
            var nodes = head.querySelectorAll('.shikimori-chip');
            for (var i = 0; i < nodes.length; i++) {
                var key = nodes[i].getAttribute('data-chip');
                if (key == 'reset') continue;
                var val = labels[key];
                nodes[i].innerText = val ? base[key] + ': ' + val : base[key];
                if (val) nodes[i].classList.add('shikimori-chip--active');
                else nodes[i].classList.remove('shikimori-chip--active');
            }
        };

        this.onChip = function (key) {
            if (key == 'search') return this.searchInput();
            if (key == 'reset') {
                object.filters = {};
                return this.reload();
            }
            if (key == 'genre') return this.pickGenre();
            if (key == 'kind') return this.pickFrom(FILTER_KINDS, 'kind', function (v) { return Lampa.Lang.translate('shikimori_kind_' + v); });
            if (key == 'status') return this.pickFrom(FILTER_STATUSES, 'status', function (v) { return Lampa.Lang.translate('shikimori_status_filter_' + v); });
            if (key == 'season') return this.pickSeason();
            if (key == 'score') return this.pickFrom(FILTER_SCORES, 'score', function (v) { return Lampa.Lang.translate('shikimori_score_from') + ' ' + v; });
            if (key == 'order') return this.pickFrom(FILTER_ORDERS, 'order', function (v) { return Lampa.Lang.translate('shikimori_order_' + v); });
        };

        this.searchInput = function () {
            Lampa.Input.edit({
                title: Lampa.Lang.translate('shikimori_chip_search'),
                value: object.filters.search || '',
                free: true,
                nosave: true
            }, function (value) {
                object.filters.search = value || '';
                self.reload();
            });
        };

        this.pickFrom = function (values, key, titleFn) {
            var enabled = Lampa.Controller.enabled().name;
            var items_list = [{ title: Lampa.Lang.translate('shikimori_any'), value: '', selected: !object.filters[key] }];
            for (var i = 0; i < values.length; i++) {
                items_list.push({
                    title: titleFn(values[i]),
                    value: values[i],
                    selected: object.filters[key] == values[i]
                });
            }
            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_chip_' + key),
                items: items_list,
                onSelect: function (item) {
                    Lampa.Controller.toggle(enabled);
                    if (item.value) object.filters[key] = item.value;
                    else delete object.filters[key];
                    self.reload();
                },
                onBack: function () {
                    Lampa.Controller.toggle(enabled);
                }
            });
        };

        this.pickSeason = function () {
            var seasons = [];
            for (var i = 0; i > -8; i--) seasons.push(currentSeason(i));
            var next = currentSeason(1);
            seasons.unshift(next);

            var values = [];
            for (i = 0; i < seasons.length; i++) values.push({ v: seasons[i], t: seasonTitle(seasons[i]) });
            var year = new Date().getFullYear();
            for (i = year - 2; i >= 2000; i--) values.push({ v: String(i), t: String(i) });
            values.push({ v: '199x', t: '1990-е' });
            values.push({ v: '198x', t: '1980-е' });

            var enabled = Lampa.Controller.enabled().name;
            var items_list = [{ title: Lampa.Lang.translate('shikimori_any'), value: '', selected: !object.filters.season }];
            for (i = 0; i < values.length; i++) {
                items_list.push({ title: values[i].t, value: values[i].v, selected: object.filters.season == values[i].v });
            }
            Lampa.Select.show({
                title: Lampa.Lang.translate('shikimori_chip_season'),
                items: items_list,
                onSelect: function (item) {
                    Lampa.Controller.toggle(enabled);
                    if (item.value) object.filters.season = item.value;
                    else delete object.filters.season;
                    self.reload();
                },
                onBack: function () {
                    Lampa.Controller.toggle(enabled);
                }
            });
        };

        this.pickGenre = function () {
            var enabled = Lampa.Controller.enabled().name;
            Shiki.genres(net, function (genres) {
                var selected = String(object.filters.genre || '').split(',');
                var items_list = [{ title: Lampa.Lang.translate('shikimori_any'), value: '', selected: !object.filters.genre }];
                for (var i = 0; i < genres.length; i++) {
                    var g = genres[i];
                    items_list.push({
                        title: (selected.indexOf(String(g.id)) >= 0 ? '✓ ' : '') + g.title,
                        value: String(g.id),
                        g_title: g.title
                    });
                }
                Lampa.Select.show({
                    title: Lampa.Lang.translate('shikimori_chip_genre'),
                    items: items_list,
                    onSelect: function (item) {
                        Lampa.Controller.toggle(enabled);
                        if (!item.value) {
                            delete object.filters.genre;
                            delete object.filters.genre_titles;
                            return self.reload();
                        }
                        var current = object.filters.genre ? String(object.filters.genre).split(',') : [];
                        var titles = object.filters.genre_titles ? object.filters.genre_titles.split(', ') : [];
                        var idx = current.indexOf(item.value);
                        if (idx >= 0) {
                            current.splice(idx, 1);
                            titles.splice(idx, 1);
                        }
                        else {
                            current.push(item.value);
                            titles.push(item.g_title);
                        }
                        if (current.length) {
                            object.filters.genre = current.join(',');
                            object.filters.genre_titles = titles.join(', ');
                        }
                        else {
                            delete object.filters.genre;
                            delete object.filters.genre_titles;
                        }
                        self.reload();
                    },
                    onBack: function () {
                        Lampa.Controller.toggle(enabled);
                    }
                });
            }, function () {
                Lampa.Noty.show(Lampa.Lang.translate('shikimori_error_api'));
                Lampa.Controller.toggle(enabled);
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

        this.loadCalendar = function (first) {
            has_more = false;
            UserData.upcoming(net, function (upcoming) {
                var list = [];
                var only_my = [];
                for (var i = 0; i < upcoming.length; i++) {
                    var card = upcomingToCard(upcoming[i]);
                    list.push(card);
                    if (upcoming[i].my) only_my.push(card);
                }
                // Сначала мои, затем все остальные с датами
                var final_list = only_my.length ? only_my.concat([]) : list;
                if (only_my.length && list.length > only_my.length) {
                    for (i = 0; i < list.length; i++) {
                        if (only_my.indexOf(list[i]) == -1) final_list.push(list[i]);
                    }
                }
                self.append(final_list);
                if (first) self.ready(final_list.length);
            }, function () {
                if (first) self.empty();
            });
        };

        this.next = function () {
            if (waitload || !has_more || object.mode != 'catalog') return;
            waitload = true;
            object.page++;
            this.load(false);
        };

        this.reload = function () {
            object.page = 1;
            has_more = true;
            last = null;
            for (var i = 0; i < items.length; i++) items[i].destroy();
            items = [];
            while (body.firstChild) body.removeChild(body.firstChild);
            this.updateHead();
            this.activity.loader(true);
            Shiki.catalog(net, this.requestParams(), function (list) {
                has_more = list.length >= 36;
                self.append(list);
                self.activity.loader(false);
                if (!list.length) Lampa.Noty.show(Lampa.Lang.translate('shikimori_empty'));
                Lampa.Controller.toggle('content');
            }, function () {
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
            shikimori_ep: { ru: 'серия', en: 'ep', uk: 'серія' },
            shikimori_not_found: { ru: 'Не найдено в TMDB', en: 'Not found in TMDB', uk: 'Не знайдено в TMDB' },
            shikimori_pick_title: { ru: 'Выберите тайтл', en: 'Pick a title', uk: 'Оберіть тайтл' },
            shikimori_empty: { ru: 'Ничего не найдено', en: 'Nothing found', uk: 'Нічого не знайдено' },
            shikimori_error_api: { ru: 'Ошибка Shikimori API', en: 'Shikimori API error', uk: 'Помилка Shikimori API' },
            shikimori_any: { ru: 'Любой', en: 'Any', uk: 'Будь-який' },
            shikimori_next_episode: { ru: 'Следующая серия', en: 'Next episode', uk: 'Наступна серія' },

            shikimori_title_menu: { ru: 'Меню', en: 'Menu', uk: 'Меню' },
            shikimori_title_watching: { ru: 'Я смотрю', en: 'Watching', uk: 'Я дивлюсь' },
            shikimori_title_upcoming: { ru: 'Скоро новые серии', en: 'Upcoming episodes', uk: 'Скоро нові серії' },
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
            shikimori_settings_uncensored: { ru: 'Показывать 18+', en: 'Show 18+', uk: 'Показувати 18+' },
            shikimori_settings_uncensored_descr: { ru: 'Отключает фильтр цензуры Shikimori', en: 'Disables Shikimori censorship filter', uk: 'Вимикає фільтр цензури Shikimori' },
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
        Lampa.Template.add('shikimori_card',
            '<div class="card selector layer--visible layer--render shikimori-card">' +
                '<div class="card__view">' +
                    '<img src="./img/img_load.svg" class="card__img" />' +
                    '<div class="shikimori-card__type"></div>' +
                    '<div class="shikimori-card__vote"></div>' +
                    '<div class="shikimori-card__status"></div>' +
                    '<div class="shikimori-card__new"></div>' +
                    '<div class="shikimori-card__date"></div>' +
                '</div>' +
                '<div class="card__title shikimori-card__title"></div>' +
            '</div>');

        Lampa.Template.add('shikimori_action',
            '<div class="selector shikimori-action">' +
                '<div class="shikimori-action__icon"></div>' +
                '<div class="shikimori-action__title"></div>' +
            '</div>');

        Lampa.Template.add('shikimori_style',
            '<style>' +
            '.shikimori-card{position:relative}' +
            '.shikimori-card__type{position:absolute;left:-0.8em;top:0.8em;padding:0.3em 0.5em;background:#ff4242;color:#fff;font-size:0.75em;border-radius:0.3em;-webkit-border-radius:0.3em}' +
            '.shikimori-card__vote{position:absolute;right:0.3em;top:0.6em;padding:0.2em 0.4em;background:rgba(0,0,0,0.6);color:#fff;font-size:0.85em;border-radius:0.3em;-webkit-border-radius:0.3em}' +
            '.shikimori-card__status{position:absolute;left:-0.8em;bottom:2.4em;padding:0.3em 0.5em;background:#ffe216;color:#000;font-size:0.7em;border-radius:0.3em;-webkit-border-radius:0.3em}' +
            '.shikimori-card__new{position:absolute;right:0.3em;bottom:2.4em;padding:0.3em 0.5em;background:#22a51d;color:#fff;font-weight:bold;font-size:0.8em;border-radius:0.3em;-webkit-border-radius:0.3em}' +
            '.shikimori-card__date{position:absolute;left:0;right:0;bottom:0;padding:0.4em 0.5em;background:rgba(0,80,220,0.85);color:#fff;font-size:0.75em;text-align:center;border-radius:0 0 0.3em 0.3em;-webkit-border-radius:0 0 0.3em 0.3em}' +
            '.shikimori-catalog{-webkit-box-pack:justify!important;-webkit-justify-content:space-between!important;-ms-flex-pack:justify!important;justify-content:space-between!important}' +
            '.shikimori-head{display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-flex-wrap:wrap;-ms-flex-wrap:wrap;flex-wrap:wrap;margin:0 1.5em 1em 1.5em}' +
            '.shikimori-chip{padding:0.5em 1em;margin:0 0.6em 0.6em 0;background:rgba(255,255,255,0.08);border-radius:2em;-webkit-border-radius:2em;font-size:1em}' +
            '.shikimori-chip--active{background:rgba(255,255,255,0.2)}' +
            '.shikimori-chip.focus{background:#fff;color:#000}' +
            '.shikimori-action{display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-box-orient:vertical;-webkit-flex-direction:column;-ms-flex-direction:column;flex-direction:column;-webkit-box-align:center;-webkit-align-items:center;-ms-flex-align:center;align-items:center;-webkit-box-pack:center;-webkit-justify-content:center;-ms-flex-pack:center;justify-content:center;width:8.5em;height:9em;margin:1em 1em 1em 0;background:rgba(255,255,255,0.08);border-radius:0.8em;-webkit-border-radius:0.8em}' +
            '.shikimori-action.focus{background:#fff;color:#000}' +
            '.shikimori-action__icon{width:2.4em;height:2.4em;margin-bottom:0.8em}' +
            '.shikimori-action__icon svg{width:100%;height:100%}' +
            '.shikimori-action__title{font-size:1em;text-align:center;padding:0 0.5em}' +
            '.shikimori-rate{background:rgba(255,255,255,0.12)}' +
            '.shikimori-next{margin-left:0.5em;color:#22a51d}' +
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
