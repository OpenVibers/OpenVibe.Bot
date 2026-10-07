'use strict';
// Robot-owned profiles, the button/point gate and the server-rendered controls. No HTTP listener.
const assert = require('assert');
const { check, done } = require('./helpers/app');
const { testDb } = require('./helpers/db');
const { seedProfiles, loadProfiles, listProfiles, validateProfile } = require('../server/profiles');
const { createDomain } = require('../server/domain');
const { prefixedId } = require('../server/util');
const { renderPanel } = require('../server/web/render');

(async () => {
    const store = await testDb();
    const db = store.db;
    await seedProfiles(db, { log: { log() {} } });
    let clock = Date.now();
    const id = prefixedId('rob', clock);
    const owner = { subject: 'usr_owner', kind: 'user' };
    const operator = { subject: 'usr_operator', kind: 'user' };
    const at = new Date(clock).toISOString();
    await db.query(`INSERT INTO robots (id, owner_subject, name, profile_id, profile_version, access_policy, limits, created_at, updated_at)
        VALUES ($1, $2, 'Test robot', 'sim.rover', 1, 'invite', '{"cooldown_ms":0}', $3, $3)`, [id, owner.subject, at]);
    await db.query(`INSERT INTO robot_operators (robot_id, subject, role, created_at) VALUES ($1, $2, 'owner', $4), ($1, $3, 'operator', $4)`,
        [id, owner.subject, operator.subject, at]);
    const domain = createDomain({ db, outbox: null, now: () => clock,
        config: { control: { cooldownMs: 0, maxCommandMs: 300 }, device: { heartbeatMs: 1000 }, media: {} } });

    try {
        await check('every existing catalogue profile still loads under the contract', () => {
            assert.deepStrictEqual([...loadProfiles().keys()].sort(), ['adeept.adr036', 'adeept.adr036.mecanum', 'camera.onvif', 'cozmo', 'relay.generic', 'sim.rover']);
        });

        await check('an operator cannot edit or switch the robot-owned profile', async () => {
            await assert.rejects(domain.robots.saveLocalProfile(id, operator, { buttons: { go: { label: 'Go' } } }), (e) => e.status === 403);
            assert.strictEqual(await domain.robots.localProfile(id), null);
        });

        await check('schema-invalid local profiles are never stored', async () => {
            await assert.rejects(domain.robots.saveLocalProfile(id, owner, { buttons: { go: { label: 'x'.repeat(41) } } }), (e) => e.status === 422);
            // The drive and stop keys stay with driving: a button never takes Space, WASD, Q/E or an arrow.
            for (const key of ['Space', ' ', 'w', 'KeyD', 'ArrowUp', 'e', 'Escape'])
                await assert.rejects(domain.robots.saveLocalProfile(id, owner, { buttons: { go: { label: 'Go', key } } }),
                    (e) => e.status === 422 && /stops the robot|drives the robot/.test(e.detail || e.message), `key ${JSON.stringify(key)}`);
            assert.strictEqual(await domain.robots.localProfile(id), null);
            assert.strictEqual((await domain.robots.get(id)).profile_id, 'sim.rover');
        });

        await check('owner saves a local profile; its contract, ownership and audit are stored', async () => {
            const p = await domain.robots.saveLocalProfile(id, owner, { buttons: {
                go: { label: 'Go', key: 'KeyG', cooldown_ms: 1000 },
                grab: { label: 'Grab', hold: true, cooldown_ms: 800 },
            }, point: { cooldown_ms: 500 } });
            assert.ok(p.id.startsWith('local.rob_'));
            assert.ok(validateProfile(p));
            const row = await db.maybe('SELECT robot_id, source_profile_id FROM robot_profiles WHERE id = $1', [p.id]);
            assert.strictEqual(row.robot_id, id);
            assert.strictEqual(row.source_profile_id, 'sim.rover');
            assert.strictEqual((await domain.robots.get(id)).profile_id, p.id);
            assert.strictEqual((await domain.audit.list(id, { limit: 1 }))[0].kind, 'profile.local');
            assert.ok(!(await listProfiles(db)).some((x) => x.id === p.id), 'the local profile is absent from the public catalogue');
            const atBoot = await db.many(`SELECT r.id FROM robots r JOIN robot_profiles p
                ON p.id = r.profile_id AND p.version = r.profile_version WHERE p.profile->'mapping'->>'driver' = 'sim'`);
            assert.ok(atBoot.some((x) => x.id === id), 'the local simulator profile attaches at boot');
        });

        const gate = (principal, kind, value) => domain.control.prepare({ robotId: id, principal, kind, value, online: true });
        await check('button names and states, hold deadline, and per-button cooldown', async () => {
            assert.strictEqual((await gate(owner, 'button', { name: 'missing' })).code, 'bot.command_not_allowed');
            assert.strictEqual((await gate(owner, 'button', { name: 'go', state: 'down' })).code, 'bot.invalid_input');
            assert.strictEqual((await gate(owner, 'button', { name: 'go', state: null })).code, 'bot.invalid_input');
            assert.strictEqual((await gate(owner, 'button', { name: 'grab' })).code, 'bot.invalid_input');
            assert.strictEqual((await gate(owner, 'button', { name: 'grab', state: 'sideways' })).code, 'bot.invalid_input');
            assert.strictEqual((await gate(operator, 'button', { name: 'go' })).ok, true);
            assert.strictEqual((await gate(operator, 'button', { name: 'go' })).code, 'bot.cooldown');
            const down = await gate(operator, 'button', { name: 'grab', state: 'down' });
            assert.ok(down.ok && down.deadlineMs > clock);
            assert.strictEqual((await gate(operator, 'button', { name: 'grab', state: 'down' })).ok, true, 'held resend renews the deadman');
            assert.strictEqual((await gate(operator, 'button', { name: 'grab', state: 'up' })).ok, true, 'release passes cooldown');
            assert.strictEqual((await gate(operator, 'button', { name: 'grab', state: 'down' })).code, 'bot.cooldown');
            clock += 1001;
            assert.strictEqual((await gate(operator, 'button', { name: 'go' })).ok, true);
        });

        await check('point requires declaration and coordinates inside the displayed box', async () => {
            for (const value of [{ x: -0.1, y: 0 }, { x: 1.1, y: 0 }, { x: 0, y: NaN }, { x: 0.5 }, { x: '0.5', y: 0.5 }])
                assert.strictEqual((await gate(operator, 'point', value)).code, 'bot.invalid_input');
            assert.strictEqual((await gate(operator, 'point', { x: 0, y: 1 })).ok, true);
            assert.strictEqual((await gate(operator, 'point', { x: 1, y: 0 })).code, 'bot.cooldown');
            await domain.robots.saveLocalProfile(id, owner, { buttons: { go: { label: 'Go' } }, point: null });
            assert.strictEqual((await gate(operator, 'point', { x: 0.5, y: 0.5 })).code, 'bot.command_not_allowed');
        });

        await check('panel and embed show declared labels; viewers have disabled buttons', async () => {
            const p = await domain.robots.saveLocalProfile(id, owner, { buttons: { go: { label: 'Go' }, grab: { label: 'Grab', hold: true } }, point: {} });
            const robot = domain.present.robot(await domain.robots.get(id));
            const ownerHtml = renderPanel({ robot, profile: p, role: 'owner', allowed_commands: ['button', 'point'] });
            assert.match(ownerHtml, /data-button-name="go"[^>]*><span>Go<\/span><\/button>/);
            assert.match(ownerHtml, /data-button-name="grab"[^>]*><span>Grab<\/span><\/button>/);
            assert.match(ownerHtml, /<section class="widget widget-buttons" data-widget="buttons"[^>]*><h2>buttons<\/h2>/, 'a titled card like every widget');
            assert.ok(ownerHtml.includes('data-video-click'));
            assert.ok(ownerHtml.includes('data-profile-form'));
            const viewerHtml = renderPanel({ robot, profile: p, role: 'watcher', allowed_commands: [], mode: 'embed' });
            assert.match(viewerHtml, /data-button-name="go"[^>]*disabled><span>Go<\/span><\/button>/);
            assert.ok(!viewerHtml.includes('data-video-click') && !viewerHtml.includes('data-profile-form'));
        });

        await check('only the owner can return to the catalogue profile, with an audit row', async () => {
            await assert.rejects(domain.robots.useCatalogueProfile(id, operator), (e) => e.status === 403);
            await domain.robots.useCatalogueProfile(id, owner);
            assert.strictEqual((await domain.robots.get(id)).profile_id, 'sim.rover');
            assert.strictEqual((await domain.audit.list(id, { limit: 1 }))[0].kind, 'profile.catalogue');
        });
    } finally {
        await store.close();
    }
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
