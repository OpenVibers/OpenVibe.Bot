'use strict';
// The panel's Network client for a person's layout (make your own controls, stage 2): the read is the person's
// own token, a 404 or an unreachable Network leaves the default, and save/suggest/share speak the person routes.
// No network: a fake fetch records the request.
const assert = require('node:assert/strict');
const layouts = require('../server/web/layouts');

const config = { network: { url: 'https://network.example' } };
const layout = { surface: 'bot.controls', surface_version: 1, device: 'phone', name: 'Mine', author: { name: 'Ana' }, sharing: 'private', parts: [] };
const catalog = { id: 'bot.controls', version: 1, name: 'Robot controls', devices: ['phone'], grid: { columns: { phone: 4 }, cell_px: { phone: 64 } }, theme_tokens: ['surface'], parts: [] };
const seen = [];
const answer = (status, body) => async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
};

(async () => {
    assert.equal(await layouts.activeLayout({ config, token: null, surface: 'bot.controls', device: 'phone', fetchImpl: async () => { throw new Error('must not call'); } }), null, 'signed out never calls Network');
    assert.equal(await layouts.activeLayout({ config, token: 't', surface: 'bot.controls', device: 'phone', fetchImpl: answer(404, { error: 'none' }) }), null, 'no layout is the default');
    const got = await layouts.activeLayout({ config, token: 't', surface: 'bot.controls', device: 'phone', fetchImpl: answer(200, { layout }) });
    assert.deepEqual(got, layout);
    assert.match(seen.at(-1).url, /\/api\/v1\/me\/layouts\/bot\.controls\?device=phone$/);
    assert.equal(seen.at(-1).auth, 'Bearer t', 'the person’s own token');

    await layouts.saveLayout({ config, token: 't', surface: 'bot.controls', device: 'phone', layout, catalog, fetchImpl: answer(200, { ...layout, id: 'lay_x' }) });
    assert.equal(seen.at(-1).method, 'PUT');
    assert.deepEqual(seen.at(-1).body, { catalog, layout });

    const sug = await layouts.suggestLayout({ config, token: 't', surface: 'bot.overlay', device: 'phone', words: 'put Stop left', layout, catalog, fetchImpl: answer(200, { ok: true, layout, summary: 'Stop is left.', reasons: [] }) });
    assert.equal(sug.ok, true);
    assert.match(seen.at(-1).url, /\/api\/v1\/me\/layouts\/bot\.overlay\/suggest\?device=phone$/);
    assert.equal(seen.at(-1).body.words, 'put Stop left');

    await assert.rejects(() => layouts.saveLayout({ config, token: 't', surface: 'bot.controls', device: 'phone', layout, catalog, fetchImpl: answer(422, { detail: 'Stop has to stay visible.' }) }), /Stop has to stay visible\./);

    assert.deepEqual(await layouts.resetLayout({ config, token: 't', surface: 'bot.controls', device: 'phone', fetchImpl: answer(204, null) }), { ok: true });
    assert.match(seen.at(-1).url, /\/api\/v1\/me\/layouts\/bot\.controls\/reset\?device=phone$/);
    assert.deepEqual(await layouts.resetLayout({ config, token: 't', surface: 'bot.controls', device: 'phone', fetchImpl: answer(404, { code: 'layout.none' }) }), { ok: true }, 'nothing to reset is the default already');

    const shared = await layouts.shareLayout({ config, token: 't', surface: 'bot.controls', device: 'phone', layout, catalog, fetchImpl: (url, init) => {
        if (init.method === 'PUT') return answer(200, { ...layout, id: 'lay_abc' })(url, init);
        return answer(200, { url: '/api/v1/layouts/shared/tok_1' })(url, init);
    } });
    assert.match(seen.at(-1).url, /\/api\/v1\/me\/layouts\/lay_abc\/share$/);
    assert.equal(shared.url, 'https://network.example/api/v1/layouts/shared/tok_1');
    console.log('arrange-layouts: read, 404, save, suggest and a refusal');
})().catch((e) => { console.error(e); process.exit(1); });
