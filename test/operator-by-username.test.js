'use strict';
// The owner adds a person by @username from the panel (POST /robots/:id/operators). Network answers
// identity.subject-projection@1, whose `subject` is a subject-ref { type, id }: until 2026-11-06 Bot read it as a
// string and answered "No OpenVibe account is called @…" for every person Network found (a community member could not
// add @Quinn). The stub now speaks the contract's shape, so this test fails on that reading.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const quinn = t.network.newUser('Quinn');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const post = (p, user, form) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(t.base).origin, ...cookie(user) },
    });
    const { robot } = await t.robot(alex, { name: 'LOOI' });
    const members = async () => (await t.call("GET", `/api/v1/robots/${robot.id}/operators`, { user: alex })).json;

    await check('an @username Network knows is added, whatever its case and with or without the @', async () => {
        const r = await post(`/robots/${robot.id}/operators`, alex, { username: '@Quinn', role: 'operator' });
        assert.ok(r.status === 303 || r.status === 302, `added (got ${r.status})`);
        const m = await members();
        const ops = (m.operators || m.members || []);
        assert.ok(ops.some((o) => o.subject === quinn.subject && o.role === 'operator'), 'Quinn is an operator');
    });

    await check('a name Network does not know is still "No OpenVibe account"', async () => {
        const r = await post(`/robots/${robot.id}/operators`, alex, { username: 'nobody_here', role: 'viewer' });
        assert.strictEqual(r.status, 422);
        assert.match(await r.text(), /No OpenVibe account is called @nobody_here/);
    });

    await done();
})();
