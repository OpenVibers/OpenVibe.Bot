'use strict';

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
    stop: '<path d="M8.2 2h7.6L22 8.2v7.6L15.8 22H8.2L2 15.8V8.2z"/><path d="M8 12h8"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    camera: '<path d="M3 7h3l2-3h8l2 3h3v12H3z"/><circle cx="12" cy="13" r="3.5"/>',
    horn: '<path d="M3 10v4h4l6 5V5L7 10z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    robot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/>',
    plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
    gamepad: '<path d="M7 7h10a4 4 0 0 1 4 4l.8 5a2.6 2.6 0 0 1-4.6 2L15 15H9l-2.2 3a2.6 2.6 0 0 1-4.6-2L3 11a4 4 0 0 1 4-4z"/><path d="M7.5 10v3M6 11.5h3M16 11h.01M18 13h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
};
const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
/** Hold-button icons by axis: [negative, positive]. */
const AXIS_ICONS = { throttle: ['down', 'up'], y: ['down', 'up'], steer: ['left', 'right'], x: ['left', 'right'], rotation: ['ccw', 'cw'], pan: ['left', 'right'], tilt: ['down', 'up'], zoom: ['minus', 'plus'] };
const AXIS_NAME = { throttle: 'Forward / back', y: 'Forward / back', steer: 'Steer', x: 'Sideways', rotation: 'Turn on the spot', pan: 'Pan', tilt: 'Tilt', zoom: 'Zoom' };

function page(title, body, { scripts = [], bodyClass = '', description = null, canonical = null } = {}) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#11151c">
<title>${esc(title)} — OpenVibe.Bot</title>${description ? `
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)} — OpenVibe.Bot">
<meta property="og:description" content="${esc(description)}">` : ''}${canonical ? `
<link rel="canonical" href="https://openvibe.bot${esc(canonical)}">` : ''}${description && canonical ? `
<meta property="og:url" content="https://openvibe.bot${esc(canonical)}">
<meta property="og:image" content="https://openvibe.bot${esc(social.url('bot'))}">
<meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="stylesheet" href="/panel/panel.css">
</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>
${body}
${scripts.map((s) => `<script src="${esc(s)}" defer></script>`).join('\n')}
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

/** The drive pad: a touch joystick for two axes (pointer events, see panel.js), hold buttons for the rest. */
function drivePad(axes, enabled) {
    const x = STICK_X.find((a) => axes[a]);
    const y = STICK_Y.find((a) => axes[a]);
    const stick = {};
    if (x) stick.x = x;
    if (y) stick.y = y;
    const rest = Object.fromEntries(Object.entries(axes).filter(([a]) => a !== x && a !== y));
    const label = [y && AXIS_NAME[y], x && AXIS_NAME[x]].filter(Boolean).join(' and ');
    const joystick = x || y
        ? `<div class="stick" data-joystick="${data(stick)}" role="img" aria-label="${esc(`Joystick: ${label}. Drag and hold to drive.`)}"${enabled ? '' : ' aria-disabled="true"'}>`
            + '<span class="stick-ring"></span><span class="stick-cross"></span>'
            + `<span class="stick-knob" data-knob></span></div>`
        : '';
    return `<div class="drive-pad" data-axes="${data(axes)}">${joystick}${Object.keys(rest).length ? `<div class="pad">${axisButtons(rest, enabled)}</div>` : ''}`
        + `<button type="button" class="stop" data-stop${disabledUnless(enabled)}>${icon('square')}<span>Stop</span></button></div>`;
}

/** An actuator's name as a label: backpack_lights → Backpack lights. */
const humanName = (name) => { const s = String(name).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

/** One control per actuator the widget drives, by the actuator's declared type. */
function actuatorControl(name, a, enabled) {
    const off = disabledUnless(enabled);
    const label = humanName(name);
    if (a.type === 'number') {
        const [lo, hi] = a.range;
        const start = Math.min(hi, Math.max(lo, 0));
        return `<label class="control slider"><span class="control-name">${esc(label)}</span> <input type="range" min="${esc(lo)}" max="${esc(hi)}" step="${esc((hi - lo) / 40)}" value="${esc(start)}" data-actuator="${esc(name)}"${off}></label>`;
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
function panelScripts(profile, local = false) {
    if (!isSim(profile)) return ['/panel/panel.js'];
    return ['/panel/sim-world.js', ...(local ? ['/panel/try-device.js'] : []), '/panel/panel.js', '/panel/sim-view.js'];
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

function renderWidget(w, { profile = {}, allowed_commands = [], signaling_url = null } = {}) {
    const commands = profile.commands || {};
    const kind = w.command ? w.command.kind : null;
    const enabled = !!kind && allowed_commands.includes(kind);
    const label = w.label || w.type;
    let inner;
    switch (w.type) {
        case 'drive': {
            const axes = (commands[kind] && commands[kind].axes) || {};
            inner = drivePad(axes, enabled)
                + '<p class="hint"><kbd>W A S D</kbd> or arrows to drive, <kbd>Q</kbd> <kbd>E</kbd> to turn, <kbd>Space</kbd> to stop. '
                + `<span class="pad-hint" data-pad-hint>${icon('gamepad')} A gamepad works too: left stick drives, A sounds, B stops, Start is the e-stop.</span></p>`;
            break;
        }
        case 'ptz': {
            const axes = (commands[kind] && commands[kind].axes) || {};
            // A camera that pans and tilts gets the joystick too (Maticus, 2026-10-27: "that cool virtual joystick from the
            // sim … would work killer for LOOI or any PTZ"): drag to move, let go to stop; zoom stays on its buttons.
            const ptzStick = axes.pan && axes.tilt
                ? `<div class="stick stick--ptz" data-ptz-stick="${data({ x: 'pan', y: 'tilt' })}" data-axes="${data(axes)}" role="img" aria-label="Joystick: pan and tilt. Drag and hold to move the camera."${enabled ? '' : ' aria-disabled="true"'}>`
                    + '<span class="stick-ring"></span><span class="stick-cross"></span><span class="stick-knob" data-knob></span></div>'
                : '';
            inner = `<div class="ptz-pad">${ptzStick}<div class="pad">${axisButtons(axes, enabled)}</div></div>`;
            break;
        }
        case 'pan-tilt': case 'servo': case 'head': case 'lift': case 'lights': case 'horn': {
            const names = (commands.actuator && commands.actuator.names) || {};
            inner = `<div class="controls">${(w.command && w.command.names ? w.command.names : []).filter((n) => names[n]).map((n) => actuatorControl(n, names[n], enabled)).join('')}</div>`;
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
                    + '<span class="stick-ring"></span><span class="stick-cross"></span><span class="stick-knob" data-knob></span></div>'
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
    return `<section class="widget widget-${esc(w.type)}" data-widget="${esc(w.type)}"${cmd}><h2>${esc(label)}</h2>${inner}</section>`;
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

function renderPanel({ robot, profile, role, allowed_commands = [], holdResendMs = 150, mode = 'page', signedIn = true, streaming = null, people = null, signaling_url = null, profileForm = {}, tryIt = false, automation = null, parentOrigins = [], liveUrl = null }) {
    const embed = mode === 'embed';
    const latched = !!(robot.estop && robot.estop.latched);
    const widgets = (profile.widgets || []).map((w, i) => ({ w, i }))
        .sort((a, b) => (a.w.order != null ? a.w.order : 1e9 + a.i) - (b.w.order != null ? b.w.order : 1e9 + b.i))
        .map(({ w }) => renderWidget(w, { profile, allowed_commands, signaling_url }));
    // A framed watcher may take the controls with Drive; its e-stop waits, hidden, for an owner's or operator's join.
    const estop = ESTOP_ROLES.has(role) ? `<button type="button" class="estop" data-estop>${icon('stop')}<span>E-stop</span></button>`
        : (embed && role === 'watcher' ? `<button type="button" class="estop" data-estop hidden>${icon('stop')}<span>E-stop</span></button>` : '');
    const clear = role === 'owner' ? `<button type="button" class="estop-clear" data-estop-clear${latched ? '' : ' hidden'}>Clear e-stop</button>` : '';
    const body = `<header class="estop-banner" data-estop-banner data-latched="${latched}">
${embed ? '' : tryIt ? topbar('<span class="crumb">Try the panel</span>', '/') : topbar(`<span class="crumb">${esc(robot.name)}</span>`)}
<div class="estop-bar"><p class="estop-state" role="status" aria-live="assertive"><span class="estop-dot"></span><span data-estop-state>${latched ? 'E-stop latched' : 'E-stop clear'}</span><span class="estop-note">${latched ? ' — the robot stays still until the owner clears it.' : ''}</span></p>${clear}${estop}</div>
</header>
<main id="panel" tabindex="0" data-robot-id="${esc(robot.id)}" data-role="${esc(role)}" data-hold-ms="${esc(holdResendMs)}" data-allowed="${data(allowed_commands)}"${tryIt ? ' data-transport="local"' : ''}${embed && parentOrigins.length ? ` data-parent-origins="${esc(parentOrigins.join(' '))}"` : ''}>
<div class="panel-head">
<h1>${esc(robot.name)}</h1>
<p class="meta"><span class="pill online" data-online-pill data-state="connecting"><span class="dot"></span><span data-online-label>Connecting…</span></span> <span class="pill">${esc(profile.name || robot.profile_id)}</span> <span class="pill role" data-role-label>${esc(ROLE_LABEL[role] || role)}</span></p>
${turnStrip(robot, role)}
</div>
${tryIt ? tryIntro() : ''}
${embed && role === 'watcher' && !signedIn ? `<p class="embed-sign-in" data-drive-bar><button type="button" class="button primary" data-drive>${icon('gamepad')}<span>Drive</span></button> ${outLink(`/panel/${robot.id}`, 'Open on openvibe.bot')}</p>` : ''}
<p class="notice" data-device-fault role="status" hidden></p>
<p class="notice" data-notice role="alert" hidden></p>
<div class="widgets">
${widgets.join('\n')}
</div>
${tryIt ? tryOutro(profile) : ''}${role === 'owner' && !embed && !tryIt ? `<div class="owner-settings">${onStreamCard(robot, { liveUrl })}${localProfileForm(robot, profile, profileForm)}${automation ? routinesCard(robot, profile, automation) + webhooksCard(robot, automation) : ''}${agentForm(robot)}${listingForm(robot)}${embedForm(robot)}${streamingForm(robot, streaming)}${people ? peopleCard(robot, people) : ''}</div>` : ''}
</main>`;
    return page(tryIt ? 'Try the panel with a simulated rover' : robot.name, body, {
        scripts: panelScripts(profile, tryIt), bodyClass: embed ? 'embed-page' : 'panel-page',
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
<div class="card"><h1>${esc(robot.name)}</h1>
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
    return page('Not shown here yet', body, { bodyClass: 'embed-page', scripts: ['/panel/refused.js'] });
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
    return page('Your robots', `${topbar()}\n<main class="page">\n<h1>Your robots</h1>\n${list}\n${form}\n${kitsSection(kits, profiles)}\n</main>`);
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
<h1>Pair ${esc(robot.name)}</h1>
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
 * /link (server/claims.js): the code a device shows after `curl -fsSL https://openvibe.bot/install | sh` with no code.
 * renderLinkPage asks for it; renderClaimPage shows what that device found and the choices its robot starts with;
 * renderClaimApproved follows the device as it pairs on its own.
 */
function renderLinkPage({ code = '', error = null, installer = 'curl -fsSL https://openvibe.bot/install | sh' } = {}) {
    const body = `${topbar('<span class="crumb">Add a device</span>')}
<main class="page link">
<h1>Add a device</h1>
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
<h1>Add ${esc(claim.hostname)}?</h1>
<p class="muted">Only approve a device you set up yourself, just now. If you did not run the command on it, deny it.</p>
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
<h1>${esc(robot.name)} is yours</h1>
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

/**
 * /machines (plan T14/T16): a person's own machines that run jobs for them, and the command that adds one. A machine
 * here runs its owner's jobs only (Bot refuses anyone else's), connects out, and keeps its local limits and kill switch.
 */
function renderMachinesPage({ machines = [], pairing = null }) {
    const classesOf = (m) => {
        const w = (m.capabilities && typeof m.capabilities === 'object' ? m.capabilities : {}).worker || {};
        return Array.isArray(w.runtime_classes) ? w.runtime_classes : [];
    };
    // The computer plugin (Node docs/computer.md): the level its owner set on the machine, and whether their agent may use it.
    const LEVELS = { observe: 'Observe', ask: 'Ask first', trusted: 'Trusted', full: 'Full control' };
    const computerOf = (m) => {
        const c = (m.capabilities && typeof m.capabilities === 'object' ? m.capabilities : {}).computer;
        if (!c || typeof c !== 'object') return null;
        const level = m.computer_level || ((c.files || c.terminal || c.screen || {}).level) || null;
        const d = c.desk && typeof c.desk === 'object' ? c.desk : null;
        return { level: LEVELS[level] ? level : null, terminal: !!c.terminal, files: !!c.files, screen: !!c.screen, probe: !!c.probe, input: !!c.input,
            screenStream: !!(c.screen && c.screen.stream === true),
            // Desks for its agents (Desks plan): how many at once, which kinds, and whether sign-ins carry over.
            desks: d ? { max: Number.isInteger(d.max_desks) ? d.max_desks : 1, kinds: Array.isArray(d.kinds) ? d.kinds : ['desktop'], keeps: d.profiles === true } : null };
    };
    // Vibe by voice: shown for a machine whose Node runs the voice plugin (capabilities.voice).
    const voiceRow = (m) => {
        const v = (m.capabilities && typeof m.capabilities === 'object' ? m.capabilities : {}).voice;
        if (!v || typeof v !== 'object') return '';
        const word = m.call_word || 'hey vibe';
        return `<div class="machine-voice"><span class="pill">${m.voice_on ? `Voice: "${esc(word)}"` : 'Voice: off'}</span>`
            + (m.voice_on
                ? `<form method="post" action="/machines/${esc(m.id)}/voice"><input type="hidden" name="on" value="0"><button type="submit" class="button quiet" aria-pressed="true">Stop Vibe answering my voice here</button></form>`
                : `<form method="post" action="/machines/${esc(m.id)}/voice" class="inline-form"><input type="hidden" name="on" value="1"><label class="sr-only" for="cw-${esc(m.id)}">Call word</label><input id="cw-${esc(m.id)}" name="call_word" maxlength="40" value="${esc(word)}" aria-label="Call word"><button type="submit" class="button quiet" aria-pressed="false">Let Vibe answer my voice here</button></form>`)
            + '<span class="muted">The machine listens for its call word on its own; only what you say after it goes to Vibe, and the answer is spoken here and kept in your Vibe chats.</span></div>';
    };
    // "Desks for your agents: 4 at once (browser desks count as half), sign-ins kept"
    const deskWords = (d) => {
        const browser = d.kinds.includes('browser');
        const whole = d.kinds.includes('desktop');
        const kinds = browser && whole ? `${d.max} at once, or twice as many browser desks` : browser ? `${d.max * 2} browser desks at once` : `${d.max} at once`;
        return `Desks for your agents: ${kinds}${d.keeps ? ', sign-ins kept' : ''}`;
    };
    const computerRow = (m) => {
        const c = computerOf(m);
        if (!c) return '';
        const can = [c.terminal && 'terminal', c.files && 'files', c.screen && 'screen', c.input && 'mouse and keyboard'].filter(Boolean).join(', ');
        const desks = c.desks ? `<span class="muted">${esc(deskWords(c.desks))}</span>` : '';
        // The desks running now (the Node's telemetry), and the page that lists them, to watch or stop one.
        const running = Number.isInteger(m.computer_desks) && m.computer_desks > 0
            ? ` <span class="pill">${m.computer_desks === 1 ? '1 desk running' : `${m.computer_desks} desks running`}</span>` : '';
        const deskLink = c.desks && m.online ? `<a class="button quiet" href="/machines/${esc(m.id)}/desks">See its desks</a>` : '';
        const waiting = Number.isInteger(m.computer_waiting) && m.computer_waiting > 0
            ? ` <span class="pill warn">${m.computer_waiting} waiting for you on the machine</span>` : '';
        return `<div class="machine-computer"><span class="pill">Computer: ${esc(c.level ? LEVELS[c.level] : 'on')}</span><span class="muted">${esc(can)}</span>${desks}${running}${waiting}${deskLink}`
            + `<form method="post" action="/machines/${esc(m.id)}/agent-computer"><input type="hidden" name="on" value="${m.agent_computer ? '0' : '1'}">`
            + `<button type="submit" class="button quiet" aria-pressed="${m.agent_computer ? 'true' : 'false'}">${m.agent_computer ? 'Stop my agent using this computer' : 'Let my agent use this computer'}</button></form>`
            + (c.screenStream && m.online ? `<form method="post" action="/machines/${esc(m.id)}/screen"><button type="submit" class="button quiet">${m.computer_screen_stream === 'live' ? 'Watch my screen' : 'Show my screen'}</button></form>` : '')
            + (c.probe ? `<form method="post" action="/machines/${esc(m.id)}/watch-probe"><input type="hidden" name="on" value="${m.watch_probe ? '0' : '1'}">`
                + `<button type="submit" class="button quiet" aria-pressed="${m.watch_probe ? 'true' : 'false'}">${m.watch_probe ? 'Stop my watches checking from here' : 'Let my watches check things from this computer'}</button></form>` : '')
            + '</div>';
    };
    const list = machines.length
        ? `<ul class="robots">${machines.map((m) => `<li class="robot-card"><span class="robot-name">${icon('plug')}<span>${esc(m.name || m.id)}</span></span>`
            + `<span class="robot-meta"><span class="pill">${m.online ? 'Online' : 'Offline'}</span>${classesOf(m).map((c) => ` <span class="pill">${esc(c)} jobs</span>`).join('')}`
            + `${m.agent_version ? ` <span class="pill">Node ${esc(m.agent_version)}</span>` : ''}${m.robot ? ` <span class="pill">Serves ${esc(m.robot)}</span>` : ''}</span>`
            + computerRow(m) + voiceRow(m)
            + `<span class="robot-actions"><form method="post" action="/machines/${esc(m.id)}/remove"><button type="submit" class="button quiet">Remove</button></form></span></li>`).join('')}</ul>`
        : `<div class="empty">${icon('plug', 'icon empty-icon')}<p class="empty-title">No machines yet.</p><p>Add your computer or a server you own. It runs the jobs you start, such as a coding task on openvibe.codes, and nobody else's.</p></div>`;
    const add = pairing
        ? `<ol class="steps"><li class="card"><h2>Run this on the machine</h2>
<pre tabindex="0" class="installer"><code data-copy-source>${esc(pairing.installer)}</code></pre>
<button type="button" class="copy" data-copy>${icon('copy')}<span data-copy-label>Copy the command</span></button>
<p class="muted">Linux with systemd. It installs OpenVibe Node, turns its job worker on (jobs run as a separate user, in a sandbox, with the limits you set) and pairs the machine with your account. For coding jobs the machine also needs Node.js 22 or newer and git, and a coding agent: Claude Code, Codex, OpenCode, or a DeepSeek key.</p></li>
<li class="card"><h2>Or let your agents use this computer</h2>
<pre tabindex="0" class="installer"><code>${esc(pairing.installer.replace(/ --worker$/, ' --computer ask'))}</code></pre>
<p class="muted">Instead of running jobs, the machine's terminal, files and screen become usable by your agents, at the level you set on the machine: <code>ask</code> waits for <code>openvibe-node approve</code> there before anything runs or changes. The Node runs as your own account, never root. <a href="https://github.com/OpenVibers/OpenVibe.Node/blob/main/docs/computer.md">How it works</a>.</p></li>
<li class="card"><h2>Or make a spare computer a desk host</h2>
<pre tabindex="0" class="installer"><code>${esc(pairing.installer.replace(/ --worker$/, ' --desk-host'))}</code></pre>
<p class="muted">An old laptop, a mini PC or a spare workstation becomes a place where your agents work: each task gets a desk of its own, with its own browser, and you can watch any desk and take it over. No screen, keyboard or sign-in needed on it. It runs as its own account and only for your agents; the installer adds what desks need and sizes them to its memory. Linux. <a href="https://github.com/OpenVibers/OpenVibe.Node/blob/main/docs/computer.md#desk-hosts---desk-host-node-v0200">How it works</a>.</p></li>
<li class="card"><h2>Or enter the pairing code</h2><p><strong class="code">${esc(pairing.code)}</strong></p>
<p class="muted">Valid until <time datetime="${esc(pairing.expires_at)}">${esc(pairing.expires_at)}</time>. It works once.</p></li></ol>
<p class="muted">Reload this page once the installer says it is paired: the machine shows up above.</p>`
        : `<form class="add-robot card" method="post" action="/machines"><h2>Add a machine</h2>
<p class="muted">You get a one-line install command with a one-time code.</p><button type="submit" class="primary">Add a machine</button></form>`;
    const body = `${topbar('<span class="crumb">Machines</span>')}
<main class="page">
<h1>Your machines</h1>
<p class="muted">A machine here runs jobs for you and only you. It connects out to OpenVibe and needs no open ports. The limits in its own config and its local kill switch (<code>openvibe-node stop</code>) always win.</p>
${list}
${add}
</main>`;
    return page('Your machines', body, { scripts: pairing ? ['/panel/panel.js'] : [], description: 'Your own machines that run your jobs on OpenVibe.', canonical: '/machines' });
}

/**
 * /machines/:id/screen: the machine's screen, live, for its owner only (plan T14). The tile waits for the machine's
 * session (public/panel.js polls `stateUrl`) and plays it like a robot's camera; Stop ends it at once.
 */
/** The owner's links to this screen (server/screen-shares.js): make one to watch or use it, see and stop the others. */
function sharesBlock(machine, shares, madeLink, madeShare, hasDesk = false, hasScreen = true) {
    // Only screens the machine has: a desk host has none of its own (its private desk is what a link shares), and a
    // machine with neither has nothing to share.
    if (!hasScreen && !hasDesk) return '';
    const which = !hasScreen
        ? '<input type="hidden" name="desk" value="private"><p class="muted small">A link here shares the private desk: this computer has no screen of its own.</p>'
        : hasDesk ? '<label class="field"><span class="field-label">Which screen</span><select name="desk"><option value="main">Your own screen</option><option value="private">The private desk, where your agent works</option></select></label>' : '';
    const rows = (shares || []).map((x) => `<li><strong>${esc(x.label || 'A link')}</strong> · ${x.desk === 'private' ? 'the private desk · ' : ''}${x.control ? 'watch and use' : 'watch only'} · until <time datetime="${esc(x.expires_at || '')}" data-local-time>${esc(String(x.expires_at || '').slice(0, 10))}</time>${x.last_used_at ? ` · last opened <time datetime="${esc(x.last_used_at)}" data-local-time>${esc(String(x.last_used_at).slice(0, 16).replace('T', ' '))}</time>` : ''}
<form method="post" action="/machines/${esc(machine.id)}/shares/${esc(x.id)}/revoke" class="inline-form"><button type="submit" class="button quiet">Stop this link</button></form></li>`).join('');
    return `<section class="machine-shares" aria-labelledby="shares-h"><h2 id="shares-h">Share this screen</h2>
<p class="muted">Make a link for a group: put it in a workspace room on OpenVibe.Chat (the staff room's Screen) or anywhere people work together. <strong>Watch</strong> shows the screen live. <strong>Watch and use</strong> also lets them start it and use the mouse and keyboard, at the level you set on this computer: at <code>ask</code> each action waits for your approval there, and at <code>observe</code> nothing happens. Nobody can run programs or read files through a link.</p>
${madeLink ? `<p class="notice" role="status">Your new link${madeShare && madeShare.control ? ' (watch and use)' : ''}. Copy it now: it is not shown again.<br><input class="share-link" type="text" readonly value="${esc(madeLink)}" aria-label="The new screen link"></p>` : ''}
<form method="post" action="/machines/${esc(machine.id)}/shares" class="share-form">
<label class="field"><span class="field-label">Where it goes</span><input name="label" maxlength="80" placeholder="Staff room"></label>
<label class="field"><span class="field-label">Lasts (days)</span><input name="days" type="number" min="1" max="365" value="30"></label>
${which}
<label class="check"><input type="checkbox" name="control" value="1"> They may use the mouse and keyboard too</label>
<button type="submit" class="primary">Make a link</button></form>
${rows ? `<ul class="share-list">${rows}</ul>` : ''}</section>`;
}

/** A screen link that does not work (stopped, ended, never existed): one answer for every reason. */
function renderShareGone() {
    return page('Screen link', `<main class="page share-page"><h1>This screen link does not work</h1><p class="muted">It was stopped, it ended, or it never existed. Ask whoever shared it for a new one.</p></main>`, { description: 'A shared computer screen on OpenVibe.Bot.' });
}

/** /screen/:token: a shared screen, live, for a frame or a tab; with "use" links, the mouse and keyboard too. */
function renderSharePage({ token, name, control, label, desk = 'main' }) {
    const base = `/screen/${encodeURIComponent(token)}`;
    const body = `<main class="page share-page" data-share="${esc(base)}" data-control="${control ? '1' : '0'}">
<header class="share-head"><h1>${esc(name)}${label ? ` <span class="muted">· ${esc(label)}</span>` : ''}</h1>
<p class="muted share-mode">${control ? 'Shared to watch and use' : 'Shared to watch'}${desk === 'private' ? ': the private desk, where an agent works (never the owner\'s own screen)' : ''}</p></header>
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
 * /machines/:id/desks: the desks running on the owner's machine (Desks plan), each a computer of its own for an agent:
 * its kind, size and start, Watch and take over (the screen page on that desk), and Stop.
 */
function renderMachineDesksPage({ machine, desks = [], maxDesks = null, error = null, stopped = null }) {
    const name = machine.name || machine.id;
    const id = esc(machine.id);
    const KIND = { browser: 'Browser desk', desktop: 'Whole desk' };
    const since = (d) => {
        const t = Number(d.since);
        if (!Number.isFinite(t) || t <= 0) return '';
        const iso = new Date(t * 1000).toISOString();
        return ` <span class="muted">since <time datetime="${esc(iso)}" data-local-time>${esc(iso.slice(11, 16))} UTC</time></span>`;
    };
    const rows = desks.map((d) => `<li class="robot-card"><span class="robot-name">${icon('plug')}<span><code>${esc(d.desk)}</code></span></span>`
        + `<span class="robot-meta"><span class="pill">${esc(KIND[d.kind] || 'Desk')}</span>${Number.isInteger(d.width) ? ` <span class="muted">${d.width}×${d.height}</span>` : ''}${since(d)}</span>`
        + `<span class="robot-actions"><a class="button" href="/machines/${id}/screen?desk=${encodeURIComponent(d.desk)}">Watch and take over</a>`
        + `<form method="post" action="/machines/${id}/desks/stop"><input type="hidden" name="desk" value="${esc(d.desk)}"><button type="submit" class="button quiet">Stop</button></form></span></li>`).join('');
    const list = error ? `<p class="error" role="alert">${esc(error)}</p>`
        : rows ? `<ul class="robots">${rows}</ul>`
            : `<div class="empty">${icon('plug', 'icon empty-icon')}<p class="empty-title">No desks are running.</p><p>An agent's task starts a desk of its own here when it needs one, and stops it when it is done.</p></div>`;
    const body = `${topbar(`<a class="crumb" href="/machines">Machines</a><span class="crumb">${esc(name)}</span>`)}
<main class="page">
<h1>${esc(name)}: desks</h1>
<p class="muted">Each desk is a computer of its own on this machine, where one of your agents works: its own screen or browser, files and sign-ins. Watch one live and take it over, or stop it; a task whose desk you stop goes on without it.</p>
${stopped ? `<p class="setting-ok" role="status">${icon('check')}<span>Stopped <code>${esc(stopped)}</code>.</span></p>` : ''}
${list}
${Number.isInteger(maxDesks) ? `<p class="muted small">At most ${maxDesks} whole ${maxDesks === 1 ? 'desk' : 'desks'} at once here; a browser desk counts as half.</p>` : ''}
</main>`;
    return page(`${name}: desks`, body, { description: 'The desks your agents work on, on your machine.', canonical: '/machines' });
}

function renderMachineScreenPage({ machine, until = null, error = null, idle = false, shares = [], madeLink = null, madeShare = null, hasDesk = false, hasScreen = true, desk = 'main' }) {
    const name = machine.name || machine.id;
    const stateUrl = `/machines/${encodeURIComponent(machine.id)}/screen.json`;
    const base = `/machines/${encodeURIComponent(machine.id)}/screen`;
    // An agent task's own desk (desk-<name>, Desks plan D1) is what a task's Watch link opens.
    const agentDesk = /^desk-/.test(desk);
    const deskWords = desk === 'main' ? 'your own screen' : desk === 'private' ? 'the private desk' : 'your agent\'s desk';
    // Idle (nothing is shown, as from a link): a start button instead of waiting for a stream nobody started.
    if (idle && !error) {
        const body = `${topbar(`<a class="crumb" href="/machines">Machines</a><span class="crumb">${esc(name)}</span>`)}
<main class="page">
<h1>${esc(name)}: screen</h1>
${agentDesk ? `<p>Your agent works on a desk of its own on this computer. Watch it live, and take it over whenever you like: while you use the mouse and keyboard, the agent waits; when you stop, it goes on.</p>
<form method="post" action="/machines/${esc(machine.id)}/screen" class="inline-form"><input type="hidden" name="desk" value="${esc(desk)}"><button type="submit" class="primary">Watch your agent's desk</button></form>` : ''}
${hasScreen ? `<p class="muted">Show this computer's screen here, live, to you only, for 10 minutes. Nothing is recorded, and the computer says on its desktop that its screen is live.</p>
<form method="post" action="/machines/${esc(machine.id)}/screen" class="inline-form"><button type="submit" class="${agentDesk ? 'button' : 'primary'}">Show my screen</button></form>` : '<p class="muted">This computer has no screen of its own to show (a desk host): only its desks, where your agents work. A task\'s Watch link opens its desk.</p>'}
${hasDesk ? `<form method="post" action="/machines/${esc(machine.id)}/screen" class="inline-form"><input type="hidden" name="desk" value="private"><button type="submit" class="button">Show the private desk</button></form>
<p class="muted">The private desk is a screen of its own on this computer, where your agent works without touching yours.</p>` : ''}
${sharesBlock(machine, shares, madeLink, madeShare, hasDesk, hasScreen)}
</main>`;
        return page(`${name}: screen`, body, { description: 'Your machine\'s screen, live, for you only.', canonical: '/machines' });
    }
    const ends = until ? `<p class="muted">Shown until <time datetime="${esc(until)}" data-local-time>${esc(until)}</time>, to you only. Nothing is recorded.</p>` : '';
    // Take over (Desks plan D4): the share page's own controls (public/screen-share.js) in owner mode, on what is shown.
    const takeOver = error ? '' : `<div class="share-controls">
<button type="button" class="primary" data-share-start hidden>Start the screen</button>
<label class="check share-use"><input type="checkbox" data-share-use> ${desk === 'main' ? 'Use the mouse and keyboard' : 'Take over: use the mouse and keyboard'}</label>
<span class="muted small" data-share-note role="status"></span></div>
${desk !== 'main' ? '<p class="muted small">While you use it, the agent waits on this desk; uncheck to give it back, and it goes on a moment later.</p>' : ''}`;
    const body = `${topbar(`<a class="crumb" href="/machines">Machines</a><span class="crumb">${esc(name)}</span>`)}
<main class="page" data-share="${esc(base)}" data-control="${error ? '0' : '1'}" data-owner="1">
<p class="muted small">Showing ${esc(deskWords)}${agentDesk ? ` (<code>${esc(desk)}</code>)` : ''}.</p>
<h1>${esc(name)}: screen</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ends}
<figure class="camera machine-screen" data-screen-state="${esc(stateUrl)}" tabindex="0" aria-label="The screen: turn on the mouse and keyboard to click and type on it">
<div class="camera-screen" data-camera-screen>${icon('plug', 'icon camera-icon')}<p class="camera-title" data-screen-status role="status">${error ? 'The screen is not shown.' : 'Waiting for the machine…'}</p>
<p class="camera-sub">The picture comes from the machine itself, a few frames a second.</p></div>
</figure>
${takeOver}
<div class="machine-screen-actions">
<form method="post" action="/machines/${esc(machine.id)}/screen/stop"><button type="submit" class="primary">Stop showing it</button></form>
<form method="post" action="/machines/${esc(machine.id)}/screen">${desk !== 'main' ? `<input type="hidden" name="desk" value="${esc(desk)}">` : ''}<button type="submit" class="button quiet">${error ? 'Try again' : 'Start again (10 more minutes)'}</button></form>
</div>
<p class="muted small">${desk === 'main' ? 'The machine says on its desktop that its screen is live. ' : 'Nothing of your own screen is shown: this is the desk\'s own. '}<code>openvibe-node stop</code> on the machine ends it at once, and it ends on its own after its time.</p>
${sharesBlock(machine, shares, madeLink, madeShare, hasDesk, hasScreen)}
</main>`;
    return page(`${name}: screen`, body, { scripts: ['/panel/panel.js', '/panel/screen-share.js'], description: 'Your machine\'s screen, live, for you only.', canonical: '/machines' });
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
<h1>Make this phone a robot</h1>
<p class="muted">Pair it with a robot you added on openvibe.bot. Its camera streams to the robot's panel, it says what the driver types, shows a face, and reports its battery and tilt. Nothing to install: keep this page open.</p>
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

module.exports = { page, renderPanel, renderPhonePage, renderMachinesPage, renderMachineDesksPage, renderMachineScreenPage, renderSharePage, renderShareGone, panelScripts, isSim, TRY_DESCRIPTION, renderEmbedRefused, renderDrivePage, renderWidget, renderRobotsPage, renderPairingPage, renderLinkPage, renderClaimPage, renderClaimApproved, camerasOf, esc };
