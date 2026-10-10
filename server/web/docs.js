'use strict';

/**
 * The public "Build for OpenVibe.Bot" pages (plan T15): a guide to writing a driver for the OpenVibe Node, the
 * robot-profile format, and a validator for a pasted profile.
 *
 * They are rendered with the app's own page helper (server/web/render.js, the one the robots page uses), which
 * emits the site stylesheet and no script at all, so these pages run under the site-wide `default-src 'self'`
 * CSP. Every value is escaped; the code samples are `<pre class="installer"><code>…</code></pre>`, escaped.
 *
 *   renderDocsIndex({ config })                       GET /docs
 *   renderDriversPage({ config })                     GET /docs/drivers
 *   renderProfilesPage({ config, source, result })    GET /docs/profiles, POST /docs/profiles/validate
 *   formatProblems(problems) / validationResult(result)
 */
const { esc } = require('./render');
const { framePage } = require('./home');
const simRover = require('../profiles/sim.rover.json');

// The driver protocol and the bundled drivers live in OpenVibe.Node (the Node core and its plugins/ tree).
const NODE = 'https://github.com/OpenVibers/OpenVibe.Node';
const TREE = `${NODE}/tree/main`;
const BLOB = `${NODE}/blob/main`;

/** A code sample, in a `<pre><code>` block, escaped. */
const code = (text) => `<pre class="installer"><code>${esc(text)}</code></pre>`;
/** An external link (openvibe.bot's CSP allows none of these origins in a frame, so it is a plain link). */
const out = (href, text) => `<a href="${esc(href)}" rel="noopener">${esc(text)}</a>`;
/** A link on this site. */
const inLink = (href, text) => `<a href="${esc(href)}">${esc(text)}</a>`;

const PAGES = [['/docs', 'Overview'], ['/docs/drivers', 'Write a driver'], ['/docs/profiles', 'Robot profiles']];

/** The Build pages inside the OpenVibe Frame: a sidebar of the three pages beside the content, plain markup. */
function docsPage({ config, path, title, description, content }) {
    const side = PAGES.map(([href, label]) => `<a href="${esc(href)}"${href === path ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('');
    const body = `<div class="docs-wrap">
<nav class="docs-side" aria-label="Build for OpenVibe.Bot"><p class="docs-side-title">Build</p>${side}<div class="docs-side-rule"></div><a href="/robots">Your robots</a></nav>
<main id="main" class="docs-main">
${content}
<p class="docs-foot muted">The Node and its bundled drivers are in ${out(`${TREE}/plugins`, 'OpenVibers/OpenVibe.Node')}; the full protocol is ${out(`${BLOB}/docs/protocol.md`, 'protocol.md')} and the plugin contract is ${out(`${BLOB}/docs/plugins.md`, 'plugins.md')}.</p>
</main>
</div>`;
    return framePage({ config, title: title.includes('OpenVibe.Bot') ? title : `${title} · OpenVibe.Bot`, description, canonicalPath: path, body, head: '<link rel="stylesheet" href="/docs/docs.css">' });
}

/** A message type: its name, a sentence, and a short JSON example. */
const message = (name, text, sample) => `<div class="card"><p><code>${esc(name)}</code> — ${esc(text)}</p>${code(sample)}</div>`;

// ── GET /docs ─────────────────────────────────────────────────────────────────────────────────────

function renderDocsIndex({ config }) {
    const content = `
<h1>Build for OpenVibe.Bot</h1>
<p class="muted">OpenVibe.Bot drives a robot from its profile. Two things are open to build against: the <b>driver</b> — a separate program the OpenVibe Node runs — and the <b>profile</b>, the JSON that turns a driver's capabilities into a panel.</p>
<section class="card"><h2>Write a driver</h2>
<p>A driver is a separate program the OpenVibe Node starts and talks to in JSON lines over stdin/stdout. It can be written in any language. It may run on the robot (on-board), on a computer beside it (a bridge), or be attached by Bot itself on the server — the same protocol either way.</p>
<p>${inLink('/docs/drivers', 'Write a driver')} covers the lifecycle, every message, the safety rules, a minimal Python driver, and how to test and contribute it.</p></section>
<section class="card"><h2>Robot profiles</h2>
<p>A profile (<code>bot.robot-profile@1</code>) says what the robot can do, which commands its driver accepts, and which widgets the panel shows. The panel is a function of the profile: a new robot needs a profile, not code.</p>
<p>${inLink('/docs/profiles', 'Robot profiles')} lists the fields, shows a full example, and has a validator for a profile you paste.</p></section>
<section class="card"><h2>Robots</h2>
<p>Add a robot and drive it from any browser. The <b>Simulated rover</b> runs inside Bot with no hardware, so you can see your profile's panel before anything is wired up.</p>
<p>${inLink('/robots', 'Your robots')} · ${inLink('/install', 'Install a device')}</p></section>
<h2>Where things live</h2>
<ul>
<li>The <b>OpenVibe Node</b> (${out(NODE, 'OpenVibers/OpenVibe.Node')}) is the agent on the robot's machine: it pairs, holds the control link, and runs the drivers.</li>
<li>Drivers are Node <b>plugins</b> (${out(`${TREE}/plugins`, 'plugins/')}), written against the Python runtime ${out(`${TREE}/plugins/sdk`, 'openvibe_plugin')} or any language over the raw protocol.</li>
<li>Bundled drivers: ${out(`${TREE}/plugins/dryrun`, 'dryrun')}, ${out(`${TREE}/plugins/adeept_adr036`, 'adeept_adr036')}, ${out(`${TREE}/plugins/cozmo`, 'cozmo')} and ${out(`${TREE}/plugins/relay`, 'relay')}.</li>
<li>Profiles ship in this repository (${inLink('/api/v1/profiles', 'GET /api/v1/profiles')}) and are validated by the same loader the pages use.</li>
</ul>
`;
    return docsPage({ config, path: '/docs', title: 'Build for OpenVibe.Bot', description: 'Build drivers and robot profiles for OpenVibe.Bot, the open robot control panel: the protocol, the profile format and a validator.', content });
}

// ── GET /docs/drivers ──────────────────────────────────────────────────────────────────────────────

function renderDriversPage({ config }) {
    const content = `
<h1>Write a driver</h1>
<p class="muted">A driver is how OpenVibe.Bot moves a specific piece of hardware. This page is the spec: build against it instead of reverse-engineering Bot. The full contract is ${out(`${BLOB}/docs/plugins.md`, 'plugins.md')} in OpenVibe.Node.</p>

<section class="card"><h2>What a driver is</h2>
<p>A driver is a <b>separate executable</b> the OpenVibe Node core starts. It can be written in any language. The two speak <b>JSON lines over stdin/stdout</b>: one JSON object per line, UTF-8, in each direction. The core never links driver code; the robot drivers are Python 3 because their hardware libraries are.</p>
<p>Nothing but protocol lines may go to stdout. Send diagnostics to <b>stderr</b> (the Python runtime points file descriptor 1 at stderr and keeps a private copy for the protocol, because hardware libraries print).</p>
<p>The Node core itself speaks a different protocol to openvibe.bot (<code>bot.device-message@1</code>, ${out(`${BLOB}/docs/protocol.md`, 'protocol.md')}); a driver never speaks it. The core is the one that pairs, holds the control link, applies the e-stop and the deadman, and forwards already-validated commands to a driver.</p></section>

<section class="card"><h2>The three connection kinds</h2>
<p>The robot's profile carries a <code>kind</code>, which says where the Node runs relative to the robot:</p>
<ul>
<li><b>on-board</b> (<code>kind: "onboard"</code>) — the Node runs on the robot itself, over its own GPIO/I²C bus. Example: ${out(`${TREE}/plugins/adeept_adr036`, 'adeept_adr036')} on a Raspberry Pi.</li>
<li><b>bridge</b> (<code>kind: "bridge"</code>) — the Node runs on a computer next to the robot and drives it over the robot's own link. Example: ${out(`${TREE}/plugins/cozmo`, 'cozmo')} through PyCozmo, where the computer joins the robot's Wi-Fi on one interface and the internet on another.</li>
<li><b>server-side</b> (<code>kind: "server"</code>) — there is no Node on the robot at all: Bot attaches the device itself from the server. Examples: the ${inLink('/docs/profiles', 'simulated rover')} and an ONVIF camera.</li>
</ul>
<p>The pairing's <code>device_kind</code> is <code>onboard</code> or <code>bridge</code>; a server-side robot is not installed on a machine.</p></section>

<section class="card"><h2>Lifecycle</h2>
<ol>
<li>The core starts the process and sends <code>hello</code>.</li>
<li>The driver answers <code>describe</code> <b>before touching any hardware</b>.</li>
<li>Unless <code>hello.probe</code> is true, the driver opens its hardware with every actuator stopped and sends <code>ready</code> (or <code>fault</code> if it cannot). Probe mode is used by <code>openvibe-node pair</code> and <code>openvibe-node plugins</code>: describe, then wait for EOF without opening anything.</li>
<li>The core sends <code>heartbeat</code> every 250 ms and commands as they arrive; the driver answers each command with <code>ack</code> or <code>nack</code>, and sends <code>telemetry</code>, <code>event</code> and <code>video</code> whenever it has them.</li>
<li>On shutdown the core sends <code>stop</code> and closes stdin; the driver stops everything and exits. After 2 s it is killed.</li>
</ol>
<p>A driver that exits is restarted with exponential backoff (1 s doubling to 30 s, reset after a minute of uptime). It starts stopped; if the e-stop or the local kill switch is latched, the core sends <code>estop</code> right after <code>hello</code>. A driver that does not describe itself within 15 s, or stops reading stdin, is killed.</p></section>

<section class="card"><h2>Messages</h2>
<p>Every message is one JSON object on one line with an <code>op</code> field. Command <code>value</code> has already been validated and clamped to the owner's limits by the core, and <code>deadline_ms</code> is relative to receipt and already capped.</p>
<h3>Core → driver</h3>
${message('hello', 'start-up: the driver answers describe; then sets up unless probe', '{ "op": "hello", "config": { "backend": "real" }, "probe": false }')}
${message('command', 'act, then answer ack or nack with the same id', '{ "op": "command", "id": "cmd_01J8Z4M2Q0R7T9YV3K6N8P1W2X", "kind": "drive", "value": { "throttle": 0.5, "steer": 0 }, "deadline_ms": 300 }')}
${message('heartbeat', 'the core clock; note the time for the deadman', '{ "op": "heartbeat", "t": 1728384000000 }')}
${message('stop', 'stop every actuator (idempotent, safe at any time)', '{ "op": "stop" }')}
${message('estop', 'stop every actuator and refuse motion until resume', '{ "op": "estop" }')}
${message('resume', 'accept motion again', '{ "op": "resume" }')}
<h3>Driver → core</h3>
${message('describe', 'the driver names itself and its capabilities, before hardware', '{ "op": "describe", "driver": "my_arm", "version": "0.1.0", "protocol": 1, "capabilities": { "actuator": { "names": ["shoulder", "gripper"] } }, "motion_kinds": ["drive", "actuator"] }')}
${message('ready', 'setup finished, every actuator stopped', '{ "op": "ready" }')}
${message('fault', 'the driver runs but cannot drive; commands get this code as nack', '{ "op": "fault", "fault_code": "hardware", "message": "gripper not responding" }')}
${message('ack', 'the command was carried out', '{ "op": "ack", "id": "cmd_01J8Z4M2Q0R7T9YV3K6N8P1W2X" }')}
${message('nack', 'the command was refused', '{ "op": "nack", "id": "cmd_01J8Z4M2Q0R7T9YV3K6N8P1W2X", "fault_code": "unsupported", "message": "only actuators" }')}
${message('telemetry', 'battery, signal and sensor readouts', '{ "op": "telemetry", "battery": { "volts": 7.4, "percent": 82 }, "rssi": -54, "sensors": { "distance_cm": 34 } }')}
${message('event', 'a discrete thing that happened', '{ "op": "event", "name": "cliff", "fields": { "side": "left" } }')}
${message('video', 'a frame written to a file; the core reads and encodes it', '{ "op": "video", "format": "jpeg", "path": "/run/frame-1.jpg", "width": 640, "height": 360, "seq": 1 }')}
<p class="muted"><code>video</code> writes each frame to a temporary name and renames it, so a slow reader never sees a partial file. Plugin events (<code>cliff</code>, <code>picked_up</code>, <code>low_battery</code>, …) travel as <code>event</code>. There is no separate event message type.</p></section>

<section class="card"><h2>Safety rules (requirements, not options)</h2>
<p>A driver <b>must stop every actuator itself</b>, because the core dying must never leave motors running:</p>
<ul>
<li>when its <b>stdin closes</b> (EOF), then exit;</li>
<li>when a <b>motion command's deadline passes</b> without a newer command (its own timer to <code>deadline_ms</code>);</li>
<li>when it has <b>not heard a heartbeat for 1 s</b> (and refuse motion with <code>no_heartbeat</code> until they return);</li>
<li>on <code>stop</code>, <code>estop</code> and a <code>halt</code> command;</li>
<li>when its own sensors say so (for example a cliff or a pick-up).</li>
</ul>
<p><code>stop</code> must be idempotent and safe at any time, including before setup. <code>estop</code> latches: keep refusing motion until the core sends <code>resume</code>. The e-stop is the owner's and is latched across reconnects by Bot; a driver never clears it. Handlers must not block — slow work (speech synthesis, file I/O) goes on a thread.</p></section>

<section class="card"><h2>A minimal driver in Python</h2>
<p>The Python runtime (<code>openvibe_plugin</code>, ${out(`${TREE}/plugins/sdk`, 'plugins/sdk')}) implements every safety rule above, so a driver only says how to move its hardware. <code>motion_kinds</code> is the set of kinds the runtime stops at their deadline.</p>
${code(`from openvibe_plugin import Fault, Plugin, clamp, run

class Arm(Plugin):
    driver, version = "my_arm", "0.1.0"
    motion_kinds = frozenset({"drive", "actuator"})   # stop these at their deadline

    def describe(self, config):
        return {"actuator": {"names": ["shoulder", "gripper"]}}

    def setup(self, config):
        self.bus = open_serial(config["port"])           # every actuator stopped when this returns

    def handle(self, cmd):
        if cmd.kind != "actuator":
            raise Fault("unsupported")
        self.bus.speed(cmd.value["name"], clamp(cmd.value.get("value"), -1, 1))

    def stop(self):
        if getattr(self, "bus", None):
            self.bus.stop_all()

if __name__ == "__main__":
    raise SystemExit(run(Arm()))`)}
<p class="muted">Test it with <code>openvibe_plugin.Runtime(plugin, infile, outfile, clock)</code> and a fake clock, as the bundled drivers do.</p></section>

<section class="card"><h2>The same driver in plain stdin/stdout</h2>
<p>Any language: read one JSON object per line, write one per line, and keep your own stop timers. This is the same arm, without the SDK.</p>
${code(`#!/usr/bin/env python3
import json, sys, threading, time

last = time.monotonic()          # when the last heartbeat (or fresh motion command) arrived
latched = False

def out(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()

def stop():
    pass                         # stop every actuator here: idempotent, safe even before setup

def watchdog():
    while True:
        time.sleep(0.1)
        if time.monotonic() - last > 1.0:   # the deadman: no heartbeat for 1 s → stop
            stop()

threading.Thread(target=watchdog, daemon=True).start()

for line in sys.stdin:                    # EOF means the core is gone: stop and exit
    m = json.loads(line)
    if m["op"] == "hello":
        out({"op": "describe", "driver": "my_arm", "version": "0.1.0", "protocol": 1,
             "capabilities": {"actuator": {"names": ["shoulder", "gripper"]}},
             "motion_kinds": ["drive", "actuator"]})
        if not m.get("probe"):
            out({"op": "ready"})          # open the bus with every actuator stopped, then say ready
    elif m["op"] == "command":
        if latched or m["kind"] != "actuator":
            out({"op": "nack", "id": m["id"], "fault_code": "unsupported", "message": "only actuators"})
            continue
        move(m["value"]["name"], m["value"].get("value"))   # clamp and set your own deadline_ms timer
        last = time.monotonic()
        out({"op": "ack", "id": m["id"]})
    elif m["op"] == "heartbeat":
        last = time.monotonic()
    elif m["op"] == "stop":
        stop()
    elif m["op"] == "estop":
        latched = True
        stop()
    elif m["op"] == "resume":
        latched = False
stop()`)}</section>

<section class="card"><h2>Test it</h2>
<p><b>With the <code>dryrun</code> driver</b> (${out(`${TREE}/plugins/dryrun`, 'plugins/dryrun')}): it accepts every kind, logs it, reports simulated battery and distance, and asks the core for the test-pattern camera. Add it to your <code>config.json</code> plugins and set <code>config.record: "&lt;path&gt;"</code> to append one JSON line per <code>setup</code>, <code>command</code> and <code>stop</code> — end-to-end tests read that file to check what reached the "robot".</p>
${code('{ "plugins": [ { "name": "dryrun", "config": { "record": "/tmp/dryrun.jsonl" } } ] }')}
<p><b>With the simulated rover</b> on this site: add a robot and pick the <b>Simulated rover</b> profile (${inLink('/robots', 'Your robots')}). Bot runs it in-process, so the panel renders from the profile and drives with no hardware and no Node. Use it to see exactly what your profile shows before wiring a driver.</p></section>

<section class="card"><h2>Contribute it</h2>
<p>Open a pull request to ${out(NODE, 'OpenVibers/OpenVibe.Node')} adding your driver under ${out(`${TREE}/plugins`, 'plugins/')}, with the robot profile it pairs with. The profile is validated by Bot's loader (<code>bot.robot-profile@1</code> plus the capability, driver, widget and command registries), and the driver is reviewed before it runs on anyone's Node. A genuinely new capability, driver or widget name is one line in Bot's registries — never a schema change.</p></section>
`;
    return docsPage({ config, path: '/docs/drivers', title: 'Write a driver', description: 'How to write a driver for the OpenVibe Node: JSON lines over stdio, the lifecycle, every message, the safety rules, a Python example and how to test it.', content });
}

// ── GET /docs/profiles · POST /docs/profiles/validate ─────────────────────────────────────────────

/** The validator's answer block: "valid", or the readable list of problems. */
function validationResult(result) {
    if (!result) return '';
    if (result.valid) {
        const p = result.profile || {};
        const widgets = Array.isArray(p.widgets) ? p.widgets.length : 0;
        return `<section class="card" aria-labelledby="result-h"><h2 id="result-h">Result</h2>
<p role="status"><strong>This profile is valid.</strong></p>
<p class="muted">id <code>${esc(p.id)}</code>, version <code>${esc(p.version)}</code>, ${widgets} widget${widgets === 1 ? '' : 's'}. It passes the same checks a shipped profile does: the <code>bot.robot-profile@1</code> contract and the loader's capability, driver, widget and command registries.</p></section>`;
    }
    const n = result.problems.length;
    return `<section class="card" aria-labelledby="result-h"><h2 id="result-h">Result</h2>
<div class="error" role="alert"><p><strong>This profile is not valid (${n} problem${n === 1 ? '' : 's'}):</strong></p>
<ul>${result.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></section>`;
}

function renderProfilesPage({ config, source = '', result = null } = {}) {
    const example = JSON.stringify(simRover, null, 2);
    const content = `
<h1>Robot profiles</h1>
<p class="muted">A robot profile (<code>bot.robot-profile@1</code>) is the contract between a robot and its panel. The panel is a function of the profile: a new robot needs a profile, not code. Profiles ship as <code>server/profiles/*.json</code>, are validated by the loader, and are served at ${inLink('/api/v1/profiles', 'GET /api/v1/profiles')}.</p>

<section class="card"><h2>Fields</h2>
<ul>
<li><code>id</code> — the profile's name, <code>^[a-z][a-z0-9._-]{1,63}$</code> (for example <code>sim.rover</code>).</li>
<li><code>version</code> — a positive integer; a new profile is a new version.</li>
<li><code>name</code> — what the owner sees. <code>vendor</code>, <code>description</code> — optional.</li>
<li><code>kind</code> — <code>onboard</code>, <code>bridge</code> or <code>server</code> (see ${inLink('/docs/drivers', 'Write a driver')}).</li>
<li><code>capabilities</code> — one or more of the registry: <code>drive.differential</code>, <code>drive.mecanum</code>, <code>servo.pan_tilt</code>, <code>head</code>, <code>lift</code>, <code>lights.rgb</code>, <code>lights.backpack</code>, <code>lights.cube</code>, <code>speaker.horn</code>, <code>speaker.say</code>, <code>display.text</code>, <code>sensor.ultrasonic</code>, <code>sensor.line</code>, <code>sensor.cliff</code>, <code>sensor.pickup</code>, <code>battery</code>, <code>ptz</code>, <code>camera</code>, <code>relay</code>. A typo is refused at load.</li>
<li><code>variants</code> — optional: one profile, several wheel layouts.</li>
<li><code>mapping</code> — <code>{ "driver": … }</code>, one of <code>pca9685</code>, <code>ads7830</code>, <code>cozmo</code>, <code>onvif</code>, <code>sim</code>, <code>relay</code>, plus the driver's own hardware map (addresses, channels).</li>
<li><code>commands</code> — what the driver accepts, keyed by kind: <code>drive</code> and <code>ptz</code> (<code>{ axes: { &lt;axis&gt;: [min, max] } }</code>), <code>actuator</code> (<code>{ names: { &lt;name&gt;: { type: number|rgb|tone|bool, … } } }</code>), <code>say</code>, <code>display</code>, <code>button</code> and <code>point</code>. Every profile also takes <code>halt</code>. The gate allows only the kinds declared here and builds every value from it.</li>
<li><code>widgets</code> — the panel, in order. Each is <code>{ type, capability?, label?, command? }</code>; types are <code>drive</code>, <code>pan-tilt</code>, <code>servo</code>, <code>lights</code>, <code>horn</code>, <code>speaker</code>, <code>display</code>, <code>telemetry</code>, <code>battery</code>, <code>latency</code>, <code>ptz</code>, <code>camera</code>, <code>head</code>, <code>lift</code>, <code>buttons</code>, <code>video_click</code>. A widget that sends commands names them in <code>command</code>, checked against <code>commands</code> at load.</li>
<li><code>camera</code> — optional: <code>{ transport: "whip"|"onvif"|"rtsp", resolution }</code>.</li>
<li><code>limits</code> — optional, with defaults: <code>max_speed</code> and <code>max_turn</code> (1), <code>max_command_ms</code> (300), <code>heartbeat_ms</code> (1000). Positive; the stricter of these and the server's own limits applies.</li>
</ul>
<p class="muted">The schema is <code>bot.robot-profile@1</code>; capability and widget names are open strings checked against the registries in <code>server/profiles/index.js</code>, so a new one is one line there, never a schema change.</p></section>

<section class="card"><h2>A full example</h2>
<p>The simulated rover (<code>sim.rover</code>), the profile the in-process simulator on this site runs:</p>
${code(example)}</section>

<section class="card"><h2>Validate a profile</h2>
<p>Paste a profile JSON. It is run through exactly the checks a shipped profile gets.</p>
<form method="post" action="/docs/profiles/validate">
<label class="field"><span class="field-label">Profile JSON</span>
<textarea name="profile" rows="14" spellcheck="false" autocomplete="off" placeholder="{ &quot;id&quot;: &quot;my.robot&quot;, ... }" required>${esc(source)}</textarea></label>
<button type="submit" class="primary">Validate</button>
</form>
<p class="muted">Tools can POST the profile as JSON to <code>/api/v1/profiles/validate</code> and read <code>{ valid, problems }</code> back.</p></section>

${validationResult(result)}
`;
    return docsPage({ config, path: '/docs/profiles', title: 'Robot profiles', description: 'The bot.robot-profile@1 format that turns a driver\'s capabilities into a panel, a full example, and a validator for your own profile.', content });
}

module.exports = { renderDocsIndex, renderDriversPage, renderProfilesPage, validationResult };
