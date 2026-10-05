'use strict';

/**
 * Curated kit catalogue (plan T15 "Get a robot", the O29 metadata half): the kits a person can buy to get a
 * robot online, each bound to a shipped profile and carrying its parts list and build guide. Kits live as
 * server/kits/*.json and are validated here in the style of server/profiles/index.js — a typo or a kit bound
 * to a profile that does not ship refuses at load, never at a store page.
 *
 * Metadata only: this is what to buy and how to build it. Pricing, shipping, returns and fulfilment are the
 * owner's (O29), not modelled here, so nothing in this catalogue carries a price.
 *
 * Kit shape (bot.kit@1):
 *   { id, name, vendor?, description?,
 *     profile_id,           // must name a shipped profile (loadKits checks it)
 *     build_guide_url,      // https
 *     parts: [{ name, qty?, required?, note? }] }   // qty defaults to 1, required defaults to true
 *
 * GET /api/v1/kits serves list()/get(); the robots page ("Get a robot") reads the same helper.
 */
const fs = require('fs');
const path = require('path');
const { BotError } = require('../util');
const { loadProfiles } = require('../profiles');

const DIR = path.join(__dirname);
const ID_RE = /^[a-z][a-z0-9._-]{1,63}$/;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function bad(why) { throw new BotError(500, 'bot.kit_invalid', why); }

/** https only, so a catalogue entry can never smuggle a `javascript:` or plain-http link into a page. */
function isGuideUrl(v) {
    if (typeof v !== 'string' || !v.trim() || v.length > 300) return false;
    try { const u = new URL(v); return u.protocol === 'https:' && !!u.hostname; } catch { return false; }
}

/** One line of a kit's parts list: what it is, how many, and whether the build needs it. */
function validatePart(where, p) {
    if (!isObject(p)) bad(`${where} must be an object`);
    if (typeof p.name !== 'string' || !p.name.trim()) bad(`${where}.name is required`);
    if (p.name.trim().length > 120) bad(`${where}.name must be at most 120 characters`);
    const qty = p.qty == null ? 1 : p.qty;
    if (!(Number.isInteger(qty) && qty > 0)) bad(`${where}.qty must be a positive integer`);
    if (p.required != null && typeof p.required !== 'boolean') bad(`${where}.required must be true or false`);
    if (p.note != null && (typeof p.note !== 'string' || p.note.trim().length > 200)) bad(`${where}.note must be at most 200 characters`);
    return { name: p.name.trim(), qty, required: p.required !== false, ...(p.note && p.note.trim() ? { note: p.note.trim() } : {}) };
}

/**
 * Validate one kit. `profiles` (a Map of id → profile) is optional: loadKits passes the shipped set so a kit
 * bound to a profile that does not ship is refused; validateKit alone checks shape only.
 */
function validateKit(k, { profiles = null } = {}) {
    if (!isObject(k)) bad('a kit must be an object');
    if (typeof k.id !== 'string' || !ID_RE.test(k.id)) bad(`kit id is not valid: ${k.id}`);
    if (typeof k.name !== 'string' || !k.name.trim()) bad(`${k.id}: name is required`);
    if (k.name.trim().length > 120) bad(`${k.id}: name must be at most 120 characters`);
    if (k.vendor != null && (typeof k.vendor !== 'string' || k.vendor.trim().length > 60)) bad(`${k.id}: vendor must be at most 60 characters`);
    if (k.description != null && (typeof k.description !== 'string' || k.description.trim().length > 500)) bad(`${k.id}: description must be at most 500 characters`);
    if (typeof k.profile_id !== 'string' || !ID_RE.test(k.profile_id)) bad(`${k.id}: profile_id is required`);
    if (profiles && !profiles.has(k.profile_id)) bad(`${k.id}: profile_id ${k.profile_id} is not a shipped profile`);
    if (!isGuideUrl(k.build_guide_url)) bad(`${k.id}: build_guide_url must be an https URL`);
    if (!Array.isArray(k.parts) || !k.parts.length) bad(`${k.id}: parts must be a non-empty array`);
    const parts = k.parts.map((p, i) => validatePart(`${k.id}: parts[${i}]`, p));
    return {
        id: k.id, name: k.name.trim(), vendor: k.vendor ? k.vendor.trim() : null,
        description: k.description ? k.description.trim() : null,
        profile_id: k.profile_id, build_guide_url: k.build_guide_url, parts,
    };
}

/** Every kit in server/kits/*.json, validated and bound to a shipped profile. Throws on the first invalid file. */
function loadKits(dir = DIR) {
    const profiles = loadProfiles();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const out = new Map();
    for (const f of files) {
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { bad(`${f}: ${e.message}`); }
        const kit = validateKit(raw, { profiles });
        out.set(kit.id, kit);
    }
    if (!out.size) bad('no kits found');
    return out;
}

/** The catalogue as the API and the robots page present it. */
function list() { return [...loadKits().values()]; }
function get(id) { return loadKits().get(id) || null; }

module.exports = { validateKit, validatePart, loadKits, list, get, DIR };
