'use strict';
// The machines hub (plan L34, step M2): Bot stays the registry of the machines. A person sees their own
// machines and nobody else's; the network's hub (a service holding bot.machine.manage) acts for a person it
// names in X-OV-Subject; a role outside the catalogue is refused; a pairing code is one code for the person;
// the roles reach the Node in its config frame; and a machine's online state is reported to Network once per
// change.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const sam = t.network.newUser('sam');

    /** A worker machine of `owner`, paired on Network and bound here, so Bot has a device row for it. */
    async function machine(owner, { name = 'garage-pi' } = {}) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name });
        const r = await t.call('POST', '/api/v1/devices/bind', { token: t.network.signNode(principal) });
        assert.strictEqual(r.status, 201, r.text);
        return { id: r.json.device_id, principal };
    }
    /** The hub's own call: the service that fronts Bot for a person. */
    const hub = (path, { body, subject = alex.subject, cap = ['bot.machine.manage'] } = {}) =>
        t.call(path.method, path.url, { body, sub: 'svc:network', cap, headers: { 'X-OV-Subject': subject } });

    const alexMachine = await machine(alex);
    const samMachine = await machine(sam, { name: 'sam-pi' });

    await check('a person sees their own machines and nobody else\'s', async () => {
        const mine = await t.call('GET', '/api/v1/machines', { user: alex });
        assert.strictEqual(mine.status, 200, mine.text);
        assert.deepStrictEqual(mine.json.machines.map((m) => m.id), [alexMachine.id]);
        assert.strictEqual(mine.json.machines[0].name, 'garage-pi');
        assert.strictEqual(mine.json.machines[0].roles.length, 0);
        assert.deepStrictEqual(mine.json.machines[0].running, []);
        const theirs = await t.call('GET', '/api/v1/machines', { user: sam });
        assert.deepStrictEqual(theirs.json.machines.map((m) => m.id), [samMachine.id]);
        // One machine of another person is not there at all, never a 403 that says it exists.
        const one = await t.call('GET', `/api/v1/machines/${samMachine.id}`, { user: alex });
        assert.strictEqual(one.status, 404, one.text);
        assert.strictEqual(one.json.code, 'bot.device_not_found');
    });

    await check('the hub acts for the person: rename, roles and revoke reach Bot as them', async () => {
        const renamed = await hub({ method: 'PATCH', url: `/api/v1/machines/${alexMachine.id}` }, { body: { name: 'Studio' } });
        assert.strictEqual(renamed.status, 200, renamed.text);
        assert.strictEqual(renamed.json.machine.name, 'Studio');
        const roles = await hub({ method: 'PUT', url: `/api/v1/machines/${alexMachine.id}/roles` }, { body: { roles: ['codes.worker'] } });
        assert.strictEqual(roles.status, 200, roles.text);
        assert.deepStrictEqual(roles.json.machine.roles, ['codes.worker']);
        const row = await t.db.maybe('SELECT name, roles FROM devices WHERE id = $1', [alexMachine.id]);
        assert.strictEqual(row.name, 'Studio');
        assert.deepStrictEqual(row.roles, ['codes.worker']);
    });

    await check('the hub needs the capability and the person, and never another person\'s machine', async () => {
        const noCap = await t.call('PATCH', `/api/v1/machines/${alexMachine.id}`, { body: { name: 'Nope' }, sub: 'svc:network', cap: ['bot.read'], headers: { 'X-OV-Subject': alex.subject } });
        assert.strictEqual(noCap.status, 403, noCap.text);
        assert.strictEqual(noCap.json.code, 'capability.denied');
        const noSubject = await t.call('PATCH', `/api/v1/machines/${alexMachine.id}`, { body: { name: 'Nope' }, sub: 'svc:network', cap: ['bot.machine.manage'] });
        assert.strictEqual(noSubject.status, 422, noSubject.text);
        const other = await hub({ method: 'PATCH', url: `/api/v1/machines/${samMachine.id}` }, { body: { name: 'Stolen' } });
        assert.strictEqual(other.status, 404, other.text);
        assert.strictEqual(other.json.code, 'bot.device_not_found');
        const same = await t.call('PATCH', `/api/v1/machines/${samMachine.id}`, { body: { name: 'Stolen' }, user: alex });
        assert.strictEqual(same.status, 404, same.text);
    });

    await check('the hub is the network\'s own service: another service with the capability is refused', async () => {
        // The capability alone must not be enough: any service holding it could name any person in X-OV-Subject
        // and act as them, so only the network's own service may.
        const other = (path, body) => t.call(path.method, path.url, { body, sub: 'svc:codes', cap: ['bot.machine.manage'], headers: { 'X-OV-Subject': alex.subject } });
        const list = await other({ method: 'GET', url: '/api/v1/machines' });
        assert.strictEqual(list.status, 403, list.text);
        assert.strictEqual(list.json.code, 'bot.forbidden');
        const renamed = await other({ method: 'PATCH', url: `/api/v1/machines/${alexMachine.id}` }, { name: 'Stolen' });
        assert.strictEqual(renamed.status, 403, renamed.text);
        assert.strictEqual(renamed.json.code, 'bot.forbidden');
        const roles = await other({ method: 'PUT', url: `/api/v1/machines/${alexMachine.id}/roles` }, { roles: ['codes.worker'] });
        assert.strictEqual(roles.status, 403, roles.text);
        assert.strictEqual(roles.json.code, 'bot.forbidden');
        const pairing = await other({ method: 'POST', url: '/api/v1/machines/pairings' }, {});
        assert.strictEqual(pairing.status, 403, pairing.text);
        assert.strictEqual(pairing.json.code, 'bot.forbidden');
        // Nothing of the person's changed.
        const row = await t.db.maybe('SELECT name, roles FROM devices WHERE id = $1', [alexMachine.id]);
        assert.strictEqual(row.name, 'Studio');
        assert.deepStrictEqual(row.roles, ['codes.worker']);
    });

    await check('a role outside the catalogue is refused and nothing is stored', async () => {
        const before = await t.db.maybe('SELECT roles FROM devices WHERE id = $1', [alexMachine.id]);
        const bad = await hub({ method: 'PUT', url: `/api/v1/machines/${alexMachine.id}/roles` }, { body: { roles: ['codes.worker', 'nope.nope'] } });
        assert.strictEqual(bad.status, 422, bad.text);
        assert.strictEqual(bad.json.code, 'bot.unknown_role');
        const after = await t.db.maybe('SELECT roles FROM devices WHERE id = $1', [alexMachine.id]);
        assert.deepStrictEqual(after.roles, before.roles, 'the roles are left as they were');
        // A role in the catalogue but of another shape is refused too.
        const shape = await hub({ method: 'PUT', url: `/api/v1/machines/${alexMachine.id}/roles` }, { body: { roles: 'codes.worker' } });
        assert.strictEqual(shape.status, 422, shape.text);
    });

    await check('a pairing is one code for the person, with the command to run', async () => {
        const r = await hub({ method: 'POST', url: '/api/v1/machines/pairings' }, { body: {} });
        assert.strictEqual(r.status, 201, r.text);
        const p = r.json.pairing;
        assert.match(p.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, p.code);
        assert.ok(p.expires_at && new Date(p.expires_at) > new Date(), 'the code has an expiry');
        assert.match(p.installer, /--pairing/, p.installer);
        // Network is the authority for the code: it minted it for this person and this worker ref.
        const minted = t.network.pairings[t.network.pairings.length - 1];
        assert.strictEqual(minted.body.owner.subject, alex.subject);
        assert.strictEqual(minted.body.ref, `worker:${alex.subject}`);
        // Another person gets another code, for them.
        const other = await hub({ method: 'POST', url: '/api/v1/machines/pairings' }, { body: {}, subject: sam.subject });
        assert.strictEqual(other.status, 201, other.text);
        assert.notStrictEqual(other.json.pairing.code, p.code);
        // A person may pair for themself without the hub.
        const own = await t.call('POST', '/api/v1/machines/pairings', { user: alex, body: {} });
        assert.strictEqual(own.status, 201, own.text);
    });

    await check('the roles reach the Node in its config frame', async () => {
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(alexMachine.principal)}` } });
        const config = await c.waitFor((m) => m.type === 'config');
        assert.ok(config, 'the machine gets its config');
        assert.deepStrictEqual(config.roles, ['codes.worker']);
        // A change while it is connected reaches it at once.
        await hub({ method: 'PUT', url: `/api/v1/machines/${alexMachine.id}/roles` }, { body: { roles: ['codes.worker', 'desks.host'] } });
        const again = await c.waitFor((m) => m.type === 'config' && Array.isArray(m.roles) && m.roles.length === 2);
        assert.ok(again, 'the new roles are pushed');
        assert.deepStrictEqual(again.roles, ['codes.worker', 'desks.host']);
        c.close();
    });

    await check('a machine\'s online state is reported to Network once per change', async () => {
        // Its own machine (another person's, so the list of alex's machines stays as it was): the reports of the
        // other machines (a connection above, its close) are not this one's.
        const own = await machine(sam, { name: 'attic-pi' });
        const of = (s) => s.body.machine_id === own.id;
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(own.principal)}` } });
        await c.waitFor((m) => m.type === 'config');
        for (let i = 0; i < 40 && !t.network.statuses.some((s) => of(s) && s.body.online === true); i++) await t.wait(25);
        const online = t.network.statuses.filter((s) => of(s) && s.body.online === true);
        assert.strictEqual(online.length, 1, 'the machine is reported online once');
        assert.strictEqual(online[0].body.owner, sam.subject);
        c.close();
        for (let i = 0; i < 40 && !t.network.statuses.some((s) => of(s) && s.body.online === false); i++) await t.wait(25);
        const offline = t.network.statuses.filter((s) => of(s) && s.body.online === false);
        assert.strictEqual(offline.length, 1, 'the machine is reported offline once');
    });

    await check('revoking a machine ends it for good', async () => {
        const r = await hub({ method: 'POST', url: `/api/v1/machines/${alexMachine.id}/revoke` }, { body: {} });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(t.network.revokes.includes(alexMachine.principal), 'the node principal on Network is revoked too');
        const row = await t.db.maybe('SELECT revoked_at FROM devices WHERE id = $1', [alexMachine.id]);
        assert.ok(row.revoked_at, 'the device is revoked');
        const after = await t.call('GET', '/api/v1/machines', { user: alex });
        assert.deepStrictEqual(after.json.machines.map((m) => m.id), [], 'a revoked machine is not listed');
    });

    await t.close();
    done();
})();
