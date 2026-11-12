'use strict';
/**
 * Bot's control API for person-owned robots (ADR-048 amendment 2026-10-15, step 8 phase 2; capability
 * bot.resource.control): POST /api/v1/resources/control takes one common.owned-resource-control-request@1 from a
 * first-party service (OpenVibe.Services) naming a bot.robot by its id and its owner, and answers a
 * common.resource-control-result@1 (200 for every outcome, without `resource`: robots have no OVRN; a malformed request
 * is a 400 problem).
 *
 *   stop      send the robot's own Stop command (halt): every actuator stops, and nothing is latched.
 *   resume    answer that nothing was latched, so there is nothing to clear. A Stop on the machine itself stays local.
 *
 * Any other action is refused `control.unsupported_action`. Only the owner Bot holds may be named: a robot of another
 * person is refused as unknown, never confirmed to exist. dry_run decides and explains without applying. The first
 * answer per (caller, idempotency_key) is kept in bot_control_log and returned for a repeat; the same key with another
 * request is refused `control.idempotency_conflict`.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');
const { fail } = require('../util');

const CAPABILITY = 'bot.resource.control';
const KIND = 'bot.robot';
const ROBOT_RE = /^rob_[0-9A-HJKMNP-TV-Z]{26}$/;

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const digestOf = (request) => crypto.createHash('sha256')
    .update(canonical({ ...request, idempotency_key: undefined, confirmation_id: undefined, trace_id: undefined })).digest('hex');

function router({ domain, apiAuth, hub, now = () => Date.now() }) {
    const r = express.Router();
    const db = domain.db;
    const json = express.json({ limit: '16kb' });
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
    const result = (request, state, extra = {}) => ({ action: request.action, state, at: new Date(now()).toISOString(), ...extra });
    const problem = (status, code, detail) => ({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail });

    function firstParty(req, res, next) {
        if (req.principal.kind === 'anonymous') fail(401, 'bot.sign_in', 'sign in to do that');
        if (req.principal.kind !== 'service' || !/^svc:/.test(String(req.principal.sub || ''))) fail(403, 'capability.denied', `${CAPABILITY} is first-party`);
        if (!apiAuth.granted(req.principal, CAPABILITY)) fail(403, 'capability.denied', `${CAPABILITY} not granted`);
        next();
    }

    async function decide(request) {
        if (request.owned.kind !== KIND || !ROBOT_RE.test(request.owned.id)) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no robot ${request.owned.kind} ${request.owned.id}`) });
        }
        if (request.action !== 'stop' && request.action !== 'resume') {
            return result(request, 'refused', { problem: problem(422, 'control.unsupported_action', `a robot takes stop and resume, not ${request.action}`) });
        }
        const robot = await domain.robots.get(request.owned.id);
        if (!robot || robot.owner_subject !== request.owner.id) {
            return result(request, 'refused', { problem: problem(404, 'resources.unknown_resource', `no robot ${request.owned.id} of this person`) });
        }
        const owner = { kind: 'user', subject: robot.owner_subject };
        if (request.action === 'stop') {
            if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: 'send the robot a Stop' } });
            const out = hub
                ? await hub.operatorCommand(robot.id, owner, robot.owner_subject, { id: `rc-${crypto.randomUUID()}`, kind: 'halt', value: {}, ms: 5000 })
                : { result: 'refused', code: 'bot.device_offline' };
            return result(request, 'done', { result: { stop: true, changed: out.result === 'ack', ...(out.result === 'ack' ? {} : { reason: out.reason || out.code || 'the robot is offline' }) } });
        }
        // Nothing is latched any more: a resume has nothing to clear. A Stop held on the machine itself stays local.
        return result(request, 'done', { result: { stop: false, changed: false } });
    }

    r.post('/', firstParty, json, wrap(async (req, res) => {
        const request = req.body;
        if (!request || typeof request !== 'object' || request.owned === undefined) {
            // Bot holds no project resources: a project-scoped request names nothing here.
            return contracts.http.sendProblem(res, 400, 'control.bad_request', { detail: 'Bot\'s robots are person-owned: send common.owned-resource-control-request@1', ctx: req.ov });
        }
        const check = contracts.resources.checkControlRequest(request);
        if (!check.valid) return contracts.http.sendProblem(res, 400, 'control.bad_request', { detail: JSON.stringify(check.errors).slice(0, 500), ctx: req.ov });
        const caller = req.principal.sub;
        const digest = digestOf(request);
        const seen = await db.maybe('SELECT digest, response FROM bot_control_log WHERE caller = $1 AND idempotency_key = $2', [caller, request.idempotency_key]);
        if (seen) {
            if (seen.digest !== digest) return contracts.http.sendProblem(res, 409, 'control.idempotency_conflict', { detail: 'this idempotency_key was used for another request', ctx: req.ov });
            return res.json(typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response);
        }
        const answer = await decide(request);
        await db.query(`INSERT INTO bot_control_log (caller, idempotency_key, owner_subject, digest, response, created_at)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [caller, request.idempotency_key, request.owner.id, digest, JSON.stringify(answer), new Date(now()).toISOString()]);
        return res.json(answer);
    }));
    return r;
}

module.exports = { router, CAPABILITY, digestOf };
