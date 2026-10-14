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
 *   renderAutomationPage({ config })                  GET /docs/automation (routines, webhooks, the agent switch)
 *   renderComputersPage({ config })                   GET /docs/computers (the Node's computer plugin for your agents)
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

const PAGES = [['/docs', 'Overview'], ['/docs/drivers', 'Write a driver'], ['/docs/profiles', 'Robot profiles'], ['/docs/automation', 'Routines and webhooks'], ['/docs/computers', 'Your computer']];

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
<section class="card"><h2>Automate a robot</h2>
<p>${inLink('/docs/automation', 'Routines, webhooks and your agent')}: steps on a schedule, signed event deliveries to your server, and letting your OpenVibe.Actor agent drive.</p></section>
<section class="card"><h2>Your computer for your agents</h2>
<p>${inLink('/docs/computers', 'Your computer')}: the Node's computer plugin, its levels, approvals on the computer, and the API.</p></section>
<section class="card"><h2>Robots</h2>
<p>Add a robot and drive it from any browser. The <b>Simulated rover</b> runs inside Bot with no hardware, so you can see your profile's panel before anything is wired up.</p>
<p>${inLink('/robots', 'Your robots')} · ${inLink('/install', 'Install a device')}</p></section>
<h2>Where things live</h2>
<ul>
<li>The <b>OpenVibe Node</b> (${out(NODE, 'OpenVibers/OpenVibe.Node')}) is the agent on the robot's machine: it pairs, holds the control link, and runs the drivers.</li>
<li>Drivers are Node <b>plugins</b> (${out(`${TREE}/plugins`, 'plugins/')}), written against the Python runtime ${out(`${TREE}/plugins/sdk`, 'openvibe_plugin')} or any language over the raw protocol.</li>
<li>Bundled drivers: ${out(`${TREE}/plugins/dryrun`, 'dryrun')}, ${out(`${TREE}/plugins/adeept_adr036`, 'adeept_adr036')}, ${out(`${TREE}/plugins/cozmo`, 'cozmo')}, ${out(`${TREE}/plugins/relay`, 'relay')} and ${out(`${TREE}/plugins/ros2`, 'ros2')} (any ROS 2 robot on <code>cmd_vel</code>, through rosbridge or rclpy; profiles <code>ros2.diffdrive</code> and <code>ros2.holonomic</code>, installer <code>--driver ros2</code>). LOOI's driver is written by LOOI owners against the contract in ${out(`${TREE}/docs/hardware-looi.md`, 'docs/hardware-looi.md')} (profile <code>looi</code>, installer <code>--driver looi</code>).</li>
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
<p><code>stop</code> must be idempotent and safe at any time, including before setup. <code>estop</code> latches: keep refusing motion until the core sends <code>resume</code>. The e-stop is the owner's and is latched across reconnects by Bot; a driver never clears it.</p>
<p><b>A stop on the robot itself.</b> If your robot or bridge has its own stop (a button, a hotkey, a sensor you trust), send <code>{"op": "local_stop", "reason": "…"}</code> (Python: <code>self.local_stop("reason")</code>), or run <code>openvibe-node stop</code> from a terminal. That sets the Node's <i>local</i> latch: every actuator stops within a quarter second, the panel shows the robot as stopped on the robot, and the owner's remote clear cannot lift it. Only <code>openvibe-node resume</code> on that machine releases it, and the owner then clears the panel's e-stop. It works even when the Node is not answering and survives restarts. Handlers must not block — slow work (speech synthesis, file I/O) goes on a thread.</p></section>

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
<li><code>mapping</code> — <code>{ "driver": … }</code>, one of <code>pca9685</code>, <code>ads7830</code>, <code>cozmo</code>, <code>looi</code>, <code>onvif</code>, <code>sim</code>, <code>relay</code>, plus the driver's own hardware map (addresses, channels).</li>
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

// ── GET /docs/automation ──────────────────────────────────────────────────────────────────────────

const WEBHOOK_VERIFY = `const { verifyDeliveryV2 } = require('openvibe-sdk/events');

// Express, with the raw body: the signature covers the exact bytes Bot sent.
app.post('/robot-events', express.text({ type: 'application/json' }), (req, res) => {
    if (!verifyDeliveryV2(req.body, req.headers, process.env.ROBOT_WEBHOOK_SECRET)) return res.status(401).end();
    const event = JSON.parse(req.body);   // { id, type, robot_id, occurred_at, data }
    if (event.type === 'bot.estop.set') console.log('robot', event.robot_id, 'stopped');
    res.status(204).end();
});`;

const STEPS_CALL = `curl -X POST https://openvibe.bot/api/v1/robots/rob_…/steps \\
  -H "Authorization: Bearer $OPENVIBE_TOKEN" -H "Content-Type: application/json" \\
  -d '{"steps": "forward 1\\nleft 0.5\\nheadlights #00ff00\\nstop"}'
# → {"robot_id": "rob_…", "result": "done", "steps": 4}`;

function renderAutomationPage({ config }) {
    const content = `
<h1>Routines, webhooks and your agent</h1>
<p class="muted">A robot can move without anyone holding the controls, tell your own server what happened to it, and take orders from your OpenVibe.Actor agent. Every one of these goes through the same gate as a person at the panel: the robot's limits, cooldowns and e-stop apply, and the audit records each command.</p>

<section class="card" aria-labelledby="steps-h"><h2 id="steps-h">Steps</h2>
<p>Routines and the agent both speak in steps, one per line, checked against the robot's own profile. A robot takes only what it has:</p>
<ul>
<li><code>forward 2</code>, <code>back 1 0.4</code>, <code>left 0.5</code>, <code>right 0.5</code>: drive for that many seconds, at an optional speed (0–1); <code>stop</code>.</li>
<li><code>wait 1</code>: pause.</li>
<li><code>say Hello</code>, <code>face happy</code>, <code>show Hi</code>: speech, a face or text on its display.</li>
<li><code>headlights #ff8800</code>, <code>horn A4 0.3</code>, <code>lights off</code>, <code>pan 0.5 1</code>: an actuator or a camera axis by its name in the profile, with a value and how long to hold it.</li>
<li><code>press horn</code>: one of its buttons.</li>
</ul>
<p>A held step (a motion or a tone) is re-sent inside the device's deadman window and released at its end. A refused step (the e-stop, the robot going offline, a cooldown) stops the rest, with the reason.</p></section>

<section class="card" aria-labelledby="routines-h"><h2 id="routines-h">Routines</h2>
<p>On a robot's panel, under <b>Routines</b>, the owner names a routine, writes its steps and picks when it runs:</p>
<ul>
<li>when the owner presses Run;</li>
<li>every N minutes (at least 5);</li>
<li>daily at a UTC time, on chosen weekdays;</li>
<li>each time the robot comes online.</li>
</ul>
<p>A routine runs as the owner. One routine runs on a robot at a time; removing a running routine stops it. Limits: 60 steps, 60 seconds a step, 10 minutes in all. The same list is <code>GET|POST /api/v1/robots/:id/routines</code>, <code>POST …/routines/:rid/run</code> and <code>DELETE …/routines/:rid</code>, for the owner or a service with <code>bot.robot.manage</code>.</p></section>

<section class="card" aria-labelledby="hooks-h"><h2 id="hooks-h">Webhooks</h2>
<p>Under <b>Webhooks</b>, the owner adds up to five https addresses, each for some of the robot's events: <code>bot.robot.online</code>, <code>bot.robot.offline</code>, <code>bot.estop.set</code>, <code>bot.estop.cleared</code>, <code>bot.command.refused</code>. Each hook has its own secret (<code>whsec_…</code>), shown once when it is made.</p>
<p>Bot posts <code>{ id, type, robot_id, occurred_at, data }</code>, signed the way OpenVibe.Events signs a delivery (<code>X-OpenVibe-Timestamp</code>, <code>X-OpenVibe-Signature-V2</code>), only to public addresses, never following a redirect. Anything but a 2xx is retried after 30 seconds, then 2, 10, 30 and 120 minutes. Check the signature before trusting a delivery:</p>
${code(WEBHOOK_VERIFY)}
<p class="muted">The API is <code>GET|POST /api/v1/robots/:id/webhooks</code> (the POST answers the secret) and <code>DELETE …/webhooks/:hid</code>.</p></section>

<section class="card" aria-labelledby="agent-h"><h2 id="agent-h">Your agent</h2>
<p>On the panel, <b>Your agent</b> has one switch: <b>Let my OpenVibe.Actor agent drive this robot</b>. It is off until the owner turns it on. With it on, a task you give ${out('https://openvibe.actor', 'OpenVibe.Actor')}, such as "drive my rover forward for a second and turn its lights green", can see your robots (online, e-stop, battery, sensors) and run steps on this one, as you. It never acts for anyone else, and turning the switch off stops it at once.</p>
<p>Your own token runs steps directly, and answers when they end:</p>
${code(STEPS_CALL)}
<p class="muted"><code>GET /api/v1/robots/:id/steps</code> answers the robot's state and the step words it takes. A call takes at most 20 steps and 30 seconds; the agent's calls are refused with <code>403 bot.agent_not_allowed</code> while the switch is off.</p></section>
`;
    return docsPage({ config, path: '/docs/automation', title: 'Routines, webhooks and your agent', description: 'Make a robot run steps on a schedule, send its events to your server signed, and let your OpenVibe.Actor agent drive it, all through the same gate.', content });
}


// ── GET /docs/computers ────────────────────────────────────────────────────────────────────────────

const COMPUTER_INSTALL = `curl -fsSL https://openvibe.bot/install | sh -s -- \\
  --network https://openvibe.network --pairing pair_… --code ABCD-1234 --computer ask`;
const COMPUTER_APPROVE = `openvibe-node approvals          # what waits: id, kind, what it would do
openvibe-node approve cmd_01J…   # let it run
openvibe-node deny cmd_01J…      # refuse it
openvibe-node stop               # the kill switch: observe only until resume`;
const COMPUTER_CALL = `curl -X POST https://openvibe.bot/api/v1/machines/dev_…/commands \\
  -H "Authorization: Bearer $OPENVIBE_TOKEN" -H "Content-Type: application/json" \\
  -d '{"kind": "exec", "value": {"argv": ["git", "status", "--short"], "cwd": "/home/you/site"}}'
# → {"machine_id": "dev_…", "result": "ack", "data": {"exit_code": 0, "stdout": " M index.html\\n", …}}`;

function renderComputersPage({ config }) {
    const content = `
<h1>Your computer for your agents</h1>
<p class="muted">The OpenVibe Node's <b>computer</b> plugin lets your agents use your own computer: its terminal, its files and its screen. It is off unless you install it, it never runs as root, and you decide what it may do on the computer itself. Nothing on OpenVibe can raise that level.</p>

<section class="card" aria-labelledby="install-h"><h2 id="install-h">Install it</h2>
<p>On ${inLink('/machines', 'Your machines')}, choose <b>Add a machine</b> and run the second command it shows on the computer, from your own account (the installer uses sudo itself):</p>
${code(COMPUTER_INSTALL)}
<p>The Node then runs as you, never as root, and its only folder is your home folder. Linux for now; elsewhere, run the Node in your own session with the plugin in its config (${out(`${BLOB}/docs/computer.md`, 'computer.md')}).</p></section>

<section class="card" aria-labelledby="levels-h"><h2 id="levels-h">Levels, set on the computer</h2>
<ul>
<li><b>observe</b> (the default): take a screenshot; list, inspect and read files inside its folders.</li>
<li><b>ask</b>: also run programs and write files there, each only after you approve it on the computer.</li>
<li><b>trusted</b>: run programs and write files inside its folders without asking.</li>
<li><b>full</b>: as trusted, anywhere your account can reach.</li>
</ul>
<p>A program is always a program and its arguments, never a shell line. It runs for at most the time you set (30 seconds by default), at most two at once, and its output is cut at 64 KB. A path is checked after links are followed, so a link out of a folder is outside it.</p></section>

<section class="card" aria-labelledby="approve-h"><h2 id="approve-h">Approving on the computer</h2>
<p>At level <b>ask</b>, a request waits up to two minutes for your answer, with a desktop notification when the Node runs in your session:</p>
${code(COMPUTER_APPROVE)}
<p>The local stop drops the computer to observe at once: what runs is killed, what waits is denied, and nothing runs or changes until you resume.</p></section>

<section class="card" aria-labelledby="agent-c-h"><h2 id="agent-c-h">Your agent</h2>
<p>On ${inLink('/machines', 'Your machines')}, <b>Let my agent use this computer</b> is off until you turn it on. With it on, a task you give ${out('https://openvibe.actor', 'OpenVibe.Actor')}, such as "what changed in ~/site today?", can list and read files, run programs and write files there, as you and at your level. The ${out('https://openvibe.actor/console', 'Console')} shows what waits for you. Turning the switch off stops it at once.</p>
<p><b>Let my watches check things from this computer</b> is a separate switch. It lets ${out('https://openvibe.watch', 'OpenVibe.Watch')} probe your own network from the computer for your watches, for example "tell me when my NAS stops answering". It allows only probes: one GET or one TCP connect, to private addresses only.</p></section>

<section class="card" aria-labelledby="api-c-h"><h2 id="api-c-h">The API</h2>
<p>Your own token reaches your own computers. The answer comes back in <code>data</code>:</p>
${code(COMPUTER_CALL)}
<ul>
<li><code>exec</code>: <code>argv</code>, <code>cwd</code>, <code>timeout_s</code>, <code>stdin</code> → <code>exit_code</code>, <code>stdout</code>, <code>stderr</code>, <code>truncated</code>, <code>timed_out</code>.</li>
<li><code>fs</code>: <code>op</code> list, stat, read (<code>offset</code>, <code>length</code>), write (<code>content_b64</code>, <code>mode</code> create, overwrite or append) or mkdir, and an absolute <code>path</code>.</li>
<li><code>screen</code>: <code>max_width</code> → a JPEG in <code>content_b64</code>.</li>
<li><code>probe</code>: <code>target</code> (<code>http(s)://…</code> or <code>tcp://host:port</code> on the computer's own network) → the status and body of one GET, or whether the port is open. It is read-only and runs at every level.</li>
</ul>
<p class="muted"><code>GET /api/v1/machines</code> lists your machines with their level. A machine whose plugin is off answers <code>409 bot.computer_off</code>; a refusal on the computer answers <code>result: "nack"</code> with the reason. The audit keeps the program name or the file and path, never its content.</p></section>
`;
    return docsPage({ config, path: '/docs/computers', title: 'Your computer for your agents', description: 'Let your agents use your own computer through the OpenVibe Node: its terminal, files and screen, at the level you set on the computer, with approvals there and a kill switch.', content });
}

module.exports = { renderDocsIndex, renderDriversPage, renderProfilesPage, renderAutomationPage, renderComputersPage, validationResult };
