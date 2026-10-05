'use strict';
// Operator invites from the owner's panel (a @username resolved through Network) and the public turn queue's
// leave route (plan T15): the People card, the three form posts, and the turn strip on a queue robot's panel.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { createIdentity } = require('../server/network');

/**
 * A Network identity endpoint over a fake fetch, for the cache's own rules (subject keying, the TTL and the
 * 2000-entry bound) without a server. `now` drives the TTL; the token endpoint answers once.
 */
function identityStub() {
    let clock = 1_000_000;
    const users = new Map();     // subject → { subject, username, display_name }
    const names = new Map();     // lowercased username → subject
    const calls = { resolve: 0, batch: 0 };
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        if (u.pathname === '/oauth/token') return reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 300 });
        if (u.pathname === '/internal/identity/resolve' && opts.method === 'GET') {
            calls.resolve++;
            const subject = names.get(String(u.searchParams.get('username') || '').toLowerCase());
            return subject ? reply(200, users.get(subject)) : reply(404, { code: 'identity.subject_not_found' });
        }
        if (u.pathname === '/internal/identity/resolve-batch') {
            calls.batch++;
            const results = {};
            for (const id of (JSON.parse(opts.body || '{}').subject_ids || [])) results[id] = users.get(id) || null;
            return reply(200, { results });
        }
        return reply(404, { code: 'not_found' });
    };
    const identity = createIdentity(
        { network: { internalUrl: 'http://network.test' }, oauth: { clientId: 'bot', clientSecret: 'shh' } },
        { fetchImpl, now: () => clock });
    return {
        identity, calls,
        add: (username) => {
            const u = { subject: `usr_${username}`, username, display_name: username[0].toUpperCase() + username.slice(1) };
            users.set(u.subject, u);
            names.set(username.toLowerCase(), u.subject);
            return u;
        },
        now: () => clock,
        setNow: (t) => { clock = t; },
    };
}

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

    await check('a Network 404 that is not "no such person", or a 400, is an outage (503), never unknown_user', async () => {
        for (const status of [404, 400]) {
            t.network.failIdentity(status);
            try {
                const r = await post(`/robots/${robot.id}/operators`, alex, { username: '@carol', role: 'viewer' });
                const body = await r.text();
                assert.strictEqual(r.status, 503, `${status}: ${body}`);
                assert.match(body, /Network answered/);
            } finally { t.network.failIdentity(null); }
        }
        // The only 404 that means "no such account" is Network's own identity.subject_not_found (the 422 above).
    });

    await check('a non-owner cannot add or remove people (and asks Network nothing)', async () => {
        t.network.failIdentity(500);
        try {
            assert.strictEqual((await post(`/robots/${robot.id}/operators`, bob, { username: '@carol', role: 'viewer' })).status, 403);
            assert.strictEqual((await post(`/robots/${robot.id}/operators/${bob.subject}/remove`, bob)).status, 403);
        } finally { t.network.failIdentity(null); }
    });

    await check('the owner removes a person; the owner row stays', async () => {
        assert.strictEqual((await post(`/robots/${robot.id}/operators/${alex.subject}/remove`, alex)).status, 303);
        assert.ok((await t.domain.members.list(robot.id)).some((m) => m.subject === alex.subject && m.role === 'owner'));
        assert.strictEqual((await post(`/robots/${robot.id}/operators/${bob.subject}/remove`, alex)).status, 303);
        assert.ok(!(await t.domain.members.list(robot.id)).some((m) => m.subject === bob.subject));
    });

    await check('removing an operator drops their live /control socket (form and API)', async () => {
        const { robot: r } = await t.robot(alex, { name: 'Watch' });
        assert.strictEqual((await post(`/robots/${r.id}/operators`, alex, { username: '@bob', role: 'operator' })).status, 303);
        const viaForm = await t.ws('/control', { headers: cookie(bob) });
        viaForm.send({ type: 'join', robot_id: r.id });
        assert.strictEqual((await viaForm.waitFor((m) => m.type === 'joined')).role, 'operator');
        assert.strictEqual((await post(`/robots/${r.id}/operators/${bob.subject}/remove`, alex)).status, 303);
        assert.strictEqual(await viaForm.waitForClose(), 4003, 'the removed operator\'s socket stayed open');

        await t.domain.members.add(r.id, bob.subject, 'operator', alex.subject);
        const viaApi = await t.ws('/control', { headers: cookie(bob) });
        viaApi.send({ type: 'join', robot_id: r.id });
        assert.strictEqual((await viaApi.waitFor((m) => m.type === 'joined')).role, 'operator');
        const del = await t.call('DELETE', `/api/v1/robots/${r.id}/operators/${bob.subject}`, { user: alex });
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual(await viaApi.waitForClose(), 4003, 'the API-removed operator\'s socket stayed open');
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
        const joined = await c.waitFor((m) => m.type === 'joined');
        assert.strictEqual(joined.role, 'queue');
        // A queue member's frame carries their own subject and no other: never the active driver's.
        assert.strictEqual(joined.state.queue.subject, bob.subject);
        assert.ok(!('turn_subject' in joined.state.queue), 'a queue member learned another subject');
        await t.domain.queue.join(q.id, carol.subject);
        const active = await t.domain.queue.state(q.id, bob.subject);
        assert.strictEqual(active.active, true);
        assert.ok(!('turn_subject' in active), 'the active driver\'s subject leaked into a queue view');
        const waiting = await t.domain.queue.state(q.id, carol.subject);
        assert.strictEqual(waiting.subject, carol.subject);
        assert.ok(!('turn_subject' in waiting), 'a waiting member learned the driver\'s subject');

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

    await check('the identity cache is keyed by subject', async () => {
        const s = identityStub();
        const bob = s.add('bob');
        const resolved = await s.identity.byUsername('bob');
        assert.strictEqual(resolved.subject, bob.subject);
        assert.strictEqual(s.calls.resolve, 1);
        // The resolution is cached under the subject: names() for it needs no batch call.
        const cached = await s.identity.names([bob.subject]);
        assert.strictEqual(cached.get(bob.subject).username, 'bob');
        assert.strictEqual(s.calls.batch, 0, 'a resolved subject was looked up again');
        // A subject never resolved is a miss.
        const carol = s.add('carol');
        const fresh = await s.identity.names([carol.subject]);
        assert.strictEqual(fresh.get(carol.subject).username, 'carol');
        assert.strictEqual(s.calls.batch, 1);
    });

    await check('the identity cache expires after its TTL', async () => {
        const s = identityStub();
        const bob = s.add('bob');
        await s.identity.names([bob.subject]);
        await s.identity.names([bob.subject]);
        assert.strictEqual(s.calls.batch, 1, 'a second lookup inside the TTL was not cached');
        s.setNow(s.now() + 5 * 60 * 1000 + 1);
        await s.identity.names([bob.subject]);
        assert.strictEqual(s.calls.batch, 2, 'an expired entry was still served');
    });

    await check('the identity cache holds at most 2000 subjects', async () => {
        const s = identityStub();
        const subjects = [];
        for (let i = 0; i < 2001; i++) subjects.push(s.add(`u${i}`).subject);
        await s.identity.names(subjects);
        const filled = s.calls.batch;
        await s.identity.names([subjects[0]]);          // the oldest was evicted at the bound
        assert.strictEqual(s.calls.batch, filled + 1, 'the cache grew past 2000 entries');
        await s.identity.names([subjects[2000]]);       // the newest is still held
        assert.strictEqual(s.calls.batch, filled + 1);
    });

    await t.close();
    done();
})();
