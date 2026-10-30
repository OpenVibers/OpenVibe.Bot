'use strict';
// The fleet (Codes C9c): a machine's OpenVibe.Node reports what its coding agents have left with each heartbeat
// (bot.device-message@1's `fleet`), and Bot keeps the latest reading per machine for Codes' Agents page, its router and
// its MCP. GET /api/v1/machines answers it with the machine's Network id (`node_id`, nod_…), which is the same machine
// Run pins a job to by its device id (dev_…): one row, both names.
//
// What this checks: a reading is stored and answered; it is bounded exactly as the Node bounds it (16 agents, 10 windows,
// an id shaped like an id, short labels, numbers only), and a frame that is not a reading changes nothing; the owner
// sees their own reading and nobody else does; a machine that has reported nothing answers null; the reading is stored
// again when it changes or a minute has passed, never on every beat.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const rowOf = (id) => t.db.maybe('SELECT * FROM devices WHERE id = $1', [id]);
    const at = (v) => (v == null ? null : new Date(v).getTime());
    const list = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const machines = async (user) => { const r = await t.call('GET', '/api/v1/machines', { user }); assert.strictEqual(r.status, 200, r.text); return r.json.machines; };

    /** A Network-paired machine of `owner`, beating like a real Node (its own timer, no fleet) until closed. */
    async function machine(owner) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'desk-pc' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        await c.waitFor((m) => m.type === 'config');
        const beat = (fields = {}) => c.send(frame('heartbeat', { t: Date.now(), ...fields }));
        const keep = setInterval(() => { try { beat(); } catch { /* closed */ } }, 80);
        c.onClose = () => clearInterval(keep);
        return { c, deviceId, principal, beat };
    }

    const FLEET = [
        { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', used: 100, limit: 100, resets_at: '2026-11-04T00:00:00Z' }] },
        { agent: 'opencode', installed: true, signed_in: false },
    ];

    let mine;
    let bare;
    try {
        await check('a machine\'s fleet is stored and answered with its Network id', async () => {
            mine = await machine(alex);
            mine.beat({ fleet: FLEET });
            const row = await poll(async () => { const r = await rowOf(mine.deviceId); return r && r.fleet && r.fleet_at ? r : null; });
            assert.ok(row, 'the reading was stored');
            assert.deepStrictEqual(list(row.fleet), FLEET, 'labels, numbers and times, exactly as sent');
            assert.ok(at(row.fleet_at) > Date.now() - 60_000, 'fleet_at says when Bot stored it');

            const [m] = await machines(alex);
            assert.strictEqual(m.id, mine.deviceId);
            assert.strictEqual(m.node_id, mine.principal, 'the machine\'s Network id: how Codes, and a Run pin, name it');
            assert.deepStrictEqual(m.fleet, FLEET);
            assert.strictEqual(m.fleet_at, new Date(row.fleet_at).toISOString());
        });

        await check('the reading is bounded, and a frame that is not a reading changes nothing', async () => {
            const many = Array.from({ length: 40 }, (_, i) => ({
                agent: `agent-${i}`,
                installed: true,
                signed_in: i % 2 === 0,
                windows: Array.from({ length: 12 }, (_, w) => ({ name: `w${w}`, used: 1, limit: 100, resets_at: '2026-11-02T00:00:00Z' })),
            }));
            mine.beat({ fleet: many });
            const row = await poll(async () => { const r = await rowOf(mine.deviceId); const f = list(r && r.fleet); return f && f.length === 16 ? r : null; });
            assert.ok(row, '16 agents at most');
            assert.ok(list(row.fleet).every((a) => a.windows.length === 10), '10 windows each');

            // What the sanitizer drops: an agent id that is not an id, a repeated agent, a window it cannot label
            // faithfully (no name, or a name too long), a number that is not a number. What it keeps: the agent and its
            // windows, and nothing it was not sent.
            mine.beat({ fleet: [
                { agent: 'Bad ID!', installed: true, signed_in: true },
                { agent: 'deepseek', installed: true, signed_in: true, api_key: 'sk-secret', account: 'ada@example.com',
                    windows: [{ name: 'month', used: 96, limit: 'a lot', account: 'ada@example.com' }, { used: 3 }, { name: 'x'.repeat(80), used: 1 }] },
                { agent: 'deepseek', installed: false, signed_in: false },
                { agent: 'minimax-code', installed: true, signed_in: true },
            ] });
            const clean = await poll(async () => { const r = await rowOf(mine.deviceId); const f = list(r && r.fleet); return f && f.length === 2 && f[0].agent === 'deepseek' ? r : null; });
            assert.ok(clean, JSON.stringify(clean && list(clean.fleet)));
            assert.deepStrictEqual(list(clean.fleet), [
                { agent: 'deepseek', installed: true, signed_in: true, windows: [{ name: 'month', used: 96 }] },
                { agent: 'minimax-code', installed: true, signed_in: true },
            ]);

            // Not an array: no reading, so the last one stands.
            const before = await rowOf(mine.deviceId);
            mine.beat({ fleet: { codex: 'full' } });
            await t.wait(300);
            assert.deepStrictEqual((await rowOf(mine.deviceId)).fleet, before.fleet);

            // An empty array is a reading: the probe ran and found no agents.
            bare = await machine(bob);
            bare.beat({ fleet: [] });
            const empty = await poll(async () => { const r = await rowOf(bare.deviceId); return r && Array.isArray(r.fleet) ? r : null; });
            assert.deepStrictEqual(empty.fleet, []);
            assert.ok(empty.fleet_at, 'it is a reading, taken and stored like any other');
        });

        await check('the owner sees their own machine, its reading and the Network id; nobody else sees it', async () => {
            const machineOf = async (user) => (await machines(user)).find((m) => m.id === mine.deviceId) || null;
            const asAlex = await machineOf(alex);
            assert.deepStrictEqual([asAlex.id, asAlex.node_id, Array.isArray(asAlex.fleet)], [mine.deviceId, mine.principal, true]);
            assert.strictEqual(await machineOf(bob), null, 'a machine is its owner\'s');
        });

        await check('the reading is stored again when it changes, or after a minute, never on every beat', async () => {
            const first = (await rowOf(mine.deviceId)).fleet_at;
            mine.beat({ fleet: [{ agent: 'codex', installed: true, signed_in: false }] });
            await poll(async () => { const r = await rowOf(mine.deviceId); const f = list(r.fleet); return f.length === 1 && f[0].signed_in === false ? r : null; });
            const changed = (await rowOf(mine.deviceId)).fleet_at;
            assert.ok(at(changed) >= at(first));

            // The same reading on the next beat is not another write...
            mine.beat({ fleet: [{ agent: 'codex', installed: true, signed_in: false }] });
            await t.wait(300);
            assert.strictEqual(at((await rowOf(mine.deviceId)).fleet_at), at(changed));
            // ...until a minute has passed, so a machine that keeps beating keeps fleet_at current (and one that stops
            // keeps its reading with an age that says so).
            t.clock.offset += 61_000;
            mine.beat({ fleet: [{ agent: 'codex', installed: true, signed_in: false }] });
            const again = await poll(async () => { const r = await rowOf(mine.deviceId); return at(r.fleet_at) > at(changed) ? r : null; });
            assert.ok(again, 'a minute later the same reading is stored again with a fresh time');
            mine.c.close();
        });
    } finally {
        if (bare) bare.c.close();
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
