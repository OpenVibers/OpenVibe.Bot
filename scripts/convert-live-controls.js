#!/usr/bin/env node
'use strict';

/**
 * One-time conversion of OpenVibe.Live's stream controls into Bot robots (plan T15 R9 step 5).
 *
 *   scripts/live-controls-export.sh <Live SQLite> > export.json        (on the Live host, read-only)
 *   node scripts/convert-live-controls.js --input export.json          (dry run: prints the plan)
 *   node scripts/convert-live-controls.js --input export.json --apply  (writes robots through the domain)
 *
 * For each Live control_configs row: a robot owned by the owner's Network subject (Live users →
 * linked_accounts/ subject_projection), a robot-local profile built from its buttons, and the channel's
 * whitelisted users as operators. Where the owner's most recent stream's copy of the buttons overrides a
 * label, command or cooldown, the override wins. Everything the run cannot convert is reported with the
 * reason, and an owner with no Network subject is skipped (they must sign in to Network once first).
 *
 * Idempotent on the Live config id: live_conversions (migration 0007) records each converted config, so a
 * second --apply changes nothing and reports "already converted". The robots are always written through the
 * domain layer (createRobot / saveLocalProfile / members.add), never raw SQL, so every validation holds.
 *
 * A Bot button name must match ^[a-z][a-z0-9_]{0,31}$ and is not Live's command string (which is what the
 * owner's script understands). Each button's Live command is kept in the live_conversions detail and in the
 * robot's audit, as a command → name map, so the relay plugin can map a panel button back.
 */
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_LABEL = 40;
// The panel's drive and stop keys: a converted Live key that is one of these is dropped (server/domain).
const RESERVED_KEYS = new Set(['space', ' ', 'escape', 'w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    'keyw', 'keya', 'keys', 'keyd', 'keyq', 'keye']);
const RELAY_PROFILE = 'relay.generic';

// ── The plan (pure: built from the export document alone; no database, no writes) ────────────────
const asArray = (v) => (Array.isArray(v) ? v : []);
const strOr = (v, d = '') => (typeof v === 'string' ? v : d);

/** Live's command string → a Bot button name: lowercase, every run of other characters becomes `_`. */
function normaliseName(command) {
    const s = String(command == null ? '' : command).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
    if (!s) return null;
    const cut = s.length > 32 ? s.slice(0, 32).replace(/_+$/, '') : s;
    return NAME_RE.test(cut) ? cut : null;
}

/** A unique name among `used`, suffixing _2, _3, … within the 32-character budget. */
function uniqueName(name, used) {
    if (!used.has(name)) return name;
    for (let n = 2; ; n++) {
        const suffix = `_${n}`;
        const candidate = `${name.slice(0, 32 - suffix.length).replace(/_+$/, '')}${suffix}`;
        if (!used.has(candidate)) return candidate;
    }
}

/** The label: trimmed, never empty, at most 40 characters (truncated, with a note). */
function labelFor(raw, fallback, notes) {
    let label = String(raw == null ? '' : raw).trim();
    if (!label) { label = String(fallback || '').trim(); if (label) notes.push(`label was empty; used ${JSON.stringify(label.slice(0, MAX_LABEL))}`); }
    if (!label) { label = 'Button'; notes.push('label was empty; used "Button"'); }
    if (label.length > MAX_LABEL) { notes.push(`label truncated to ${MAX_LABEL} characters`); label = label.slice(0, MAX_LABEL); }
    return label;
}

/** The Live key, kept as-is unless Bot's panel reserves it (drive/stop) or it is too long. */
function keyFor(raw, notes) {
    const key = String(raw == null ? '' : raw).trim();
    if (!key) return null;
    if (RESERVED_KEYS.has(key.toLowerCase())) { notes.push(`key ${JSON.stringify(key)} dropped: the panel drives and stops with it`); return null; }
    if (key.length > 16) { notes.push(`key ${JSON.stringify(key)} dropped: at most 16 characters`); return null; }
    return key;
}

const cooldownFor = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * One Live button (possibly the stream's overridden copy) → a Bot button, or a drop with the reason.
 * `overridden` names the fields the stream copy changed (for the plan's report).
 */
function convertButton({ button, stream, notes, overridden }) {
    const command = strOr(stream ? stream.command : button.command).trim();
    const type = strOr(stream ? stream.control_type : button.control_type, 'button') || 'button';
    if (type === 'onvif') return { dropped: { command, label: strOr(button.label), reason: 'an ONVIF control: ONVIF moves go to Bot\'s server-side camera (camera.onvif), not a relay button' } };
    const raw = normaliseName(command);
    if (!raw) return { dropped: { command, label: strOr(button.label), reason: 'no button name can be made from this command' } };
    const hold = type === 'keyboard';
    const out = {
        command, name: raw, hold,
        label: labelFor(stream ? stream.label : button.label, command, notes),
        key: keyFor(stream ? stream.key_binding : button.key_binding, notes),
        cooldown_ms: cooldownFor(stream ? stream.cooldown_ms : button.cooldown_ms),
    };
    if (!hold && type !== 'button') notes.push(`Live type ${JSON.stringify(type)} converted as a plain button`);
    if (overridden.length) notes.push(`the latest stream overrides ${overridden.join(', ')}; the override wins`);
    return { button: out };
}

/**
 * Build the plan from an export document. Pure: no I/O. Returns { exported_at, configs: [...], summary },
 * each config carrying its robot, its buttons (name, label, command, key, cooldown_ms, hold), the drops
 * with their reasons, its operators and the Live command → Bot name map.
 */
function buildPlan(doc) {
    const configs = asArray(doc.configs);
    const buttons = asArray(doc.buttons);
    const whitelist = asArray(doc.whitelist);
    const streams = asArray(doc.latest_stream_controls);
    const owners = new Map(asArray(doc.owners).map((o) => [o.id, o]));
    const subjectOf = (userId) => { const o = owners.get(userId); return o && o.subject_id ? o.subject_id : null; };

    const plan = [];
    for (const config of configs) {
        const owner = owners.get(config.user_id) || null;
        const cfg = {
            live_config_id: config.id, live_name: strOr(config.name),
            owner: owner ? { id: owner.id, username: owner.username || null, subject_id: owner.subject_id || null } : { id: config.user_id, username: null, subject_id: null },
            robot: null, buttons: [], dropped: [], overrides: [], operators: [], skipped_operators: [], notes: [],
            command_to_name: {}, name_to_command: {}, status: 'convert',
        };

        const ownerSubject = owner && owner.subject_id;
        if (!ownerSubject) {
            cfg.status = 'owner_unlinked';
            cfg.reason = owner ? `Live user ${owner.id} (${owner.username || 'unknown'}) has no Network subject: they must sign in to Network once` : `no row for Live user ${config.user_id}`;
            plan.push(cfg);
            continue;
        }
        cfg.robot = { name: `${owner.username || ownerSubject}'s controls`, profile_id: RELAY_PROFILE, access_policy: 'private' };

        const mine = buttons.filter((b) => b.config_id === config.id);
        const enabled = mine.filter((b) => b.is_enabled === undefined || Number(b.is_enabled) !== 0);
        for (const b of mine) if (!enabled.includes(b)) cfg.dropped.push({ command: strOr(b.command), label: strOr(b.label), reason: 'disabled in Live (is_enabled 0)' });

        // The owner's most recent stream, and whether its copy of the buttons belongs to this config.
        const ownerStreams = streams.filter((s) => s.owner_user_id === config.user_id);
        const boundElsewhere = ownerStreams.length && ownerStreams[0].stream_config_id != null && ownerStreams[0].stream_config_id !== config.id;
        let copies = [];
        if (boundElsewhere) {
            cfg.notes.push(`the latest stream (id ${ownerStreams[0].stream_id}) uses Live config ${ownerStreams[0].stream_config_id}, so its overrides do not apply here`);
        } else {
            copies = ownerStreams.filter((s) => s.stream_config_id == null || s.stream_config_id === config.id)
                .slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
        }

        const used = new Set();
        enabled.forEach((button, i) => {
            const stream = copies[i] || null;
            const notes = [];
            const overridden = stream ? ['label', 'command', 'cooldown_ms'].filter((f) => {
                const a = f === 'cooldown_ms' ? cooldownFor(button[f]) : (button[f] == null ? null : String(button[f]));
                const b = f === 'cooldown_ms' ? cooldownFor(stream[f]) : (stream[f] == null ? null : String(stream[f]));
                return a !== b;
            }) : [];
            const r = convertButton({ button, stream, notes, overridden });
            if (r.dropped) { cfg.dropped.push(r.dropped); return; }
            const b = r.button;
            b.name = uniqueName(b.name, used);
            used.add(b.name);
            if (overridden.length) cfg.overrides.push({ name: b.name, command: b.command, fields: overridden });
            cfg.command_to_name[b.command] = b.name;
            cfg.name_to_command[b.name] = b.command;
            cfg.buttons.push({ ...b, notes });
        });
        for (const extra of copies.slice(enabled.length)) {
            cfg.dropped.push({ command: strOr(extra.command), label: strOr(extra.label), reason: 'on the stream but not in the config' });
        }

        // The whitelist of the owner's channel, by Network subject.
        const seen = new Set();
        for (const w of whitelist.filter((x) => x.owner_user_id === config.user_id)) {
            if (seen.has(w.user_id)) continue;
            seen.add(w.user_id);
            const user = owners.get(w.user_id);
            const subject = subjectOf(w.user_id);
            if (!subject) {
                cfg.skipped_operators.push({ id: w.user_id, username: user ? user.username || null : null, reason: 'no Network subject: they must sign in to Network once' });
                continue;
            }
            cfg.operators.push({ id: w.user_id, username: user ? user.username || null : null, subject_id: subject });
        }
        plan.push(cfg);
    }
    return {
        exported_at: strOr(doc.exported_at, null),
        configs: plan,
        summary: {
            configs: plan.length,
            to_convert: plan.filter((c) => c.status === 'convert').length,
            skipped: plan.filter((c) => c.status !== 'convert').length,
            buttons: plan.reduce((n, c) => n + c.buttons.length, 0),
            operators: plan.reduce((n, c) => n + c.operators.length, 0),
        },
    };
}

/** The plan as the operator reads it: one block per Live config. */
function formatPlan(plan) {
    const out = [];
    out.push(`OpenVibe.Live controls → Bot robots — ${plan.summary.to_convert} to convert, ${plan.summary.skipped} skipped`);
    if (plan.exported_at) out.push(`exported ${plan.exported_at}`);
    out.push('');
    for (const c of plan.configs) {
        out.push(`config ${c.live_config_id}  ${JSON.stringify(c.live_name)}  owner ${c.owner.username || c.owner.id} <${c.owner.subject_id || 'no Network subject'}>`);
        if (c.status !== 'convert') { out.push(`  SKIPPED: ${c.reason}`); out.push(''); continue; }
        out.push(`  robot ${JSON.stringify(c.robot.name)}  profile ${c.robot.profile_id}  access ${c.robot.access_policy}`);
        if (!c.buttons.length) out.push('  buttons: none');
        for (const b of c.buttons) {
            const key = b.key ? `  key ${b.key}` : '';
            const cd = b.cooldown_ms != null ? `  cooldown ${b.cooldown_ms}ms` : '';
            out.push(`  - ${b.name}  "${b.label}"  ← ${JSON.stringify(b.command)}${key}${cd}${b.hold ? '  hold' : ''}`);
            for (const n of b.notes) out.push(`      note: ${n}`);
        }
        for (const d of c.dropped) out.push(`  - DROPPED ${JSON.stringify(d.command)} "${d.label}": ${d.reason}`);
        for (const o of c.operators) out.push(`  operator ${o.username || o.id} <${o.subject_id}>`);
        for (const o of c.skipped_operators) out.push(`  operator SKIPPED ${o.username || o.id}: ${o.reason}`);
        for (const n of c.notes) out.push(`  note: ${n}`);
        out.push('');
    }
    return `${out.join('\n')}\n`;
}

// ── Apply (through the domain layer) ─────────────────────────────────────────────────────────────
/** The profile's `buttons` object for one plan config. */
function buttonsObject(cfg) {
    return Object.fromEntries(cfg.buttons.map((b) => [b.name, {
        label: b.label,
        ...(b.key ? { key: b.key } : {}),
        ...(b.cooldown_ms != null ? { cooldown_ms: b.cooldown_ms } : {}),
        ...(b.hold ? { hold: true } : {}),
    }]));
}

/**
 * Write the plan: for each convertible config whose Live id is not already in live_conversions, create the
 * robot, save its local profile, add the operators, then record the conversion and the command map. Returns
 * the results (one per config) with `outcome` converted | already_converted | skipped.
 */
async function applyPlan(plan, { db, domain, log = console }) {
    const results = [];
    for (const cfg of plan.configs) {
        if (cfg.status !== 'convert') { results.push({ ...cfg, outcome: 'skipped' }); continue; }
        const done = await db.maybe('SELECT robot_id FROM live_conversions WHERE live_config_id = $1', [cfg.live_config_id]);
        if (done) { results.push({ ...cfg, outcome: 'already_converted', robot_id: done.robot_id }); continue; }

        let robot = null;
        try {
            const actor = { subject: cfg.owner.subject_id, kind: 'service' };
            const buttons = buttonsObject(cfg);
            ({ robot } = await domain.robots.create({ owner: cfg.owner.subject_id, name: cfg.robot.name, profile_id: cfg.robot.profile_id, access_policy: cfg.robot.access_policy }));
            await domain.robots.saveLocalProfile(robot.id, actor, Object.keys(buttons).length ? { buttons } : { buttons: {}, point: null });
            for (const o of cfg.operators) await domain.members.add(robot.id, o.subject_id, 'operator', cfg.owner.subject_id);

            const detail = { source: 'openvibe.live', live_config_id: cfg.live_config_id, live_name: cfg.live_name,
                command_to_name: cfg.command_to_name, name_to_command: cfg.name_to_command,
                dropped: cfg.dropped, skipped_operators: cfg.skipped_operators };
            await db.query(`INSERT INTO live_conversions (live_config_id, robot_id, owner_subject, detail, converted_at)
                VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (live_config_id) DO NOTHING`,
                [cfg.live_config_id, robot.id, cfg.owner.subject_id, JSON.stringify(detail), new Date().toISOString()]);
            // The audit row the relay plugin reads: the Live command behind every Bot button name. (The audit
            // prunes after 30 days; live_conversions.detail above keeps the same map for good.)
            await domain.audit.record({ robotId: robot.id, subject: cfg.owner.subject_id, operatorKind: 'service', role: 'owner',
                kind: 'profile.local', value: { source: 'openvibe.live', live_config_id: cfg.live_config_id, commands: cfg.command_to_name }, result: 'ack' });
            log.log(`[convert] config ${cfg.live_config_id}: robot ${robot.id} (${cfg.robot.name}) with ${cfg.buttons.length} buttons, ${cfg.operators.length} operators`);
            results.push({ ...cfg, outcome: 'converted', robot_id: robot.id });
        } catch (e) {
            // One bad config does not stop the run; the robot it may have made is reported so the operator can remove it.
            log.error(`[convert] config ${cfg.live_config_id} failed: ${e.message}`);
            results.push({ ...cfg, outcome: 'failed', robot_id: robot ? robot.id : null, reason: e.message });
        }
    }
    return results;
}

// ── Entry ────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { input: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--input') args.input = argv[++i];
        else if (a.startsWith('--input=')) args.input = a.slice(8);
        else if (a === '--apply') args.apply = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return args;
}

const USAGE = `usage: node scripts/convert-live-controls.js --input export.json [--apply]

  --input FILE   the JSON document from scripts/live-controls-export.sh
  --apply        write the robots (default: dry run, prints the plan and stops)`;

/**
 * Read the export, build the plan and (with apply) write it. `db`/`domain` may be injected (tests); a real
 * run opens Bot's database and domain from the environment, exactly as server/index.js does.
 */
async function convert({ input, apply = false, db = null, domain = null, log = console } = {}) {
    const doc = JSON.parse(fs.readFileSync(input, 'utf8'));
    const plan = buildPlan(doc);
    if (!apply) { log.log(formatPlan(plan)); return { plan, results: null }; }

    let own = null;
    if (!db || !domain) {
        const { loadConfig } = require('../server/config');
        const { openDb, migrate } = require('../server/db');
        const { seedProfiles } = require('../server/profiles');
        const { createApp } = require('../server/app');
        const config = loadConfig();
        own = openDb(config);
        const quiet = { log() {}, warn() {}, error: (...a) => log.error(...a) };
        await migrate(config, { serving: own, log: quiet });
        await seedProfiles(own, { log: quiet });
        const app = createApp({ config, db: own, log: quiet });
        db = own; domain = app.locals.domain;
    }
    try {
        const results = await applyPlan(plan, { db, domain, log });
        for (const r of results) {
            if (r.outcome === 'converted') log.log(`[convert] config ${r.live_config_id}: converted → ${r.robot_id}`);
            else if (r.outcome === 'already_converted') log.log(`[convert] config ${r.live_config_id}: already converted → ${r.robot_id} (nothing changed)`);
            else if (r.outcome === 'failed') log.log(`[convert] config ${r.live_config_id}: FAILED — ${r.reason}${r.robot_id ? ` (robot ${r.robot_id} was made; remove it before retrying)` : ''}`);
            else log.log(`[convert] config ${r.live_config_id}: skipped — ${r.reason}`);
        }
        const count = (o) => results.filter((r) => r.outcome === o).length;
        log.log(`[convert] ${count('converted')} converted, ${count('already_converted')} already converted, ${count('skipped')} skipped, ${count('failed')} failed`);
        return { plan, results };
    } finally {
        if (own) await own.close().catch(() => {});
    }
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help || !args.input) { console.log(USAGE); return args.help ? 0 : 2; }
    await convert({ input: path.resolve(args.input), apply: args.apply });
    return 0;
}

if (require.main === module) {
    main().then((code) => { if (code) process.exit(code); }).catch((e) => { console.error(`convert-live-controls: ${e.message}`); process.exit(1); });
}

module.exports = { buildPlan, formatPlan, applyPlan, buttonsObject, convert, normaliseName, uniqueName, RELAY_PROFILE, RESERVED_KEYS };
