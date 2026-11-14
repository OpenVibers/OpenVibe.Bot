'use strict';
// What a machine is (OpenVibe Link v0.66 sends `machine` with its status; 2026-11-14): Bot keeps it bounded in
// devices.specs, the owner's machine shows it with one line of words, and the desk hosts Run places on carry the few
// facts placement weighs. Junk is dropped, never stored.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const specs = require('../server/machine-specs');

const NODE01 = {
    os_name: 'Ubuntu', os_version: '26.04', kernel: '7.0.0-34-generic', arch: 'amd64',
    cpu: { model: 'Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz', cores: 4, threads: 8 }, memory_mb: 15932,
    gpus: [{ vendor: 'AMD', model: 'FirePro W4100', vram_mb: 2048 }, { vendor: 'Intel', model: 'HD Graphics 630' }],
    disk_total_gb: 512.1, disk_free_gb: 133.4, virtualization: { kvm: true }, display: 'none',
};

(async () => {
    await check('clean keeps the known fields, typed and bounded, and drops junk', async () => {
        const c = specs.clean({ ...NODE01, serial: 'ABC123', cpu: { ...NODE01.cpu, threads: '8' }, gpus: [...NODE01.gpus, { model: 'x'.repeat(500) }, 'nope', { vendor: 'NoModel' }], display: 'teletype', os_name: 'Ubuntu\u0007' });
        assert.ok(!('serial' in c), 'nothing it does not know');
        assert.deepStrictEqual([c.os_name, c.cpu.threads, c.gpus.length, c.gpus[2].model.length, c.display, c.virtualization.kvm], ['Ubuntu', 8, 3, 120, null, true]);
        assert.strictEqual(specs.clean(null), null);
        assert.strictEqual(specs.clean({ display: 'x11' }), null, 'nothing usable');
        assert.strictEqual(specs.words(specs.clean(NODE01)), 'Intel Core i7-7700 · 8 threads · 16 GB · FirePro W4100 2 GB · Ubuntu 26.04');
        assert.deepStrictEqual(specs.summary(specs.clean(NODE01)), { memory_mb: 15932, threads: 8, gpu: 'FirePro W4100', gpu_vram_mb: 2048, disk_free_gb: 133.4, kvm: true, apple_vz: false, hyperv: false });
    });

    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_OFFLINE_GRACE_MS: '30000' } });
    const alex = t.network.newUser('alex');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };

    await check('a Link\'s status carries what the machine is: stored, shown, and given to placement', async () => {
        const principal = t.network.addNode({ owner: alex.subject, ref: `worker:${alex.subject}`, name: 'ov-node-01' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        await c.waitFor((m) => m.type === 'config');
        const computer = { desk: { level: 'trusted', input: true, screen: true, named: true, max_desks: 2, kinds: ['browser'], profiles: true } };
        c.send(frame('status', { capabilities: { computer }, drivers: [], faults: [], agent_version: 'v0.66.0', machine: { ...NODE01, serial: 'nope' } }));
        const row = await poll(async () => { const d = await t.db.maybe('SELECT specs, specs_at FROM devices WHERE id = $1', [deviceId]); return d && d.specs ? d : null; });
        assert.ok(row && row.specs_at, 'stored with its time');
        assert.strictEqual(row.specs.cpu.threads, 8);
        assert.ok(!('serial' in row.specs));
        const m = (await t.call('GET', '/api/v1/machines', { user: alex })).json.machines.find((x) => x.id === deviceId);
        assert.strictEqual(m.specs_words, 'Intel Core i7-7700 · 8 threads · 16 GB · FirePro W4100 2 GB · Ubuntu 26.04');
        assert.strictEqual(m.specs.memory_mb, 15932);
        await poll(() => t.hub.computerOf(deviceId) !== null);
        await t.domain.machines.setAgentComputer(deviceId, true);
        const hosts = (await t.call('GET', '/api/v1/desk-hosts', { token: t.network.signService({ sub: 'svc:run', cap: ['bot.desk.session'] }), headers: { 'X-OV-Subject': alex.subject } })).json.hosts;
        assert.deepStrictEqual(hosts.find((h) => h.machine_id === deviceId).specs, specs.summary(row.specs), 'placement weighs memory, threads, GPU and virtualization');
        // The same reading again writes nothing.
        const before = (await t.db.maybe('SELECT specs_at FROM devices WHERE id = $1', [deviceId])).specs_at;
        c.send(frame('status', { capabilities: { computer }, drivers: [], faults: [], machine: NODE01 }));
        await t.wait(300);
        assert.strictEqual(String((await t.db.maybe('SELECT specs_at FROM devices WHERE id = $1', [deviceId])).specs_at), String(before));
        c.close();
    });

    await done(t);
})();
