'use strict';
// Robot profiles (ADR-043 decision 7): every shipped profile validates, the registries refuse typos, and
// every panel control produces only commands the matching device plugin accepts (names, shapes, ranges).
const assert = require('assert');
const { check, done } = require('./helpers/app');
const { loadProfiles, validateProfile } = require('../server/profiles');
const { createDomain } = require('../server/domain');
const plugins = require('./helpers/plugins');

// The gate's value builder needs no database: only the limits and the profile.
const domain = createDomain({ db: null, outbox: null, config: { control: { maxCommandMs: 300, cooldownMs: 0 }, device: { heartbeatMs: 1000 }, media: {} } });
const build = (profile, kind, value, limits = {}) => domain.control.buildValue(kind, value, domain.control.effectiveLimits({ limits }, profile), profile);
// The panel widgets that send commands; each must say which.
const CONTROL_WIDGETS = new Set(['drive', 'pan-tilt', 'servo', 'lights', 'horn', 'speaker', 'display', 'ptz', 'head', 'lift']);
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** What an operator might send through a control: in range, at the edges, beyond them, and odd shapes. */
function samples(profile, kind, names) {
    const spec = profile.commands[kind];
    if (kind === 'halt') return [{}, null];
    if (kind === 'drive' || kind === 'ptz') {
        const axes = Object.keys(spec.axes);
        const out = [Object.fromEntries(axes.map((a) => [a, 0.5]))];
        for (const a of axes) out.push({ [a]: 7 }, { [a]: -7 }, { [a]: spec.axes[a][1] });
        if (kind === 'drive') out.push({}, { speed: 0.4, turn: -0.2 }, { throttle: 0.3, x: 0.3, rotation: -9, y: 2 });
        return out;
    }
    if (kind === 'actuator') {
        const out = [];
        for (const name of names) {
            const a = spec.names[name];
            const values = a.type === 'number' ? [a.range[0] - 1, a.range[0], (a.range[0] + a.range[1]) / 2, a.range[1], a.range[1] + 5]
                : a.type === 'rgb' ? [{ r: 300, g: -4, b: 12.6 }, { r: 0, g: 128, b: 255 }, null, false, ...(a.count ? [{ r: 1, g: 2, b: 3, index: a.count - 1 }] : [])]
                    : a.type === 'tone' ? [{ note: 'A4' }, { note: 'C5' }, { note: 'C9' }, { hz: 100000 }, { hz: 1 }, { hz: 0 }, null, 0]
                        : [true, false];
            for (const value of values) out.push({ name, value });
        }
        return out;
    }
    if (kind === 'say') return [{ text: 'hello there' }, { text: '  padded  ' }];
    const out = [];   // display
    if (spec.modes.includes('text')) out.push({ text: 'hi' });
    if (spec.modes.includes('face')) for (const face of spec.faces) out.push({ face }, { face: face.toUpperCase() });
    if (spec.modes.includes('image_png_b64')) out.push({ image_png_b64: PNG }, { image_png_b64: PNG, text: 'both' });
    return out;
}

(async () => {
    const profiles = loadProfiles();

    await check('the five shipped profiles load and validate', () => {
        assert.deepStrictEqual([...profiles.keys()].sort(), ['adeept.adr036', 'adeept.adr036.mecanum', 'camera.onvif', 'cozmo', 'sim.rover']);
        for (const p of profiles.values()) {
            assert.ok(p.capabilities.length > 0, `${p.id} capabilities`);
            assert.ok(p.widgets.length > 0, `${p.id} widgets`);
            assert.ok(p.limits.max_speed > 0 && p.limits.max_turn > 0);
        }
    });

    await check('adeept.adr036 maps the pca9685 at 0x5f, motor channels 8–15, servos 0/1, ADS7830 battery', () => {
        const p = profiles.get('adeept.adr036');
        assert.strictEqual(p.mapping.driver, 'pca9685');
        assert.strictEqual(p.mapping.address, '0x5f');
        assert.deepStrictEqual(p.mapping.motor_channels, [8, 9, 10, 11, 12, 13, 14, 15]);
        assert.deepStrictEqual(p.mapping.servo_channels, { pan: 0, tilt: 1 });
        assert.strictEqual(p.mapping.battery.driver, 'ads7830');
        assert.strictEqual(p.mapping.battery.address, '0x48');
        assert.strictEqual(p.mapping.wheels, 'ordinary');
        assert.deepStrictEqual(Object.keys(p.commands.drive.axes), ['throttle', 'steer']);
        const m = profiles.get('adeept.adr036.mecanum');
        assert.strictEqual(m.mapping.wheels, 'mecanum');
        assert.deepStrictEqual(m.mapping.motor_channels, p.mapping.motor_channels);
        assert.deepStrictEqual(Object.keys(m.commands.drive.axes), ['x', 'y', 'rotation'], 'the mecanum chassis strafes');
    });

    await check('cozmo carries drive, head, lift, say, display, lights, cliff/pick-up and a 320x240 camera, and no animations', () => {
        const p = profiles.get('cozmo');
        for (const c of ['drive.differential', 'head', 'lift', 'speaker.say', 'display.text', 'lights.backpack', 'lights.cube', 'battery', 'sensor.cliff', 'sensor.pickup', 'camera']) {
            assert.ok(p.capabilities.includes(c), `cozmo has ${c}`);
        }
        assert.strictEqual(p.mapping.driver, 'cozmo');
        assert.ok(!p.capabilities.includes('display.animation') && !p.mapping.animations, 'the plugin implements no animations');
        assert.deepStrictEqual(p.commands.display.modes, ['text', 'face', 'image_png_b64']);
        assert.deepStrictEqual(p.commands.actuator.names.lift.range, [0, 1]);
        assert.strictEqual(p.camera.resolution, '320x240');
    });

    await check('camera.onvif is PTZ only and sim.rover is drive + camera', () => {
        assert.deepStrictEqual(profiles.get('camera.onvif').capabilities.slice().sort(), ['camera', 'ptz']);
        assert.deepStrictEqual(profiles.get('sim.rover').capabilities.slice().sort(), ['camera', 'drive.differential']);
    });

    await check('limits default to max_command_ms 300 and heartbeat_ms 1000', () => {
        const v = validateProfile({ id: 'x.y', version: 1, name: 'X', capabilities: ['camera'], mapping: { driver: 'sim' }, widgets: [{ type: 'camera', capability: 'camera' }] });
        assert.strictEqual(v.limits.max_command_ms, 300);
        assert.strictEqual(v.limits.heartbeat_ms, 1000);
    });

    await check('an unknown widget, capability or driver is refused', () => {
        const base = { id: 'x.y', version: 1, name: 'X', capabilities: ['camera'], mapping: { driver: 'sim' }, widgets: [{ type: 'camera', capability: 'camera' }] };
        assert.throws(() => validateProfile({ ...base, widgets: [{ type: 'nope' }] }), /unknown widget/);
        assert.throws(() => validateProfile({ ...base, capabilities: ['teleport'] }), /unknown capability/);
        assert.throws(() => validateProfile({ ...base, mapping: { driver: 'does-not-exist' } }), /mapping.driver/);
    });

    await check('commands are checked against the per-kind schema, and a widget only sends what commands declares', () => {
        const base = { id: 'x.y', version: 1, name: 'X', capabilities: ['drive.differential'], mapping: { driver: 'sim' }, widgets: [{ type: 'latency' }] };
        const ok = validateProfile({ ...base, commands: { drive: { axes: { throttle: [-1, 1] } } }, widgets: [{ type: 'drive', command: { kind: 'drive' } }] });
        assert.deepStrictEqual(Object.keys(ok.commands).sort(), ['drive', 'halt'], 'halt is always taken');
        assert.deepStrictEqual(validateProfile(base).commands, { halt: {} }, 'no commands: halt only');
        const refused = [
            [{ teleport: {} }, /unknown command kind teleport/],
            [{ drive: { axes: { warp: [-1, 1] } } }, /unknown axis warp/],
            [{ drive: { axes: { throttle: [1, -1] } } }, /throttle must be \[min, max\]/],
            [{ drive: {} }, /axes must name/],
            [{ ptz: { axes: { throttle: [-1, 1] } } }, /unknown axis throttle/],
            [{ actuator: { names: { pan: { type: 'number' } } } }, /range must be/],
            [{ actuator: { names: { pan: { type: 'servo' } } } }, /type must be one of/],
            [{ actuator: { names: { horn: { type: 'tone', hz: [0, 880] } } } }, /hz must be/],
            [{ actuator: { names: { 'Bad Name': { type: 'bool' } } } }, /not valid/],
            [{ display: { modes: ['animation'] } }, /unknown display mode animation/],
            [{ display: { modes: ['face'] } }, /faces must list/],
            [{ say: { max_chars: -1 } }, /max_chars/],
            [{ halt: { hard: true } }, /takes no options/],
        ];
        for (const [commands, re] of refused) assert.throws(() => validateProfile({ ...base, commands }), re, JSON.stringify(commands));
        const actuators = { actuator: { names: { pan: { type: 'number', range: [-1, 1] } } } };
        assert.throws(() => validateProfile({ ...base, commands: actuators, widgets: [{ type: 'drive', command: { kind: 'drive' } }] }), /sends drive, which commands does not declare/);
        assert.throws(() => validateProfile({ ...base, commands: actuators, widgets: [{ type: 'pan-tilt', command: { kind: 'actuator', names: ['pan', 'tilt'] } }] }), /drives actuator tilt/);
        assert.throws(() => validateProfile({ ...base, commands: actuators, widgets: [{ type: 'pan-tilt', command: { kind: 'actuator' } }] }), /lists its names/);
    });

    for (const p of profiles.values()) {
        await check(`${p.id}: every panel control produces a command ${plugins.contractFor(p).name} accepts`, () => {
            const plugin = plugins.contractFor(p);
            let tried = 0;
            for (const w of p.widgets) {
                if (CONTROL_WIDGETS.has(w.type)) assert.ok(w.command, `${p.id}: the ${w.type} widget names the command it sends`);
                if (!w.command) continue;
                for (const value of samples(p, w.command.kind, w.command.names || [])) {
                    const sent = build(p, w.command.kind, value);
                    const why = plugin.accepts(w.command.kind, sent);
                    assert.strictEqual(why, null, `${p.id} ${w.type}: ${JSON.stringify(value)} → ${JSON.stringify(sent)}: ${why}`);
                    tried++;
                }
            }
            const why = plugin.accepts('halt', build(p, 'halt', {}));
            assert.strictEqual(why, null, `${p.id}: halt: ${why}`);
            assert.ok(tried > 0, `${p.id} has controls`);
        });
    }

    await check('the owner\'s limits cut the drive axes the device gets (max_speed: throttle, x, y; max_turn: steer, rotation)', () => {
        const limits = { max_speed: 0.4, max_turn: 0.25 };
        assert.deepStrictEqual(build(profiles.get('adeept.adr036'), 'drive', { throttle: 1, steer: -1 }, limits), { throttle: 0.4, steer: -0.25 });
        assert.deepStrictEqual(build(profiles.get('adeept.adr036.mecanum'), 'drive', { x: 1, y: -1, rotation: 1 }, limits), { x: 0.4, y: -0.4, rotation: 0.25 });
        assert.deepStrictEqual(build(profiles.get('cozmo'), 'drive', { throttle: 1, steer: 1 }), { throttle: 0.6, steer: 0.8 }, 'the profile\'s own limits too');
    });

    await check('values the plugins would refuse are refused by Bot before they reach a device', () => {
        const adeept = profiles.get('adeept.adr036');
        const cozmo = profiles.get('cozmo');
        const refuses = (p, kind, value, code) => assert.throws(() => build(p, kind, value), (e) => e.code === code, `${p.id} ${kind} ${JSON.stringify(value)}`);
        refuses(adeept, 'actuator', { name: 'horn', value: { note: 'A4' } }, 'bot.unknown_actuator');
        refuses(adeept, 'actuator', { name: 'servo', value: 0.5 }, 'bot.unknown_actuator');
        refuses(adeept, 'actuator', { name: 'pan', value: 'left' }, 'bot.invalid_input');
        refuses(adeept, 'actuator', { name: 'buzzer', value: { note: 'H2' } }, 'bot.invalid_input');
        refuses(adeept, 'actuator', { name: 'lights', value: { r: 1, g: 2, b: 3, index: 8 } }, 'bot.invalid_input');
        refuses(adeept, 'actuator', { name: 'lights', value: [255, 0, 0] }, 'bot.invalid_input');
        refuses(cozmo, 'display', { animation: 'anim_bored_01' }, 'bot.invalid_input');
        refuses(cozmo, 'display', { face: 'wink' }, 'bot.invalid_input');
        refuses(cozmo, 'display', { image_png_b64: 'not base64!' }, 'bot.invalid_input');
        refuses(cozmo, 'say', { text: '   ' }, 'bot.invalid_input');
        refuses(cozmo, 'actuator', { name: 'lights', value: { r: 1, g: 1, b: 1 } }, 'bot.unknown_actuator');
        refuses(profiles.get('camera.onvif'), 'ptz', {}, 'bot.invalid_input');
        assert.ok(!adeept.commands.say && !adeept.commands.display && !cozmo.commands.ptz, 'kinds a plugin does not take are not declared');
    });

    await check('a buzzer note is sent as the tone in Hz the plugin plays; a lights colour as integers 0..255', () => {
        const adeept = profiles.get('adeept.adr036');
        assert.deepStrictEqual(build(adeept, 'actuator', { name: 'buzzer', value: { note: 'A4' } }), { name: 'buzzer', value: { hz: 440 } });
        assert.deepStrictEqual(build(adeept, 'actuator', { name: 'buzzer', value: { note: 'C5' } }), { name: 'buzzer', value: { hz: 523.25 } });
        assert.deepStrictEqual(build(adeept, 'actuator', { name: 'buzzer', value: { hz: 5000 } }), { name: 'buzzer', value: { hz: 880 } });
        assert.deepStrictEqual(build(adeept, 'actuator', { name: 'buzzer', value: null }), { name: 'buzzer', value: null });
        assert.deepStrictEqual(build(adeept, 'actuator', { name: 'lights', value: { r: 300, g: -1, b: 12.6 } }), { name: 'lights', value: { r: 255, g: 0, b: 13 } });
        assert.deepStrictEqual(build(profiles.get('cozmo'), 'actuator', { name: 'lift', value: -0.5 }), { name: 'lift', value: 0 });
    });

    done();
})();
