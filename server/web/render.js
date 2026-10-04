'use strict';

/**
 * The signed-in pages, rendered on the server from data alone (pure functions, testable without a server).
 * The panel is a function of the robot's profile (ADR-043 decision 7): every widget comes from
 * `profile.widgets` and every control's name, shape and range from `profile.commands` — no robot-specific
 * code here. Every value is HTML-escaped; nothing is inline (the CSP is `default-src 'self'`), so the client
 * (public/panel.js) reads what it needs from data-* attributes.
 *
 *   renderPanel({ robot, profile, role, allowed_commands, holdResendMs })
 *   renderWidget(widget, { profile, allowed_commands })
 *   renderRobotsPage({ robots, profiles, error, values })
 *   renderPairingPage({ robot, pairing, profile })
 *   esc(value)
 */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
/** A data-* attribute's JSON, escaped for a double-quoted attribute. */
const data = (v) => esc(JSON.stringify(v));

/** The e-stop is the owner's and an operator's; only the owner clears it (the gate enforces both). */
const ESTOP_ROLES = new Set(['owner', 'operator']);
/** Hold-to-move arrows by axis: [negative, positive]. */
const AXIS_ARROWS = { throttle: ['▼', '▲'], y: ['▼', '▲'], steer: ['◀', '▶'], x: ['◀', '▶'], rotation: ['⟲', '⟳'], pan: ['◀', '▶'], tilt: ['▼', '▲'], zoom: ['−', '+'] };
const POLICIES = ['private', 'invite', 'queue'];

function page(title, body, { scripts = [] } = {}) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — OpenVibe.Bot</title>
<link rel="stylesheet" href="/panel/panel.css">
</head>
<body>
${body}
${scripts.map((s) => `<script src="${esc(s)}" defer></script>`).join('\n')}
</body>
</html>
`;
}

const disabledUnless = (ok) => (ok ? '' : ' disabled');

/** Hold buttons, one pair per axis: pressed sends the axis at its end of the range, released sends 0. */
function axisButtons(kind, axes, enabled) {
    return Object.entries(axes).map(([axis, [lo, hi]]) => {
        const [neg, pos] = AXIS_ARROWS[axis] || ['−', '+'];
        return `<div class="axis" data-axis="${esc(axis)}">`
            + `<button type="button" class="hold" data-hold="${data({ [axis]: lo })}" aria-label="${esc(`${axis} ${lo}`)}"${disabledUnless(enabled)}>${esc(neg)}</button>`
            + `<span class="axis-name">${esc(axis)}</span>`
            + `<button type="button" class="hold" data-hold="${data({ [axis]: hi })}" aria-label="${esc(`${axis} ${hi}`)}"${disabledUnless(enabled)}>${esc(pos)}</button>`
            + '</div>';
    }).join('');
}

/** One control per actuator the widget drives, by the actuator's declared type. */
function actuatorControl(name, a, enabled) {
    const off = disabledUnless(enabled);
    if (a.type === 'number') {
        const [lo, hi] = a.range;
        const start = Math.min(hi, Math.max(lo, 0));
        return `<label class="control">${esc(name)} <input type="range" min="${esc(lo)}" max="${esc(hi)}" step="${esc((hi - lo) / 40)}" value="${esc(start)}" data-actuator="${esc(name)}"${off}></label>`;
    }
    if (a.type === 'rgb') {
        return `<div class="control"><label>${esc(name)} <input type="color" value="#ffffff" data-rgb="${esc(name)}"${off}></label>`
            + ` <button type="button" data-rgb-off="${esc(name)}"${off}>Off</button></div>`;
    }
    if (a.type === 'tone') return `<button type="button" class="hold" data-tone="${esc(name)}"${off}>${esc(name)}</button>`;
    return `<label class="control">${esc(name)} <input type="checkbox" data-bool="${esc(name)}"${off}></label>`;
}

function renderWidget(w, { profile = {}, allowed_commands = [] } = {}) {
    const commands = profile.commands || {};
    const kind = w.command ? w.command.kind : null;
    const enabled = !!kind && allowed_commands.includes(kind);
    const label = w.label || w.type;
    let inner;
    switch (w.type) {
        case 'drive':
        case 'ptz': {
            const axes = (commands[kind] && commands[kind].axes) || {};
            inner = `<div class="pad">${axisButtons(kind, axes, enabled)}</div>`;
            if (w.type === 'drive') inner += `<button type="button" class="stop" data-stop${disabledUnless(enabled)}>Stop</button>`;
            break;
        }
        case 'pan-tilt': case 'servo': case 'head': case 'lift': case 'lights': case 'horn': {
            const names = (commands.actuator && commands.actuator.names) || {};
            inner = (w.command && w.command.names ? w.command.names : []).filter((n) => names[n]).map((n) => actuatorControl(n, names[n], enabled)).join('');
            break;
        }
        case 'speaker': {
            const max = commands.say ? commands.say.max_chars : 200;
            inner = `<form class="control" data-say><input type="text" name="text" maxlength="${esc(max)}" aria-label="${esc(label)}"${disabledUnless(enabled)}>`
                + ` <button type="submit"${disabledUnless(enabled)}>Say</button></form>`;
            break;
        }
        case 'display': {
            const d = commands.display || { modes: [] };
            let fields = '';
            if (d.modes.includes('face')) fields += `<select name="face" aria-label="face"${disabledUnless(enabled)}><option value="">—</option>${(d.faces || []).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select>`;
            if (d.modes.includes('text')) fields += ` <input type="text" name="text" maxlength="${esc(d.max_chars)}" aria-label="text"${disabledUnless(enabled)}>`;
            inner = `<form class="control" data-display>${fields} <button type="submit"${disabledUnless(enabled)}>Show</button></form>`;
            break;
        }
        case 'telemetry':
            inner = `<output class="readout" data-telemetry="${esc(w.capability || '')}">—</output>`;
            break;
        case 'battery':
            inner = '<meter min="0" max="1" low="0.25" optimum="1" data-battery></meter> <output class="readout" data-battery-text>—</output>';
            break;
        case 'latency':
            inner = '<output class="readout" data-latency>—</output>';
            break;
        case 'camera':
            // R8b brings the viewer URL; until then the slot is held.
            inner = '<div class="camera-placeholder" data-camera>Video is not connected yet.</div>';
            break;
        default:
            inner = '';
    }
    const cmd = w.command ? ` data-command="${data(w.command)}"` : '';
    return `<section class="widget widget-${esc(w.type)}" data-widget="${esc(w.type)}"${cmd}><h2>${esc(label)}</h2>${inner}</section>`;
}

function renderPanel({ robot, profile, role, allowed_commands = [], holdResendMs = 150 }) {
    const latched = !!(robot.estop && robot.estop.latched);
    const widgets = (profile.widgets || []).map((w, i) => ({ w, i }))
        .sort((a, b) => (a.w.order != null ? a.w.order : 1e9 + a.i) - (b.w.order != null ? b.w.order : 1e9 + b.i))
        .map(({ w }) => renderWidget(w, { profile, allowed_commands }));
    const estop = ESTOP_ROLES.has(role) ? `<button type="button" class="estop" data-estop>Stop</button>` : '';
    const clear = role === 'owner' ? `<button type="button" class="estop-clear" data-estop-clear${latched ? '' : ' hidden'}>Clear e-stop</button>` : '';
    const body = `<header class="estop-banner" data-estop-banner data-latched="${latched}" role="status" aria-live="assertive">
<span class="estop-state" data-estop-state>${latched ? 'E-stop latched' : 'E-stop clear'}</span>${estop}${clear}
</header>
<main id="panel" data-robot-id="${esc(robot.id)}" data-role="${esc(role)}" data-hold-ms="${esc(holdResendMs)}" data-allowed="${data(allowed_commands)}">
<h1>${esc(robot.name)}</h1>
<p class="meta"><span class="profile">${esc(profile.name || robot.profile_id)}</span> · <span class="role" data-role-label>${esc(role)}</span> · <span class="online" data-online>connecting…</span></p>
<p class="notice" data-notice role="alert" hidden></p>
<div class="widgets">
${widgets.join('\n')}
</div>
</main>`;
    return page(robot.name, body, { scripts: ['/panel/panel.js'] });
}

function renderRobotsPage({ robots = [], profiles = [], error = null, values = {} }) {
    const names = new Map(profiles.map((p) => [p.id, p.name]));
    const list = robots.length
        ? `<ul class="robots">${robots.map((r) => `<li><a href="/panel/${esc(r.id)}">${esc(r.name)}</a> <span class="profile">${esc(names.get(r.profile_id) || r.profile_id)}</span> <span class="policy">${esc(r.access_policy)}</span> <a class="pair" href="/pair/${esc(r.id)}">Pair a device</a></li>`).join('')}</ul>`
        : '<p class="empty">No robots yet.</p>';
    const option = (v, label, selected) => `<option value="${esc(v)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
    const form = `<form class="add-robot" method="post" action="/robots">
<h2>Add a robot</h2>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<label>Name <input type="text" name="name" maxlength="80" required value="${esc(values.name || '')}"></label>
<label>Robot <select name="profile_id">${profiles.map((p) => option(p.id, p.name, p.id === values.profile_id)).join('')}</select></label>
<label>Who may drive <select name="access_policy">${POLICIES.map((p) => option(p, p, p === (values.access_policy || 'private'))).join('')}</select></label>
<button type="submit">Add</button>
</form>`;
    return page('Your robots', `<main class="page">\n<h1>Your robots</h1>\n${list}\n${form}\n</main>`);
}

function renderPairingPage({ robot, pairing, profile = null }) {
    const body = `<main class="page pairing">
<h1>Pair ${esc(robot.name)}</h1>
<p>Run this on the machine that serves the robot${profile ? ` (${esc(profile.name)})` : ''}:</p>
<pre class="installer"><code data-copy-source>${esc(pairing.installer)}</code></pre>
<button type="button" data-copy>Copy the command</button>
<p>Or enter the pairing code <strong class="code">${esc(pairing.code)}</strong>, valid until <time datetime="${esc(pairing.expires_at)}">${esc(pairing.expires_at)}</time>.</p>
<p class="waiting">Waiting for the device. <a href="/panel/${esc(robot.id)}">Open the panel</a></p>
</main>`;
    return page(`Pair ${robot.name}`, body, { scripts: ['/panel/panel.js'] });
}

module.exports = { renderPanel, renderWidget, renderRobotsPage, renderPairingPage, esc };
