'use strict';
const kit = require('openvibe-shared/kit');
const sharedServe = require('openvibe-shared/serve');

/**
 * The signed-in pages, rendered on the server from data alone (pure functions, testable without a server).
 * The panel is a function of the robot's profile (ADR-043 decision 7): every widget comes from
 * `profile.widgets` and every control's name, shape and range from `profile.commands` — no robot-specific
 * code here. Every value is HTML-escaped; nothing is inline (the CSP is `default-src 'self'`), so the client
 * (public/panel.js) reads what it needs from data-* attributes, and the icons are inline SVG markup.
 *
 *   renderPanel({ robot, profile, role, allowed_commands, holdResendMs, mode, signedIn, streaming, people, signaling_url })
 *                                   mode 'embed': the framed panel (no topbar, no owner form, links open a new tab);
 *                                   `people` (owner page only) the non-owner members for the People card;
 *                                   `signaling_url` the robot's live OpenRestream WebRTC session, on the camera tiles
 *   renderEmbedRefused({ robotId })  the framed answer when the visitor may not see the robot
 *   renderWidget(widget, { profile, allowed_commands })
 *   renderRobotsPage({ robots, profiles, error, values })
 *   renderPairingPage({ robot, pairing, profile })
 *   renderLinkPage({ code, error, installer }), renderClaimPage({ claim, models, values, error }),
 *   renderClaimApproved({ robot, profile, live, chatUrl })   /link: a device that asked to be added (server/claims.js)
 *   camerasOf(profile)
 *   esc(value)
 */
const { qrSvg } = require('./qr');
const { stepHelp } = require('../routines');
const social = require('openvibe-shared/social');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
/** A data-* attribute's JSON, escaped for a double-quoted attribute. */
const data = (v) => esc(JSON.stringify(v));

/** The e-stop is the owner's and an operator's; only the owner clears it (the gate enforces both). */
const ESTOP_ROLES = new Set(['owner', 'operator']);
/** The drive joystick's two axes, by preference: horizontal and vertical. The rest stay hold buttons. */
const STICK_X = ['steer', 'x', 'rotation'];
const STICK_Y = ['throttle', 'y'];
const POLICIES = [['private', 'Only me and people I add'], ['invite', 'People I invite'], ['queue', 'Anyone, taking turns']];
const POLICY_LABEL = Object.fromEntries(POLICIES.map(([v]) => [v, { private: 'Private', invite: 'Invite only', queue: 'Open queue' }[v]]));
const ROLE_LABEL = { owner: 'Owner', operator: 'Operator', viewer: 'Viewer', queue: 'In the queue', watcher: 'Watching' };

// ── Icons: 24×24 strokes in currentColor, decorative (the text beside them is the label) ─────────────────────
const PATHS = {
    up: '<path d="M12 5v14M5 12l7-7 7 7"/>',
    down: '<path d="M12 19V5M5 12l7 7 7-7"/>',
    left: '<path d="M5 12h14M12 5l-7 7 7 7"/>',
    right: '<path d="M19 12H5M12 5l7 7-7 7"/>',
    ccw: '<path d="M4 4v6h6"/><path d="M5.5 15a7.5 7.5 0 1 0 1.8-7.8L4 10"/>',
    cw: '<path d="M20 4v6h-6"/><path d="M18.5 15a7.5 7.5 0 1 1-1.8-7.8L20 10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    stop: '<path d="M8.2 2h7.6L22 8.2v7.6L15.8 22H8.2L2 15.8V8.2z"/><path d="M8 12h8"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    camera: '<path d="M3 7h3l2-3h8l2 3h3v12H3z"/><circle cx="12" cy="13" r="3.5"/>',
    horn: '<path d="M3 10v4h4l6 5V5L7 10z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    robot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/>',
    plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
    gamepad: '<path d="M7 7h10a4 4 0 0 1 4 4l.8 5a2.6 2.6 0 0 1-4.6 2L15 15H9l-2.2 3a2.6 2.6 0 0 1-4.6-2L3 11a4 4 0 0 1 4-4z"/><path d="M7.5 10v3M6 11.5h3M16 11h.01M18 13h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
/** Hold-button icons by axis: [negative, positive]. */
const AXIS_ICONS = { throttle: ['down', 'up'], y: ['down', 'up'], steer: ['left', 'right'], x: ['left', 'right'], rotation: ['ccw', 'cw'], pan: ['left', 'right'], tilt: ['down', 'up'], zoom: ['minus', 'plus'] };
const AXIS_NAME = { throttle: 'Forward / back', y: 'Forward / back', steer: 'Steer', x: 'Sideways', rotation: 'Turn on the spot', pan: 'Pan', tilt: 'Tilt', zoom: 'Zoom' };

/*
 * The panel's own files by their content (2026-11-11: Bot #393 shipped new markup, and the edge kept serving the old
 * panel.css under its plain address for a while, so the new stick drew without its styles). Each address carries the
 * file's hash, so a deploy is a new address and a cached copy can only ever be the right one.
 */
const _assetHash = new Map();
function versioned(src) {
    const m = /^\/panel\/([a-z0-9-]+\.(?:js|css))$/.exec(String(src));
    if (!m) return src;
    if (!_assetHash.has(m[1])) {
        let h = '';
        try { h = require('crypto').createHash('sha1').update(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'public', m[1]))).digest('hex').slice(0, 10); } catch { h = ''; }
        _assetHash.set(m[1], h);
    }
    const h = _assetHash.get(m[1]);
    return h ? `${src}?v=${h}` : src;
}

function page(title, body, { scripts = [], bodyClass = '', description = null, canonical = null, robots = null, htmlClass = '', htmlAttrs = '', colorScheme = 'dark' } = {}) {
    return `<!doctype html>
<html lang="en"${htmlClass ? ` class="${esc(htmlClass)}"` : ''}${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="${esc(colorScheme)}">
<meta name="theme-color" content="#11151c">
<title>${esc(title)} — OpenVibe.Bot</title>${robots ? `
<meta name="robots" content="${esc(robots)}">` : ''}${description ? `
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)} — OpenVibe.Bot">
<meta property="og:description" content="${esc(description)}">` : ''}${canonical ? `
<link rel="canonical" href="https://openvibe.bot${esc(canonical)}">` : ''}${description && canonical ? `
<meta property="og:url" content="https://openvibe.bot${esc(canonical)}">
<meta property="og:image" content="https://openvibe.bot${esc(social.url('bot'))}">
<meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="stylesheet" href="${require('openvibe-shared/serve').url('kit.css')}">
<link rel="stylesheet" href="${versioned('/panel/panel.css')}">
</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>
${body}
${scripts.map((s) => `<script src="${esc(versioned(s))}" defer></script>`).join('\n')}
</body>
</html>
`;
}

const disabledUnless = (ok) => (ok ? '' : ' disabled');
const topbar = (crumb = '', home = '/robots') => `<nav class="topbar"><a class="brand" href="${esc(home)}">${icon('robot')}<span>OpenVibe<b>.Bot</b></span></a>${crumb}</nav>`;

/** Hold buttons, one pair per axis: pressed sends the axis at its end of the range, released sends 0. */
function axisButtons(axes, enabled) {
    return Object.entries(axes).map(([axis, [lo, hi]]) => {
        const [neg, pos] = AXIS_ICONS[axis] || ['minus', 'plus'];
        const name = AXIS_NAME[axis] || axis;
        return `<div class="axis" data-axis="${esc(axis)}">`
            + `<button type="button" class="hold" data-hold="${data({ [axis]: lo })}" aria-label="${esc(`${name} ${lo}`)}"${disabledUnless(enabled)}>${icon(neg)}</button>`
            + `<span class="axis-name">${esc(name)}</span>`
            + `<button type="button" class="hold" data-hold="${data({ [axis]: hi })}" aria-label="${esc(`${name} ${hi}`)}"${disabledUnless(enabled)}>${icon(pos)}</button>`
            + '</div>';
    }).join('');
}

/** The buttons that mean a direction on a robot made of buttons (panel.js presses them from keys, a stick and a pad). */
const DIRECTION_BUTTONS = [
    { dir: 'up', label: 'forward', names: ['forward', 'drive_forward', 'up'] },
    { dir: 'down', label: 'back', names: ['backward', 'back', 'reverse', 'down'] },
    { dir: 'left', label: 'left', names: ['turn_left', 'left', 'rotate_left'] },
    { dir: 'right', label: 'right', names: ['turn_right', 'right', 'rotate_right'] },
];

/**
 * The drive pad: a touch joystick for two axes (pointer events, see panel.js), hold buttons for the rest.
 * Its stick, Stop and direction buttons are the panel's arrangeable parts (make your own controls, stage 2):
 * the section around them flattens (`display: contents`) so each is a cell of the panel's grid.
 */
function drivePad(axes, enabled, attrs = {}, flatten = false) {
    const x = STICK_X.find((a) => axes[a]);
    const y = STICK_Y.find((a) => axes[a]);
    const stick = {};
    if (x) stick.x = x;
    if (y) stick.y = y;
    const rest = Object.fromEntries(Object.entries(axes).filter(([a]) => a !== x && a !== y));
    const label = [y && AXIS_NAME[y], x && AXIS_NAME[x]].filter(Boolean).join(' and ');
    const joystick = x || y
        ? `<div class="stick" data-joystick="${data(stick)}" data-ov-part="stick" ${attrs.stick || ''} role="img" aria-label="${esc(`Joystick: ${label}. Drag and hold to drive.`)}"${enabled ? '' : ' aria-disabled="true"'}>`
            + '<span class="stick-ring"></span><span class="stick-cross"></span><svg class="stick-dirs" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="M50 5l6 7H44zM95 50l-7 6V44zM50 95l-6-7h12zM5 50l7-6v12z"/></svg>'
            + `<span class="stick-knob" data-knob></span></div>`
        : '';
    const pad = Object.keys(rest).length ? `<div class="pad" data-ov-part="pad" ${attrs.pad || ''}>${axisButtons(rest, enabled)}</div>` : '';
    return `<div class="drive-pad" data-axes="${data(axes)}"${flatten ? ' data-ov-flatten="true"' : ''}>${joystick}${pad}`
        + `<button type="button" class="stop" data-stop data-ov-part="stop" ${attrs.stop || ''}${disabledUnless(enabled)}>${icon('square')}<span>Stop</span></button></div>`;
}

/** An actuator's name as a label: backpack_lights → Backpack lights. */
const humanName = (name) => { const s = String(name).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

/** One control per actuator the widget drives, by the actuator's declared type. */
/**
 * Sliders that repeat while held (2026-11-09, the LOOI bridge's short head-target leases): by profile and actuator, the
 * cadence in ms (75-250). The panel's own setting, not the profile contract's (bot.robot-profile@1 takes no extra
 * fields); a profile field can replace it with the next Contracts release.
 */
const HOLD_REPEAT_MS = { looi: { head: 90 } };
const holdRepeatOf = (profileId, name) => { const v = (HOLD_REPEAT_MS[profileId] || {})[name]; return v ? Math.min(250, Math.max(75, v)) : 0; };

function numberRange(name, a, enabled, profileId = '') {
    const repeat = a.type === 'number' ? holdRepeatOf(profileId, name) : 0;
    const [lo, hi] = a.range;
    const start = Math.min(hi, Math.max(lo, 0));
    return `<input type="range" min="${esc(lo)}" max="${esc(hi)}" step="${esc((hi - lo) / 40)}" value="${esc(start)}" data-actuator="${esc(name)}"${repeat ? ` data-hold-repeat="${esc(repeat)}"` : ''}${disabledUnless(enabled)}>`;
}

function actuatorControl(name, a, enabled, profileId = '') {
    const off = disabledUnless(enabled);
    const label = humanName(name);
    if (a.type === 'number') {
        return `<div class="control slider"><label class="slider-head"><span class="control-name">${esc(label)}</span><output class="control-value" data-value-of="${esc(name)}">0</output></label>`
            + `<div class="slider-row"><button type="button" class="step" data-step-for="${esc(name)}" data-step="-1" aria-label="${esc(`${label} down`)}"${off}>${icon('minus')}</button>`
            + `${numberRange(name, a, enabled, profileId)}`
            + `<button type="button" class="step" data-step-for="${esc(name)}" data-step="1" aria-label="${esc(`${label} up`)}"${off}>${icon('plus')}</button></div></div>`;
    }
    if (a.type === 'rgb') {
        return `<div class="control colour"><label><span class="control-name">${esc(label)}</span> <input type="color" value="#ffffff" data-rgb="${esc(name)}"${off}></label>`
            + ` <button type="button" class="quiet" data-rgb-off="${esc(name)}"${off}>Off</button></div>`;
    }
    if (a.type === 'tone') return `<button type="button" class="hold tone" data-tone="${esc(name)}"${off}>${icon('horn')}<span>${esc(label)}</span></button>`;
    return `<label class="control toggle"><input type="checkbox" data-bool="${esc(name)}"${off}> <span class="control-name">${esc(name)}</span></label>`;
}

/**
 * The cameras a profile lists: `camera` is one camera ({ transport, resolution, name? }) or a list of them.
 * A profile with a camera widget and no camera entry still gets one slot.
 */
const isSim = (profile) => !!(profile && profile.mapping && profile.mapping.driver === 'sim');

/** The panel's scripts: the client, plus the shared arena and its camera for a simulated robot (and /try's local rover). */
function panelScripts(profile, local = false, embed = false) {
    const frame = embed ? ['/panel/embed-frame.js'] : [];
    if (!isSim(profile)) return [...frame, '/panel/panel.js'];
    return [...frame, '/panel/sim-world.js', ...(local ? ['/panel/try-device.js'] : []), '/panel/panel.js', '/panel/sim-view.js'];
}

function camerasOf(profile = {}) {
    const c = profile.camera;
    const list = Array.isArray(c) ? c.filter((x) => x && typeof x === 'object') : (c && typeof c === 'object' ? [c] : []);
    return list.length ? list : [{}];
}

/**
 * One tile per camera. A camera widget naming one (`camera`: its name or index) shows only that one.
 * `signaling_url` is the robot's live OpenRestream WebRTC session, when one is; the tile carries it (escaped)
 * so public/panel.js can play it — the server itself emits no script.
 */
function cameraTiles(w, profile, signaling_url = null, pointEnabled = false) {
    const all = camerasOf(profile).map((c, i) => ({ c, i }));
    // A simulated robot's camera is drawn in the page from its pose (public/sim-view.js), never streamed.
    const simulated = isSim(profile);
    const pick = w.camera != null ? all.filter(({ c, i }) => c.name === w.camera || i === w.camera) : all;
    return (pick.length ? pick : all).map(({ c, i }) => {
        const res = typeof c.resolution === 'string' && /^\d+x\d+$/.test(c.resolution) ? c.resolution : '';
        const title = c.name || (all.length > 1 ? `Camera ${i + 1}` : '');
        const caption = [title, res.replace('x', '×'), c.transport ? String(c.transport).toUpperCase() : ''].filter(Boolean).join(' · ');
        return `<figure class="camera" data-camera="${esc(i)}"${res ? ` data-resolution="${esc(res)}"` : ''}${c.transport && !simulated ? ` data-transport="${esc(c.transport)}"` : ''}`
            + `${simulated ? ' data-sim-camera' : signaling_url ? ` data-signaling-url="${esc(signaling_url)}"` : ''}>`
            + `<div class="camera-screen" data-camera-screen${pointEnabled ? ' data-video-click' : ''}>${icon('camera', 'icon camera-icon')}`
            + `<p class="camera-title">${simulated ? 'The rover is starting.' : 'No live video right now.'}</p>`
            + `<p class="camera-sub">${simulated ? 'Its camera shows here once the simulator is running.' : 'The camera shows here while the robot is online and sending video.'}</p></div>`
            + (caption ? `<figcaption>${esc(caption)}</figcaption>` : '')
            + '</figure>';
    }).join('');
}

function renderWidget(w, { profile = {}, allowed_commands = [], signaling_url = null, part = null, partAttrs = {}, flatten = false } = {}) {
    const commands = profile.commands || {};
    const kind = w.command ? w.command.kind : null;
    const enabled = !!kind && allowed_commands.includes(kind);
    const label = w.label || w.type;
    let inner;
    switch (w.type) {
        case 'drive': {
            const axes = (commands[kind] && commands[kind].axes) || {};
            // What Q and E do on this robot (public/panel.js): tilt the head where it has one, else turn where the
            // drive has a rotation axis, else nothing, and then the legend does not offer them.
            const headName = ((commands.actuator && commands.actuator.names) || {}).head;
            const qe = headName ? ' · <kbd>Q</kbd> / <kbd>E</kbd> to tilt' : axes.rotation ? ' · <kbd>Q</kbd> / <kbd>E</kbd> to turn' : '';
            inner = drivePad(axes, enabled, partAttrs, flatten)
                + `<p class="hint" data-ov-decor><kbd>W A S D</kbd> or arrows to drive${qe} · <kbd>Space</kbd> to stop. `
                + `<span class="pad-hint" data-pad-hint>${icon('gamepad')} A gamepad works too: left stick drives, A sounds, B stops, Start is the e-stop.</span></p>`;
            break;
        }
        case 'ptz': {
            const axes = (commands[kind] && commands[kind].axes) || {};
            // A camera that pans and tilts gets the joystick too (Maticus, 2026-10-27: "that cool virtual joystick from the
            // sim … would work killer for LOOI or any PTZ"): drag to move, let go to stop; zoom stays on its buttons.
            const ptzStick = axes.pan && axes.tilt
                ? `<div class="stick stick--ptz" data-ptz-stick="${data({ x: 'pan', y: 'tilt' })}" data-axes="${data(axes)}" role="img" aria-label="Joystick: pan and tilt. Drag and hold to move the camera."${enabled ? '' : ' aria-disabled="true"'}>`
                    + '<span class="stick-ring"></span><span class="stick-cross"></span><svg class="stick-dirs" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="M50 5l6 7H44zM95 50l-7 6V44zM50 95l-6-7h12zM5 50l7-6v12z"/></svg><span class="stick-knob" data-knob></span></div>'
                : '';
            inner = `<div class="ptz-pad">${ptzStick}<div class="pad">${axisButtons(axes, enabled)}</div></div>`;
            break;
        }
        case 'pan-tilt': case 'servo': case 'head': case 'lift': case 'lights': case 'horn': {
            const names = (commands.actuator && commands.actuator.names) || {};
            inner = `<div class="controls">${(w.command && w.command.names ? w.command.names : []).filter((n) => names[n]).map((n) => actuatorControl(n, names[n], enabled, profile.id)).join('')}</div>`;
            break;
        }
        case 'speaker': {
            const max = commands.say ? commands.say.max_chars : 200;
            inner = `<form class="control inline-form" data-say><input type="text" name="text" maxlength="${esc(max)}" placeholder="Something to say" aria-label="${esc(label)}"${disabledUnless(enabled)}>`
                + ` <button type="submit"${disabledUnless(enabled)}>Say</button></form>`;
            break;
        }
        case 'display': {
            const d = commands.display || { modes: [] };
            let fields = '';
            if (d.modes.includes('face')) fields += `<select name="face" aria-label="Face"${disabledUnless(enabled)}><option value="">Face…</option>${(d.faces || []).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select>`;
            if (d.modes.includes('text')) fields += ` <input type="text" name="text" maxlength="${esc(d.max_chars)}" placeholder="Text" aria-label="Text"${disabledUnless(enabled)}>`;
            inner = `<form class="control inline-form" data-display>${fields} <button type="submit"${disabledUnless(enabled)}>Show</button></form>`;
            break;
        }
        case 'telemetry':
            inner = `<output class="readout" data-telemetry="${esc(w.capability || '')}">—</output>`;
            break;
        case 'battery':
            inner = '<div class="battery"><meter min="0" max="1" low="0.25" high="0.6" optimum="1" data-battery></meter> <output class="readout" data-battery-text>—</output></div>';
            break;
        case 'latency':
            inner = '<div class="stats">'
                + '<div class="stat"><output class="readout" data-latency data-quality="none">—</output><span class="stat-label">Round trip, median</span></div>'
                + '<div class="stat"><output class="readout" data-telemetry-age data-quality="none">—</output><span class="stat-label">Telemetry age</span></div>'
                + '<div class="stat"><output class="readout" data-link>—</output><span class="stat-label">Device link</span></div>'
                + '</div>';
            break;
        case 'camera':
            inner = `<div class="cameras">${cameraTiles(w, profile, signaling_url,
                (profile.widgets || []).some((widget) => widget.type === 'video_click') && allowed_commands.includes('point'))}</div>`;
            break;
        case 'buttons': {
            const names = (commands.button && commands.button.names) || {};
            // A robot made of buttons (a relay profile: forward, backward, turn_left, turn_right …) with no drive of its own
            // drives from a joystick, the keyboard and a gamepad too: each direction presses its button (panel.js).
            const dirs = DIRECTION_BUTTONS.filter((d) => d.names.some((n) => names[n]));
            const hasDrive = (profile.widgets || []).some((x) => x.type === 'drive');
            const buttonStick = dirs.length >= 2 && !hasDrive
                ? `<div class="stick stick--buttons" data-button-stick role="img" aria-label="Joystick: presses ${esc(dirs.map((d) => d.label).join(', '))}. Drag and hold to drive."${enabled ? '' : ' aria-disabled="true"'}>`
                    + '<span class="stick-ring"></span><span class="stick-cross"></span><svg class="stick-dirs" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="M50 5l6 7H44zM95 50l-7 6V44zM50 95l-6-7h12zM5 50l7-6v12z"/></svg><span class="stick-knob" data-knob></span></div>'
                    + `<p class="hint"><kbd>W A S D</kbd> or arrows press ${esc(dirs.map((d) => d.label).join(', '))}. <span class="pad-hint" data-pad-hint>${icon('gamepad')} A gamepad's stick and D-pad do too.</span></p>`
                : '';
            inner = `${buttonStick}<div class="button-grid">${Object.entries(names).map(([name, button]) =>
                `<button type="button" class="hold pad-button" data-button-name="${esc(name)}" data-button-hold="${button.hold ? 'true' : 'false'}"${button.key ? ` data-button-key="${esc(button.key)}"` : ''}${disabledUnless(enabled)}>`
                + `<span>${esc(button.label)}</span>${button.key ? `<kbd>${esc(button.key)}</kbd>` : ''}</button>`).join('')}</div>`;
            break;
        }
        case 'video_click':
            if ((profile.widgets || []).some((widget) => widget.type === 'camera')) return '';
            inner = `<div class="cameras">${cameraTiles(w, profile, signaling_url, enabled)}</div>`;
            break;
        default:
            inner = '';
    }
    const cmd = w.command ? ` data-command="${data(w.command)}"` : '';
    if (w.type === 'drive') {
        return `<section class="widget widget-drive" data-widget="drive" data-ov-host${flatten ? ' data-ov-flatten="true"' : ''}${cmd}><h2 data-ov-decor>${esc(label)}</h2>${inner}</section>`;
    }
    const partAttr = part ? ` data-ov-part="${esc(part)}" ${partAttrs[part] || ''}` : '';
    return `<section class="widget widget-${esc(w.type)}" data-widget="${esc(w.type)}"${cmd}${partAttr}><h2>${esc(label)}</h2>${inner}</section>`;
}

/** One owner switch: a checkbox posted as name=on, after a hidden name=off so an unchecked box still says off. */
const toggle = (name, on, title, note, disabled = false, was = false) => `${was ? `<input type="hidden" name="${esc(name)}_was" value="${on ? 'on' : 'off'}">` : ''}<input type="hidden" name="${esc(name)}" value="off">
<label class="toggle"><input type="checkbox" name="${esc(name)}" value="on"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><b>${esc(title)}</b><small>${esc(note)}</small></span></label>`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The owner's routines: what exists, Run and Remove, and the add form (plain markup, works without JavaScript). */
function routinesCard(robot, profile, a) {
    const help = stepHelp(profile);
    const v = a.values || {};
    const row = (r) => {
        const last = r.last_result ? `${r.last_result === 'running' ? 'running now' : `last: ${r.last_result}`}${r.last_run_at ? ` (${new Date(r.last_run_at).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}` : 'not run yet';
        return `<li class="person"><span class="who"><b>${esc(r.name)}</b><small>${esc(a.describe(r.trigger))}${r.enabled ? '' : ' · off'} · ${esc(last)}</small></span>`
            + `<span class="routine-actions"><form method="post" action="/robots/${esc(robot.id)}/routines/${esc(r.id)}/run"><button type="submit">Run</button></form>`
            + `<form method="post" action="/robots/${esc(robot.id)}/routines/${esc(r.id)}/remove"><button type="submit" class="quiet">Remove</button></form></span></li>`;
    };
    const t = v.trigger || 'manual';
    return `<section class="setting-card" id="routines" aria-labelledby="routines-h"><h2 id="routines-h">Routines</h2>
<p class="setting-note">Steps the robot runs by itself, through the same limits, cooldowns and e-stop as you. Run one now, on a schedule, or each time the robot comes online; anything the robot refuses stops it there.</p>
${a.routineError ? `<p class="error" role="alert">${esc(a.routineError)}</p>` : ''}
${a.routines.length ? `<ul class="people-list">${a.routines.map(row).join('\n')}</ul>` : ''}
<details${a.routineError ? ' open' : ''}><summary>Add a routine</summary>
<form class="routine-form" method="post" action="/robots/${esc(robot.id)}/routines">
<label class="field"><span>Name</span><input name="name" maxlength="60" required value="${esc(v.name || '')}" placeholder="Patrol"></label>
<label class="field"><span>Steps, one per line</span><textarea name="steps" rows="6" required spellcheck="false" placeholder="${esc(help.slice(0, 5).join('\n'))}">${esc(v.steps || '')}</textarea></label>
<p class="setting-note">This robot takes: ${help.map((w) => `<code>${esc(w)}</code>`).join(' ')} (seconds after a motion; a line starting with # is a note).</p>
<fieldset class="trigger"><legend>When</legend>
<label class="check"><input type="radio" name="trigger" value="manual"${t === 'manual' ? ' checked' : ''}> When I run it</label>
<label class="check"><input type="radio" name="trigger" value="every"${t === 'every' ? ' checked' : ''}> Every <input type="number" name="every" min="5" max="10080" step="1" value="${esc(v.every || '60')}" aria-label="Minutes"> minutes</label>
<label class="check"><input type="radio" name="trigger" value="daily"${t === 'daily' ? ' checked' : ''}> At <input type="time" name="at" value="${esc(v.at || '09:00')}" aria-label="Time (UTC)"> UTC on</label>
<span class="days">${DAYS.map((d, i) => `<label class="check"><input type="checkbox" name="days" value="${i}"${!v.days || v.days.includes(String(i)) ? ' checked' : ''}> ${d}</label>`).join(' ')}</span>
<label class="check"><input type="radio" name="trigger" value="online"${t === 'online' ? ' checked' : ''}> Each time it comes online</label>
</fieldset>
<button type="submit" class="primary">Save routine</button>
</form></details></section>`;
}

/** The owner's webhooks: where the robot's events go, the add form, and a new hook's secret once. */
function webhooksCard(robot, a) {
    const row = (h) => `<li class="person"><span class="who"><b>${esc(h.url)}</b><small>${esc((h.events || []).map((e) => e.replace(/^bot\./, '')).join(', '))}${h.last ? ` · last delivery: ${esc(h.last)}` : ''}</small></span>`
        + `<form method="post" action="/robots/${esc(robot.id)}/webhooks/${esc(h.id)}/remove"><button type="submit" class="quiet">Remove</button></form></li>`;
    return `<section class="setting-card" id="webhooks" aria-labelledby="webhooks-h"><h2 id="webhooks-h">Webhooks</h2>
<p class="setting-note">Bot posts this robot's events to your https endpoint, signed like OpenVibe.Events deliveries (<code>X-OpenVibe-Signature-V2</code>, with the hook's own secret), and retries for about three hours.</p>
${a.webhookSecret ? `<p class="secret-once" role="status">The new hook's secret, shown this once: <code>${esc(a.webhookSecret)}</code></p>` : ''}
${a.webhookError ? `<p class="error" role="alert">${esc(a.webhookError)}</p>` : ''}
${a.hooks.length ? `<ul class="people-list">${a.hooks.map(row).join('\n')}</ul>` : ''}
<form class="webhook-form" method="post" action="/robots/${esc(robot.id)}/webhooks">
<label class="field"><span>Endpoint (https)</span><input type="url" name="url" required maxlength="300" placeholder="https://example.com/robot-events"></label>
<span class="days">${a.events.map((e) => `<label class="check"><input type="checkbox" name="events" value="${esc(e)}" checked> ${esc(e.replace(/^bot\./, ''))}</label>`).join(' ')}</span>
<button type="submit">Add webhook</button>
</form></section>`;
}

/** The owner's agent switch: their OpenVibe.Actor agent may drive the robot as them, through the same gate. */
function agentForm(robot) {
    return `<section class="setting-card" id="agent" aria-labelledby="agent-h"><h2 id="agent-h">Your agent</h2>
<form class="embed-form" method="post" action="/robots/${esc(robot.id)}/agent">
${toggle('agent_control', robot.agent_control, 'Let my OpenVibe.Actor agent drive this robot', 'Ask your agent on openvibe.actor to move it, speak or show something. It acts as you, through the same limits, cooldowns and e-stop, and every command it sends is on the record.')}
<button type="submit">Save</button>
</form></section>`;
}

/** The owner's directory switch: list the robot on /robots with a public page (/r/:id), watchable by anyone. */
function listingForm(robot) {
    return `<section class="setting-card" aria-labelledby="listing-h"><h2 id="listing-h">Directory</h2>
<form class="embed-form" method="post" action="/robots/${esc(robot.id)}/listing">
${toggle('listed', robot.listed, 'List it in the robot directory', 'It gets a public page where anyone can watch it live (never drive it, unless your queue lets them take a turn). Listing also turns on watching where it is embedded.')}
<button type="submit">Save</button>
</form>${robot.listed ? `<p class="setting-note"><a href="/r/${esc(robot.id)}">Its public page</a></p>` : ''}</section>`;
}

/**
 * "On your stream" (owner, 2026-10-26, from a streamer's notes: "impossible to put buttons on my stream"): one button
 * puts this robot's panel under the owner's OpenVibe.Live stream (it shows the panel where it is embedded, then opens
 * their channel, which asks to bind it), and who may drive from there is chosen beside it. Plain forms, no JavaScript.
 */
function onStreamCard(robot, { liveUrl = null } = {}) {
    const policy = robot.access_policy || 'private';
    const state = robot.embed_public
        ? `<p class="setting-ok" role="status">${icon('check')}<span>Its panel shows wherever it is embedded. Bound to your channel, viewers see it under your stream.</span></p>`
        : '';
    return `<section class="setting-card on-stream" id="on-stream" aria-labelledby="on-stream-h"><h2 id="on-stream-h">On your stream</h2>
<p class="setting-note">Put this robot's buttons under your OpenVibe.Live stream so your viewers can drive it there. Your stream stays the video; the panel adds the buttons, the e-stop and the latency.</p>
${state}${liveUrl ? `<form method="post" action="/robots/${esc(robot.id)}/on-stream"><button type="submit" class="button primary">${icon('gamepad')}<span>Put the buttons under my OpenVibe.Live stream</span></button></form>
<p class="setting-note">Opens your channel on OpenVibe.Live, which asks you to confirm. To take it off, choose no robot there, or turn off the panel below.</p>` : ''}
<form class="access-form" method="post" action="/robots/${esc(robot.id)}/access">
<label class="field"><span class="field-label">Who may drive</span><select name="access_policy">${POLICIES.map(([v, label]) => `<option value="${esc(v)}"${v === policy ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
<p class="setting-note">"Anyone, taking turns" lets every signed-in viewer queue for a turn. With the other two, only you and the people you add can drive; everyone else watches.</p>
<button type="submit">Save</button>
</form></section>`;
}

/** The owner's embed switch: plain markup, works without JavaScript. On the panel it is a card; in the robots list, a compact row. */
function embedForm(robot, { card = true } = {}) {
    const form = `<form class="embed-form${card ? '' : ' embed-inline'}" method="post" action="/robots/${esc(robot.id)}/embed" data-embed-form>
${toggle('embed_public', robot.embed_public, 'Show the panel where it is embedded (your OpenVibe.Live stream)', "Your stream's page and any other page that embeds this robot show its panel to everyone. Driving still needs who you allow below, through Drive.")}
<button type="submit">Save</button>
</form>`;
    return card ? `<section class="setting-card" aria-labelledby="embed-h"><h2 id="embed-h">Embedding</h2>\n${form}</section>` : form;
}

// Why the streaming switches cannot be used right now, in the owner's words (domain.streaming reasons, plus
// 'unavailable' when OpenRestream did not answer while the page was drawn).
const STREAMING_WHY = {
    not_configured: 'Streaming needs OpenRestream, which this server is not connected to.',
    not_paired: "Pair a device first: the robot's video stream is made when a device pairs.",
    stream_missing: "OpenRestream no longer has this robot's stream. Pair the device again to make a new one.",
    unavailable: 'OpenRestream did not answer just now, so these switches cannot be read. Reload in a moment.',
};

/**
 * The owner's streaming and recording switches (plan T15 row S), both off until the owner turns them on. They
 * are the robot's OpenRestream stream's own settings (domain.streaming): Bot keeps no copy, so the page shows what
 * OpenRestream says. The panel's own video never depends on either.
 */
function streamingForm(robot, streaming) {
    const s = streaming || { available: false, reason: 'unavailable', media: { on: false }, live: { on: false } };
    const off = !s.available;
    const why = off ? `<p class="setting-note" role="status">${esc(STREAMING_WHY[s.reason] || STREAMING_WHY.unavailable)}${s.reason === 'not_paired' ? ` <a href="/pair/${esc(robot.id)}">Pair a device</a>` : ''}</p>` : '';
    return `<section class="setting-card" aria-labelledby="streaming-h"><h2 id="streaming-h">Streaming and recording</h2>
<p class="setting-note">Off until you turn them on. Operators and viewers cannot change these.</p>
${why}<form class="streaming-form" method="post" action="/robots/${esc(robot.id)}/streaming" data-streaming-form>
${toggle('media', s.media && s.media.on, 'Record to OpenVibe.Media', 'Each time the robot goes live, OpenRestream records the session to OpenVibe.Media as an unlisted video.', off, true)}
${toggle('live', s.live && s.live.on, "Send the robot's camera to my OpenVibe.Live channel", "Video only: OpenRestream mirrors the camera to your Live channel. For the buttons under your stream, use \"On your stream\" above.", off, true)}
<button type="submit"${off ? ' disabled' : ''}>Save</button>
</form></section>`;
}

/** Robot-owned button profile editor. Add and remove submit the form and redraw it without saving. */
function localProfileForm(robot, profile, settings = {}) {
    const rows = settings.rows || Object.entries((profile.commands.button && profile.commands.button.names) || {})
        .map(([name, b]) => ({ name, label: b.label, key: b.key || '', cooldown: b.cooldown_ms == null ? '' : String(b.cooldown_ms), hold: !!b.hold }));
    const shown = rows.length ? rows : [{ name: '', label: '', key: '', cooldown: '', hold: false }];
    const point = settings.point !== undefined ? settings.point : !!profile.commands.point;
    const pointCooldown = settings.pointCooldown !== undefined ? settings.pointCooldown :
        (profile.commands.point && profile.commands.point.cooldown_ms != null ? String(profile.commands.point.cooldown_ms) : '');
    const fields = shown.map((row, i) => `<fieldset class="button-def">
<legend>Button ${i + 1}</legend>
<div class="button-def-grid">
<label class="field"><span>Name</span><input name="name_${i}" value="${esc(row.name)}" maxlength="32" autocomplete="off" pattern="[a-z][a-z0-9_]{0,31}" placeholder="horn"></label>
<label class="field"><span>Label</span><input name="label_${i}" value="${esc(row.label)}" maxlength="40" autocomplete="off" placeholder="Horn"></label>
<label class="field"><span>Key</span><input name="key_${i}" value="${esc(row.key)}" maxlength="16" autocomplete="off" placeholder="h"></label>
<label class="field"><span>Cooldown (ms)</span><input name="cooldown_${i}" type="number" min="0" step="1" value="${esc(row.cooldown)}" placeholder="0"></label>
</div>
<div class="button-def-foot">
<label class="check"><input name="hold_${i}" type="checkbox" value="on"${row.hold ? ' checked' : ''}> Hold while pressed</label>
<button type="submit" class="quiet" name="action" value="remove:${i}">Remove</button>
</div>
</fieldset>`).join('');
    return `<section class="setting-card" aria-labelledby="buttons-h"><h2 id="buttons-h">Buttons</h2>
<p class="setting-note">Each button sends its name to the robot. A key works while the panel has focus. Space always stops, and on a robot that drives its drive keys stay with driving. Buttons named forward, back (or backward), left (or turn_left) and right (or turn_right) also get a joystick, and W A S D, the arrows and a gamepad press them.</p>
${settings.error ? `<p class="error" role="alert">${esc(settings.error)}</p>` : ''}
<form method="post" action="/robots/${esc(robot.id)}/profile" data-profile-form>
<input type="hidden" name="count" value="${shown.length}">
${fields}
<button type="submit" class="quiet" name="action" value="add">Add a button</button>
<label class="toggle"><input type="checkbox" name="point" value="on"${point ? ' checked' : ''}><span><b>Video click</b><small>A click on the camera sends where it landed, for drivers.</small></span></label>
<label class="field"><span>Video click cooldown (ms)</span><input type="number" name="point_cooldown" min="0" step="1" value="${esc(pointCooldown)}" placeholder="0"></label>
<div class="form-actions">
<button type="submit" class="primary" name="action" value="save">Save buttons</button>
${settings.catalogueId && robot.profile_id.startsWith('local.') ? `<button type="submit" class="quiet" name="action" value="catalogue">Use ${esc(settings.catalogueId)} instead</button>` : ''}
</div>
</form></section>`;
}

/** A link out of a frame: always a new tab, never with a handle back to the framing page. */
const outLink = (href, text, cls = 'button') => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

/**
 * The owner's People card: who may drive (operators) and who may watch (viewers), each with Network's name
 * (or the subject id when Network was not reachable while the page was drawn), and the @username add form.
 * Rendered only for the owner's own page.
 */
function peopleCard(robot, people) {
    const roleName = (r) => (r === 'viewer' ? 'Viewer' : 'Operator');
    const row = (p) => {
        const remove = `<form method="post" action="/robots/${esc(robot.id)}/operators/${esc(encodeURIComponent(p.subject))}/remove"><button type="submit" class="quiet">Remove</button></form>`;
        const who = p.username
            ? `<b>${esc(p.display_name)}</b><small>@${esc(p.username)} · ${roleName(p.role)}</small>`
            : `<b>${esc(p.subject)}</b><small>name unavailable</small>`;
        return `<li class="person"><span class="who">${who}</span>${remove}</li>`;
    };
    const queue = robot.access_policy === 'queue' ? ' Anyone signed in can also take a turn: this robot uses the open queue.' : '';
    return `<section class="setting-card people" aria-labelledby="people-h"><h2 id="people-h">People</h2>
<p class="setting-note">Operators drive and can press the e-stop; viewers watch.${queue}</p>
<ul class="people-list">
<li class="person"><span class="who"><b>You</b><small>Owner</small></span></li>
${(people || []).map(row).join('\n')}
</ul>
<form class="people-add" method="post" action="/robots/${esc(robot.id)}/operators"><label class="sr-only" for="people-name">Username</label><input id="people-name" name="username" placeholder="@username" required maxlength="41" autocomplete="off"><select name="role" aria-label="Role"><option value="operator">Operator</option><option value="viewer">Viewer</option></select><button type="submit">Add</button></form>
</section>`;
}

/**
 * The turn strip on a `queue` robot's panel. A signed-in non-member sees the active turn's countdown or their place in
 * line, with a plain leave form that works without JavaScript. The owner and operators see it only while their own
 * driving has paused someone's turn (owner takeover), with "Give back now". public/panel.js unhides and paints it from
 * the state frames; it stays hidden until one says there is something to show this person.
 */
function turnStrip(robot, role) {
    if (robot.access_policy !== 'queue' || !['queue', 'owner', 'operator'].includes(role)) return '';
    const leave = role === 'queue' ? `<form method="post" action="/robots/${esc(robot.id)}/queue/leave" data-turn-leave><button type="submit" class="quiet">Leave the queue</button></form>` : '';
    const give = role === 'queue' ? '' : '<button type="button" class="quiet" data-turn-give hidden>Give back now</button>';
    return `<div class="turn" data-turn hidden><span class="turn-state" data-turn-state></span><span class="turn-meta" data-turn-meta></span>${leave}${give}</div>`;
}

/**
 * The owner's limits card: the values the gate and the device actually enforce, each with where it came
 * from (the profile's default, or set for this robot), and the owner's account id. `robot.limits` alone
 * can be `{}`, which reads as "no limits"; these are the numbers the robot really uses.
 */
function limitsCard(robot, info, profile = null) {
    if (!info) return '';
    const { effective, profileName, robotLimits = {}, subject } = info;
    const row = (label, key, shown) => {
        const source = robotLimits[key] != null ? 'set for this robot' : `from the ${profileName} profile`;
        return `<li><b>${esc(label)}</b> <span>${esc(shown)}</span> <small>${esc(source)}</small></li>`;
    };
    return `<section class="setting-card" aria-labelledby="limits-h"><h2 id="limits-h">Limits</h2>
<p class="setting-note">What this robot enforces on every command, from anyone including you. A profile value applies until you set one for this robot.</p>
<ul class="people-list">
${row('Top speed', 'max_speed', effective.maxSpeed)}
${row('Turning', 'max_turn', effective.maxTurn)}
${row('Longest command', 'max_command_ms', `${effective.maxCommandMs} ms`)}
</ul>
<p class="setting-note">Your account ID <code data-copy-source>${esc(subject)}</code> <button type="button" class="copy" data-copy data-copy-label="Copy"><span data-copy-label>Copy</span></button></p>
</section>`;
}


/**
 * Commissioning (owner only): raise this robot's max_speed/max_turn above the profile's defaults, up to its
 * ceiling, and drop back to the defaults at once. One explicit form each way; nothing here applies to an
 * operator or an agent.
 */
function commissionForm(robot, profile) {
    const limits = profile.limits || {};
    const ceiling = profile.ceiling || limits;
    const at = robot.commissioned || null;
    const own = robot.limits || {};
    const allow = `up to ${esc(ceiling.max_speed)} speed and ${esc(ceiling.max_turn)} turn`;
    const when = (iso) => { const d = new Date(iso); return isNaN(d) ? esc(iso) : esc(d.toISOString().slice(0, 16).replace('T', ' ')) + ' UTC'; };
    if (at) {
        // Commissioned: the owner sets this robot's own drive limits here (or with PATCH /api/v1/robots/:id).
        const field = (name, label, value, cap) => `<label class="setting-field"><span>${label}</span><input type="number" name="${name}" min="0.05" max="${esc(cap)}" step="0.05" value="${esc(value)}" required inputmode="decimal"><small>${esc(limits[name])} by default, at most ${esc(cap)}</small></label>`;
        return `<section class="setting-card" id="commission" aria-labelledby="commission-h"><h2 id="commission-h">Commissioned limits</h2>
<p class="setting-ok" role="status">Commissioned ${when(at.at)}. This robot may use your own speed and turn ${allow}.</p>
<form method="post" action="/robots/${esc(robot.id)}/limits" class="setting-form">
${field('max_speed', 'Top speed', own.max_speed != null ? own.max_speed : limits.max_speed, ceiling.max_speed)}
${field('max_turn', 'Top turn', own.max_turn != null ? own.max_turn : limits.max_turn, ceiling.max_turn)}
<button type="submit" class="primary">Save the limits</button></form>
<p class="setting-note">The robot gets them at once. The e-stop, cooldowns and command length (${esc(limits.max_command_ms)} ms) stay as they are.</p>
<form method="post" action="/robots/${esc(robot.id)}/uncommission"><button type="submit" class="quiet">Return to the profile defaults (${esc(limits.max_speed)} speed, ${esc(limits.max_turn)} turn)</button></form></section>`;
    }
    // Not commissioned: one deliberate act, with the owner saying what they checked.
    return `<section class="setting-card" id="commission" aria-labelledby="commission-h"><h2 id="commission-h">Commissioned limits</h2>
<p class="setting-note">The profile's speed (${esc(limits.max_speed)}) and turn (${esc(limits.max_turn)}) limits clamp every command. Commissioning this robot lets you set its own higher values ${allow}. It records that you did it and when, and it is yours alone: operators and your agent can never do it.</p>
<form method="post" action="/robots/${esc(robot.id)}/commission" class="setting-form">
<label class="setting-check"><input type="checkbox" name="confirm" value="on" required> I have checked this robot can move faster safely: there is clear space around it, and I can reach its e-stop.</label>
<button type="submit" class="primary">Commission this robot</button></form></section>`;
}


// ── The same controls over a picture ({mode=overlay}) or in a narrow card ({mode=compact}) ───────────────
// The embeddable panel normally draws the whole page. Over a stream it must draw only the live controls:
// the first stick, the first slider, the e-stop and a way to the full panel. Which ones exist comes from the
// robot's profile (commands + widgets), exactly as the full panel does; nothing here is robot-specific.
const BOT_VIEWS = new Set(['panel', 'overlay', 'compact']);
const botViewOf = (v) => (BOT_VIEWS.has(v) ? v : 'panel');
const BOT_VIEW_MIN = { panel: [320, 480], overlay: [280, 196], compact: [320, 112] };

/** The first stick the robot has: a drive joystick, a pan-tilt camera's, or a direction-button robot's. */
function overlayStickMarkup(profile, allowed) {
    const commands = profile.commands || {};
    for (const w of profile.widgets || []) {
        const kind = w.command ? w.command.kind : null;
        const enabled = !!kind && allowed.includes(kind);
        if (w.type === 'drive') {
            const axes = (commands[kind] && commands[kind].axes) || {};
            const x = STICK_X.find((a) => axes[a]);
            const y = STICK_Y.find((a) => axes[a]);
            if (!x && !y) continue;
            const stick = {};
            if (x) stick.x = x;
            if (y) stick.y = y;
            const label = [y && AXIS_NAME[y], x && AXIS_NAME[x]].filter(Boolean).join(' and ');
            return `<section class="widget widget-drive bot-widget" data-widget="drive" data-command="${data(w.command)}">`
                + `<div class="drive-pad" data-axes="${data(axes)}"><div class="stick" data-joystick="${data(stick)}" role="img" aria-label="${esc(`Joystick: ${label}. Drag and hold to drive.`)}"${enabled ? '' : ' aria-disabled="true"'}>`
                + '<span class="stick-ring"></span><span class="stick-cross"></span><svg class="stick-dirs" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="M50 5l6 7H44zM95 50l-7 6V44zM50 95l-6-7h12zM5 50l7-6v12z"/></svg><span class="stick-knob" data-knob></span></div></div></section>';
        }
        if (w.type === 'ptz') {
            const axes = (commands[kind] && commands[kind].axes) || {};
            if (!axes.pan || !axes.tilt) continue;
            return `<section class="widget widget-ptz bot-widget" data-widget="ptz" data-command="${data(w.command)}">`
                + `<div class="ptz-pad"><div class="stick stick--ptz" data-ptz-stick="${data({ x: 'pan', y: 'tilt' })}" data-axes="${data(axes)}" role="img" aria-label="Joystick: pan and tilt. Drag and hold to move the camera."${enabled ? '' : ' aria-disabled="true"'}>`
                + '<span class="stick-ring"></span><span class="stick-cross"></span><svg class="stick-dirs" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="M50 5l6 7H44zM95 50l-7 6V44zM50 95l-6-7h12zM5 50l7-6v12z"/></svg><span class="stick-knob" data-knob></span></div></div></section>';
        }
        if (w.type === 'buttons') {
            const names = (commands.button && commands.button.names) || {};
            const dirs = DIRECTION_BUTTONS.filter((d) => d.names.some((n) => names[n]));
            if (dirs.length < 2) continue;
            return `<section class="widget widget-buttons bot-widget" data-widget="buttons" data-command="${data(w.command || { kind: 'button' })}">`
                + `<div class="stick stick--buttons" data-button-stick role="img" aria-label="${esc(`Joystick: presses ${dirs.map((d) => d.label).join(', ')}. Drag and hold to drive.`)}"${enabled ? '' : ' aria-disabled="true"'}>`
                + '<span class="stick-ring"></span><span class="stick-cross"></span><svg class="stick-dirs" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="M50 5l6 7H44zM95 50l-7 6V44zM50 95l-6-7h12zM5 50l7-6v12z"/></svg><span class="stick-knob" data-knob></span></div></section>';
        }
    }
    return '';
}

/** The first actuator slider (a number range) any widget drives, e.g. the LOOI's head. */
function overlaySlider(profile, allowed) {
    const commands = profile.commands || {};
    const names = (commands.actuator && commands.actuator.names) || {};
    for (const w of profile.widgets || []) {
        if (!['pan-tilt', 'servo', 'head', 'lift', 'lights', 'horn'].includes(w.type)) continue;
        const kind = w.command ? w.command.kind : null;
        for (const name of (w.command && w.command.names) || []) {
            const a = names[name];
            if (a && a.type === 'number') return { widget: w, name, actuator: a, enabled: !!kind && allowed.includes(kind) };
        }
    }
    return null;
}

const botPill = (robot, attrs = '') => `<span class="bot-pill bot-control" data-bot-pill data-online-pill data-state="connecting" data-bot-hit data-ov-part="pill" ${attrs}><span class="dot"></span><b class="bot-pill-name">${esc(robot.name)}</b><span class="bot-pill-state" data-bot-state>Connecting…</span></span>`;
// A watcher (the anonymous embed on a stream) takes the controls with Drive, as on the full panel; the e-stop waits,
// hidden, for the join that makes them an operator (public/panel.js onFrame), and the line under the controls says
// what the page around answered (sign in there, or the owner decides who drives). Ask 353, 2026-11-11: on a phone over
// the stream there was no way to start driving at all.
const botEstop = (role, canDrive = false, attrs = '') => (ESTOP_ROLES.has(role)
    ? `<button type="button" class="bot-estop bot-control" data-estop data-bot-hit data-ov-part="estop" ${attrs} aria-label="E-stop" title="E-stop">${icon('stop')}</button>`
    : canDrive ? `<button type="button" class="bot-estop bot-control" data-estop data-bot-hit data-ov-part="estop" data-ov-role-hidden="true" ${attrs} aria-label="E-stop" title="E-stop" hidden>${icon('stop')}</button>` : '');
const botDrive = (canDrive, attrs = '') => (canDrive
    ? `<button type="button" class="bot-drive bot-control" data-drive data-drive-bar data-bot-hit data-ov-part="drive" ${attrs} title="Take the controls">${icon('gamepad')}<span>Drive</span></button>` : '');
const botNotice = '<p class="bot-notice bot-control" data-notice data-bot-hit role="alert" hidden></p>';
const botMore = (attrs = '') => `<button type="button" class="bot-more bot-control" data-bot-more data-bot-hit data-ov-part="more" ${attrs} aria-label="More controls" title="Open the full panel"><span aria-hidden="true">•••</span></button>`;

/** The overlay/compact page: a transparent surface with only the controls, no topbar, header or widgets. */
function renderBotSurface({ robot, profile, role, allowed_commands = [], holdResendMs = 150, view = 'overlay', parentOrigins = [], signedIn = true, arrange = null }) {
    const surface = require('./surface');
    const arrangeApply = !!(arrange && arrange.layoutSource === 'account');
    const attrs = (id) => (arrange ? surface.attrsFor(arrange.catalog, arrange.layout, arrange.device, id, { apply: arrangeApply }) : '');
    const stick = overlayStickMarkup(profile, allowed_commands);
    const slider = overlaySlider(profile, allowed_commands);
    const canDrive = role === 'watcher' && !signedIn;
    const stop = botEstop(role, canDrive, attrs('estop')) + botDrive(canDrive, attrs('drive'));
    const sliderLabel = slider ? esc(humanName(slider.name)) : '';
    const sliderMarkup = slider
        ? `<div class="bot-slider bot-control" data-bot-hit data-ov-part="slider" ${attrs('slider')}><section class="widget bot-widget" data-command="${data(slider.widget.command)}"><label class="control bot-range-label"><span class="sr-only">${sliderLabel}</span>${numberRange(slider.name, slider.actuator, slider.enabled, profile.id)}</label></section></div>`
        : '';
    const stickMarkup = stick ? `<div class="bot-stick bot-control" data-bot-hit data-ov-part="stick" ${attrs('stick')}>${stick}</div>` : '';
    const surfaceAttrs = arrange ? surface.overlaySurfaceAttrs(arrange.catalog, arrange.layout, arrange.device, arrangeApply && view !== 'compact') : '';
    const body = view === 'compact'
        ? `<div class="bot-compact" data-bot-compact${slider ? '' : ' data-no-slider'} ${surfaceAttrs}>${botPill(robot, attrs('pill'))}${stickMarkup}${sliderMarkup}${stop}${botMore(attrs('more'))}${botNotice}</div>`
        : `<div class="bot-overlay" data-bot-overlay ${surfaceAttrs}>${botPill(robot, attrs('pill'))}${stickMarkup}${sliderMarkup}${stop}${botMore(attrs('more'))}${botNotice}</div>`;
    const dataScript = arrange ? `<script type="application/json" id="ov-arrange-data">${JSON.stringify({ catalog: arrange.catalog, layout: arrange.layout, device: arrange.device, surface: arrange.catalog.id, signedIn: arrange.signedIn, layoutSource: arrange.layoutSource || 'default', save: arrange.save || null, suggest: arrange.suggest || null, share: arrange.share || null, reset: arrange.reset || null, author: arrange.author || null }).replace(/</g, '\\u003c')}</script>` : '';
    return `<main id="panel" class="bot-surface" tabindex="0" data-robot-id="${esc(robot.id)}" data-role="${esc(role)}" data-hold-ms="${esc(holdResendMs)}" data-allowed="${data(allowed_commands)}" data-bot-view="${esc(view)}"${parentOrigins.length ? ` data-parent-origins="${esc(parentOrigins.join(' '))}"` : ''}>${body}${dataScript}</main>`;
}

function renderPanel({ robot, profile, role, allowed_commands = [], holdResendMs = 150, mode = 'page', view = 'panel', signedIn = true, streaming = null, people = null, signaling_url = null, profileForm = {}, tryIt = false, automation = null, parentOrigins = [], liveUrl = null, limitsInfo = null, arrange = null }) {
    const embed = mode === 'embed';
    const botView = embed ? botViewOf(view) : 'panel';
    if (embed && botView !== 'panel') {
        const [minWidth, minHeight] = BOT_VIEW_MIN[botView];
        return page(robot.name, renderBotSurface({ robot, profile, role, allowed_commands, holdResendMs, view: botView, parentOrigins, signedIn, arrange }), {
            scripts: panelScripts(profile, false, true),
            bodyClass: `embed-page bot-mode-${botView}`,
            htmlClass: `embed-page bot-mode-${botView}`,
            htmlAttrs: ` data-bot-view="${botView}" data-bot-min-width="${minWidth}" data-bot-min-height="${minHeight}"`,
            colorScheme: 'dark light',
        });
    }
    const minSize = BOT_VIEW_MIN.panel;
    const htmlAttrs = embed ? ` data-bot-view="panel" data-bot-min-width="${minSize[0]}" data-bot-min-height="${minSize[1]}"` : '';
    const latched = !!(robot.estop && robot.estop.latched);
    const widgetOrder = (profile.widgets || []).map((w, i) => ({ w, i }))
        .sort((a, b) => (a.w.order != null ? a.w.order : 1e9 + a.i) - (b.w.order != null ? b.w.order : 1e9 + b.i));
    // The arrangeable part ids each widget draws: the drive is split into its stick, Stop and direction buttons.
    const byWidget = new Map();
    for (const p of (arrange && arrange.catalog ? arrange.catalog.parts || [] : [])) {
        const source = (arrange.parts || []).find((x) => x.id === p.id);
        if (!source || source.widgetIndex == null) continue;
        if (!byWidget.has(source.widgetIndex)) byWidget.set(source.widgetIndex, []);
        byWidget.get(source.widgetIndex).push(p.id);
    }
    const widgetParts = (i) => byWidget.get(i) || [];
    const arrangeApply = !!(arrange && arrange.layoutSource === 'account');
    const attrsOf = (ids) => Object.fromEntries(ids.map((id) => [id, arrange ? require('./surface').attrsFor(arrange.catalog, arrange.layout, arrange.device, id, { apply: arrangeApply }) : '']));
    const widgets = widgetOrder.map(({ w, i }) => renderWidget(w, { profile, allowed_commands, signaling_url, part: widgetParts(i)[0] || null, partAttrs: attrsOf(widgetParts(i)), flatten: arrangeApply }));
    // A robot with no drive widget still gets its Stop: a required part of bot.controls, drawn on its own.
    const drawn = new Set([...byWidget.values()].flat());
    if (arrange && !drawn.has('stop') && require('./surface').partOf(arrange.catalog, 'stop')) {
        widgets.push(`<section class="widget widget-stop" data-widget="stop" data-ov-part="stop" ${attrsOf(['stop']).stop || ''}>`
            + `<h2>Stop</h2><button type="button" class="stop" data-stop>${icon('square')}<span>Stop</span></button></section>`);
    }
    // A framed watcher may take the controls with Drive; its e-stop waits, hidden, for an owner's or operator's join.
    const estop = ESTOP_ROLES.has(role) ? `<button type="button" class="estop" data-estop>${icon('stop')}<span>E-stop</span></button>`
        : (embed && role === 'watcher' ? `<button type="button" class="estop" data-estop hidden>${icon('stop')}<span>E-stop</span></button>` : '');
    const clear = role === 'owner' ? `<button type="button" class="estop-clear" data-estop-clear${latched ? '' : ' hidden'}>Clear e-stop</button>` : '';
    const arrangeButton = arrange && arrange.src
        ? `<button type="button" class="arrange-btn" data-arrange data-arrange-src="${esc(arrange.src || '')}" title="Arrange the controls">${icon('sliders')}<span>Arrange</span></button>` : '';
    const body = `<header class="estop-banner" data-estop-banner data-latched="${latched}">
${embed ? '' : tryIt ? topbar('<span class="crumb">Try the panel</span>', '/') : topbar(`<span class="crumb">${esc(robot.name)}</span>`)}
<div class="estop-bar"><p class="estop-state" role="status" aria-live="assertive"><span class="estop-dot"></span><span data-estop-state>${latched ? 'E-stop latched' : 'E-stop clear'}</span><span class="estop-note">${latched ? ' — the robot stays still until the owner clears it.' : ''}</span></p>${clear}${estop}</div>
</header>
<main id="panel" tabindex="0" data-robot-id="${esc(robot.id)}" data-role="${esc(role)}" data-hold-ms="${esc(holdResendMs)}" data-allowed="${data(allowed_commands)}"${tryIt ? ' data-transport="local"' : ''} data-bot-view="${esc(botView)}"${embed && parentOrigins.length ? ` data-parent-origins="${esc(parentOrigins.join(' '))}"` : ''}>
<div class="panel-head">
${kit.pageHead({ title: `${robot.name}`, icon: 'gear', back: embed ? null : { href: '/', label: 'Home' } })}
<p class="meta"><span class="pill online" data-online-pill data-state="connecting"><span class="dot"></span><span data-online-label>Connecting…</span></span> <span class="pill">${esc(profile.name || robot.profile_id)}</span> <span class="pill role" data-role-label>${esc(ROLE_LABEL[role] || role)}</span></p>
${turnStrip(robot, role)}
${arrangeButton}
${embed && role === 'watcher' && !signedIn ? `<p class="embed-sign-in"><button type="button" class="button primary" data-drive data-drive-bar>${icon('gamepad')}<span>Drive</span></button> <a class="button embed-open" href="/panel/${esc(robot.id)}" target="_blank" rel="noopener" title="Open on openvibe.bot">${icon('external')}<span>Open on openvibe.bot</span></a></p>` : ''}
</div>
${tryIt ? tryIntro() : ''}
<p class="notice" data-device-fault role="status" hidden></p>
<p class="notice" data-notice role="alert" hidden></p>
<div class="widgets"${arrange ? require('./surface').surfaceAttrs(arrange.catalog, arrange.layout, arrange.device, arrangeApply) : ''}>
${widgets.join('\n')}
</div>
${arrange ? `<script type="application/json" id="ov-arrange-data">${JSON.stringify({ catalog: arrange.catalog, layout: arrange.layout, device: arrange.device, surface: arrange.catalog.id, signedIn: arrange.signedIn, layoutSource: arrange.layoutSource || 'default', save: arrange.save || null, suggest: arrange.suggest || null, share: arrange.share || null, reset: arrange.reset || null, author: arrange.author || null }).replace(/</g, '\\u003c')}</script>` : ''}${tryIt ? tryOutro(profile) : ''}${role === 'owner' && !embed && !tryIt ? `<div class="owner-settings">${limitsCard(robot, limitsInfo, profile)}${onStreamCard(robot, { liveUrl })}${localProfileForm(robot, profile, profileForm)}${commissionForm(robot, profile)}${automation ? routinesCard(robot, profile, automation) + webhooksCard(robot, automation) : ''}${agentForm(robot)}${listingForm(robot)}${embedForm(robot)}${streamingForm(robot, streaming)}${people ? peopleCard(robot, people) : ''}</div>` : ''}
</main>`;
    return page(tryIt ? 'Try the panel with a simulated rover' : robot.name, body, {
        scripts: panelScripts(profile, tryIt, embed), bodyClass: embed ? 'embed-page' : 'panel-page',
        htmlClass: embed ? 'embed-page' : '', htmlAttrs, colorScheme: embed ? 'dark light' : 'dark',
        description: tryIt ? TRY_DESCRIPTION : null, canonical: tryIt ? '/try' : null,
    });
}

const TRY_DESCRIPTION = 'Drive a simulated rover from your browser with no account or hardware: the same Bot panel, safety gate and e-stop a real robot gets, with a live camera.';

/** /try's opening lines: what this is, and that nothing here is real hardware. */
function tryIntro() {
    return `<section class="try-intro" aria-labelledby="try-h">
<h2 id="try-h">Drive a rover, right here</h2>
<p>This rover is simulated in your browser, so nothing you press moves real hardware. It goes through the same panel a paired robot gets: the same controls, the same limits, and an e-stop that holds until it is cleared.</p>
<ul class="try-keys"><li><kbd>W A S D</kbd> or the arrows, or drag the joystick</li><li><kbd>Space</kbd> stops</li><li>Follow the yellow tape, or find the crates</li></ul>
<p><button type="button" class="button quiet" data-try-reset>Back to the start</button></p>
</section>`;
}

/** /try's closing card: from the simulator to a real robot, and the profile this panel was drawn from. */
function tryOutro(profile) {
    return `<section class="try-next card" aria-labelledby="try-next-h">
<h2 id="try-next-h">Ready for a real one?</h2>
<p>Add a robot, pair its computer with one pasted command, and this panel drives it. A Raspberry Pi rover, a Cozmo through a nearby computer, an ONVIF camera or a phone are all a few minutes away.</p>
<p class="try-actions"><a class="button primary" href="/robots/new">Add a robot</a> <a class="button quiet" href="/models">See the models</a> <a class="button quiet" href="/docs/profiles">How a profile draws this panel</a> <a class="button quiet" href="/docs/drivers">Write a driver</a></p>
</section>
<script type="application/json" id="try-profile">${JSON.stringify(profile).replace(/</g, '\\u003c')}</script>`;
}

/**
 * The Drive popup (/panel/:id/drive): first-party, so it has the openvibe.bot session the frame cannot see. Its script
 * (public/drive.js) mints a one-time control ticket and hands it to the panel that opened it, then closes.
 */
function renderDrivePage({ robot }) {
    const body = `<main class="page drive-page" data-drive-page data-robot-id="${esc(robot.id)}">
<div class="card">${kit.pageHead({ title: `${robot.name}`, icon: 'gear', back: { href: '/', label: 'Home' } })}
<p data-drive-status role="status">Connecting the panel…</p>
<p>${outLink(`/panel/${robot.id}`, 'Open the full panel instead')}</p></div>
</main>`;
    return page(`Drive ${robot.name}`, body, { scripts: ['/panel/drive.js'], bodyClass: 'drive-popup' });
}

/** The framed 403: no robot data, only a way out to openvibe.bot (where signing in may grant access). */
function renderEmbedRefused({ robotId, parentOrigins = [] }) {
    const body = `<main class="page embed-refused" data-embed-refused="${esc(robotId)}" data-parent-origins="${esc(parentOrigins.join(' '))}">
<div class="card"><p>This robot's panel is not shown here yet.</p>
<p class="setting-note">Its owner turns it on with "Put the buttons under my OpenVibe.Live stream" on the robot's page.</p>
<p>${outLink(`/panel/${robotId}#on-stream`, 'Open on openvibe.bot', 'button primary')}</p></div>
</main>`;
    // refused.js tells the page around the frame, so a stream page can hide the box or point its owner to the switch.
    return page('Not shown here yet', body, { bodyClass: 'embed-page', htmlClass: 'embed-page', colorScheme: 'dark light', scripts: ['/panel/refused.js'] });
}

/**
 * "Get a robot": the curated kits (server/kits), each with what it is, the parts to buy, its build guide and a
 * one-click start that opens the add form with the kit's tested profile chosen. Metadata only: no prices or
 * shop links until the owner settles supply (plan O29).
 */
function kitsSection(kits = [], profiles = []) {
    const shipped = new Set(profiles.map((p) => p.id));
    const usable = kits.filter((k) => shipped.has(k.profile_id));
    if (!usable.length) return '';
    const part = (p) => `<li><span class="part-qty">${esc(p.qty)}×</span><span>${esc(p.name)}${p.note ? `<small>${esc(p.note)}</small>` : ''}</span></li>`;
    const card = (k) => {
        const need = k.parts.filter((p) => p.required !== false).length;
        return `<li class="kit card"><div class="kit-head">${icon('robot', 'icon kit-icon')}<div><h3>${esc(k.name)}</h3>${k.vendor ? `<span class="pill">${esc(k.vendor)}</span>` : ''}</div></div>
<p class="kit-desc">${esc(k.description || '')}</p>
<details class="kit-parts"><summary>What you need <span class="muted">(${esc(need)} ${need === 1 ? 'part' : 'parts'})</span></summary><ul>${k.parts.map(part).join('')}</ul></details>
<p class="kit-actions"><a class="button primary" href="/robots/new?profile=${encodeURIComponent(k.profile_id)}">Add this robot</a> ${outLink(k.build_guide_url, 'Build guide', 'button quiet')}</p></li>`;
    };
    return `<section class="kits" aria-labelledby="kits-h"><h2 id="kits-h">Get a robot</h2>
<p class="muted">Curated kits with a ready-made profile: build one, pair it, and its panel already knows every motor and sensor.</p>
<ul class="kit-list">${usable.map(card).join('')}</ul></section>`;
}

function renderRobotsPage({ robots = [], profiles = [], kits = [], error = null, values = {} }) {
    const names = new Map(profiles.map((p) => [p.id, p.name]));
    const list = robots.length
        ? `<ul class="robots">${robots.map((r) => `<li class="robot-card"><a class="robot-name" href="/panel/${esc(r.id)}">${icon('robot')}<span>${esc(r.name)}</span></a>`
            + `<span class="robot-meta"><span class="pill">${esc(names.get(r.profile_id) || r.profile_id)}</span> <span class="pill">${esc(POLICY_LABEL[r.access_policy] || r.access_policy)}</span></span>`
            + `<span class="robot-actions"><a class="button" href="/panel/${esc(r.id)}">Open panel</a> <a class="button quiet pair" href="/pair/${esc(r.id)}">${icon('plug')}<span>Pair a device</span></a></span>${embedForm(r, { card: false })}</li>`).join('')}</ul>`
        : `<div class="empty">${icon('robot', 'icon empty-icon')}<p class="empty-title">No robots yet.</p><p>Add one below. A simulated rover needs no hardware and drives straight away.</p></div>`;
    const option = (v, label, selected) => `<option value="${esc(v)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
    const form = `<form class="add-robot card" id="add-robot" method="post" action="/robots">
<h2>Add a robot</h2>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<label class="field"><span class="field-label">Name</span><input type="text" name="name" maxlength="80" required autocomplete="off" placeholder="e.g. Kitchen rover" value="${esc(values.name || '')}"></label>
<label class="field"><span class="field-label">Model</span><select name="profile_id">${profiles.map((p) => option(p.id, p.name, p.id === values.profile_id)).join('')}</select></label>
<label class="field"><span class="field-label">Who may drive</span><select name="access_policy">${POLICIES.map(([v, label]) => option(v, label, v === (values.access_policy || 'private'))).join('')}</select></label>
<button type="submit" class="primary">Add robot</button>
</form>`;
    return page('Your robots', `${topbar()}\n<main class="page">\n${kit.pageHead({ title: `Your robots`, icon: 'gear', back: { href: '/', label: 'Home' } })}\n${list}\n${form}\n${kitsSection(kits, profiles)}\n</main>`);
}

function renderPairingPage({ robot, pairing, profile = null, phoneUrl = null }) {
    // A phone is the device itself: it pairs from its browser (the QR code opens /device/phone with the code).
    const phone = !!(profile && profile.mapping && profile.mapping.driver === 'phone' && phoneUrl);
    const first = phone
        ? `<li class="card phone-pair"><h2>Scan this with the phone <span class="pill">${esc(profile.name)}</span></h2>
<div class="qr-box">${qrSvg(phoneUrl, { label: `Opens the pairing page for ${robot.name} on the phone` })}</div>
<p class="muted">It opens the robot's page on the phone with this code filled in. Tap Pair, allow the camera, and keep the page open: the phone is the robot now. No app to install.</p>
<p class="muted">No camera app handy? Open <b>openvibe.bot/device/phone</b> on the phone and enter the robot and code by hand: <code>${esc(robot.id)}</code></p></li>`
        : `<li class="card"><h2>Run this on the machine that serves the robot${profile ? ` <span class="pill">${esc(profile.name)}</span>` : ''}</h2>
<pre tabindex="0" class="installer"><code data-copy-source>${esc(pairing.installer)}</code></pre>
<button type="button" class="copy" data-copy>${icon('copy')}<span data-copy-label>Copy the command</span></button></li>`;
    const body = `${topbar(`<span class="crumb">${esc(robot.name)}</span>`)}
<main class="page pairing" data-pair-robot="${esc(robot.id)}">
${kit.pageHead({ title: `Pair ${robot.name}`, icon: 'gear', back: { href: '/', label: 'Home' } })}
<p class="pair-status" data-pair-status data-state="waiting" role="status" aria-live="polite"><span class="dot"></span><span data-pair-text>Waiting for the device.</span> <a class="button primary" href="/panel/${esc(robot.id)}" data-pair-open hidden>Open the panel</a></p>
<ol class="steps">
${first}
<li class="card"><h2>Or enter the pairing code</h2>
<p><strong class="code">${esc(pairing.code)}</strong></p>
<p class="muted">Valid until <time datetime="${esc(pairing.expires_at)}">${esc(pairing.expires_at)}</time>. It works once.</p></li>
</ol>
<p class="muted">This page turns green as soon as the device connects. <a href="/panel/${esc(robot.id)}">Open the panel</a> any time.</p>
</main>`;
    return page(`Pair ${robot.name}`, body, { scripts: ['/panel/panel.js'] });
}

/**
 * A gated page's answer on this origin (audit SEO-7): noindex, and a link to Network sign-in instead of a
 * redirect there. A redirect handed a crawler openvibe.network's canonical as this page's; this keeps the
 * page on openvibe.bot, says noindex, and a person is one click from signing in.
 */
function renderSignInPage({ next = '/robots', what = 'this page' } = {}) {
    const body = `${topbar('')}
<main class="page">
${kit.pageHead({ title: `Sign in to continue`, icon: 'gear', back: { href: '/', label: 'Home' } })}
<p>${esc(what.charAt(0).toUpperCase() + what.slice(1))} is for OpenVibe accounts. Sign in and you come straight back here.</p>
<p><a class="button primary" href="/auth/login?next=${esc(encodeURIComponent(next))}">Sign in with OpenVibe</a></p>
</main>`;
    return page('Sign in to continue', body, { robots: 'noindex, nofollow' });
}

/**
 * /link (server/claims.js): the code a device shows after `curl -fsSL https://openvibe.link/install | sh` with no code.
 * renderLinkPage asks for it; renderClaimPage shows what that device found and the choices its robot starts with;
 * renderClaimApproved follows the device as it pairs on its own.
 */
function renderLinkPage({ code = '', error = null, installer = 'curl -fsSL https://openvibe.link/install | sh' } = {}) {
    const body = `${topbar('<span class="crumb">Add a device</span>')}
<main class="page link">
${kit.pageHead({ title: `Add a device`, icon: 'gear', back: { href: '/', label: 'Home' } })}
<form class="card" method="get" action="/link">
<p>Enter the code the robot's computer shows. It shows one when you run this on it:</p>
<pre tabindex="0" class="installer"><code>${esc(installer)}</code></pre>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<label class="field"><span class="field-label">Code</span><input type="text" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" value="${esc(code)}" required autofocus></label>
<button type="submit" class="primary">Continue</button>
</form>
<p class="muted">Nothing on the robot's card yet? <a href="/setup/sd-card">Start from a blank microSD card</a>: the card adds the robot by itself, with no code.</p>
</main>`;
    return page('Add a device', body);
}

/**
 * /link/phone (plan 2026-11-07 §13.2): link the Android app to this account. The code is Network's one-time pairing
 * code; the QR carries it in the app's own link, so scanning it opens OpenVibe Link with the code filled in.
 */
function renderPhoneLinkPage({ pairing = null, apkUrl = null } = {}) {
    if (!apkUrl || !pairing) {
        const body = `${topbar('<span class="crumb">Link on your phone</span>')}
<main class="page pairing">
${kit.pageHead({ title: `Link on your phone`, icon: 'gear', back: { href: '/', label: 'Home' } })}
<p>OpenVibe Link for Android puts your agents' approvals in your pocket and adds <b>Send to OpenVibe</b> to every app's
share sheet. It is in testing and not published yet: when it is, you install it from here and pair it with a code.</p>
<p class="muted"><a href="https://openvibe.link/machines" rel="noopener">Your machines</a> · <a href="/robots">Your robots</a></p>
</main>`;
        return page('Link on your phone', body, { description: 'OpenVibe Link for Android: in testing, not published yet.' });
    }
    const qr = pairing.qr ? qrSvg(pairing.qr, { label: 'Opens OpenVibe Link with this pairing code' }) : '';
    const minutes = Math.max(1, Math.round((Date.parse(pairing.expires_at) - Date.now()) / 60000)) || 15;
    const body = `${topbar('<span class="crumb">Link on your phone</span>')}
<main class="page pairing">
${kit.pageHead({ title: `Link on your phone`, icon: 'gear', back: { href: '/', label: 'Home' } })}
<p>OpenVibe Link puts your agents' approvals in your pocket and adds <b>Send to OpenVibe</b> to every app's share sheet.
First <a href="${esc(apkUrl)}" rel="noopener">install it on your Android phone</a>, then scan or type the code below.</p>
<ol class="steps">
<li class="card phone-pair"><h2>Scan this with the phone</h2>
<div class="qr-box">${qr}</div>
<p class="muted">The phone's camera opens OpenVibe Link with the code filled in. No password is typed on the phone here:
the code pairs the device, and the app asks you to sign in separately.</p></li>
<li class="card"><h2>Or type the code in the app</h2>
<p><strong class="code">${esc(pairing.code)}</strong></p>
<p class="muted">It works once, for the next ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} (until <time datetime="${esc(pairing.expires_at)}">${esc(String(pairing.expires_at).slice(11, 16))} UTC</time>).</p></li>
</ol>
<p class="muted">The phone shows up on your account as a device of kind <b>phone</b>. It has no camera or screen access, and
nothing on the phone is automated. <a href="https://openvibe.link/machines" rel="noopener">Your machines</a> · <a href="/robots">Your robots</a></p>
</main>`;
    return page('Link on your phone', body, { description: 'Pair the OpenVibe Link Android app with a one-time code or its QR code.' });
}

function renderClaimPage({ claim, models = [], values = {}, error = null, now = Date.now() }) {
    const hw = claim.hardware || {};
    const minutes = (ms) => Math.max(0, Math.round(ms / 60000));
    const asked = minutes(now - new Date(claim.created_at).getTime());
    const left = minutes(new Date(claim.expires_at).getTime() - now);
    const suggested = models.some((m) => m.id === claim.suggested_profile) ? claim.suggested_profile : null;
    const chosen = values.profile_id || suggested || (models[0] && models[0].id);
    const facts = [
        ['Computer', [hw.model, hw.os, hw.arch].filter(Boolean).join(' · ') || 'not reported'],
        ['It found', (hw.found && hw.found.length ? hw.found.join(', ') : '') || hw.kit_name || 'no kit it knows'],
        ['Camera', hw.camera || 'none found'],
        ['Asked', `${asked < 1 ? 'just now' : `${asked} min ago`}${claim.address ? ` from ${claim.address}` : ''}`],
    ];
    const option = (m) => `<option value="${esc(m.id)}"${m.id === chosen ? ' selected' : ''}>${esc(m.name)}${m.id === suggested ? ' (found on it)' : ''}</option>`;
    const policy = values.access_policy || 'private';
    const live = values.live !== false;
    const body = `${topbar('<span class="crumb">Add a device</span>')}
<main class="page link">
${kit.pageHead({ title: `Add ${claim.hostname}?`, icon: 'gear', back: { href: '/', label: 'Home' } , lede: `Only approve a device you set up yourself, just now. If you did not run the command on it, deny it.` })}
<dl class="card facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<form class="card" method="post" action="/link/${esc(claim.id)}/approve">
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<label class="field"><span class="field-label">Name</span><input type="text" name="name" maxlength="80" required autocomplete="off" value="${esc(values.name != null ? values.name : claim.hostname)}"></label>
<label class="field"><span class="field-label">Model</span><select name="profile_id">${models.map(option).join('')}</select></label>
<label class="field"><span class="field-label">Who may drive</span><select name="access_policy">${POLICIES.map(([v, label]) => `<option value="${esc(v)}"${v === policy ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
<label class="field check"><input type="checkbox" name="live" value="on"${live ? ' checked' : ''}> <span>Show its camera on my OpenVibe.Live channel</span></label>
<button type="submit" class="primary">Approve</button>
</form>
<form method="post" action="/link/${esc(claim.id)}/deny"><button type="submit" class="quiet">Deny</button> <span class="muted">This code works for ${left} more minute${left === 1 ? '' : 's'}.</span></form>
</main>`;
    return page(`Add ${claim.hostname}`, body);
}

function renderClaimApproved({ robot, profile = null, live = false, chatUrl = null }) {
    const body = `${topbar(`<span class="crumb">${esc(robot.name)}</span>`)}
<main class="page pairing" data-pair-robot="${esc(robot.id)}">
${kit.pageHead({ title: `${robot.name} is yours`, icon: 'gear', back: { href: '/', label: 'Home' } })}
<p class="pair-status" data-pair-status data-state="waiting" role="status" aria-live="polite"><span class="dot"></span><span data-pair-text>Waiting for the device.</span> <a class="button primary" href="/panel/${esc(robot.id)}" data-pair-open hidden>Open the panel</a></p>
<ol class="steps">
<li class="card"><h2>The device carries on by itself${profile ? ` <span class="pill">${esc(profile.name)}</span>` : ''}</h2>
<p class="muted">It pairs, starts its driver and its camera, and prints its panel link. This page turns green when it connects.</p></li>
${live ? '<li class="card"><h2>On your Live channel</h2><p class="muted">Its camera goes on your OpenVibe.Live channel once it is streaming. Turn that off any time on its panel.</p></li>' : ''}
${chatUrl ? `<li class="card"><h2>Drive it from your chat</h2><p class="muted">Let your channel's chat commands (!forward, !left, !say …) drive this robot.</p><p><a class="button" href="${esc(chatUrl)}">Use it in my OpenVibe.Live chat</a></p></li>` : ''}
</ol>
<p class="muted"><a href="/panel/${esc(robot.id)}">Open the panel</a> any time.</p>
</main>`;
    return page(`${robot.name} is yours`, body, { scripts: ['/panel/panel.js'] });
}

/** A screen link that does not work (stopped, ended, never existed): one answer for every reason. */
function renderShareGone() {
    return page('Screen link', `<main class="page share-page">${kit.pageHead({ title: `This screen link does not work`, icon: 'gear', back: { href: '/', label: 'Home' } , lede: `It was stopped, it ended, or it never existed. Ask whoever shared it for a new one.` })}</main>`, { description: 'A shared computer screen on OpenVibe.Bot.' });
}

/** /screen/:token: a shared screen, live, for a frame or a tab; with "use" links, the mouse and keyboard too. */
function renderSharePage({ token, name, control, label, desk = 'main' }) {
    const base = `/screen/${encodeURIComponent(token)}`;
    const body = `<main class="page share-page" data-share="${esc(base)}" data-control="${control ? '1' : '0'}">
<header class="share-head"><h1>${esc(name)}${label ? ` <span class="muted">· ${esc(label)}</span>` : ''}</h1>
<p class="muted share-mode">${control ? 'Shared to watch and use' : 'Shared to watch'}${desk && desk !== 'main' ? `: the ${esc(desk)} desk, where an agent works (never the owner\'s own screen)` : ''}</p></header>
<figure class="camera machine-screen share-screen" data-screen-state="${esc(base)}/state.json" tabindex="${control ? '0' : '-1'}" aria-label="The shared screen${control ? ': turn on Use to click and type on it' : ''}">
<div class="camera-screen" data-camera-screen>${icon('plug', 'icon camera-icon')}<p class="camera-title" data-screen-status role="status">Looking for the screen…</p>
<p class="camera-sub">The picture comes from the computer itself, a few frames a second.</p></div>
</figure>
${control ? `<div class="share-controls">
<button type="button" class="primary" data-share-start hidden>Start the screen</button>
<label class="check share-use"><input type="checkbox" data-share-use> Use the mouse and keyboard</label>
<button type="button" class="button quiet" data-share-stop>Stop the screen</button>
<span class="muted small" data-share-note role="status"></span></div>` : ''}
</main>`;
    return page(`${name}: shared screen`, body, { scripts: ['/panel/panel.js', ...(control ? ['/panel/screen-share.js'] : [])], bodyClass: 'share-body', description: 'A shared computer screen on OpenVibe.Bot.' });
}

/**
 * /device/phone: the page that makes a phone the robot's device (public/phone-device.js). Its setup form pairs it (the
 * QR code fills in the robot and code); once running, the screen is the robot's face, with the link and camera state
 * above it and the phone's own Stop below.
 */
function renderPhonePage() {
    const body = `<main id="phone" class="phone" data-state="setup">
<section class="phone-setup" data-setup>
<p class="phone-brand">${icon('robot')}<span>OpenVibe<b>.Bot</b></span></p>
${kit.pageHead({ title: `Make this phone a robot`, icon: 'gear', back: { href: '/', label: 'Home' } , lede: `Pair it with a robot you added on openvibe.bot. Its camera streams to the robot's panel, it says what the driver types, shows a face, and reports its battery and tilt. Nothing to install: keep this page open.` })}
<form class="phone-form" data-pair-form>
<div data-pair-fields>
<label class="field" data-robot-field><span class="field-label">Robot</span><input name="robot" autocomplete="off" spellcheck="false" placeholder="rob_…"></label>
<label class="field"><span class="field-label">Pairing code</span><input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH"></label>
</div>
<p class="phone-paired" data-paired hidden>Paired as <b data-paired-name></b>. <button type="button" class="quiet" data-unpair-setup>Pair with another robot</button></p>
<label class="check"><input type="checkbox" name="front"> Use the front camera</label>
<button type="submit" class="primary">Start</button>
<p class="error" data-error role="alert" hidden></p>
</form>
<p class="muted small">Get a code: on openvibe.bot, add a robot, choose <b>A phone</b>, and scan the code its pairing page shows.</p>
</section>
<section class="phone-run" data-run hidden>
<header class="phone-bar"><span class="phone-pill" data-link-state data-state="connecting">Connecting…</span><span class="phone-pill" data-video-state data-state="off"></span><span class="phone-rtt" data-rtt></span></header>
<div class="phone-face" data-face aria-live="polite"></div>
<p class="phone-safety" data-safety role="status" hidden></p>
<video class="phone-preview" data-preview muted playsinline autoplay hidden></video>
<footer class="phone-foot"><button type="button" class="phone-stop" data-local-stop>Stop</button><button type="button" class="quiet" data-forget>Unpair</button></footer>
</section>
</main>`;
    return page('This phone is a robot', body, { scripts: ['/panel/phone-device.js'], bodyClass: 'phone-page', description: 'Turn a phone into a robot on OpenVibe.Bot from its browser: its camera, voice and face, with nothing to install.', canonical: '/device/phone' });
}

/**
 * /admin/first-run: the measured first run, reviewers only. One row per step the Link reported (link.first_run), so
 * the number that reach each step and the median time between them answer whether installs get to a working machine.
 */
function renderFirstRunPage({ rows = [] }) {
    const order = ['installed', 'paired', 'self_check', 'first_job'];
    const byStep = new Map(order.map((s) => [s, []]));
    const byDevice = new Map();
    for (const r of rows) {
        if (!byStep.has(r.step)) continue;
        const at = Date.parse(r.at);
        byStep.get(r.step).push({ ...r, ms: Number.isFinite(at) ? at : 0 });
        if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, {});
        byDevice.get(r.device_id)[r.step] = Number.isFinite(at) ? at : 0;
    }
    const median = (values) => {
        if (!values.length) return null;
        const a = [...values].sort((x, y) => x - y);
        const m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const span = (from, to) => median([...byDevice.values()]
        .map((d) => (d[from] && d[to] && d[to] >= d[from] ? (d[to] - d[from]) / 1000 : null))
        .filter((x) => x !== null));
    const secs = (v) => {
        if (v === null || v === undefined) return '—';
        if (v < 1) return 'under a second';
        if (v < 90) return `${Math.round(v)} s`;
        const m = Math.round(v / 60 * 10) / 10;
        return `${m} min`;
    };
    const count = (s) => byStep.get(s).length;
    const checks = byStep.get('self_check');
    const failed = checks.filter((r) => r.ok === false).length;
    const rowsHtml = [
        ['Installed', count('installed'), null],
        ['Paired', count('paired'), span('installed', 'paired')],
        ['Self-check', count('self_check'), span('paired', 'self_check')],
        ['First job done', count('first_job'), span('self_check', 'first_job')],
    ].map(([label, n, d]) => `<tr><th scope="row">${label}</th><td>${n}</td><td>${esc(secs(d))}</td></tr>`).join('');
    const latest = [...byDevice.entries()].map(([id, steps]) => {
        const last = order.filter((s) => steps[s]).at(-1) || 'installed';
        const at = steps[last] || steps.installed || 0;
        return { id, last, at };
    }).sort((a, b) => b.at - a.at).slice(0, 25);
    const recent = latest.length
        ? `<ul class="dir-list">${latest.map(({ id, last, at }) => {
            const row = byStep.get(last).find((r) => r.device_id === id);
            return `<li class="dir-card"><div class="dir-card-link"><code>${esc(id)}</code><span class="dir-card-text">${esc(last.replace('_', ' '))}`
                + `${row && row.agent_version ? ` · Link ${esc(row.agent_version)}` : ''}${row && row.os ? ` · ${esc(row.os)}` : ''}`
                + `${at ? ` · <time datetime="${esc(new Date(at).toISOString())}" data-local-time>${esc(new Date(at).toISOString().slice(0, 16).replace('T', ' '))}</time> UTC` : ''}</span></div></li>`;
        }).join('')}</ul>`
        : '<p class="muted">No machine has reported a first run yet.</p>';
    const body = `<p class="dir-crumb"><a href="/robots/submissions">Review</a> / First runs</p>
<div class="dir-hero">${kit.pageHead({ title: `First run`, icon: 'gear', back: { href: '/', label: 'Home' } , lede: `How many machines reach each step of OpenVibe Link's guided first run, and the median time from the step before. A machine reports one event per step over its own device link (link.first_run); nothing here names a person, folder or address.` })}</div>
<section class="dir-sec"><h2>The funnel</h2>
<table class="dir-table"><caption class="sr-only">First-run steps, machines and median time</caption>
<thead><tr><th scope="col">Step</th><th scope="col">Machines</th><th scope="col">Median from the step before</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
<p class="muted">${count('self_check') - failed} self-check${count('self_check') - failed === 1 ? '' : 's'} passed${failed ? `, ${failed} failed` : ''}. A failed check is still a machine that got that far; its reason is in the machine's own record.</p></section>
<section class="dir-sec"><h2>Most recent</h2>${recent}</section>`;
    return page('First run', body, { description: 'The guided first run of OpenVibe Link, measured step by step.', canonical: '/admin/first-run' });
}

module.exports = { page, renderPanel, renderPhonePage, renderSharePage, renderShareGone, panelScripts, isSim, TRY_DESCRIPTION, renderEmbedRefused, renderDrivePage, renderWidget, renderRobotsPage, renderPairingPage, renderPhoneLinkPage, renderLinkPage, renderSignInPage, renderClaimPage, renderClaimApproved, renderFirstRunPage, camerasOf, overlayStickMarkup, overlaySlider, esc };
