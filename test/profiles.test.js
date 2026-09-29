'use strict';
// Robot profiles (ADR-043 decision 7): every shipped profile validates, the registries refuse typos.
const assert = require('assert');
const { check, done } = require('./helpers/app');
const { loadProfiles, validateProfile } = require('../server/profiles');

(async () => {
    const profiles = loadProfiles();

    await check('the four shipped profiles load and validate', () => {
        assert.deepStrictEqual([...profiles.keys()].sort(), ['adeept.adr036', 'camera.onvif', 'cozmo', 'sim.rover']);
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
        assert.ok(p.capabilities.includes('drive.differential') && p.capabilities.includes('drive.mecanum'), 'both wheel variants');
        assert.deepStrictEqual(Object.keys(p.variants).sort(), ['differential', 'mecanum']);
    });

    await check('cozmo carries drive, head, lift, say, display/animation, lights, cliff/pick-up and a 320x240 camera', () => {
        const p = profiles.get('cozmo');
        for (const c of ['drive.differential', 'head', 'lift', 'speaker.say', 'display.text', 'display.animation', 'lights.backpack', 'lights.cube', 'battery', 'sensor.cliff', 'sensor.pickup', 'camera']) {
            assert.ok(p.capabilities.includes(c), `cozmo has ${c}`);
        }
        assert.strictEqual(p.mapping.driver, 'cozmo');
        assert.ok(Array.isArray(p.mapping.animations) && p.mapping.animations.length > 0);
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

    done();
})();
