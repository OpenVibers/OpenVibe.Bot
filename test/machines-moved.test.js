'use strict';
// The machines hub belongs to OpenVibe Link (owner, 11-09): openvibe.bot/machines and every path below it answer a
// 301 to https://openvibe.link/machines, signed in or not, so a signed-out visitor never sees Bot's sign-in page first.
const assert = require('assert');
// Loaded directly, not only through the app, so a change to the web or API surface is in this test's closure.
require('../server/web/routes');
require('../server/web/docs');
require('../server/api/v1');
require('../server/machine-screen');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const LINK = 'https://openvibe.link/machines';

    await check('/machines answers 301 to Link signed out, with no sign-in bounce', async () => {
        for (const p of ['/machines', '/machines/dev_01ABC/screen?desk=desk-task-a', '/machines/dev_01ABC/desks']) {
            const r = await fetch(`${t.base}${p}`, { redirect: 'manual' });
            assert.deepStrictEqual([r.status, r.headers.get('location')], [301, LINK], p);
        }
    });

    await check('it answers 301 the same way signed in, and for a form post', async () => {
        const headers = { Cookie: `ov_token=${t.network.signUser(alex)}` };
        const r = await fetch(`${t.base}/machines`, { redirect: 'manual', headers });
        assert.deepStrictEqual([r.status, r.headers.get('location')], [301, LINK]);
        const post = await fetch(`${t.base}/machines`, { method: 'POST', redirect: 'manual', headers });
        assert.deepStrictEqual([post.status, post.headers.get('location')], [301, LINK], 'no page is left behind here');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
