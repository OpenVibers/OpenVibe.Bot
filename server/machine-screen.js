'use strict';
/**
 * The live screen (plan T14, contracts 0.182.0): a machine's owner watches its screen on their own private OpenRestream
 * stream. Used by the API (POST/GET/DELETE /api/v1/machines/:id/screen) and the web page (/machines/:id/screen), for
 * the owner signed in as themselves only — never an agent, a watch or another service.
 *
 *   start(device, subject, principal, { seconds, fps, desk })  a new key for the machine's stream (domain.machines.screen),
 *                                                         then screen_stream start to the machine with the WHIP URL
 *                                                         and key → { streaming, seconds, fps, until, desk }; desk
 *                                                         `private` shows the machine's private desk (contracts
 *                                                         0.214.0, Node v0.15.0) instead of the owner's own screen
 *   state(device, subject)                                → { live, signaling_url, state, stream } (the session's viewer
 *                                                         URL once the machine is publishing; `state` the machine's own
 *                                                         telemetry: live or off)
 *   stop(device, subject, principal)                      screen_stream stop to the machine (when online) and the
 *                                                         stream's key retired with its session → { stopped }
 *
 * OpenVibe.Node's computer plugin captures the frames and its core publishes them (Node v0.12.0, docs/computer.md).
 */
const { BotError } = require('./util');

const SECONDS = { min: 30, max: 1800, default: 600 };
const FPS = { min: 1, max: 5, default: 2 };

function whole(v, { min, max, default: dflt }, name) {
    if (v == null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new BotError(422, 'bot.invalid_input', `${name} is a whole number from ${min} to ${max}`);
    return n;
}

function createMachineScreen({ domain, hub, now = () => Date.now() }) {
    const unavailable = () => new BotError(503, 'bot.unavailable', 'machines are not connected here');
    return {
        limits: { SECONDS, FPS },
        async start(device, subject, principal, opts = {}) {
            if (!hub) throw unavailable();
            const seconds = whole(opts.seconds, SECONDS, 'seconds');
            const fps = whole(opts.fps, FPS, 'fps');
            const desk = opts.desk == null || opts.desk === '' ? 'main' : String(opts.desk);
            if (desk !== 'main' && desk !== 'private') throw new BotError(422, 'bot.invalid_input', 'desk is main or private');
            if (!hub.isOnline(device.id)) throw new BotError(409, 'bot.device_offline', 'the machine is offline');
            // Before any key is made: the machine says whether it can (Node v0.12.0's computer plugin, a capture tool).
            const offered = hub.computerOf(device.id);
            if (!(offered && offered.screen && offered.screen.stream === true)) {
                throw new BotError(409, 'bot.computer_off', 'this machine does not show its screen live: it needs OpenVibe Node v0.12.0 or newer, with the computer plugin running in your graphical session');
            }
            if (desk === 'private' && !(offered.desk && offered.desk.screen)) {
                throw new BotError(409, 'bot.computer_off', 'this machine has no private desk to show: it needs OpenVibe Node v0.15.0 or newer on Linux, with Xvfb and allow_desk on');
            }
            const key = await domain.machines.screen.key(device, subject);
            const r = await hub.machineScreen(device.id, principal, subject, { action: 'start', whip_url: key.whipUrl, publish_key: key.key, seconds, fps, ...(desk === 'private' ? { desk } : {}) });
            if (r.result !== 'ack') {
                const code = r.code || (r.result === 'expired' ? 'bot.device_timeout' : 'bot.device_refused');
                const status = r.result === 'refused' ? (code === 'bot.computer_off' || code === 'bot.device_offline' ? 409 : 422) : r.result === 'expired' ? 504 : 409;
                throw new BotError(status, code.startsWith('bot.') ? code : 'bot.device_refused', `the machine did not start showing its screen: ${r.reason || r.result}`.slice(0, 300));
            }
            const data = r.data && typeof r.data === 'object' ? r.data : {};
            const until = Number.isFinite(data.until_ms) ? new Date(data.until_ms).toISOString() : new Date(now() + seconds * 1000).toISOString();
            return { streaming: true, seconds, fps, until, desk };
        },
        async state(device, subject) {
            const sensors = hub ? ((hub.deviceState(device.id).telemetry || {}).sensors || {}) : {};
            const state = sensors.computer_screen_stream === 'live' ? 'live' : 'off';
            const url = state === 'live' ? await domain.machines.screen.live(device, subject) : null;
            return { live: !!url, signaling_url: url, state, online: !!(hub && hub.isOnline(device.id)) };
        },
        async stop(device, subject, principal) {
            let told = false;
            if (hub && hub.isOnline(device.id)) {
                const r = await hub.machineScreen(device.id, principal, subject, { action: 'stop' });
                told = r.result === 'ack';
            }
            const ended = await domain.machines.screen.end(device, subject);
            return { stopped: told || ended };
        },
    };
}

module.exports = { createMachineScreen, SECONDS, FPS };
