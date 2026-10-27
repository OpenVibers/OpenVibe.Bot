'use strict';

/**
 * Bot's authority resource index for OpenVibe.Services (ADR-048). Robots and machines are person-owned.
 * GET /api/v1/resources?project=&kind=&owner=&cursor=&limit=: `owner` (usr_…/agt_…) answers only that subject's
 * (openvibe-sdk 0.41 sends it for a person's own resources; an owner is a person, so an agt_ owner matches nothing).
 * Neither is in a project, so a project filter matches nothing. A malformed filter is a 400.
 *
 * Kinds: bot.robot (rob_, state ready or estopped), then bot.machine (dev_: a person's own machine, the Desks plan's
 * hosts, state online or offline). A robot's device keeps no owner of its own and is its robot's, not listed here.
 * The cursor names the kind and id of the last one, so a page that ends among the robots goes on to the machines.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { fail } = require('../util');

const SERVICE = 'bot';
const KIND = 'bot.robot';
const MACHINE_KIND = 'bot.machine';
const CAPABILITY = 'bot.resource.read';
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Only the public fields in common.resource-summary@1. Person-owned robots have no OVRN. */
function robotSummary(row) {
    const summary = {
        id: row.id, kind: KIND, service: SERVICE,
        name: row.name, state: row.estop_latched ? 'estopped' : 'ready',
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
    };
    if (USER_SUBJECT_RE.test(String(row.owner_subject || ''))) summary.owner = { type: 'user', id: row.owner_subject };
    const ovrn = contracts.resources.nameOf(summary);
    if (ovrn) summary.ovrn = ovrn;
    return summary;
}

/** A person's own machine (devices.owner_subject): online while its Node is connected. */
function machineSummary(row, online) {
    const summary = {
        id: row.id, kind: MACHINE_KIND, service: SERVICE,
        name: row.name || row.id, state: online ? 'online' : 'offline',
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
    };
    if (USER_SUBJECT_RE.test(String(row.owner_subject || ''))) summary.owner = { type: 'user', id: row.owner_subject };
    return summary;
}

const encodeCursor = (id, kind = KIND) => Buffer.from(JSON.stringify([kind, id])).toString('base64url');
function decodeCursor(raw) {
    let value;
    try { value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    if (!Array.isArray(value) || value.length !== 2) return null;
    if (value[0] === KIND && /^rob_[0-9A-HJKMNP-TV-Z]{26}$/.test(value[1])) return { kind: KIND, id: value[1] };
    if (value[0] === MACHINE_KIND && /^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(value[1])) return { kind: MACHINE_KIND, id: value[1] };
    return null;
}

function filtersOf(query) {
    const project = query.project === undefined || query.project === '' ? null : query.project;
    if (project !== null && (typeof project !== 'string' || !PROJECT_ID_RE.test(project))) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    const owner = query.owner === undefined || query.owner === '' ? null : query.owner;
    if (owner !== null && (typeof owner !== 'string' || !SUBJECT_RE.test(owner))) return { error: 'owner must be a usr_ or agt_ subject id' };
    let limit = DEFAULT_LIMIT;
    if (query.limit !== undefined && query.limit !== '') {
        if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (query.cursor !== undefined && query.cursor !== '') {
        cursor = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : null;
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, owner, limit, cursor };
}

function router({ db, apiAuth, hub = null }) {
    const r = express.Router();
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
    const bad = (res, detail, ctx) => contracts.http.sendProblem(res, 400, 'resources.bad_query', { detail, ctx });
    const unknown = (res, name, ctx) => contracts.http.sendProblem(res, 404, 'resources.unknown_resource', { detail: `no resource named ${name}`, ctx });

    function firstParty(req, res, next) {
        if (req.principal.kind === 'anonymous') fail(401, 'bot.sign_in', 'sign in to do that');
        if (req.principal.kind !== 'service') fail(403, 'bot.forbidden', 'the resource index is a service-to-service call');
        if (!apiAuth.granted(req.principal, CAPABILITY)) fail(403, 'capability.denied', `${CAPABILITY} not granted`);
        next();
    }

    r.use(firstParty);
    r.get('/', wrap(async (req, res) => {
        const filters = filtersOf(req.query);
        if (filters.error) return bad(res, filters.error, req.ov);
        if (filters.project || (filters.kind && filters.kind !== KIND && filters.kind !== MACHINE_KIND)) return res.json({ resources: [], next_cursor: null });
        if (filters.owner && !USER_SUBJECT_RE.test(filters.owner)) return res.json({ resources: [], next_cursor: null });
        const cur = filters.cursor;
        const out = [];
        if ((!filters.kind || filters.kind === KIND) && (!cur || cur.kind === KIND)) {
            const rows = await db.many(`SELECT id, owner_subject, name, estop_latched, created_at, updated_at
                FROM robots WHERE ($1::text IS NULL OR id > $1) AND ($3::text IS NULL OR owner_subject = $3) ORDER BY id LIMIT $2`,
            [cur ? cur.id : null, filters.limit + 1, filters.owner]);
            out.push(...rows.map(robotSummary));
        }
        if ((!filters.kind || filters.kind === MACHINE_KIND) && out.length <= filters.limit) {
            const after = cur && cur.kind === MACHINE_KIND ? cur.id : null;
            const rows = await db.many(`SELECT id, owner_subject, name, created_at, updated_at
                FROM devices WHERE owner_subject IS NOT NULL AND revoked_at IS NULL AND ($1::text IS NULL OR id > $1)
                  AND ($3::text IS NULL OR owner_subject = $3) ORDER BY id LIMIT $2`,
            [after, filters.limit + 1 - out.length, filters.owner]);
            out.push(...rows.map((row) => machineSummary(row, !!(hub && hub.isOnline(row.id)))));
        }
        const resources = out.slice(0, filters.limit);
        const last = resources[resources.length - 1];
        const next_cursor = out.length > filters.limit ? encodeCursor(last.id, last.kind) : null;
        return res.json({ resources, next_cursor });
    }));
    r.get('/:ovrn', (req, res) => unknown(res, String(req.params.ovrn), req.ov));
    return r;
}

module.exports = { router, robotSummary, machineSummary, filtersOf, encodeCursor, SERVICE, KIND, MACHINE_KIND, CAPABILITY, DEFAULT_LIMIT, MAX_LIMIT };
