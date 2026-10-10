'use strict';

/** Bot's authority resource index for OpenVibe.Services (ADR-048). Robots are person-owned. */
const express = require('express');
const contracts = require('openvibe-contracts');
const { fail } = require('../util');

const SERVICE = 'bot';
const KIND = 'bot.robot';
const CAPABILITY = 'bot.resource.read';
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
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

const encodeCursor = (id) => Buffer.from(JSON.stringify([KIND, id])).toString('base64url');
function decodeCursor(raw) {
    let value;
    try { value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(value) && value.length === 2 && value[0] === KIND && /^rob_[0-9A-HJKMNP-TV-Z]{26}$/.test(value[1]) ? value[1] : null;
}

function filtersOf(query) {
    const project = query.project === undefined || query.project === '' ? null : query.project;
    if (project !== null && (typeof project !== 'string' || !PROJECT_ID_RE.test(project))) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
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
    return { project, kind, limit, cursor };
}

function router({ db, apiAuth }) {
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
        if (filters.project || (filters.kind && filters.kind !== KIND)) return res.json({ resources: [], next_cursor: null });
        const rows = await db.many(`SELECT id, owner_subject, name, estop_latched, created_at, updated_at
            FROM robots WHERE ($1::text IS NULL OR id > $1) ORDER BY id LIMIT $2`, [filters.cursor, filters.limit + 1]);
        const resources = rows.slice(0, filters.limit).map(robotSummary);
        const next_cursor = rows.length > filters.limit ? encodeCursor(resources[resources.length - 1].id) : null;
        return res.json({ resources, next_cursor });
    }));
    r.get('/:ovrn', (req, res) => unknown(res, String(req.params.ovrn), req.ov));
    return r;
}

module.exports = { router, robotSummary, filtersOf, encodeCursor, SERVICE, KIND, CAPABILITY, DEFAULT_LIMIT, MAX_LIMIT };
