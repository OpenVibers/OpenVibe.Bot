'use strict';

/**
 * Robot profiles (ADR-043 decision 7): the panel is a function of the profile, and a new robot needs a
 * profile, not code. Profiles live as server/profiles/*.json and are validated here before they are
 * seeded into robot_profiles; the panel and the gate read them from there.
 *
 * Capability and widget names are open strings, but they are checked against the registries below, so a
 * typo is refused at load and a genuinely new capability means one line here — never a schema change.
 *
 * Profile shape (bot.robot-profile@1):
 *   { id, version, name, vendor, kind,
 *     capabilities: ["drive.differential", …],      // in CAPABILITIES
 *     variants: { differential: { drive: … }, … },  // optional: one profile, several wheel layouts
 *     mapping: { driver: "pca9685", … },            // driver + the hardware mapping (addresses, channels)
 *     commands: { drive: { axes: { throttle: [-1, 1], … } }, … },  // what the device accepts (COMMAND_SCHEMAS)
 *     widgets: [{ type: "drive", capability: …, label: …, command: { kind: "drive" } }],  // types in WIDGETS
 *     camera: { transport: "whip|onvif|rtsp", resolution },
 *     limits: { max_speed, max_turn, max_command_ms, heartbeat_ms } }
 *
 * `commands` is the contract with the device's plugin: the gate allows only the kinds declared there
 * (plus `halt`, which every profile takes) and builds every value from it, so a panel control can only
 * send a name, shape and range the plugin accepts. A widget that sends commands names them in `command`
 * ({ kind } or, for actuators, { kind: "actuator", names: [...] }), checked against `commands` at load.
 */
const fs = require('fs');
const path = require('path');
const { BotError } = require('../util');
const { validate } = require('openvibe-contracts');

const DIR = path.join(__dirname);

/** Every capability a profile may declare. A profile that names anything else is refused at load. */
const CAPABILITIES = new Set([
    'drive.differential', 'drive.mecanum',
    'servo.pan_tilt', 'head', 'lift',
    'lights.rgb', 'lights.backpack', 'lights.cube',
    'speaker.horn', 'speaker.say',
    'display.text',
    'sensor.ultrasonic', 'sensor.line', 'sensor.cliff', 'sensor.pickup',
    'battery', 'ptz', 'camera',
    // A robot that carries no hardware of its own: the owner's Node forwards the panel's commands to a
    // local script with the relay plugin (relay.generic, plan T15 R9).
    'relay',
]);

/** Panel widget types (open in the profile, closed in code: a new widget is a new entry here). */
const WIDGETS = new Set(['drive', 'pan-tilt', 'servo', 'lights', 'horn', 'speaker', 'display', 'telemetry', 'battery', 'latency', 'ptz', 'camera', 'head', 'lift', 'buttons', 'video_click']);

/** Device drivers a mapping may name. `relay` is a Node plugin with no hardware map of its own. */
const DRIVERS = new Set(['pca9685', 'ads7830', 'cozmo', 'onvif', 'sim', 'relay']);

const ID_RE = /^[a-z][a-z0-9._-]{1,63}$/;
const KINDS = new Set(['onboard', 'bridge', 'server']);
const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isRange = (r) => Array.isArray(r) && r.length === 2 && number(r[0]) != null && number(r[1]) != null && r[0] < r[1];

function bad(why) { throw new BotError(500, 'bot.profile_invalid', why); }

/**
 * The per-kind schema of `commands` (what each kind's value may be):
 *   drive     { axes: { <axis>: [min, max] } }    axes: throttle, steer (differential) or x, y, rotation (holonomic)
 *   ptz       { axes: { <axis>: [min, max] } }    axes: pan, tilt, zoom
 *   actuator  { names: { <name>: { type, … } } }  number { range: [min, max] }, rgb { count? } ({r,g,b} 0–255,
 *                                                 `index` < count when given), tone { hz: [min, max] }, bool
 *   say       { max_chars }
 *   display   { modes: [text|face|image_png_b64], faces: [...] (with face), max_chars }
 *   halt      {}                                  every profile takes it; the gate never refuses it for the e-stop
 */
const AXES = { drive: new Set(['throttle', 'steer', 'x', 'y', 'rotation']), ptz: new Set(['pan', 'tilt', 'zoom']) };
const ACTUATOR_TYPES = new Set(['number', 'rgb', 'tone', 'bool']);
const DISPLAY_MODES = new Set(['text', 'face', 'image_png_b64']);
const COMMAND_KINDS = new Set(['drive', 'actuator', 'ptz', 'say', 'display', 'halt', 'button', 'point']);
const NAME_RE = /^[a-z][a-z0-9_]{0,23}$/;
const BUTTON_RE = /^[a-z][a-z0-9_]{0,31}$/;

function validateAxes(where, axes, allowed) {
    if (!isObject(axes) || !Object.keys(axes).length) bad(`${where}.axes must name at least one axis`);
    const out = {};
    for (const [axis, range] of Object.entries(axes)) {
        if (!allowed.has(axis)) bad(`${where}: unknown axis ${axis} (one of ${[...allowed].join(', ')})`);
        if (!isRange(range)) bad(`${where}.axes.${axis} must be [min, max]`);
        out[axis] = [range[0], range[1]];
    }
    return { axes: out };
}

function validateActuator(where, a) {
    if (!isObject(a) || !ACTUATOR_TYPES.has(a.type)) bad(`${where}.type must be one of ${[...ACTUATOR_TYPES].join(', ')}`);
    if (a.type === 'number') {
        if (!isRange(a.range)) bad(`${where}.range must be [min, max]`);
        return { type: 'number', range: [a.range[0], a.range[1]] };
    }
    if (a.type === 'rgb') {
        if (a.count != null && !(int(a.count) > 0)) bad(`${where}.count must be a positive integer`);
        return a.count != null ? { type: 'rgb', count: a.count } : { type: 'rgb' };
    }
    if (a.type === 'tone') {
        if (!isRange(a.hz) || !(a.hz[0] > 0)) bad(`${where}.hz must be [min, max] above 0`);
        return { type: 'tone', hz: [a.hz[0], a.hz[1]] };
    }
    return { type: 'bool' };
}

/** `commands`, checked kind by kind against the schema above; `halt` is always added. */
function validateCommands(id, commands) {
    if (commands != null && !isObject(commands)) bad(`${id}: commands must be an object keyed by command kind`);
    const out = {};
    for (const [kind, spec] of Object.entries(commands || {})) {
        const where = `${id}: commands.${kind}`;
        if (!COMMAND_KINDS.has(kind)) bad(`${id}: unknown command kind ${kind}`);
        if (!isObject(spec)) bad(`${where} must be an object`);
        if (kind === 'drive' || kind === 'ptz') out[kind] = validateAxes(where, spec.axes, AXES[kind]);
        else if (kind === 'actuator') {
            if (!isObject(spec.names) || !Object.keys(spec.names).length) bad(`${where}.names must name at least one actuator`);
            const names = {};
            for (const [name, a] of Object.entries(spec.names)) {
                if (!NAME_RE.test(name)) bad(`${where}: actuator name ${name} is not valid`);
                names[name] = validateActuator(`${where}.names.${name}`, a);
            }
            out.actuator = { names };
        } else if (kind === 'say') {
            if (spec.max_chars != null && !(int(spec.max_chars) > 0)) bad(`${where}.max_chars must be a positive integer`);
            out.say = { max_chars: spec.max_chars || 200 };
        } else if (kind === 'display') {
            if (!Array.isArray(spec.modes) || !spec.modes.length) bad(`${where}.modes must be a non-empty array`);
            for (const m of spec.modes) if (!DISPLAY_MODES.has(m)) bad(`${where}: unknown display mode ${m} (one of ${[...DISPLAY_MODES].join(', ')})`);
            if (spec.max_chars != null && !(int(spec.max_chars) > 0)) bad(`${where}.max_chars must be a positive integer`);
            const d = { modes: [...new Set(spec.modes)], max_chars: spec.max_chars || 200 };
            if (d.modes.includes('face')) {
                if (!Array.isArray(spec.faces) || !spec.faces.length || !spec.faces.every((f) => typeof f === 'string' && NAME_RE.test(f))) bad(`${where}.faces must list the face names`);
                d.faces = spec.faces.slice();
            }
            out.display = d;
        } else if (kind === 'button') {
            if (!isObject(spec.names) || !Object.keys(spec.names).length) bad(`${where}.names must name at least one button`);
            const names = {};
            for (const [name, button] of Object.entries(spec.names)) {
                if (!BUTTON_RE.test(name)) bad(`${where}: button name ${name} is not valid`);
                if (!isObject(button) || typeof button.label !== 'string' || !button.label.trim() || button.label.length > 40) bad(`${where}.names.${name}.label is invalid`);
                if (button.key != null && (typeof button.key !== 'string' || button.key.length > 16)) bad(`${where}.names.${name}.key is invalid`);
                if (button.cooldown_ms != null && !(int(button.cooldown_ms) >= 0)) bad(`${where}.names.${name}.cooldown_ms is invalid`);
                if (button.hold != null && typeof button.hold !== 'boolean') bad(`${where}.names.${name}.hold is invalid`);
                names[name] = { label: button.label, ...(button.key ? { key: button.key } : {}),
                    ...(button.cooldown_ms != null ? { cooldown_ms: button.cooldown_ms } : {}), ...(button.hold ? { hold: true } : {}) };
            }
            out.button = { names };
        } else if (kind === 'point') {
            if (spec.cooldown_ms != null && !(int(spec.cooldown_ms) >= 0)) bad(`${where}.cooldown_ms is invalid`);
            out.point = spec.cooldown_ms != null ? { cooldown_ms: spec.cooldown_ms } : {};
        } else if (Object.keys(spec).length) bad(`${where} takes no options`);
    }
    out.halt = {};
    return out;
}

/** A widget's `command`: a declared kind, and for an actuator the declared names it drives. */
function validateWidgetCommand(id, w, commands) {
    const c = w.command;
    const where = `${id}: widget ${w.type}`;
    if (!isObject(c) || !commands[c.kind]) bad(`${where} sends ${c && c.kind}, which commands does not declare`);
    if (c.kind !== 'actuator') {
        if (c.names != null) bad(`${where}: only an actuator command names actuators`);
        return { kind: c.kind };
    }
    if (!Array.isArray(c.names) || !c.names.length) bad(`${where}: an actuator command lists its names`);
    for (const n of c.names) if (!Object.prototype.hasOwnProperty.call(commands.actuator.names, n)) bad(`${where} drives actuator ${n}, which commands does not declare`);
    return { kind: 'actuator', names: c.names.slice() };
}

/** Validate one profile, filling the limit defaults (max_command_ms 300, heartbeat_ms 1000). */
function validateProfile(p) {
    if (!p || typeof p !== 'object') bad('a profile must be an object');
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) bad(`profile id is not valid: ${p.id}`);
    if (!int(p.version) || p.version < 1) bad(`${p.id}: version must be a positive integer`);
    if (typeof p.name !== 'string' || !p.name.trim()) bad(`${p.id}: name is required`);
    if (p.kind != null && !KINDS.has(p.kind)) bad(`${p.id}: kind must be one of onboard, bridge, server`);
    if (!Array.isArray(p.capabilities) || !p.capabilities.length) bad(`${p.id}: capabilities must be a non-empty array`);
    for (const c of p.capabilities) if (!CAPABILITIES.has(c)) bad(`${p.id}: unknown capability ${c}`);
    const commands = validateCommands(p.id, p.commands);
    if (!Array.isArray(p.widgets) || !p.widgets.length) bad(`${p.id}: widgets must be a non-empty array`);
    const widgets = p.widgets.map((w) => {
        if (!w || typeof w.type !== 'string' || !WIDGETS.has(w.type)) bad(`${p.id}: unknown widget type ${w && w.type}`);
        if (w.capability != null && !CAPABILITIES.has(w.capability)) bad(`${p.id}: widget ${w.type} binds unknown capability ${w.capability}`);
        if (w.label != null && (typeof w.label !== 'string' || w.label.length > 60)) bad(`${p.id}: widget ${w.type} label is invalid`);
        return w.command != null ? { ...w, command: validateWidgetCommand(p.id, w, commands) } : { ...w };
    });
    if (!p.mapping || typeof p.mapping !== 'object' || !DRIVERS.has(p.mapping.driver)) bad(`${p.id}: mapping.driver must be one of ${[...DRIVERS].join(', ')}`);
    const l = p.limits && typeof p.limits === 'object' ? p.limits : {};
    const limits = {
        max_speed: number(l.max_speed) != null ? number(l.max_speed) : 1,
        max_turn: number(l.max_turn) != null ? number(l.max_turn) : 1,
        max_command_ms: int(l.max_command_ms) != null ? l.max_command_ms : 300,
        heartbeat_ms: int(l.heartbeat_ms) != null ? l.heartbeat_ms : 1000,
    };
    if (!(limits.max_speed > 0) || !(limits.max_turn > 0)) bad(`${p.id}: max_speed and max_turn must be positive`);
    if (!(limits.max_command_ms > 0) || !(limits.heartbeat_ms > 0)) bad(`${p.id}: max_command_ms and heartbeat_ms must be positive`);
    const contract = validate('bot.robot-profile@1', p);
    if (!contract.valid) bad(`bot.robot-profile@1: ${JSON.stringify(contract.errors)}`);
    return {
        id: p.id, version: p.version, name: p.name.trim(), vendor: p.vendor || null, kind: p.kind || null,
        description: p.description || null, capabilities: [...p.capabilities], variants: p.variants || null,
        mapping: p.mapping, commands, widgets, camera: p.camera || null, limits,
    };
}

/** Every profile in server/profiles/*.json, validated. Throws on the first invalid file (a broken ship). */
function loadProfiles(dir = DIR) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const out = new Map();
    for (const f of files) {
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { bad(`${f}: ${e.message}`); }
        const profile = validateProfile(raw);
        out.set(profile.id, profile);
    }
    if (!out.size) bad('no profiles found');
    return out;
}

/** Seed (idempotently) the shipped profiles into robot_profiles. */
async function seedProfiles(db, { now = () => Date.now(), log = console } = {}) {
    const profiles = loadProfiles();
    for (const p of profiles.values()) {
        await db.query(
            `INSERT INTO robot_profiles (id, version, profile, created_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (id, version) DO UPDATE SET profile = EXCLUDED.profile`,
            [p.id, p.version, JSON.stringify(p), new Date(now()).toISOString()],
        );
    }
    log.log(`[Bot] ${profiles.size} profiles seeded: ${[...profiles.keys()].join(', ')}`);
    return profiles;
}

/** The profile as the API and the panel present it (the same JSON that was validated). */
async function getProfile(db, id, version = null) {
    const row = version
        ? await db.maybe('SELECT id, version, profile FROM robot_profiles WHERE id = $1 AND version = $2', [id, version])
        : await db.maybe('SELECT id, version, profile FROM robot_profiles WHERE id = $1 ORDER BY version DESC LIMIT 1', [id]);
    return row || null;
}

async function listProfiles(db) {
    return db.many('SELECT DISTINCT ON (id) id, version, profile FROM robot_profiles WHERE robot_id IS NULL ORDER BY id, version DESC');
}

module.exports = { validateProfile, loadProfiles, seedProfiles, getProfile, listProfiles, CAPABILITIES, WIDGETS, DRIVERS, COMMAND_KINDS };
