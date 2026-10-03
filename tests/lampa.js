// Minimal Lampa emulator for running shikimori.js under jsdom.
// Only what the plugin touches; every call is recorded for assertions.
'use strict';

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

function hash(input) {
    // Lampa.Utils.hash — the exact algorithm does not matter for tests,
    // it only has to be deterministic and shared by plugin and fixtures
    let h = 0;
    const s = String(input);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(Math.abs(h));
}

function createEnv(opts) {
    opts = opts || {};
    const dom = new JSDOM('<!doctype html><html><body><div class="menu"><ul class="menu__list"></ul></div></body></html>', {
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        url: 'https://lampa.test/'
    });
    const window = dom.window;
    const document = window.document;

    // jsdom has no layout, so no innerText either: map it onto textContent
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent; },
        set(v) { this.textContent = v; },
        configurable: true
    });

    // jQuery bound to this window
    const jqFactory = require('jquery');
    const $ = jqFactory(window);
    window.$ = window.jQuery = $;

    const log = {
        requests: [],
        noty: [],
        pushes: [],
        selects: [],
        inputs: [],
        searches: [],
        built: [],
        errors: []
    };

    // ---------- Storage ----------
    const store = new Map();
    const fields = Object.assign({ source: 'tmdb', tmdb_lang: 'ru', proxy_tmdb: false }, opts.fields || {});
    const initial = opts.storage || {};
    for (const k in initial) store.set(k, JSON.stringify(initial[k]));

    const Storage = {
        get(name, def) {
            if (!store.has(name)) return def;
            const raw = store.get(name);
            try { return JSON.parse(raw); } catch (e) { return raw; }
        },
        set(name, value) {
            store.set(name, typeof value == 'string' ? JSON.stringify(value) : JSON.stringify(value));
        },
        field(name) {
            if (store.has(name)) return Storage.get(name);
            return fields[name];
        },
        raw: store
    };

    // ---------- Lang ----------
    const phrases = {};
    const Lang = {
        add(map) { for (const k in map) phrases[k] = map[k]; },
        translate(key) {
            if (phrases[key]) return phrases[key].ru || phrases[key].en || key;
            return key;
        },
        selected(codes) { return codes.indexOf(Storage.get('language', 'ru')) >= 0; }
    };

    // ---------- Listener ----------
    function Subscribe() {
        const map = {};
        return {
            follow(name, fn) { name.split(',').forEach(n => { (map[n] = map[n] || []).push(fn); }); },
            remove(name, fn) { if (map[name]) map[name] = map[name].filter(f => f !== fn); },
            send(name, data) { (map[name] || []).slice().forEach(fn => fn(data)); }
        };
    }
    const Listener = Subscribe();

    // ---------- Template ----------
    const templates = {};
    const Template = {
        add(name, html) { templates[name] = html; },
        js(name) {
            const box = document.createElement('div');
            box.innerHTML = templates[name];
            return box.firstElementChild;
        },
        get(name, vars, like_static) {
            if (like_static) return templates[name];
            return $(templates[name]);
        }
    };

    // ---------- Controller ----------
    let enabled = { name: 'content' };
    const controllers = {};
    const Controller = {
        add(name, obj) { controllers[name] = obj; },
        toggle(name) { enabled = { name }; if (controllers[name] && controllers[name].toggle) try { controllers[name].toggle(); } catch (e) {} },
        enabled() { return enabled; },
        own() { return false; },
        collectionSet() {},
        collectionFocus() {},
        collectionAppend() {}
    };

    // ---------- Select ----------
    const Select = {
        show(params) {
            log.selects.push(params);
            enabled = { name: 'select' };
        }
    };

    function Scroll() {
        const el = document.createElement('div');
        el.className = 'scroll';
        const body = document.createElement('div');
        body.className = 'scroll__body';
        el.appendChild(body);
        this.minus = function () {};
        this.append = function (node) { body.appendChild(node); };
        this.render = function (js) { return js ? el : $(el); };
        this.update = function () {};
        this.destroy = function () { el.remove(); };
    }

    function Empty() {
        const el = document.createElement('div');
        el.className = 'empty';
        this.render = function (js) { return js ? el : $(el); };
        this.start = function () {};
    }

    function InteractionMain(object) {
        this.object = object;
        this.html = document.createElement('div');
        this.activity = { loader() {}, toggle() {}, render: () => $(this.html) };
    }
    InteractionMain.prototype.render = function (js) { return js ? this.html : $(this.html); };
    InteractionMain.prototype.build = function (data) {
        this.built = data;
        log.built.push(data);
        // Как настоящая строка: карточки создаются и попадают в DOM
        for (const line of data) {
            if (!line.cardClass) continue;
            for (const item of line.results || []) {
                try {
                    const c = line.cardClass(item);
                    c.create();
                    this.html.appendChild(c.render(true));
                } catch (e) { log.errors.push(e); }
            }
        }
    };

    const components = {};

    const timeline = opts.timeline || {};   // key: hash(season, ':'?, ep, name) -> percent

    const favorites = opts.favorites || {};  // type -> [cards]

    const Lampa = {
        Storage,
        Lang,
        Listener,
        Template,
        Controller,
        Select,
        Scroll,
        Empty,
        InteractionMain,
        Noty: { show(text) { log.noty.push(String(text)); } },
        Loading: { start() {}, stop() {} },
        Activity: {
            push(obj) { log.pushes.push(obj); },
            backward() {},
            active() { return {}; }
        },
        Component: { add(name, comp) { components[name] = comp; } },
        SettingsApi: {
            params: [],
            addComponent() {},
            addParam(p) { Lampa.SettingsApi.params.push(p); }
        },
        Manifest: {
            cub_domain: 'cub.rip',
            set plugins(v) { this._plugins = v; },
            get plugins() { return this._plugins; }
        },
        TMDB: {
            key() { return 'KEY'; },
            api(url) {
                if (Storage.field('proxy_tmdb')) return 'https://apitmdb.cub.rip/3/' + url;
                return 'https://api.themoviedb.org/3/' + url;
            },
            image(url) { return 'https://image.tmdb.org/' + url; }
        },
        Utils: {
            protocol() { return 'https://'; },
            hash
        },
        Favorite: {
            get(params) { return (favorites[params.type] || []).map(c => Object.assign({}, c)); },
            check(card) {
                const res = {};
                for (const t in favorites) res[t] = (favorites[t] || []).some(c => c.id == card.id);
                return res;
            },
            add(where, card) { (favorites[where] = favorites[where] || []).push(card); },
            remove(where, card) { favorites[where] = (favorites[where] || []).filter(c => c.id != card.id); }
        },
        Timeline: {
            watchedEpisode(card, season, ep) {
                const name = card.original_name || card.original_title;
                const key = hash([season, season > 10 ? ':' : '', ep, name].join(''));
                return timeline[key] ? { percent: timeline[key], updated: Date.now() - 3600e3 } : null;
            },
            update(rec) { timeline[rec.hash] = rec.percent; },
            view(h) { return { hash: h, percent: timeline[h] || 0, time: 0, duration: 0 }; }
        },
        Input: { edit(params, cb) { log.inputs.push(params); if (opts.onInput) opts.onInput(params, cb); } },
        Background: { change() {} },
        Layer: { visible() {} },
        Platform: { tv() { return false; } },
        Account: { logged() { return false; }, Permit: { sync: false } },
        Search: { open(params) { log.searches.push(params || {}); } }
    };

    window.Lampa = Lampa;
    window.Navigator = { canmove() { return false; }, move() {} };
    window.appready = false;

    // ---------- XHR ----------
    const pending = new Set();
    class FakeXHR {
        constructor() {
            this.readyState = 0;
            this.status = 0;
            this.responseText = '';
            this.timeout = 0;
            this.headers = {};
        }
        open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
        setRequestHeader(k, v) { this.headers[k] = v; }
        abort() { this.aborted = true; pending.delete(this); }
        send(body) {
            const self = this;
            const entry = { method: self.method, url: self.url, body: body || null, t: Date.now() };
            log.requests.push(entry);
            pending.add(self);
            let res;
            try { res = opts.route(self.method, self.url, body, entry); }
            catch (e) { log.errors.push(e); res = { status: 500, body: { error: String(e) } }; }
            const delay = (res && res.delay) || 2;
            setTimeout(() => {
                if (self.aborted) return;
                pending.delete(self);
                if (!res || res.network) return self.onerror && self.onerror();
                if (res.timeout) return self.ontimeout && self.ontimeout();
                self.status = res.status || 200;
                self.responseText = typeof res.body == 'string' ? res.body : JSON.stringify(res.body);
                entry.status = self.status;
                self.onload && self.onload();
            }, delay);
        }
    }
    window.XMLHttpRequest = FakeXHR;

    window.addEventListener('error', e => log.errors.push(e.error || e.message));

    function load(file) {
        const code = fs.readFileSync(file, 'utf8');
        window.eval(code);
    }

    function idle(ms) {
        return new Promise(resolve => {
            let quiet = 0;
            const started = Date.now();
            const tick = () => {
                if (pending.size == 0) quiet++;
                else quiet = 0;
                if (quiet >= 3 || Date.now() - started > (ms || 8000)) return resolve();
                setTimeout(tick, 15);
            };
            setTimeout(tick, 15);
        });
    }

    async function waitFor(fn, ms) {
        const started = Date.now();
        while (Date.now() - started < (ms || 8000)) {
            const v = fn();
            if (v) return v;
            await new Promise(r => setTimeout(r, 10));
        }
        return null;
    }

    return { window, document, $, Lampa, log, store, components, timeline, favorites, load, idle, waitFor, hash };
}

module.exports = { createEnv, hash };
