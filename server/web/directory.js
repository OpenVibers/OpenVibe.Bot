'use strict';

/**
 * The robot directory (plan T15 "a robot directory (/robots)"), inside the OpenVibe Frame like the front page:
 *
 *   renderDirectory({ config, listed, mine, models, signedIn })   GET /robots: robots people list, the models Bot
 *                                                                   drives and, signed in, your own robots
 *   renderModels({ config, models })                              GET /models
 *   renderModel({ config, model, kit })                           GET /models/:id: what it is, how it connects, the
 *                                                                   panel it gets, its setup steps and guide
 *   renderRobotPage({ config, robot, model, owner, state, role })   GET /r/:id: a listed robot's public page (its live
 *                                                                   panel, watch-only, in a frame of this site)
 *   renderAddRobot({ config, models, values, error })             GET /robots/new: name it, choose what it is, who drives
 *
 * Plain markup, no script (the Frame's own aside), every value escaped. A model is a catalogue profile; MODELS adds
 * what a profile does not say (how it connects in words, the setup steps, the guide). An unknown profile still gets
 * a page from its own fields.
 */
const { esc } = require('./render');
const { framePage } = require('./home');

const NODE_BLOB = 'https://github.com/OpenVibers/OpenVibe.Node/blob/main';
const CONNECT = {
    browser: { label: 'Simulated', text: 'Runs inside Bot and in your browser: nothing to buy or install.' },
    onboard: { label: 'On-board', text: 'The OpenVibe Node runs on the robot\'s own computer and drives its hardware.' },
    bridge: { label: 'Bridge', text: 'The OpenVibe Node runs on a computer or phone next to the robot and joins the robot\'s own link. Nothing on the robot changes.' },
    server: { label: 'Server-side', text: 'Nothing to install: Bot connects to the device itself.' },
    phone: { label: 'Phone', text: 'The phone\'s browser is the device: scan a code, allow the camera, keep the page open. Nothing to install.' },
};
const MODELS = {
    'sim.rover': {
        connect: 'browser', order: 0,
        setup: ['Add it and its panel drives straight away; the simulator runs inside Bot.', 'Or drive one at /try without an account.'],
        guide: { href: '/try', label: 'Try it now, no account' },
    },
    'adeept.adr036': {
        connect: 'onboard', order: 1,
        setup: ['Build the kit and flash Raspberry Pi OS (64-bit, Lite is enough) on its card.', 'Add the robot here and paste the one pairing command on the Pi.',
            'The OpenVibe Node drives the Robot HAT itself, publishes the Pi camera, and stops the motors the moment commands stop. The kit\'s stock control server is never run.'],
        guide: { href: `${NODE_BLOB}/docs/hardware-adeept.md`, label: 'Adeept setup guide' },
    },
    'adeept.adr036.mecanum': {
        connect: 'onboard', order: 2,
        setup: ['The same kit built with mecanum wheels, so it also moves sideways.', 'Pair it with the same one command; the installer picks the mecanum driver.'],
        guide: { href: `${NODE_BLOB}/docs/hardware-adeept.md`, label: 'Adeept setup guide' },
    },
    cozmo: {
        connect: 'bridge', order: 3,
        setup: ['Cozmo keeps its own firmware and app; nothing on it changes.', 'On a computer beside it (one network adapter on Cozmo\'s Wi-Fi, one on the internet) paste the pairing command.',
            'The bridge drives it through PyCozmo and streams its camera; cliff and pick-up stop it on the robot.'],
        guide: { href: `${NODE_BLOB}/docs/hardware-cozmo.md`, label: 'Cozmo setup guide' },
    },
    looi: {
        connect: 'bridge', order: 4,
        setup: ['The community\'s Generic LOOI driver bridges to the desk robot over Bluetooth from a Windows PC.', 'Install the Node with --driver looi; the phone in LOOI keeps doing what it does.'],
        guide: { href: `${NODE_BLOB}/docs/hardware-looi.md`, label: 'LOOI driver contract' },
    },
    'phone.camera': {
        connect: 'phone', order: 1,
        setup: ['Add the robot here and choose A phone; its pairing page shows a QR code.', 'Scan it with the phone, tap Start and allow the camera. The phone streams, speaks, shows a face and reports its battery and tilt.',
            'Keep the page open (the screen stays on). Its Stop button holds the robot until it is released on the phone.'],
        guide: { href: '/device/phone', label: 'The phone\'s page' },
    },
    'camera.onvif': {
        connect: 'server', order: 5,
        setup: ['Any ONVIF pan-tilt-zoom camera: Bot moves it, with the same gate and limits as a robot.', 'Today an operator names the camera in Bot\'s configuration (its address and the names of its secrets).'],
        guide: { href: 'https://github.com/OpenVibers/OpenVibe.Bot#readme', label: 'ONVIF notes' },
    },
    'relay.generic': {
        connect: 'onboard', order: 6,
        setup: ['Any Raspberry Pi or Linux machine running the OpenVibe Node.', 'Each button on the panel is passed to a script of yours by the relay driver: lights, a door, a motor board.'],
        guide: { href: '/docs/drivers', label: 'Write a driver' },
    },
};
const CAPABILITY_WORDS = {
    'drive.differential': 'Drives', 'drive.mecanum': 'Drives any direction', 'servo.pan_tilt': 'Pan / tilt camera', head: 'Head', lift: 'Lift',
    'lights.rgb': 'RGB lights', 'lights.backpack': 'Backpack lights', 'lights.cube': 'Cube lights', 'speaker.horn': 'Horn', 'speaker.say': 'Speaks',
    'display.text': 'Face and text', 'sensor.ultrasonic': 'Range finder', 'sensor.line': 'Line tracking', 'sensor.cliff': 'Cliff sensors',
    'sensor.pickup': 'Pick-up sensor', battery: 'Battery', ptz: 'Pan, tilt, zoom', camera: 'Live camera', relay: 'Your own buttons',
    'lights.torch': 'Torch', 'sensor.tilt': 'Tilt sensor',
};
const POLICY_WORDS = { private: 'Only its owner and the people they add drive it.', invite: 'People the owner invites drive it.', queue: 'Anyone signed in can take a timed turn.' };

/** A catalogue profile as a model: its own fields plus MODELS. */
/**
 * A catalogue profile as a model. `community` is the approved submission that put a community profile in the catalogue
 * ({ by, driver_url, guide_url, license, key_id }); its guide becomes the model's guide.
 */
function modelOf(profile, community = null) {
    const extra = MODELS[profile.id] || {};
    const connect = extra.connect || (profile.kind === 'bridge' ? 'bridge' : profile.kind === 'server' ? 'server' : 'onboard');
    const guide = extra.guide || (community && community.guide_url ? { href: community.guide_url, label: 'Setup guide' } : null);
    return {
        id: profile.id, name: profile.name, vendor: profile.vendor || '', description: profile.description || '',
        connect, order: extra.order != null ? extra.order : community ? 200 : 100, setup: extra.setup || [], guide,
        capabilities: (profile.capabilities || []).filter((c) => CAPABILITY_WORDS[c]), widgets: profile.widgets || [], profile,
        community,
    };
}
const sortModels = (models) => models.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

const chips = (caps) => `<ul class="dir-chips">${caps.map((c) => `<li>${esc(CAPABILITY_WORDS[c])}</li>`).join('')}</ul>`;
const badge = (connect) => `<span class="dir-badge dir-${esc(connect)}">${esc(CONNECT[connect].label)}</span>`;
const communityBadge = (m) => (m.community ? ' <span class="dir-badge dir-community">Community</span>' : '');
const link = (href, text, cls = '') => `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}"${/^https?:/.test(href) ? ' rel="noopener"' : ''}>${esc(text)}</a>`;
/** A card's line: the description's first clause, cut at a word near `max` characters. */
function short(text, max = 120) {
    const first = String(text).split(/(?<=[.:;])\s/)[0].replace(/[:;]$/, '.');
    if (first.length <= max) return /[.!?]$/.test(first) ? first : `${first}.`;
    return `${first.slice(0, first.lastIndexOf(' ', max)).replace(/[,(]$/, '')}…`;
}
const ownerName = (o) => (o && o.username ? `@${o.username}` : 'an OpenVibe member');

function shell({ config, path, title, description, body }) {
    return framePage({ config, title: `${title} · OpenVibe.Bot`, description, canonicalPath: path, head: '<link rel="stylesheet" href="/directory.css">', body: `<main id="main" class="dir">${body}</main>` });
}

function modelCard(m) {
    return `<li class="dir-card"><a class="dir-card-link" href="/models/${esc(m.id)}"><span class="dir-card-head"><b>${esc(m.name)}</b><span>${badge(m.connect)}${communityBadge(m)}</span></span>`
        + `<span class="dir-card-text">${esc(short(m.description))}</span></a>${chips(m.capabilities.slice(0, 6))}</li>`;
}

function robotCard(r) {
    return `<li class="dir-card"><a class="dir-card-link" href="/r/${esc(r.id)}"><span class="dir-card-head"><b>${esc(r.name)}</b>`
        + `<span class="dir-state" data-state="${r.online ? 'online' : 'offline'}"><span class="dir-dot"></span>${r.online ? 'Online' : 'Offline'}</span></span>`
        + `<span class="dir-card-text">${esc(r.model_name)} · ${esc(ownerName(r.owner))}</span></a>`
        + `<p class="dir-card-foot">${esc(POLICY_WORDS[r.access_policy] || '')}</p></li>`;
}

// ── GET /robots ─────────────────────────────────────────────────────────────────────────────────────
function renderDirectory({ config, listed = [], mine = null, models = [], signedIn = false }) {
    const yours = !signedIn ? `<section class="dir-sec dir-cta"><h2>Have a robot?</h2>
<p class="muted">Sign in to add it and pair it with one pasted command, or drive a simulated rover first, no account needed.</p>
<p class="dir-actions">${link('/try', 'Try the panel', 'dir-btn dir-primary')} ${link('/auth/login?next=%2Frobots%2Fnew', 'Sign in and add a robot', 'dir-btn')}</p></section>`
        : `<section class="dir-sec" aria-labelledby="yours-h"><div class="dir-sec-head"><h2 id="yours-h">Your robots</h2>${link('/robots/new', 'Add a robot', 'dir-btn dir-primary')}</div>
${mine && mine.length ? `<ul class="dir-list">${mine.map((r) => `<li class="dir-row"><a href="/panel/${esc(r.id)}"><b>${esc(r.name)}</b></a><span class="muted">${esc(r.model_name)}</span>`
        + `${r.listed ? `<a class="dir-pill" href="/r/${esc(r.id)}">Listed</a>` : '<span class="dir-pill dir-quiet">Not listed</span>'}`
        + `<span class="dir-row-actions">${link(`/panel/${r.id}`, 'Panel')} · ${link(`/pair/${r.id}`, 'Pair a device')}</span></li>`).join('')}</ul>`
        : '<p class="muted">No robots yet. Add one: a simulated rover drives straight away, before any hardware exists.</p>'}</section>`;
    const body = `<header class="dir-hero"><h1>Robots</h1>
<p class="muted">Robots people share on OpenVibe.Bot, and every model it drives. Watch any listed robot live; some take visitors at the controls in turns.</p></header>
${yours}
<section class="dir-sec" aria-labelledby="listed-h"><h2 id="listed-h">In the directory</h2>
${listed.length ? `<ul class="dir-grid">${listed.map(robotCard).join('')}</ul>`
        : `<p class="muted">No robot is listed yet. An owner lists theirs from its panel (Directory), and it shows here with its live camera.</p>`}</section>
<section class="dir-sec" aria-labelledby="models-h"><div class="dir-sec-head"><h2 id="models-h">Models it drives</h2>${link('/models', 'All models')}</div>
<ul class="dir-grid">${sortModels(models).map(modelCard).join('')}</ul></section>
<section class="dir-sec" aria-labelledby="byo-h"><h2 id="byo-h">Something else?</h2>
<p class="muted">Any robot with a computer on it or next to it can join: a Raspberry Pi or other Linux board, an ESP32, a ROS 2 robot, an ONVIF camera. Describe it with a profile and the panel draws itself; write a driver in any language for the hardware, then submit it so anyone can add one.</p>
<p class="dir-actions">${link('/robots/submit', 'Submit a robot', 'dir-btn dir-primary')} ${link('/docs/profiles', 'Robot profiles', 'dir-btn')} ${link('/docs/drivers', 'Write a driver', 'dir-btn')}</p></section>`;
    return shell({ config, path: '/robots', title: 'Robots', description: 'Robots on OpenVibe.Bot: watch the ones people list live, see every model it drives, and add your own.', body });
}

// ── GET /models ─────────────────────────────────────────────────────────────────────────────────────
function renderModels({ config, models = [] }) {
    const official = models.filter((m) => !m.community);
    const community = sortModels(models.filter((m) => m.community));
    const groups = ['browser', 'phone', 'onboard', 'bridge', 'server'].map((k) => [k, sortModels(official).filter((m) => m.connect === k)]).filter(([, ms]) => ms.length);
    const body = `<header class="dir-hero"><h1>Models</h1>
<p class="muted">Every robot OpenVibe.Bot has a profile for. A profile lays out the panel, so each of these drives with the controls it really has.</p></header>
${groups.map(([k, ms]) => `<section class="dir-sec" aria-labelledby="g-${esc(k)}"><h2 id="g-${esc(k)}">${esc(CONNECT[k].label)}</h2><p class="muted">${esc(CONNECT[k].text)}</p>
<ul class="dir-grid">${ms.map(modelCard).join('')}</ul></section>`).join('\n')}
${community.length ? `<section class="dir-sec" aria-labelledby="g-community"><h2 id="g-community">From the community</h2><p class="muted">Profiles people submitted and an OpenVibe admin reviewed. Each one is signed by OpenVibe.Bot; its driver is the submitter's.</p>
<ul class="dir-grid">${community.map(modelCard).join('')}</ul></section>` : ''}
<section class="dir-sec"><h2>Not here?</h2><p class="muted">Write a profile for it and check it with the validator, then submit it: once it is reviewed, anyone can add a robot with it. A driver for its hardware runs under the OpenVibe Node.</p>
<p class="dir-actions">${link('/robots/submit', 'Submit a robot', 'dir-btn dir-primary')} ${link('/docs/profiles', 'Robot profiles', 'dir-btn')} ${link('/docs/drivers', 'Write a driver', 'dir-btn')}</p></section>`;
    return shell({ config, path: '/models', title: 'Models', description: 'The robots OpenVibe.Bot drives: kits, bridged robots like Cozmo and LOOI, ONVIF cameras and a simulated rover.', body });
}

// ── GET /models/:id ─────────────────────────────────────────────────────────────────────────────────
function renderModel({ config, model, kit = null }) {
    const controls = model.widgets.filter((w) => w.type !== 'latency').map((w) => `<li>${esc(w.label || w.type)}</li>`).join('');
    const parts = kit ? `<section class="dir-sec card"><h2>What you need</h2><ul>${kit.parts.map((p) => `<li>${esc(p.qty)}× ${esc(p.name)}${p.note ? ` <span class="muted">(${esc(p.note)})</span>` : ''}</li>`).join('')}</ul>
${kit.build_guide_url ? `<p>${link(kit.build_guide_url, 'The kit\'s build guide')}</p>` : ''}</section>` : '';
    const add = model.connect === 'browser'
        ? `${link('/try', 'Try it now, no account', 'dir-btn dir-primary')} ${link(`/robots/new?profile=${encodeURIComponent(model.id)}`, 'Add one to your robots', 'dir-btn')}`
        : `${link(`/robots/new?profile=${encodeURIComponent(model.id)}`, 'Add this robot', 'dir-btn dir-primary')}${model.guide ? ` ${link(model.guide.href, model.guide.label, 'dir-btn')}` : ''}`;
    const body = `<p class="dir-crumb">${link('/robots', 'Robots')} / ${link('/models', 'Models')}</p>
<header class="dir-hero"><h1>${esc(model.name)}</h1><p>${badge(model.connect)}${communityBadge(model)}${model.vendor ? ` <span class="muted">by ${esc(model.vendor)}</span>` : ''}</p>
<p class="muted">${esc(model.description)}</p><p class="dir-actions">${add}</p></header>
<div class="dir-cols">
<section class="dir-sec card"><h2>How it connects</h2><p><b>${esc(CONNECT[model.connect].label)}.</b> ${esc(CONNECT[model.connect].text)}</p>
${model.setup.length ? `<ol>${model.setup.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</section>
<section class="dir-sec card"><h2>Its panel</h2><p class="muted">Laid out from its profile (<code>${esc(model.id)}</code>):</p><ul>${controls}</ul>${chips(model.capabilities)}</section>
</div>
${parts}
${model.community ? `<section class="dir-sec card"><h2>From the community</h2><p>Submitted by ${esc(ownerName(model.community.by))} and reviewed by an OpenVibe admin.${model.community.license ? ` Licence: ${esc(model.community.license)}.` : ''}</p>
<ul>${model.community.driver_url ? `<li>Driver: ${link(model.community.driver_url, model.community.driver_url)}</li>` : ''}${model.community.guide_url ? `<li>Setup guide: ${link(model.community.guide_url, model.community.guide_url)}</li>` : ''}
<li>Signed by OpenVibe.Bot (Ed25519, key <code>${esc(model.community.key_id || '')}</code>): ${link(`/api/v1/profiles/${model.id}`, 'the profile and its signature')} · ${link('/api/v1/profiles/signing-key', 'the public key')}</li></ul>
<p class="muted">Install the driver from its source on the robot's computer; OpenVibe.Bot never runs it.</p></section>` : ''}
<section class="dir-sec card"><h2>Safety</h2><p class="muted">Every command passes Bot's gate: roles, the owner's limits and cooldowns, and a latched e-stop only the owner clears. The device stops the motors by itself when commands stop arriving, without asking the network.</p></section>`;
    return shell({ config, path: `/models/${model.id}`, title: model.name, description: `${model.name} on OpenVibe.Bot: how it connects, the panel it gets and how to set it up.`, body });
}

// ── GET /r/:id ──────────────────────────────────────────────────────────────────────────────────────
function renderRobotPage({ config, robot, model, owner = null, state = null, role = null }) {
    const online = !!(state && state.online);
    const turn = robot.access_policy === 'queue' ? link(`/panel/${robot.id}`, 'Take a turn at the controls', 'dir-btn dir-primary') : '';
    const member = role ? link(`/panel/${robot.id}`, role === 'owner' ? 'Open your panel' : 'Open the panel', 'dir-btn dir-primary') : '';
    const body = `<p class="dir-crumb">${link('/robots', 'Robots')}</p>
<header class="dir-hero"><h1>${esc(robot.name)}</h1>
<p><span class="dir-state" data-state="${online ? 'online' : 'offline'}"><span class="dir-dot"></span>${online ? 'Online' : 'Offline'}</span> ${link(`/models/${model.id}`, model.name, 'dir-pill')} <span class="muted">by ${esc(ownerName(owner))}</span></p>
<p class="muted">${esc(POLICY_WORDS[robot.access_policy] || '')}</p>
${member || turn ? `<p class="dir-actions">${member || turn}</p>` : ''}</header>
<div class="dir-live"><iframe src="/panel/${esc(robot.id)}/embed" title="${esc(robot.name)}: live panel" loading="lazy" allow="autoplay; gamepad"></iframe></div>
<p class="muted dir-note">Watching is open to everyone; driving follows the owner's rules and passes the same gate and e-stop as on its own panel.</p>`;
    return shell({ config, path: `/r/${robot.id}`, title: robot.name, description: `${robot.name}, a ${model.name} on OpenVibe.Bot. ${POLICY_WORDS[robot.access_policy] || ''}`.trim(), body });
}

// ── GET /robots/new ─────────────────────────────────────────────────────────────────────────────────
const POLICIES = [['private', 'Only me and people I add'], ['invite', 'People I invite'], ['queue', 'Anyone signed in, taking turns']];
function renderAddRobot({ config, models = [], values = {}, error = null }) {
    const chosen = values.profile_id || 'sim.rover';
    const option = (m) => `<label class="dir-choice"><input type="radio" name="profile_id" value="${esc(m.id)}"${m.id === chosen ? ' checked' : ''} required>`
        + `<span class="dir-choice-body"><span class="dir-card-head"><b>${esc(m.name)}</b>${badge(m.connect)}</span><span class="dir-card-text">${esc(CONNECT[m.connect].text)}</span></span></label>`;
    const groups = [['browser', 'Try it with no hardware'], ['phone', 'A phone, from its browser'], ['onboard', 'A robot with its own computer'], ['bridge', 'A robot you connect through a computer next to it'], ['server', 'A camera Bot connects to']]
        .map(([k, title]) => [title, sortModels(models).filter((m) => m.connect === k)]).filter(([, ms]) => ms.length);
    const body = `<p class="dir-crumb">${link('/robots', 'Robots')}</p>
<header class="dir-hero"><h1>Add a robot</h1><p class="muted">Name it, say what it is, and choose who may drive. A simulated rover drives the moment it is added; anything else gets a one-time pairing code and one command to paste on its computer.</p></header>
<form class="dir-form" method="post" action="/robots">
${error ? `<p class="dir-error" role="alert">${esc(error)}</p>` : ''}
<label class="dir-field"><span class="dir-field-label">Name</span><input type="text" name="name" maxlength="80" required autocomplete="off" placeholder="e.g. Kitchen rover" value="${esc(values.name || '')}"></label>
<fieldset class="dir-fieldset"><legend class="dir-field-label">What are you connecting?</legend>
${groups.map(([title, ms]) => `<p class="dir-group">${esc(title)}</p><div class="dir-choices">${ms.map(option).join('')}</div>`).join('\n')}
<p class="muted dir-note">Something else (an ESP32, a ROS 2 robot, your own board)? Choose the relay robot and drive it with your own script, or ${link('/docs/profiles', 'write a profile')} for it.</p>
</fieldset>
<label class="dir-field"><span class="dir-field-label">Who may drive</span><select name="access_policy">${POLICIES.map(([v, l]) => `<option value="${esc(v)}"${v === (values.access_policy || 'private') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
<p><button type="submit" class="dir-btn dir-primary">Add robot</button></p>
</form>`;
    return shell({ config, path: '/robots/new', title: 'Add a robot', description: 'Add a robot to OpenVibe.Bot.', body });
}

// ── GET /robots/submit, /robots/submissions ────────────────────────────────────────────────────────
const TEMPLATE = {
    id: 'community.my-robot', version: 1, name: 'My robot', vendor: 'Me', kind: 'onboard',
    description: 'What it is, what it drives, and what it needs.',
    capabilities: ['drive.differential', 'battery'],
    mapping: { driver: 'plugin', plugin: 'my_robot' },
    commands: { drive: { axes: { throttle: [-1, 1], steer: [-1, 1] } } },
    widgets: [
        { type: 'drive', capability: 'drive.differential', label: 'Drive', order: 1, command: { kind: 'drive' } },
        { type: 'battery', capability: 'battery', label: 'Battery', order: 2 },
    ],
    limits: { max_speed: 0.6, max_turn: 0.6, max_command_ms: 300, heartbeat_ms: 1000 },
};
const STATUS_WORDS = { pending: 'Waiting for review', approved: 'Approved', rejected: 'Not approved', withdrawn: 'Withdrawn' };

function renderSubmit({ config, licenses = [], values = {}, error = null }) {
    const profile = values.profile != null ? values.profile : JSON.stringify(TEMPLATE, null, 2);
    const body = `<p class="dir-crumb">${link('/robots', 'Robots')} / ${link('/models', 'Models')}</p>
<header class="dir-hero"><h1>Submit a robot</h1><p class="muted">Describe your robot with a profile and point at its driver. An OpenVibe admin reviews it; once it is approved, OpenVibe.Bot signs it, it appears under <b>From the community</b>, and anyone can add a robot with it. ${link('/docs/profiles', 'How profiles work')} · ${link('/docs/drivers', 'Write a driver')}</p></header>
<form class="dir-form" method="post" action="/robots/submit">
${error ? `<p class="dir-error" role="alert">${esc(error)}</p>` : ''}
<label class="dir-field dir-wide"><span class="dir-field-label">Profile (bot.robot-profile@1)</span><textarea name="profile" rows="18" spellcheck="false" required>${esc(profile)}</textarea>
<span class="muted dir-note">Its id is <code>community.&lt;name&gt;</code>. A robot run by your own Node plugin uses <code>"driver": "plugin"</code> and names it in <code>"plugin"</code>.</span></label>
<label class="dir-field"><span class="dir-field-label">Driver source (https)</span><input type="url" name="driver_url" maxlength="300" placeholder="https://github.com/you/your-driver" value="${esc(values.driver_url || '')}"></label>
<label class="dir-field"><span class="dir-field-label">Setup guide (https)</span><input type="url" name="guide_url" maxlength="300" placeholder="https://openvibe.wiki/…" value="${esc(values.guide_url || '')}"></label>
<label class="dir-field"><span class="dir-field-label">Driver licence</span><select name="license"><option value="">Choose…</option>${licenses.map((l) => `<option value="${esc(l)}"${l === values.license ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
<label class="dir-field dir-wide"><span class="dir-field-label">Notes for the reviewer</span><textarea name="notes" rows="4" maxlength="2000">${esc(values.notes || '')}</textarea></label>
<p><button type="submit" class="dir-btn dir-primary">Submit for review</button></p>
</form>`;
    return shell({ config, path: '/robots/submit', title: 'Submit a robot', description: 'Submit a community robot profile to OpenVibe.Bot.', body });
}

function submissionRow(sub, { review = false, by = null } = {}) {
    const p = typeof sub.profile === 'string' ? JSON.parse(sub.profile) : sub.profile;
    const head = `<span class="dir-card-head"><b>${esc(p.name)} <code>${esc(sub.profile_id)}</code> v${esc(sub.profile_version)}</b><span class="dir-pill">${esc(STATUS_WORDS[sub.status] || sub.status)}</span></span>`;
    const links = [sub.driver_url && link(sub.driver_url, 'driver'), sub.guide_url && link(sub.guide_url, 'guide'), sub.license && esc(sub.license)].filter(Boolean).join(' · ');
    const note = sub.review_note ? `<p class="muted">Reviewer: ${esc(sub.review_note)}</p>` : '';
    const done = sub.status === 'approved' ? `<p>${link(`/models/${sub.profile_id}`, 'Its model page')}</p>` : '';
    const withdraw = !review && sub.status === 'pending' ? `<form method="post" action="/robots/submissions/${esc(sub.id)}/withdraw"><button type="submit" class="dir-btn">Withdraw</button></form>` : '';
    const decide = review ? `<details><summary>The profile</summary><pre class="dir-pre">${esc(JSON.stringify(p, null, 2))}</pre></details>
${sub.notes ? `<p class="muted">Notes: ${esc(sub.notes)}</p>` : ''}
<form class="dir-review" method="post" action="/robots/submissions/${esc(sub.id)}/review">
<label class="dir-field dir-wide"><span class="dir-field-label">Note (needed to reject)</span><input type="text" name="note" maxlength="1000"></label>
<p class="dir-actions"><button type="submit" name="decision" value="approve" class="dir-btn dir-primary">Approve and sign</button> <button type="submit" name="decision" value="reject" class="dir-btn">Reject</button></p>
</form>` : '';
    return `<li class="dir-card dir-sub"><div class="dir-card-link">${head}<span class="dir-card-text">${review ? `From ${esc(ownerName(by))} · ` : ''}${links || 'no links'}</span></div><div class="dir-sub-body">${note}${done}${withdraw}${decide}</div></li>`;
}

function renderSubmissions({ config, mine = [], pending = null, names = new Map(), signing = null }) {
    const body = `<p class="dir-crumb">${link('/robots', 'Robots')} / ${link('/models', 'Models')}</p>
<header class="dir-hero"><h1>Community robots</h1><p class="muted">Your submitted profiles and where each one stands. ${link('/robots/submit', 'Submit another')}</p></header>
<section class="dir-sec" aria-labelledby="mine-h"><h2 id="mine-h">Yours</h2>
${mine.length ? `<ul class="dir-list">${mine.map((s) => submissionRow(s)).join('')}</ul>` : '<p class="muted">Nothing submitted yet.</p>'}</section>
${pending ? `<section class="dir-sec" aria-labelledby="queue-h"><h2 id="queue-h">Waiting for review</h2>
${signing ? '' : '<p class="dir-error" role="alert">No profile signing key is configured, so nothing can be approved yet (BOT_PROFILE_SIGNING_KEY).</p>'}
<p class="muted">Check the profile's commands and limits are safe for the hardware it names, that its driver's source is public and matches, and that the guide is a real guide. Approving signs it and puts it in the catalogue.</p>
${pending.length ? `<ul class="dir-list">${pending.map((s) => submissionRow(s, { review: true, by: names.get(s.submitter_subject) })).join('')}</ul>` : '<p class="muted">The queue is empty.</p>'}</section>` : ''}`;
    return shell({ config, path: '/robots/submissions', title: 'Community robots', description: 'Community robot profiles on OpenVibe.Bot.', body });
}

module.exports = { renderSubmit, renderSubmissions, renderDirectory, renderModels, renderModel, renderRobotPage, renderAddRobot, modelOf, sortModels, MODELS, CONNECT, CAPABILITY_WORDS };
