'use strict';
// Operator invites from the owner's panel (a @username resolved through Network) and the public turn queue's
// leave route (plan T15): the People card, the three form posts, and the turn strip on a queue robot's panel.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user, headers = {}) => fetch(t.base + p, { redirect: 'manual', headers: { ...(user ? cookie(user) : {}), ...headers } });
    const post = (p, user, form = {}, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers },
    });

    const { robot } = await t.robot(alex, { name: 'Rover' });

    await check('the owner sees the People card and adding @bob lists them, and the API agrees', async () => {
        const html = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(html.includes('class="setting-card people"') && html.includes('id="people-h"'));
        assert.ok(html.includes('<p class="setting-note">Operators drive and can press the e-stop; viewers watch.</p>'));
        assert.ok(html.includes('<li class="person"><span class="who"><b>You</b><small>Owner</small></span></li>'));
        assert.ok(html.includes(`<form class="people-add" method="post" action="/robots/${robot.id}/operators">`));
        assert.ok(html.includes('name="username" placeholder="@username" required maxlength="41"'));

        const r = await post(`/robots/${robot.id}/operators`, alex, { username: '@bob', role: 'operator' });
        assert.strictEqual(r.status, 303, await r.text());
        assert.strictEqual(r.headers.get('location'), `/panel/${robot.id}`);

        const after = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(after.includes('<b>Bob</b><small>@bob · Operator</small>'), after.match(/<ul class="people-list">[\s\S]*?<\/ul>/));
        assert.ok(after.includes(`action="/robots/${robot.id}/operators/${bob.subject}/remove"`));
        const api = await t.call('GET', `/api/v1/robots/${robot.id}/operators`, { user: alex });
        assert.ok(api.json.operators.some((o) => o.subject === bob.subject && o.role === 'operator'));
    });

    await check('unknown name, bad role and the owner adding themself are 422', async () => {
        const unknown = await post(`/robots/${robot.id}/operators`, alex, { username: '@ghost', role: 'operator' });
        assert.strictEqual(unknown.status, 422);
        assert.match(await unknown.text(), /No OpenVibe account is called @ghost/);
        assert.strictEqual((await post(`/robots/${robot.id}/operators`, alex, { username: '@carol', role: 'admin' })).status, 422);
        assert.strictEqual((await post(`/robots/${robot.id}/operators`, alex, { username: '@alex', role: 'operator' })).status, 422);
    });

    await check('a non-owner cannot add or remove people', async () => {
        assert.strictEqual((await post(`/robots/${robot.id}/operators`, bob, { username: '@carol', role: 'viewer' })).status, 403);
        assert.strictEqual((await post(`/robots/${robot.id}/operators/${bob.subject}/remove`, bob)).status, 403);
    });

    await check('the owner removes a person; the owner row stays', async () => {
        assert.strictEqual((await post(`/robots/${robot.id}/operators/${alex.subject}/remove`, alex)).status, 303);
        assert.ok((await t.domain.members.list(robot.id)).some((m) => m.subject === alex.subject && m.role === 'owner'));
        assert.strictEqual((await post(`/robots/${robot.id}/operators/${bob.subject}/remove`, alex)).status, 303);
        assert.ok(!(await t.domain.members.list(robot.id)).some((m) => m.subject === bob.subject));
    });

    await check('Network down: the panel still renders, with the subject id and "name unavailable"', async () => {
        await t.domain.members.add(robot.id, carol.subject, 'viewer', alex.subject);
        t.network.failIdentity(500);
        const r = await get(`/panel/${robot.id}`, alex);
        assert.strictEqual(r.status, 200);
        const html = await r.text();
        assert.ok(html.includes(`<b>${carol.subject}</b><small>name unavailable</small>`), html.match(/<ul class="people-list">[\s\S]*?<\/ul>/));
        t.network.failIdentity(null);
        const back = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(back.includes('<b>Carol</b><small>@carol · Viewer</small>'));
    });

    await check('a queue robot: a signed-in non-member gets the turn strip; the owner does not', async () => {
        const { robot: q } = await t.robot(alex, { name: 'Queue', access_policy: 'queue' });
        const html = await (await get(`/panel/${q.id}`, bob)).text();
        assert.ok(html.includes('<div class="turn" data-turn hidden><span class="turn-state" data-turn-state></span><span class="turn-meta" data-turn-meta></span>'));
        assert.ok(html.includes(`<form method="post" action="/robots/${q.id}/queue/leave" data-turn-leave>`));
        const owner = await (await get(`/panel/${q.id}`, alex)).text();
        assert.ok(!owner.includes('data-turn'), 'the owner sees no leave strip');
        assert.ok(owner.includes('Anyone signed in can also take a turn'), 'the queue note is on the owner card');

        // Bob joins on /control (the queue's own door) and becomes the active turn; Carol waits.
        const c = await t.ws('/control', { headers: cookie(bob) });
        c.send({ type: 'join', robot_id: q.id });
        assert.strictEqual((await c.waitFor((m) => m.type === 'joined')).role, 'queue');
        await t.domain.queue.join(q.id, carol.subject);
        assert.strictEqual((await t.domain.queue.state(q.id, bob.subject)).active, true);

        let broadcasts = 0;
        const original = t.hub.broadcast;
        t.hub.broadcast = (id) => { if (id === q.id) broadcasts++; return original.call(t.hub, id); };
        try {
            const r = await post(`/robots/${q.id}/queue/leave`, bob);
            assert.strictEqual(r.status, 303);
            assert.strictEqual(r.headers.get('location'), `/panel/${q.id}`);
        } finally { t.hub.broadcast = original; }
        assert.strictEqual(broadcasts >= 1, true, 'the panels were not told');

        assert.strictEqual(await t.db.maybe('SELECT * FROM robot_queue WHERE robot_id = $1 AND subject = $2', [q.id, bob.subject]), null);
        const left = await t.domain.queue.state(q.id, bob.subject);
        assert.strictEqual(left.active, false);
        assert.strictEqual(left.position, null);
        const promoted = await t.domain.queue.state(q.id, carol.subject);
        assert.strictEqual(promoted.active, true);
        assert.strictEqual(promoted.position, 0);
        c.close();
    });

    await check('the panel client paints the strip from a state frame\'s queue', () => {
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        assert.match(js, /paintTurn\(m\.state && m\.state\.queue\)/);
        assert.match(js, /'Your turn'/);
        assert.match(js, /in line/);
        assert.match(js, /setInterval\(paintLeft, 1000\)/);
    });

    await t.close();
    done();
})();
