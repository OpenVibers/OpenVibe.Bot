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
const DESK = /^(main|private|desk-[a-z0-9][a-z0-9-]{0,23})$/;
const ACTIONS = new Set(['click', 'double_click', 'right_click', 'move', 'scroll', 'type', 'key']);

/** A person's mouse or keyboard action on a shown screen, as bot.command@1 input takes it (share links and the owner). */
function inputValue(value) {
    const v = value && typeof value === 'object' ? value : {};
    if (!ACTIONS.has(v.action)) throw new BotError(422, 'bot.invalid_input', `action is one of ${[...ACTIONS].join(', ')}`);
    const out = { action: v.action };
    if (['click', 'double_click', 'right_click', 'move', 'scroll'].includes(v.action) && v.x != null) {
        for (const k of ['x', 'y', 'width', 'height']) {
            const n = Math.round(Number(v[k]));
            if (!Number.isFinite(n) || n < 0 || n > 10000) throw new BotError(422, 'bot.invalid_input', `${k} is a position in the picture`);
            out[k] = n;
        }
    }
    if (v.action === 'scroll') out.dy = Math.max(-50, Math.min(50, Math.round(Number(v.dy) || 0)));
    if (v.action === 'type') out.text = String(v.text || '').slice(0, 500);
    if (v.action === 'key') out.keys = String(v.keys || '').slice(0, 40);
    return out;
}
const FPS = { min: 1, max: 5, default: 2 };

function whole(v, { min, max, default: dflt }, name) {
    if (v == null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new BotError(422, 'bot.invalid_input', `${name} is a whole number from ${min} to ${max}`);
    return n;
}

function createMachineScreen({ domain, hub, now = () => Date.now() }) {
    const unavailable = () => new BotError(503, 'bot.unavailable', 'machines are not connected here');
    // The desk each machine's live screen shows (this process): the owner's input goes there, never to another screen.
    const shown = new Map();
    const owner = (subject) => ({ kind: 'user', sub: subject });
    const rate = new Map();
    return {
        DESK,
        limits: { SECONDS, FPS },
        async start(device, subject, principal, opts = {}) {
            if (!hub) throw unavailable();
            const seconds = whole(opts.seconds, SECONDS, 'seconds');
            const fps = whole(opts.fps, FPS, 'fps');
            const desk = opts.desk == null || opts.desk === '' ? 'main' : String(opts.desk);
            if (!DESK.test(desk)) throw new BotError(422, 'bot.invalid_input', 'desk is main, private or desk-<name>');
            if (!hub.isOnline(device.id)) throw new BotError(409, 'bot.device_offline', 'the machine is offline');
            // Before any key is made: the machine says whether it can (Node v0.12.0's computer plugin, a capture tool).
            const offered = hub.computerOf(device.id);
            // The person's own screen needs a live capture of it; a desk's is the desk's own (desk.screen, below): a desk
            // host has no screen of its own to show, only its desks.
            if (desk === 'main' && !(offered && offered.screen && offered.screen.stream === true)) {
                throw new BotError(409, 'bot.computer_off', 'this machine does not show its screen live: it needs OpenVibe Node v0.12.0 or newer, with the computer plugin running in your graphical session');
            }
            if (desk !== 'main' && !(offered && offered.desk && offered.desk.screen)) {
                throw new BotError(409, 'bot.computer_off', 'this machine has no private desk to show: it needs OpenVibe Node v0.15.0 or newer on Linux, with Xvfb and allow_desk on');
            }
            if (desk !== 'main' && desk !== 'private' && offered.desk.named !== true) {
                throw new BotError(409, 'bot.computer_off', 'this machine runs one desk only (private): several named desks need OpenVibe Node v0.19.0 or newer');
            }
            // On the owner's OpenVibe Live channel (the Desks plan's D8): a desk only, never their own screen, on a public
            // stream of its own that OpenRestream links to their channel; refused with Live's reason when it cannot be.
            const live = opts.live === true;
            if (live && desk === 'main') throw new BotError(422, 'bot.live_desk_only', 'only a desk goes on your Live channel, never your own screen');
            const key = live ? await domain.machines.screen.liveKey(device, subject) : await domain.machines.screen.key(device, subject);
            if (live && !key.live.linked) {
                throw new BotError(409, key.live.code || 'bot.live_refused', key.live.reason || 'OpenVibe Live did not take the desk: sign in to openvibe.live once, then try again');
            }
            const r = await hub.machineScreen(device.id, principal, subject, { action: 'start', whip_url: key.whipUrl, publish_key: key.key, seconds, fps, ...(desk !== 'main' ? { desk } : {}) });
            if (r.result !== 'ack') {
                const code = r.code || (r.result === 'expired' ? 'bot.device_timeout' : 'bot.device_refused');
                const status = r.result === 'refused' ? (code === 'bot.computer_off' || code === 'bot.device_offline' ? 409 : 422) : r.result === 'expired' ? 504 : 409;
                throw new BotError(status, code.startsWith('bot.') ? code : 'bot.device_refused', `the machine did not start showing its screen: ${r.reason || r.result}`.slice(0, 300));
            }
            const data = r.data && typeof r.data === 'object' ? r.data : {};
            const until = Number.isFinite(data.until_ms) ? new Date(data.until_ms).toISOString() : new Date(now() + seconds * 1000).toISOString();
            shown.set(device.id, desk);
            return { streaming: true, seconds, fps, until, desk, ...(live ? { live: { channel_url: key.live.channel_url } } : {}) };
        },
        async state(device, subject) {
            const sensors = hub ? ((hub.deviceState(device.id).telemetry || {}).sensors || {}) : {};
            const state = sensors.computer_screen_stream === 'live' ? 'live' : 'off';
            const url = state === 'live' ? await domain.machines.screen.live(device, subject) : null;
            return { live: !!url, signaling_url: url, state, online: !!(hub && hub.isOnline(device.id)), desk: shown.get(device.id) || 'main' };
        },
        /**
         * The owner's own mouse or keyboard on the screen shown now (Desks plan D4, "Take over"): sent as the owner, so
         * Bot's person-first rule holds an agent off that screen while they use it, and it goes on when they stop.
         */
        async input(device, subject, value) {
            if (!hub) throw unavailable();
            const out = inputValue(value);
            const desk = shown.get(device.id) || 'main';
            if (desk !== 'main') out.desk = desk;
            const recent = (rate.get(device.id) || []).filter((x) => now() - x < 1000);
            if (recent.length >= 8) throw new BotError(429, 'bot.rate_limited', 'slow down a little');
            recent.push(now());
            rate.set(device.id, recent);
            const r = await hub.machineCommand(device.id, owner(subject), subject, { kind: 'input', value: out, ms: 15000 });
            if (r && r.result === 'ack') return { done: true, desk };
            const code = (r && r.code) || 'bot.device_refused';
            throw new BotError(r && r.result === 'expired' ? 504 : 409, code.startsWith('bot.') ? code : 'bot.device_refused', `the computer did not do it: ${(r && (r.reason || r.result)) || 'no answer'}`.slice(0, 300));
        },
        async stop(device, subject, principal) {
            let told = false;
            if (hub && hub.isOnline(device.id)) {
                const r = await hub.machineScreen(device.id, principal, subject, { action: 'stop' });
                told = r.result === 'ack';
            }
            const ended = await domain.machines.screen.end(device, subject);
            shown.delete(device.id);
            return { stopped: told || ended };
        },
    };
}

module.exports = { createMachineScreen, inputValue, ACTIONS, SECONDS, FPS, DESK };
