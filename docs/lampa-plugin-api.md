# Lampa Plugin Development — API Research

Research date: 2026-08-12.
Lampa app repo (built): https://github.com/yumata/lampa — Source repo: https://github.com/yumata/lampa-source (v3.3.0 at time of research).

---

## 1. How plugins work (loading mechanism)

- A Lampa plugin is a **single plain .js file, hosted at any URL** (usually GitHub Pages). No build system, no modules — it runs in the app's global scope where `window.Lampa` is already defined.
- The user adds the URL in **Settings → Extensions (Плагины)**. Lampa stores the list in `localStorage` key `plugins` (`Lampa.Storage.get('plugins')` → `[{url, status: 1}, ...]`).
- On every app start, `src/core/plugins.js` (`Plugins.task` / `Plugins.load`) injects each plugin with `Utils.putScriptAsync(url)` — i.e. a `<script>` tag. Query params are appended automatically: `logged=`, `origin=`, `reset=<random>` (cache-buster; the script re-executes on every app launch). Plugin code is also cached in IndexedDB (`Cache.rewriteData('plugins', ...)`) as a fallback for offline start.
- There is a **domain blacklist** fetched from the CUB API plus hardcoded entries (`bylampa.github.io`, `tinyurl.com`, `t.me/`, etc.) — plugins from those hosts are refused.
- For self-hosted builds, a plugin can also be dropped as a file into `data/plugins/` (see README of yumata/lampa). `./plugins/modification.js` is always loaded if present.
- Official technical docs: clone `yumata/lampa-source`, run `npm run doc`, open `build/doc/index.html` (JSDoc). Community: Telegram group `@lampa_plugins`. Also useful: DeepWiki pages for `yumata/lampa-source` ("Plugin API & Integration Points").

### Timing: `app` ready event and the `window.plugin_*_ready` guard

Plugins load *in parallel with* app startup, so **all real plugins use two idioms**:

```js
(function () {
    'use strict';

    function startPlugin() {
        // ... register components, templates, settings, menu items ...
    }

    // 1) Re-entry guard: script may be injected more than once
    if (!window.my_plugin_ready) {
        window.my_plugin_ready = true;

        // 2) Wait until the app is fully initialized
        if (window.appready) startPlugin();
        else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type == 'ready') startPlugin();
            });
        }
    }
})();
```

`window.plugin_<name>_ready` (or any name — `window.tmdb_networks`, `window.kp_source_plugin`, `window.prisma_collections_ready`) is **purely a plugin-defined global boolean** used as a double-initialization guard; Lampa itself only defines `window.appready` (set true at the end of `startApp()` right before `Lampa.Listener.send('app',{type:'ready'})`).

DOM-touching work (e.g. appending a menu item) must run after `app` `ready`; pure registrations (`Component.add`, `Template.add`, `Lang.add`) are safe immediately.

### `Lampa.Manifest`

`src/core/manifest.js`. Read-only info: `Manifest.app_version` ('3.3.0'), `Manifest.app_digital` (330 — integer for version gating, e.g. `if (Lampa.Manifest.app_digital >= 242)`), `Manifest.cub_domain`, `Manifest.github_lampa`.

**`Lampa.Manifest.plugins = manifest`** is a *setter that pushes into a list* of installed plugin manifests (must have a string `type`):

```js
Lampa.Manifest.plugins = {
    type: 'video',            // category of plugin
    version: '1.0.0',
    name: 'My Plugin',
    description: '...',
    component: 'my_component',
    // optional: context-menu integration on cards (long-press / options):
    onContextMenu: function (object) { return { name: 'Watch', description: '' }; },
    onContextLauch: function (object) { /* open your component for this card */ }
};
```

---

## 2. The `window.Lampa` API surface

`src/app.js` `initClass()` exposes (complete list): `Listener, Lang, Subscribe, Storage, Platform, Utils, Params, Menu, Head, Notice, Background, Favorite, Select, Controller, Activity, Keypad, Template, Component, Reguest, Filter, Files, Explorer, Scroll, Empty, Arrays, Noty, Player, PlayerVideo, PlayerInfo, PlayerPanel, PlayerFooter, PlayerIPTV, PlayerPlaylist, Timeline, Modal, Api, Settings, SettingsApi, Android, Card, Info, Account, Socket, Input, Screensaver, Recomends, TimeTable, Broadcast, Helper, InteractionMain, InteractionCategory, InteractionLine, Status, Plugins, Extensions, Tizen, Layer, Console, Iframe, Parser, Manifest, TMDB, Base64, Loading, YouTube, WebOSLauncher, Event, Search, DeviceInput, Worker, DB, NavigationBar, Endless, Color, Cache, Torrent, Torserver, Speedtest, Processing, ParentalControl, VPN, Bell, StorageMenager, RemoteHelper, Network (a ready `Reguest` instance), Maker, MaskHelper, ContentRows, Emit, Router, Timer`.

jQuery (`$`) is bundled and used pervasively.

### Key modules

**`Lampa.Component`** (`src/core/component.js`) — screen registry:
- `Lampa.Component.add(name, comp)` — register. `comp` is a constructor function `function component(object){...}` receiving the Activity object.
- `Lampa.Component.get(name)`, `.create(object)` (internal — falls back to `nocomponent` on error).
- Component instance contract (called by Activity): `create()` (must return render or set up async load), `start()` (took focus — set up Controller), `pause()`, `stop()`, `render(js)` (return root element; `js=true` → DOM node, else jQuery), `destroy()`, `refresh()`. The Activity injects `this.activity` (use `this.activity.loader(true/false)` for spinner, `this.activity.toggle()` when content ready).

**`Lampa.Activity`** (`src/interaction/activity/activity.js`) — screen stack / navigation:
- `Lampa.Activity.push(object)` — open a new screen. `object` minimally `{ title, component, page }` + anything your component needs (`url`, `source`, `card`, `id`, `method`, custom fields). The named `component` is instantiated and `create()`d.
- `Lampa.Activity.backward()` — go back; `Lampa.Activity.replace(object, clear)` — replace current; `Lampa.Activity.active()` — current activity object (has `.activity` with `.render()`, `.toggle()`, `.loader()`).
- Sends `Lampa.Listener` events `'activity'` with `type: 'init' | 'create' | ...`.

**`Lampa.Listener`** — global event bus (an instance of `Subscribe()`; `follow(name, fn)`, `send(name, data)`, `remove`). Important app events:
- `'app'` → `{type:'start'|'ready'}`
- `'full'` → detail-card lifecycle; on `{type:'complite'}` you get `e.object.activity.render()` (the card DOM) and `e.data.movie` (the TMDB/card data). This is THE hook for adding buttons to a movie/series page.
- `'activity'` → `{component, type:'init'|'create'|'start'|'archive'|'destroy', object}`
- `'menu'` → menu build/actions (kp_source uses `e.type == 'action'` + `e.abort()` to hijack standard menu items)
- `'line'`, `'select'`, `'player'`, `'keydown'`, `'profile'`, `'sources'` etc.
- Multiple: `Lampa.Listener.follow('activity,full', fn)` (comma-separated).

**`Lampa.Storage`** (`src/core/storage/storage.js`) — persistent settings over localStorage (+ sync):
- `get(name, default)`, `set(name, value)`, `field(name)` (get respecting registered Params defaults), `add(name, value)` (push to array), `cache(name, max, empty)`, `sync`, `remove`, `listener` (follow `'change'`).

**`Lampa.Reguest`** (`src/utils/reguest.js`, yes "Reguest" — typo is canonical) — network:
- `var network = new Lampa.Reguest();`
- `network.silent(url, success, error, post_data, params)` — main JSON GET/POST (queued, retried);
- `network.native(url, success, error, post_data, params)` — direct fetch/XHR (params: `{dataType:'text', headers, timeout}`);
- `network.quiet`, `network.timeout(ms)`, `network.clear()` (abort all — call in `destroy`).

**`Lampa.Template`** (`src/interaction/template.js`) — string template store:
- `Lampa.Template.add(name, htmlString)` — placeholders `{var}` (escaped) and translation refs `#{lang_key}`.
- `Lampa.Template.get(name, vars, like_static)` — returns jQuery (or static content when `like_static=true`).
- `Lampa.Template.js(name, vars)` — returns a cloned plain DOM node (fast path used by card classes).
- CSS injection idiom: `Lampa.Template.add('my_css','<style>...</style>'); $('body').append(Lampa.Template.get('my_css',{},true));`

**`Lampa.Select`** (`src/interaction/select.js`) — TV-friendly modal list:
```js
Lampa.Select.show({
    title: 'Pick one',
    items: [{title:'A', ...}, ...],   // item.selected / item.subtitle / item.disabled supported
    onSelect: function(item){ ... },  // re-toggle a Controller afterwards!
    onBack: function(){ Lampa.Controller.toggle('content'); }
});
```
Always restore focus in `onBack`/`onSelect`: `var saved = Lampa.Controller.enabled().name;` before showing, then `Lampa.Controller.toggle(saved)`.

**`Lampa.Noty.show(text, {time})`** — toast notification.

**`Lampa.Lang`** — `Lampa.Lang.add({ key: {ru:'...', en:'...', uk:'...'} })`, `Lampa.Lang.translate('key' | html-with-#{keys})`.

**`Lampa.TMDB`** (`src/core/tmdb/tmdb.js`) — `TMDB.api(path)` (full API URL incl. proxy handling), `TMDB.image(path)` (e.g. `Lampa.TMDB.image('t/p/w300' + logo_path)`), `TMDB.key()` (public API key). Also `Lampa.Api.img(path, size)` and `Lampa.Api.sources` (see §6).

**`Lampa.Favorite`** (`src/core/favorite.js`) — bookmarks: `add(where, card, limit)`, `remove(where, card)`, `toggle(where, card)`, `check(card)` (→ `{book,like,wath,history,...}`), `get(params)`, `full()`, `all()`. `where` ∈ `book|like|wath|history|...`.

**`Lampa.Controller` + `Navigator`** — TV remote focus engine:
- `Lampa.Controller.add(name, { toggle, up, down, left, right, back, gone })` — register a focus context; `toggle(name)` activates it.
- Inside `toggle`: `Lampa.Controller.collectionSet(scroll_or_container)` — collect focusable `.selector` elements; `Lampa.Controller.collectionFocus(elem_or_false, container)` — set focus; `Lampa.Controller.collectionAppend(elem)` — add appended cards to current collection.
- `Lampa.Controller.enabled().name` — current context name; `Lampa.Controller.own(this)` — does this component own focus.
- Global `Navigator`: `Navigator.canmove('up'|'down'|'left'|'right')`, `Navigator.move(dir)`, `Navigator.setCollection(domArray)`, `Navigator.focused(elem)`.
- Everything focusable is class `selector`; interaction events are jQuery custom events: `hover:enter` (OK/click), `hover:focus`, `hover:touch`, `hover:hover`, `hover:long`.

**`Lampa.Scroll`** (`src/interaction/scroll.js`) — `new Lampa.Scroll({mask:true, over:true, step:250, end_ratio:2, scroll_by_item:true})`; `.append(el)`, `.render(js)`, `.update(elem)` (scroll focused card into view), `.onEnd` (infinite scroll), `.onScroll`, `.onWheel`, `.minus()`, `.destroy()`.

**`Lampa.Card`** (`src/interaction/card.js`) — standard poster card class: `new Lampa.Card(element, {object, card_wide, card_category, ...})`; `.create()`; `.render(js)`; hooks `onFocus/onEnter/onTouch/onMenu`; `.destroy()`.

**Ready-made grid components** — the easiest way to build catalog screens (see §3):
- `Lampa.InteractionMain` (`src/interaction/items/old/main.js`) — vertical page of horizontal card **lines** (like the home screen). Overridable: `create()`, `build(data)` (data = array of `{title, results:[cards], line_type, cardClass, wide/small/broad/collection}`), `empty()`, `onMore(data)`, `onAppend(item, element)`, `next(resolve, reject)` (endless lines).
- `Lampa.InteractionCategory` (`src/interaction/items/old/category.js`) — full **grid** with paging. Overridable: `create()`, `build(data)` (data = `{results:[...], total_pages}`), `empty()`, `nextPageReuest(object, resolve, reject)` (page++ auto), `cardRender(object, element, card)` (customize each card's `onEnter` etc.).
  Both are marked "deprecated" in source (console.warn) but are still exported and are what real 2024-2025 plugins use. They implement the whole Controller/Navigator/Scroll/limit-render dance for you.
- `Lampa.InteractionLine` (`src/interaction/items/old/line.js`) — a single horizontal line of cards.

**`Lampa.Api`** (`src/core/api/api.js`) — source multiplexer: `Lampa.Api.sources` (`{tmdb, cub, ...}`), `Lampa.Api.list/category/full/img(...)` — delegate to `Storage.field('source')`.

**`Lampa.Params` / `Lampa.SettingsApi`** — see §5.

---

## 3. FULL working example — plugin that adds a menu item + new screens with card grids

Verbatim key parts of **prisma_collections.js** by levende (https://levende.github.io/lampa-plugins/prisma_collections.js) — a real plugin adding: a left-menu item, a "lines" main screen, a paged grid screen, a custom card template with focus handling, and a movie-grid drilldown. (CSS string trimmed.)

```js
(function () {
    'use strict';

    // ---- Custom card class (template + remote-control events) ----
    function Collection(data) {
      this.data = data;

      this.build = function () {
        this.item = Lampa.Template.js('prisma_collection');       // clone DOM from registered template
        this.img = this.item.find('.card__img');
        this.item.find('.card__title').text(Lampa.Utils.capitalizeFirstLetter(data.title));
        this.item.find('.luno-collection-card__items').text(data.items_count + ' Карточек');
        this.item.addEventListener('visible', this.visible.bind(this));  // lazy image load
      };

      this.create = function () {
        var _this2 = this;
        this.build();
        this.item.addEventListener('hover:focus', function () {         // remote focus
          if (_this2.onFocus) _this2.onFocus(_this2.item, data);
        });
        this.item.addEventListener('hover:touch', function () {
          if (_this2.onTouch) _this2.onTouch(_this2.item, data);
        });
        this.item.addEventListener('hover:enter', function () {         // OK pressed → open screen
          Lampa.Activity.push({
            url: data.id,
            collection: data,
            title: Lampa.Utils.capitalizeFirstLetter(data.title),
            component: 'prisma_collections_view',
            page: 1
          });
        });
      };

      this.visible = function () {
        this.img.src = Lampa.Api.img(data.backdrop_path, 'w500');
        if (this.onVisible) this.onVisible(this.item, data);
      };

      this.destroy = function () {
        this.img.onerror = function () {};
        this.img.onload = function () {};
        this.img.src = '';
        if (this.item) this.item.remove();
        this.item = null; this.img = null;
      };

      this.render = function (js) { return js ? this.item : $(this.item); };
    }

    // ---- Data layer ----
    var network = new Lampa.Reguest();
    var api_url = 'https://.../api/collections/';
    var collections = [{ hpu: 'new', title: 'Новинки' }, { hpu: 'top', title: 'В топе' } /* ... */];

    function main(params, oncomplite, onerror) {
      var status = new Lampa.Status(collections.length);   // parallel request join
      status.onComplite = function () {
        var fulldata = [];
        // ... collect status.data[key] into fulldata; each entry gets:
        //     data.title, data.collection = true, data.line_type = 'collection',
        //     data.cardClass = function (elem, param) { return new Collection(elem, param); };
        oncomplite(fulldata);
      };
      collections.forEach(function (item) {
        network.silent(api_url + 'list?category=' + item.hpu, function (data) {
          data.collection = true;
          data.line_type = 'collection';
          data.category = item.hpu;
          status.append(item.hpu, data);
        }, status.error.bind(status), false, false);
      });
    }

    function collection(params, oncomplite, onerror) {
      network.silent(api_url + 'list?category=' + params.url + '&page=' + params.page, function (data) {
        data.collection = true;
        data.total_pages = data.total_pages || 15;
        data.cardClass = function (elem, param) { return new Collection(elem, param); };
        oncomplite(data);
      }, onerror, false, false);
    }

    function full(params, oncomplite, onerror) {          // items of one collection (movie cards)
      network.silent(api_url + 'view/' + params.url + '?page=' + params.page, function (data) {
        data.total_pages = data.total_pages || 15;
        data.results = data.items;
        oncomplite(data);
      }, onerror, false, false);
    }

    var Api = { main: main, collection: collection, full: full, clear: function(){ network.clear(); } };

    // ---- Screen 1: home-style page made of horizontal lines ----
    function component$2(object) {
      var comp = new Lampa.InteractionMain(object);

      comp.create = function () {
        var _this = this;
        this.activity.loader(true);
        Api.main(object, function (data) { _this.build(data); }, this.empty.bind(this));
        return this.render();
      };

      comp.onMore = function (data) {                     // "More" tile at line end
        Lampa.Activity.push({
          url: data.category,
          title: data.title,
          component: 'prisma_collections_collection',
          page: 1
        });
      };

      return comp;
    }

    // ---- Screen 2: paged grid of collections ----
    function component(object) {
      var comp = new Lampa.InteractionCategory(object);

      comp.create = function () {
        Api.collection(object, this.build.bind(this), this.empty.bind(this));
      };

      comp.nextPageReuest = function (object, resolve, reject) {   // infinite scroll paging
        Api.collection(object, resolve.bind(comp), reject.bind(comp));
      };

      comp.cardRender = function (object, element, card) {         // per-card override
        card.onMenu = false;
        card.onEnter = function () {
          Lampa.Activity.push({
            url: element.id,
            title: element.title,
            component: 'prisma_collection',
            page: 1
          });
        };
      };

      return comp;
    }

    // ---- Screen 3: movie grid inside a collection (standard cards → 'full' detail) ----
    function component$1(object) {
      var comp = new Lampa.InteractionCategory(object);

      comp.create = function () {
        var _this = this;
        Api.full(object, function (data) {
          _this.build(data);
          comp.render().find('.category-full').addClass('mapping--grid cols--6');
        }, this.empty.bind(this));
      };

      comp.nextPageReuest = function (object, resolve, reject) {
        Api.full(object, resolve.bind(comp), reject.bind(comp));
      };

      return comp;
    }

    // ---- Registration ----
    function startPlugin() {
      var manifest = {
        type: 'video',
        version: '1.1.2',
        name: 'Подборки',
        description: '',
        component: 'prisma_collections'
      };
      Lampa.Manifest.plugins = manifest;

      Lampa.Component.add('prisma_collections_main', component$2);
      Lampa.Component.add('prisma_collections_collection', component);
      Lampa.Component.add('prisma_collections_view', component$1);

      Lampa.Template.add('prisma_collection',
        '<div class="card luno-collection-card selector layer--visible layer--render card--collection">' +
          '<div class="card__view"><img src="./img/img_load.svg" class="card__img">' +
          /* ... overlay markup ... */ '</div>' +
          '<div class="card__title"></div>' +
        '</div>');

      Lampa.Template.add('prisma_collections_css', '<style>/* plugin CSS */</style>');
      $('body').append(Lampa.Template.get('prisma_collections_css', {}, true));

      // ---- Left menu item ----
      function add() {
        var icon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">...</svg>';
        var button = $('<li class="menu__item selector"><div class="menu__ico">' + icon +
                       '</div><div class="menu__text">' + manifest.name + '</div></li>');
        button.on('hover:enter', function () {
          Lampa.Activity.push({
            url: '',
            title: manifest.name,
            component: 'prisma_collections_main',
            page: 1
          });
        });
        $('.menu .menu__list').eq(0).append(button);
      }

      if (window.appready) add();
      else Lampa.Listener.follow('app', function (e) { if (e.type == 'ready') add(); });
    }

    if (!window.prisma_collections_ready && Lampa.Manifest.app_digital >= 242) startPlugin();
})();
```

### Building a fully manual grid component (what InteractionCategory does inside)

From `src/interaction/items/old/category.js` — if you write a component from scratch, this is the required TV-navigation pattern:

```js
this.start = function(){                       // called when screen takes focus
    Lampa.Controller.add('content', {
        link: this,
        toggle: () => {
            Lampa.Controller.collectionSet(scroll.render(true));           // gather .selector elems
            Lampa.Controller.collectionFocus(last || false, scroll.render(true));
        },
        left:  () => { if(Navigator.canmove('left'))  Navigator.move('left');  else Lampa.Controller.toggle('menu'); },
        right: () => { Navigator.move('right'); },
        up:    () => { if(Navigator.canmove('up'))    Navigator.move('up');    else Lampa.Controller.toggle('head'); },
        down:  () => { if(Navigator.canmove('down'))  Navigator.move('down'); },
        back:  () => { Lampa.Activity.backward(); }
    });
    Lampa.Controller.toggle('content');
};
// per-card: card.onFocus = (target)=>{ last = target; scroll.update(card.render(true)); Lampa.Background.change(img); }
// paging:   scroll.onEnd = () => load next page, then Lampa.Controller.collectionAppend(newCard.render(true))
// cleanup:  this.destroy = () => { network.clear(); Lampa.Arrays.destroy(items); scroll.destroy(); html.remove(); }
```

---

## 4. Adding a button to the movie detail card (the `'full'` event)

Pattern from **online_mod.js** (nb557, https://github.com/nb557/plugins) — the standard "Online/Watch" button:

```js
var button = '<div class="full-start__button selector view--myplugin">' +
             '<svg ...>...</svg><span>#{myplugin_title}</span></div>';

Lampa.Listener.follow('full', function (e) {
    if (e.type == 'complite') {
        var btn = $(Lampa.Lang.translate(button));
        btn.on('hover:enter', function () {
            // e.data.movie — the card object (id, title, original_title, name, source, ...)
            Lampa.Activity.push({
                url: '',
                title: 'My Plugin',
                component: 'my_component',
                movie: e.data.movie,
                page: 1
            });
        });
        e.object.activity.render().find('.view--torrent').after(btn);
    }
});
```

---

## 5. Settings screen integration

Two-level API (`Lampa.SettingsApi`, `src/interaction/settings/api.js`).

**Own settings folder** (from **cardify.js**, https://levende.github.io/lampa-plugins/v2/cardify.js):

```js
Lampa.SettingsApi.addComponent({
    component: 'cardify',              // folder id → data-component
    icon: '<svg ...>...</svg>',
    name: 'Cardify'                    // folder title in Settings list
});

Lampa.SettingsApi.addParam({
    component: 'cardify',              // which folder
    param: {
        name: 'cardify_run_trailers',  // Storage key (read via Lampa.Storage.get/field)
        type: 'trigger',               // 'trigger' | 'select' | 'input' | 'button' | 'title' | 'static'
        default: false
    },
    field: { name: 'Show trailer', description: 'optional description' },
    onChange: function (value) { ... },  // fired on change
    onRender: function (item) { ... }    // customize the rendered row
});
```

**Select param** (from tmdb-networks.js): `param: { name: 'key', type: 'select', values: {0:'Hide', 1:'Logo', 2:'Text'}, default: 1 }`. Values are stored in `Lampa.Storage` under `param.name`; read with `Lampa.Storage.get('key', default)`.

**Attach to an existing folder** — use `component: 'interface'` (or other built-in) in `addParam`; `param.type:'button'` + `onChange` opening a sub-screen via `Lampa.Settings.create('platforms', {template:'settings_platforms', onBack: ...})` (needs `Lampa.Template.add('settings_platforms','<div></div>')`).

`Lampa.Params.select(name, values, default)` / `Lampa.Params.trigger(name, default)` register defaults so `Storage.field(name)` works before first save (kp_source uses `Lampa.Params.select('source', {...}, 'tmdb')` to appear in the source selector).

---

## 6. Alternative integration: registering a content SOURCE (kp_source.js pattern)

**kp_source.js** (nb557) does not add a menu item — it registers a whole catalog source next to TMDB/CUB:

```js
Lampa.Api.sources['KP'] = KP;   // object implementing: get, list, category, full, search, clear, ...
Object.defineProperty(Lampa.Api.sources, 'KP', { get: function(){ return KP; } });
Lampa.Params.select('source', {tmdb:'TMDB', cub:'CUB', KP:'Кинопоиск'}, 'tmdb');
// optionally intercept built-in menu clicks when your source is active:
Lampa.Listener.follow('menu', function (e) {
    if (e.type == 'action' && Lampa.Storage.field('source') == 'KP') {
        if (e.action == 'cartoon') { Lampa.Router.call('category', {url: e.action, source:'KP'}); e.abort(); }
    }
});
```

Then all built-in screens (`category`, `category_full`, `full`) render your data. The source object must return TMDB-shaped data (`{results:[{id,title/name,poster_path,vote_average,...}], total_pages}`).

Standard drill-down into the built-in detail screen from your own card list:

```js
Lampa.Activity.push({
    url: element.url,
    component: 'full',
    id: element.id,                       // TMDB id
    method: element.name ? 'tv' : 'movie',
    card: element,
    source: element.source || 'tmdb'
});
```

---

## 7. Checklists and gotchas

- **Always** guard with `window.<name>_ready` and wait for `app` ready before touching DOM.
- Register components/templates with **unique prefixed names** (`myanime_main`, not `main`).
- The left menu is plain DOM: `$('.menu .menu__list').eq(0).append(button)`; item markup must be `<li class="menu__item selector">` with `menu__ico`/`menu__text`, listen to `hover:enter`.
- Return jQuery from `render(js)` when `js` is falsy — Activity calls both styles.
- Call `this.activity.loader(true)` before async fetch, then `build()` → inside build call `this.activity.loader(false); this.activity.toggle()` (InteractionMain/Category do this).
- In `destroy()` abort network (`network.clear()`) and destroy cards/scroll, or TVs leak memory.
- Old WebKit on TVs: write ES5 (var, no arrow functions/template literals) or transpile; every real plugin ships ES5.
- Card images: use `./img/img_load.svg` placeholder and set real `src` in the `visible` event; broken → `./img/img_broken.svg`.
- Focus restore after `Lampa.Select.show`: save `Lampa.Controller.enabled().name` and `Lampa.Controller.toggle(saved)` in `onBack`, otherwise the remote goes dead.
- Version-gate with `Lampa.Manifest.app_digital` if using newer APIs.
- Test in a desktop browser at http://lampa.mx or https://yumata.github.io/lampa/ — add plugin URL via Settings → Extensions (needs CORS-enabled hosting, e.g. GitHub Pages), watch the console (`Lampa.Console`).

---

## 8. Sources

- App repo/README (install, data/plugins, npm run doc): https://github.com/yumata/lampa
- Source code: https://github.com/yumata/lampa-source — key files: `src/app.js` (window.Lampa exports), `src/core/plugins.js` (loader), `src/core/component.js`, `src/core/manifest.js`, `src/interaction/activity/activity.js`, `src/interaction/items/old/{main,category,line}.js`, `src/interaction/settings/api.js`, `src/interaction/{scroll,select,template}.js`, `src/utils/reguest.js`, `src/core/storage/storage.js`, `src/core/favorite.js`
- prisma_collections plugin (menu + grid screens): https://levende.github.io/lampa-plugins/prisma_collections.js (repo: https://github.com/levende/lampa-plugins)
- tmdb-networks plugin (settings + full-card injection + Select): https://levende.github.io/lampa-plugins/tmdb-networks.js
- cardify plugin (SettingsApi.addComponent, template override): https://levende.github.io/lampa-plugins/v2/cardify.js
- nb557 plugins (online_mod.js — 'full' button + component; kp_source.js — Api.sources): https://github.com/nb557/plugins
- levende plugin docs: https://levende.github.io/lampa-plugins/
- DeepWiki analysis: https://deepwiki.com/yumata/lampa-source/12.2-plugin-api-and-integration-points
- Plugin lists: https://github.com/AgnitumuS/lampa-plugins, https://gist.github.com/darkmanlv/54132bddd49eef44a3e3afc2606a406b
- Community: Telegram @lampa_plugins
