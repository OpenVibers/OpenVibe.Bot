'use strict';
// Each model's picture, drawn from its profile (the owner's phone, 11-18: every model card was the same gamepad on a blue
// box, "dumb, no that"): every catalogue profile draws, each as what it is (four mecanum wheels, a screen face, a phone,
// a PTZ camera, a relay box, the simulated rover in dashes over a grid); /models/:id/art.svg serves it as an image, and
// the home's cards show it instead of the gamepad.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { artFor } = require('../server/web/robot-art');
const { boot, check, done } = require('./helpers/app');

const dir = path.join(__dirname, '..', 'server', 'profiles');
const profiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const byId = (id) => profiles.find((p) => p.id === id) || { id, capabilities: [] };

(async () => {
    await check('every profile draws, each as what it is', async () => {
        const seen = new Set();
        for (const p of profiles) {
            const svg = artFor(p);
            assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img"'), p.id);
            assert.ok(!/<script|on[a-z]+=|href=/i.test(svg), `${p.id}: no script, handler or link in it`);
            seen.add(svg.replace(/hsl\([^)]*\)/g, ''));
        }
        assert.ok(seen.size >= 6, `the drawings differ by what the robots have (${seen.size} shapes)`);
        assert.strictEqual((artFor({ id: 'x', capabilities: ['drive.mecanum'] }).match(/class="wheel"/g) || []).length, 2, 'mecanum: the near wheels, striped');
        assert.match(artFor({ id: 'x', capabilities: ['drive.mecanum'] }), /class="far"/, 'and the far ones');
        assert.match(artFor(byId('looi')), /class="screen"/, 'LOOI wears a screen face');
        assert.match(artFor(byId('phone.camera')), /rx="26"/, 'a phone is a phone');
        assert.match(artFor(byId('sim.rover')), /stroke-dasharray/, 'the simulated rover is drawn in dashes');
        assert.match(artFor(byId('sim.rover')), /class="grid"/, 'over a grid');
        assert.match(artFor({ id: 'x', name: '<b>"hi"</b>', capabilities: [] }), /aria-label="&lt;b&gt;&quot;hi&quot;&lt;\/b&gt;"/, 'the name is escaped');
    });

    const t = await boot({ openre: false });
    const get = (p) => fetch(t.base + p, { redirect: 'manual' });
    await check('/models/:id/art.svg serves the drawing; the home shows it, not the gamepad', async () => {
        const r = await get('/models/cozmo/art.svg');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
        assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/);
        assert.match(await r.text(), /aria-label="Cozmo"/);
        assert.strictEqual((await get('/models/nope/art.svg')).status, 404);
        const html = await (await get('/')).text();
        assert.ok(html.includes('src="/models/cozmo/art.svg"'), 'a model card shows its drawing');
        assert.ok(html.includes('src="/models/sim.rover/art.svg"'), 'the simulated rover too');
    });
    await t.close();
    done();
})();
