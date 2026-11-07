'use strict';
// Link on the phone (plan 2026-11-07 §13.2): a phone pairs with Network's one-time code under ref `phone:<owner>`,
// binds on Bot as a device of kind 'phone' with no robot and its owner set, is not one of the person's machines, and
// /link/phone shows the code and the app's own link for the QR.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { renderPhoneLinkPage } = require('../server/web/render');

(async () => {
    const t = await boot({});
    const alex = t.network.newUser('alex');

    await check('a phone pairing binds a device of kind phone, owned by the person and serving no robot', async () => {
        const principal = t.network.addNode({ owner: alex.subject, ref: `phone:${alex.subject}`, name: 'Pixel' });
        const r = await t.call('POST', '/api/v1/devices/bind', { token: t.network.signNode(principal) });
        assert.strictEqual(r.status, 201, r.text);
        const d = await t.db.maybe('SELECT * FROM devices WHERE id = $1', [r.json.device_id]);
        assert.strictEqual(d.kind, 'phone');
        assert.deepStrictEqual(d.robot_ids, []);
        assert.deepStrictEqual(d.drivers, []);
        assert.strictEqual(d.owner_subject, alex.subject);
        assert.strictEqual(d.node_principal, principal);
        assert.ok(r.json.robot_id == null, "a phone serves no robot");
    });

    await check('a phone is not listed among the person\'s machines', async () => {
        const worker = t.network.addNode({ owner: alex.subject, ref: `worker:${alex.subject}`, name: 'desk' });
        await t.call('POST', '/api/v1/devices/bind', { token: t.network.signNode(worker) });
        const list = await t.domain.machines.list(alex.subject);
        assert.ok(list.length >= 1, 'the worker machine is there');
        assert.ok(list.every((m) => m.kind !== 'phone'), 'the phone is not a machine');
    });

    await check('mint answers the code and the link the QR carries', async () => {
        const p = await t.domain.phone.mint(alex.subject);
        assert.match(p.code, /^[0-9A-Z]{4}-?[0-9A-Z]{4}$/);
        assert.match(p.pairing_id, /^pair_/);
        assert.strictEqual(p.qr, `openvibe-link://pair?code=${encodeURIComponent(p.code)}&pairing=${encodeURIComponent(p.pairing_id)}`, 'no server in the link: the app has its own');
        assert.doesNotMatch(p.qr, /network=/);
    });

    await check('/link/phone is the person\'s own page, and it shows the code and the app link', async () => {
        const guest = await t.call('GET', '/link/phone');
        assert.ok([302, 401].includes(guest.status), `a guest got ${guest.status}`);
        const html = renderPhoneLinkPage({
            pairing: { code: 'ABCD-1234', expires_at: '2026-11-07T12:00:00Z', qr: 'openvibe-link://pair?code=ABCD-1234&pairing=pair_01JD2C3D4E5F6G7H8J9K0MNPQR' },
        });
        assert.match(html, /ABCD-1234/);
        assert.match(html, /qr-box/);
        assert.match(html, /kind <b>phone<\/b>/);
    });

    done();
})();
