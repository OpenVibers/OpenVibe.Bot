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
 *     widgets: [{ type: "drive", capability: …, label: … }],  // types in WIDGETS
 *     camera: { transport: "whip|onvif|rtsp", resolution },
 *     limits: { max_speed, max_turn, max_command_ms, heartbeat_ms } }
 */
const fs = require('fs');
const path = require('path');
const { BotError } = require('../util');

const DIR = path.join(__dirname);

/** Every capability a profile may declare. A profile that names anything else is refused at load. */
const CAPABILITIES = new Set([
    'drive.differential', 'drive.mecanum',
    'servo.pan_tilt', 'head', 'lift',
    'lights.rgb', 'lights.backpack', 'lights.cube',
    'speaker.horn', 'speaker.say',
    'display.text', 'display.animation',
    'sensor.ultrasonic', 'sensor.line', 'sensor.cliff', 'sensor.pickup',
    'battery', 'ptz', 'camera',
]);

/** Panel widget types (open in the profile, closed in code: a new widget is a new entry here). */
const WIDGETS = new Set(['drive', 'pan-tilt', 'servo', 'lights', 'horn', 'speaker', 'display', 'telemetry', 'battery', 'latency', 'ptz', 'camera', 'head', 'lift']);

/** Device drivers a mapping may name. */
const DRIVERS = new Set(['pca9685', 'ads7830', 'cozmo', 'onvif', 'sim']);

const ID_RE = /^[a-z][a-z0-9._-]{1,63}$/;
const KINDS = new Set(['onboard', 'bridge', 'server']);
const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);

function bad(why) { throw new BotError(500, 'bot.profile_invalid', why); }

/** Validate one profile, filling the limit defaults (max_command_ms 300, heartbeat_ms 1000). */
function validateProfile(p) {
    if (!p || typeof p !== 'object') bad('a profile must be an object');
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) bad(`profile id is not valid: ${p.id}`);
    if (!int(p.version) || p.version < 1) bad(`${p.id}: version must be a positive integer`);
    if (typeof p.name !== 'string' || !p.name.trim()) bad(`${p.id}: name is required`);
    if (p.kind != null && !KINDS.has(p.kind)) bad(`${p.id}: kind must be one of onboard, bridge, server`);
    if (!Array.isArray(p.capabilities) || !p.capabilities.length) bad(`${p.id}: capabilities must be a non-empty array`);
    for (const c of p.capabilities) if (!CAPABILITIES.has(c)) bad(`${p.id}: unknown capability ${c}`);
    if (!Array.isArray(p.widgets) || !p.widgets.length) bad(`${p.id}: widgets must be a non-empty array`);
    for (const w of p.widgets) {
        if (!w || typeof w.type !== 'string' || !WIDGETS.has(w.type)) bad(`${p.id}: unknown widget type ${w && w.type}`);
        if (w.capability != null && !CAPABILITIES.has(w.capability)) bad(`${p.id}: widget ${w.type} binds unknown capability ${w.capability}`);
        if (w.label != null && (typeof w.label !== 'string' || w.label.length > 60)) bad(`${p.id}: widget ${w.type} label is invalid`);
    }
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
    return {
        id: p.id, version: p.version, name: p.name.trim(), vendor: p.vendor || null, kind: p.kind || null,
        description: p.description || null, capabilities: [...p.capabilities], variants: p.variants || null,
        mapping: p.mapping, widgets: p.widgets.slice(), camera: p.camera || null, limits,
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
    return db.many('SELECT DISTINCT ON (id) id, version, profile FROM robot_profiles ORDER BY id, version DESC');
}

module.exports = { validateProfile, loadProfiles, seedProfiles, getProfile, listProfiles, CAPABILITIES, WIDGETS, DRIVERS };
