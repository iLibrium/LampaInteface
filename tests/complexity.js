// Collect every GraphQL query the plugin sends during all scenarios and
// compute its complexity the graphql-ruby way (each field 1 + children).
'use strict';
const servers = require('./servers');
const seen = new Map();
const orig = servers.makeWorld;
servers.makeWorld = function (spec) {
    spec = Object.assign({}, spec, {
        onGraphql(q) {
            const root = servers.parseGraphql(q);
            const cost = fields => fields.reduce((n, f) => n + 1 + cost(f.sel || []), 0);
            const depth = fields => fields.reduce((d, f) => Math.max(d, 1 + depth(f.sel || [])), 0);
            const key = q.replace(/\(.*?\)/g, '(…)').replace(/\s+/g, ' ').slice(0, 140);
            const c = cost(root), d = depth(root);
            const prev = seen.get(key);
            if (!prev || prev.c < c) seen.set(key, { c, d, n: (prev ? prev.n : 0) + 1 });
            else prev.n++;
        }
    });
    return orig(spec);
};
process.on('exit', () => {
    const list = [...seen.entries()].sort((a, b) => b[1].c - a[1].c);
    console.log('\nGraphQL queries seen:', list.length);
    for (const [k, v] of list.slice(0, 8)) console.log('  complexity', String(v.c).padStart(3), ' depth', v.d, ' ×' + v.n, ' ', k);
});
process.argv[2] = process.argv[2] || require('path').join(__dirname, '..', 'shikimori.js');
require('./run.js');
