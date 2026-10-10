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
 *   camerasOf(profile)
 *   esc(value)
 */
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
};
const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
/** Hold-button icons by axis: [negative, positive]. */
const AXIS_ICONS = { throttle: ['down', 'up'], y: ['down', 'up'], steer: ['left', 'right'], x: ['left', 'right'], rotation: ['ccw', 'cw'], pan: ['left', 'right'], tilt: ['down', 'up'], zoom: ['minus', 'plus'] };
const AXIS_NAME = { throttle: 'Forward / back', y: 'Forward / back', steer: 'Steer', x: 'Sideways', rotation: 'Turn on the spot', pan: 'Pan', tilt: 'Tilt', zoom: 'Zoom' };

function page(title, body, { scripts = [], bodyClass = '' } = {}) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#11151c">
<title>${esc(title)} — OpenVibe.Bot</title>
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
const topbar = (crumb = '') => `<nav class="topbar"><a class="brand" href="/robots">${icon('robot')}<span>OpenVibe<b>.Bot</b></span></a>${crumb}</nav>`;

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

/** One control per actuator the widget drives, by the actuator's declared type. */
function actuatorControl(name, a, enabled) {
    const off = disabledUnless(enabled);
    if (a.type === 'number') {
        const [lo, hi] = a.range;
        const start = Math.min(hi, Math.max(lo, 0));
        return `<label class="control slider"><span class="control-name">${esc(name)}</span> <input type="range" min="${esc(lo)}" max="${esc(hi)}" step="${esc((hi - lo) / 40)}" value="${esc(start)}" data-actuator="${esc(name)}"${off}></label>`;
    }
    if (a.type === 'rgb') {
        return `<div class="control colour"><label><span class="control-name">${esc(name)}</span> <input type="color" value="#ffffff" data-rgb="${esc(name)}"${off}></label>`
            + ` <button type="button" class="quiet" data-rgb-off="${esc(name)}"${off}>Off</button></div>`;
    }
    if (a.type === 'tone') return `<button type="button" class="hold tone" data-tone="${esc(name)}"${off}>${icon('horn')}<span>${esc(name)}</span></button>`;
    return `<label class="control toggle"><input type="checkbox" data-bool="${esc(name)}"${off}> <span class="control-name">${esc(name)}</span></label>`;
}

/**
 * The cameras a profile lists: `camera` is one camera ({ transport, resolution, name? }) or a list of them.
 * A profile with a camera widget and no camera entry still gets one slot.
 */
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
    const pick = w.camera != null ? all.filter(({ c, i }) => c.name === w.camera || i === w.camera) : all;
    return (pick.length ? pick : all).map(({ c, i }) => {
        const res = typeof c.resolution === 'string' && /^\d+x\d+$/.test(c.resolution) ? c.resolution : '';
        const title = c.name || (all.length > 1 ? `Camera ${i + 1}` : '');
        const caption = [title, res.replace('x', '×'), c.transport ? String(c.transport).toUpperCase() : ''].filter(Boolean).join(' · ');
        return `<figure class="camera" data-camera="${esc(i)}"${res ? ` data-resolution="${esc(res)}"` : ''}${c.transport ? ` data-transport="${esc(c.transport)}"` : ''}`
            + `${signaling_url ? ` data-signaling-url="${esc(signaling_url)}"` : ''}>`
            + `<div class="camera-screen" data-camera-screen${pointEnabled ? ' data-video-click' : ''}>${icon('camera', 'icon camera-icon')}`
            + '<p class="camera-title">No live video right now.</p>'
            + '<p class="camera-sub">The camera shows here while the robot is online and sending video.</p></div>'
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
            inner = `<div class="pad">${axisButtons(axes, enabled)}</div>`;
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
            inner = `<div class="button-grid">${Object.entries(names).map(([name, button]) =>
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

/** The owner's embed switch: plain markup, works without JavaScript. On the panel it is a card; in the robots list, a compact row. */
function embedForm(robot, { card = true } = {}) {
    const form = `<form class="embed-form${card ? '' : ' embed-inline'}" method="post" action="/robots/${esc(robot.id)}/embed" data-embed-form>
${toggle('embed_public', robot.embed_public, 'Let anyone watch where it is embedded', "A page that embeds this robot shows its video and readouts to everyone; never the controls.")}
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
${toggle('live', s.live && s.live.on, 'Show on my OpenVibe.Live channel', 'Lets OpenRestream mirror the camera to your Live channel. It appears there once your channel plays OpenRestream streams.', off, true)}
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
<p class="setting-note">Each button sends its name to the robot. A key works while the panel has focus. Space always stops, and on a robot that drives its drive keys stay with driving.</p>
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
 * The turn strip a signed-in non-member sees on a `queue` robot's panel: the active turn's countdown or their
 * place in line, and a plain leave form that works without JavaScript (public/panel.js unhides it and paints
 * the state). Hidden until a state frame says there is a queue view for this person.
 */
function turnStrip(robot, role) {
    if (robot.access_policy !== 'queue' || role !== 'queue') return '';
    return `<div class="turn" data-turn hidden><span class="turn-state" data-turn-state></span><span class="turn-meta" data-turn-meta></span><form method="post" action="/robots/${esc(robot.id)}/queue/leave" data-turn-leave><button type="submit" class="quiet">Leave the queue</button></form></div>`;
}

function renderPanel({ robot, profile, role, allowed_commands = [], holdResendMs = 150, mode = 'page', signedIn = true, streaming = null, people = null, signaling_url = null, profileForm = {} }) {
    const embed = mode === 'embed';
    const latched = !!(robot.estop && robot.estop.latched);
    const widgets = (profile.widgets || []).map((w, i) => ({ w, i }))
        .sort((a, b) => (a.w.order != null ? a.w.order : 1e9 + a.i) - (b.w.order != null ? b.w.order : 1e9 + b.i))
        .map(({ w }) => renderWidget(w, { profile, allowed_commands, signaling_url }));
    const estop = ESTOP_ROLES.has(role) ? `<button type="button" class="estop" data-estop>${icon('stop')}<span>E-stop</span></button>` : '';
    const clear = role === 'owner' ? `<button type="button" class="estop-clear" data-estop-clear${latched ? '' : ' hidden'}>Clear e-stop</button>` : '';
    const body = `<header class="estop-banner" data-estop-banner data-latched="${latched}">
${embed ? '' : topbar(`<span class="crumb">${esc(robot.name)}</span>`)}
<div class="estop-bar"><p class="estop-state" role="status" aria-live="assertive"><span class="estop-dot"></span><span data-estop-state>${latched ? 'E-stop latched' : 'E-stop clear'}</span><span class="estop-note">${latched ? ' — the robot stays still until the owner clears it.' : ''}</span></p>${clear}${estop}</div>
</header>
<main id="panel" tabindex="0" data-robot-id="${esc(robot.id)}" data-role="${esc(role)}" data-hold-ms="${esc(holdResendMs)}" data-allowed="${data(allowed_commands)}">
<div class="panel-head">
<h1>${esc(robot.name)}</h1>
<p class="meta"><span class="pill online" data-online-pill data-state="connecting"><span class="dot"></span><span data-online-label>Connecting…</span></span> <span class="pill">${esc(profile.name || robot.profile_id)}</span> <span class="pill role" data-role-label>${esc(ROLE_LABEL[role] || role)}</span></p>
${turnStrip(robot, role)}
</div>
${embed && role === 'watcher' && !signedIn ? `<p class="embed-sign-in">${outLink(`/panel/${robot.id}`, 'Sign in to control')}</p>` : ''}
<p class="notice" data-notice role="alert" hidden></p>
<div class="widgets">
${widgets.join('\n')}
</div>
${role === 'owner' && !embed ? `<div class="owner-settings">${localProfileForm(robot, profile, profileForm)}${embedForm(robot)}${streamingForm(robot, streaming)}${people ? peopleCard(robot, people) : ''}</div>` : ''}
</main>`;
    return page(robot.name, body, { scripts: ['/panel/panel.js'], bodyClass: embed ? 'embed-page' : 'panel-page' });
}

/** The framed 403: no robot data, only a way out to openvibe.bot (where signing in may grant access). */
function renderEmbedRefused({ robotId }) {
    const body = `<main class="page embed-refused">
<div class="card"><p>This robot is not shared for embedding.</p>
<p>${outLink(`/panel/${robotId}`, 'Open on openvibe.bot', 'button primary')}</p></div>
</main>`;
    return page('Not shared', body, { bodyClass: 'embed-page' });
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
<p class="kit-actions"><a class="button primary" href="/robots?profile=${encodeURIComponent(k.profile_id)}#add-robot">Add this robot</a> ${outLink(k.build_guide_url, 'Build guide', 'button quiet')}</p></li>`;
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

function renderPairingPage({ robot, pairing, profile = null }) {
    const body = `${topbar(`<span class="crumb">${esc(robot.name)}</span>`)}
<main class="page pairing" data-pair-robot="${esc(robot.id)}">
<h1>Pair ${esc(robot.name)}</h1>
<p class="pair-status" data-pair-status data-state="waiting" role="status" aria-live="polite"><span class="dot"></span><span data-pair-text>Waiting for the device.</span> <a class="button primary" href="/panel/${esc(robot.id)}" data-pair-open hidden>Open the panel</a></p>
<ol class="steps">
<li class="card"><h2>Run this on the machine that serves the robot${profile ? ` <span class="pill">${esc(profile.name)}</span>` : ''}</h2>
<pre class="installer"><code data-copy-source>${esc(pairing.installer)}</code></pre>
<button type="button" class="copy" data-copy>${icon('copy')}<span data-copy-label>Copy the command</span></button></li>
<li class="card"><h2>Or enter the pairing code</h2>
<p><strong class="code">${esc(pairing.code)}</strong></p>
<p class="muted">Valid until <time datetime="${esc(pairing.expires_at)}">${esc(pairing.expires_at)}</time>. It works once.</p></li>
</ol>
<p class="muted">This page turns green as soon as the device connects. <a href="/panel/${esc(robot.id)}">Open the panel</a> any time.</p>
</main>`;
    return page(`Pair ${robot.name}`, body, { scripts: ['/panel/panel.js'] });
}

module.exports = { page, renderPanel, renderEmbedRefused, renderWidget, renderRobotsPage, renderPairingPage, camerasOf, esc };
