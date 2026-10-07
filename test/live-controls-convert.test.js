'use strict';
// The one-time OpenVibe.Live controls conversion (plan T15 R9 step 5): the dry-run plan, the writes through
// the domain, idempotency on the Live config id, and the owner/whitelist people rules. The export document
// is a fixture exactly as scripts/live-controls-export.sh emits it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, check, done } = require('./helpers/app');
const { buildPlan, formatPlan, convert } = require('../scripts/convert-live-controls');

const ALICE = 'usr_01J8Z4M2Q0R7T9YV3K6N8P1W2X';
const BOB = 'usr_01J8Z4M2Q0R7T9YV3K6N8P1W2Y';

// Two configs: one owner has a Network subject, the other (user 80) does not. Buttons cover a plain button,
// a hold key with a reserved binding, an over-long label, an ONVIF control and a disabled one; the owner's
// latest stream overrides the first button's label and cooldown; the whitelist has one linked and one
// unlinked user.
const EXPORT = {
    exported_at: '2026-10-07T12:00:00Z',
    configs: [
        { id: 1, user_id: 1, name: 'Camp controls' },
        { id: 2, user_id: 80, name: 'No Network yet' },
    ],
    buttons: [
        { id: 1, config_id: 1, label: 'Wave', command: 'wave', control_type: 'button', key_binding: 'KeyG', cooldown_ms: 500, is_enabled: 1, sort_order: 0 },
        { id: 2, config_id: 1, label: 'Grip', command: 'grip it', control_type: 'keyboard', key_binding: 'w', cooldown_ms: 800, is_enabled: 1, sort_order: 1 },
        { id: 3, config_id: 1, label: 'x'.repeat(50), command: 'Spin Wheel', control_type: 'button', key_binding: null, cooldown_ms: 0, is_enabled: 1, sort_order: 2 },
        { id: 4, config_id: 1, label: 'Pan left', command: 'pan_left', control_type: 'onvif', key_binding: null, cooldown_ms: 100, is_enabled: 1, sort_order: 3 },
        { id: 5, config_id: 1, label: 'Retired', command: 'retired', control_type: 'button', key_binding: null, cooldown_ms: 100, is_enabled: 0, sort_order: 4 },
        { id: 6, config_id: 2, label: 'Go', command: 'go', control_type: 'button', key_binding: null, cooldown_ms: 100, is_enabled: 1, sort_order: 0 },
    ],
    whitelist: [
        { id: 1, user_id: 5, owner_user_id: 1 },
        { id: 2, user_id: 6, owner_user_id: 1 },
    ],
    latest_stream_controls: [
        { id: 11, stream_id: 10, owner_user_id: 1, stream_config_id: 1, label: 'Wave harder', command: 'wave', control_type: 'button', key_binding: 'KeyG', cooldown_ms: 250, is_enabled: 1, sort_order: 0 },
        { id: 12, stream_id: 10, owner_user_id: 1, stream_config_id: 1, label: 'Grip', command: 'grip it', control_type: 'keyboard', key_binding: 'w', cooldown_ms: 800, is_enabled: 1, sort_order: 1 },
        { id: 13, stream_id: 10, owner_user_id: 1, stream_config_id: 1, label: 'x'.repeat(50), command: 'Spin Wheel', control_type: 'button', key_binding: null, cooldown_ms: 0, is_enabled: 1, sort_order: 2 },
        { id: 14, stream_id: 10, owner_user_id: 1, stream_config_id: 1, label: 'Pan left', command: 'pan_left', control_type: 'onvif', key_binding: null, cooldown_ms: 100, is_enabled: 1, sort_order: 3 },
    ],
    owners: [
        { id: 1, username: 'alice', subject_id: ALICE },
        { id: 5, username: 'bob', subject_id: BOB },
        { id: 6, username: 'carol', subject_id: null },
        { id: 80, username: 'dave', subject_id: null },
    ],
};

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-live-'));
    const input = path.join(dir, 'export.json');
    fs.writeFileSync(input, JSON.stringify(EXPORT));
    const log = { log() {}, warn() {}, error() {} };
    let t = null;

    try {
        const plan = buildPlan(EXPORT);
        const cfg = plan.configs[0];
        const skipped = plan.configs[1];

        await check('the dry-run plan names each robot, its buttons, operators and drops', () => {
            assert.deepStrictEqual(plan.summary, { configs: 2, to_convert: 1, skipped: 1, buttons: 3, operators: 1 });
            assert.strictEqual(cfg.status, 'convert');
            assert.strictEqual(cfg.robot.name, 'Camp controls', 'named after the Live config');
            assert.strictEqual(cfg.robot.profile_id, 'relay.generic');
            assert.strictEqual(cfg.robot.access_policy, 'private');
            assert.deepStrictEqual(cfg.buttons.map((b) => b.name), ['wave', 'grip_it', 'spin_wheel']);
            assert.deepStrictEqual(cfg.command_to_name, { wave: 'wave', 'grip it': 'grip_it', 'Spin Wheel': 'spin_wheel' });
            assert.deepStrictEqual(cfg.name_to_command, { wave: 'wave', grip_it: 'grip it', spin_wheel: 'Spin Wheel' });
        });

        await check('the latest stream override wins for label and cooldown', () => {
            assert.deepStrictEqual(cfg.overrides, [{ name: 'wave', command: 'wave', fields: ['label', 'cooldown_ms'] }]);
            assert.strictEqual(cfg.buttons[0].label, 'Wave harder');
            assert.strictEqual(cfg.buttons[0].cooldown_ms, 250);
            assert.ok(cfg.buttons[0].notes.some((n) => /overrides/.test(n)));
        });

        await check('Space never becomes a key; a config with nothing to convert makes no robot; one owner\'s configs get distinct names', () => {
            const owners = [{ id: 7, username: 'erin', subject_id: 'usr_01J8Z4M2Q0R7T9YV3K6N8P1W3A' }];
            const doc = {
                exported_at: '2026-10-07T12:00:00Z', owners, whitelist: [], latest_stream_controls: [],
                configs: [{ id: 21, user_id: 7, name: 'Rig' }, { id: 22, user_id: 7, name: 'Rig' }, { id: 23, user_id: 7, name: 'Empty' }],
                buttons: [
                    { id: 31, config_id: 21, label: 'Honk', command: 'honk', key_binding: 'Space', cooldown_ms: 0, is_enabled: 1, sort_order: 0 },
                    { id: 32, config_id: 22, label: 'Wave', command: 'wave', key_binding: 'g', cooldown_ms: 0, is_enabled: 1, sort_order: 0 },
                    { id: 33, config_id: 23, label: 'Off', command: 'off', key_binding: 'o', cooldown_ms: 0, is_enabled: 0, sort_order: 0 },
                ],
            };
            const p = buildPlan(doc);
            const [a, b, c] = p.configs;
            assert.strictEqual(a.buttons[0].key, null);
            assert.ok(a.buttons[0].notes.some((n) => /dropped: the panel stops the robot/.test(n)));
            assert.deepStrictEqual([a.robot.name, b.robot.name], ['Rig', 'Rig (2)']);
            assert.deepStrictEqual([c.status, c.robot], ['empty', null]);
            assert.strictEqual(p.summary.to_convert, 2);
        });

        await check('a hold key becomes hold, a drive key survives on the relay profile, an over-long label truncated', () => {
            const grip = cfg.buttons[1];
            assert.strictEqual(grip.hold, true);
            assert.strictEqual(grip.key, 'w', 'relay.generic does not drive, so W stays the button\'s key');
            assert.ok(!grip.notes.some((n) => /dropped/.test(n)));
            const spin = cfg.buttons[2];
            assert.strictEqual(spin.label.length, 40);
            assert.ok(spin.notes.some((n) => /truncated/.test(n)));
        });

        await check('an ONVIF control and a disabled button are reported, not converted', () => {
            assert.deepStrictEqual(cfg.dropped.map((d) => d.command).sort(), ['pan_left', 'retired']);
            assert.ok(cfg.dropped.find((d) => d.command === 'pan_left').reason.includes('ONVIF'));
            assert.ok(cfg.dropped.find((d) => d.command === 'retired').reason.includes('disabled'));
        });

        await check('an owner with no Network subject is reported and skipped; so is an unlinked operator', () => {
            assert.strictEqual(skipped.status, 'owner_unlinked');
            assert.ok(/sign in to Network/.test(skipped.reason));
            assert.deepStrictEqual(cfg.operators, [{ id: 5, username: 'bob', subject_id: BOB }]);
            assert.deepStrictEqual(cfg.skipped_operators, [{ id: 6, username: 'carol', reason: 'no Network subject: they must sign in to Network once' }]);
        });

        await check('the printed plan is human-readable', () => {
            const text = formatPlan(plan);
            assert.match(text, /1 to convert, 1 skipped/);
            assert.match(text, /- wave  "Wave harder"  ← "wave"  key KeyG  cooldown 250ms/);
            assert.match(text, /robot "Camp controls"/);
            assert.match(text, /SKIPPED: Live user 80 \(dave\) has no Network subject/);
        });

        await check('a dry run writes nothing', async () => {
            t = await boot({ openre: false });
            const { results } = await convert({ input, apply: false, db: t.db, domain: t.domain, log });
            assert.strictEqual(results, null);
            assert.strictEqual(await t.db.value('SELECT count(*)::int FROM robots'), 0);
            assert.strictEqual(await t.db.value('SELECT count(*)::int FROM live_conversions'), 0);
        });

        let robotId = null;
        await check('--apply creates the robot, its local buttons and the operators', async () => {
            const { results } = await convert({ input, apply: true, db: t.db, domain: t.domain, log });
            assert.deepStrictEqual(results.map((r) => r.outcome), ['converted', 'skipped']);
            robotId = results[0].robot_id;
            const robot = await t.domain.robots.get(robotId);
            assert.strictEqual(robot.owner_subject, ALICE);
            assert.strictEqual(robot.name, 'Camp controls');
            assert.strictEqual(robot.access_policy, 'private');
            assert.ok(robot.profile_id.startsWith('local.rob_'), 'the robot carries a robot-local profile');

            const local = await t.domain.robots.localProfile(robotId);
            assert.strictEqual(local.source_profile_id, 'relay.generic');
            assert.deepStrictEqual(Object.keys(local.profile.commands.button.names), ['wave', 'grip_it', 'spin_wheel']);
            assert.strictEqual(local.profile.commands.button.names.wave.cooldown_ms, 250, 'the stream override is stored');
            assert.strictEqual(local.profile.commands.button.names.grip_it.hold, true);
            assert.strictEqual(local.profile.commands.button.names.grip_it.key, 'w');

            const members = await t.domain.members.list(robotId);
            assert.deepStrictEqual(members.map((m) => [m.subject, m.role]).sort(), [[ALICE, 'owner'], [BOB, 'operator']]);
            // The converted operator can press a converted button through the real gate.
            assert.strictEqual((await t.domain.control.prepare({ robotId, principal: { subject: BOB, kind: 'user' }, kind: 'button', value: { name: 'wave' }, online: true })).ok, true);
            assert.strictEqual(await t.db.value('SELECT count(*)::int FROM robots'), 1, 'the unlinked config made no robot');
        });

        await check('the conversion is recorded, with the Live command → Bot name map in the audit', async () => {
            const row = await t.db.maybe('SELECT robot_id, owner_subject, detail FROM live_conversions WHERE live_config_id = 1');
            assert.ok(row && row.robot_id === robotId && row.owner_subject === ALICE);
            assert.deepStrictEqual(row.detail.command_to_name, { wave: 'wave', 'grip it': 'grip_it', 'Spin Wheel': 'spin_wheel' });
            const audit = (await t.domain.audit.list(robotId, { limit: 10 })).find((a) => a.value && a.value.source === 'openvibe.live');
            assert.ok(audit, 'the conversion wrote an audit row');
            assert.deepStrictEqual(audit.value.commands, { wave: 'wave', 'grip it': 'grip_it', 'Spin Wheel': 'spin_wheel' });
        });

        await check('a second --apply changes nothing and reports "already converted"', async () => {
            const before = await t.db.many('SELECT id FROM robots ORDER BY id');
            const { results } = await convert({ input, apply: true, db: t.db, domain: t.domain, log });
            assert.deepStrictEqual(results.map((r) => r.outcome), ['already_converted', 'skipped']);
            assert.strictEqual(results[0].robot_id, robotId);
            assert.deepStrictEqual(await t.db.many('SELECT id FROM robots ORDER BY id'), before);
            assert.strictEqual(await t.db.value('SELECT count(*)::int FROM live_conversions'), 1);
        });
    } finally {
        if (t) await t.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
