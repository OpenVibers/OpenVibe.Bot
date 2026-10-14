'use strict';

/**
 * Robot webhooks (plan T15 "webhooks"): an owner points a robot's bot.* events at an https endpoint of theirs. Each hook
 * has its own secret (whsec_…, shown once when it is made), and every delivery is signed with it exactly like an
 * OpenVibe.Events delivery (openvibe-sdk/events signDeliveryHeaders: X-OpenVibe-Timestamp, X-OpenVibe-Signature-V2), so
 * a receiver checks it with the same code. Deliveries are written in the transaction that emits the event
 * (server/domain emit → enqueueIn), so one exists exactly when its event does, and sent by a loop with backoff.
 *
 *   EVENTS                         the bot.* events a hook may take
 *   createWebhooks({ db, post, now, log })
 *     list(robotId) / create(robot, person, { url, events }) → { hook, secret } / remove(robotId, id)
 *     enqueueIn(t, event_type, robotId, payload)   inside the emitting transaction
 *     sendDue() → how many were tried; start() / stop()
 *     recent(hookId) → the last deliveries (state, attempts, status)
 *
 * The body is { id, type, robot_id, occurred_at, data } with the event's own payload as data (ids, kinds and results
 * only). A 2xx answer delivers; anything else, a refused address or a network error retries after 30 s, 2, 10, 30 and
 * 120 minutes, then the delivery fails. Nothing a receiver answers is kept but its status code.
 */
const crypto = require('crypto');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { BotError, prefixedId, iso } = require('./util');
const { checkWebhookUrl, WebhookRefused } = require('./net/webhook-post');

const EVENTS = ['bot.robot.online', 'bot.robot.offline', 'bot.estop.set', 'bot.estop.cleared', 'bot.command.refused'];
const BACKOFF_S = [30, 120, 600, 1800, 7200];
const MAX_HOOKS = 5;
const TICK_MS = 5000;

const mintSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

function createWebhooks({ db, post, now = () => Date.now(), log = console, tickMs = TICK_MS }) {
    let timer = null;
    let busy = false;

    const list = (robotId) => db.many('SELECT id, robot_id, url, events, enabled, created_at FROM robot_webhooks WHERE robot_id = $1 ORDER BY created_at', [robotId]);

    async function create(robot, person, { url, events }) {
        let u;
        try { u = checkWebhookUrl(url); } catch (e) {
            if (e instanceof WebhookRefused) throw new BotError(422, 'bot.webhook_refused', e.message);
            throw e;
        }
        const chosen = [...new Set((Array.isArray(events) ? events : [events]).filter(Boolean).map(String))];
        if (!chosen.length || chosen.some((e) => !EVENTS.includes(e))) throw new BotError(422, 'bot.invalid_input', `events are some of ${EVENTS.join(', ')}`);
        const count = Number(await db.value('SELECT count(*) FROM robot_webhooks WHERE robot_id = $1', [robot.id]));
        if (count >= MAX_HOOKS) throw new BotError(409, 'bot.too_many_webhooks', `a robot has at most ${MAX_HOOKS} webhooks`);
        const id = prefixedId('whk', now());
        const secret = mintSecret();
        await db.query('INSERT INTO robot_webhooks (id, robot_id, url, events, secret, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, robot.id, u.href, chosen, secret, person.subject, iso(now())]);
        const hook = await db.maybe('SELECT id, robot_id, url, events, enabled, created_at FROM robot_webhooks WHERE id = $1', [id]);
        return { hook, secret };
    }

    async function remove(robotId, id) {
        return (await db.exec('DELETE FROM robot_webhooks WHERE id = $1 AND robot_id = $2', [id, robotId])) > 0;
    }

    /** Inside the emitting transaction: one delivery per enabled hook of the robot that takes this event. */
    async function enqueueIn(t, eventType, robotId, payload) {
        if (!robotId || !EVENTS.includes(eventType)) return 0;
        const hooks = await t.many('SELECT id FROM robot_webhooks WHERE robot_id = $1 AND enabled AND $2 = ANY(events)', [robotId, eventType]);
        if (!hooks.length) return 0;
        const at = iso(now());
        const body = JSON.stringify({ id: prefixedId('whe', now()), type: eventType, robot_id: robotId, occurred_at: at, data: payload || {} });
        for (const h of hooks) {
            await t.query(`INSERT INTO robot_webhook_deliveries (id, webhook_id, event_type, body, due_at, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $5, $5)`, [prefixedId('whd', now()), h.id, eventType, body, at]);
        }
        return hooks.length;
    }

    async function sendOne(d) {
        const hook = await db.maybe('SELECT url, secret, enabled FROM robot_webhooks WHERE id = $1', [d.webhook_id]);
        const attempts = d.attempts + 1;
        const at = iso(now());
        if (!hook || !hook.enabled) {
            await db.query("UPDATE robot_webhook_deliveries SET state = 'failed', attempts = $2, last_error = $3, updated_at = $4 WHERE id = $1", [d.id, attempts, 'the webhook is gone or off', at]);
            return;
        }
        let status = null; let error = null;
        try {
            const r = await post(hook.url, { headers: { ...signDeliveryHeaders(d.body, hook.secret, { now: now() }), 'X-OpenVibe-Event': d.event_type, 'X-OpenVibe-Delivery': d.id }, body: d.body });
            status = r.status;
        } catch (e) { error = String(e.message || e).slice(0, 200); }
        if (status >= 200 && status < 300) {
            await db.query("UPDATE robot_webhook_deliveries SET state = 'delivered', attempts = $2, last_status = $3, last_error = NULL, updated_at = $4 WHERE id = $1", [d.id, attempts, status, at]);
            return;
        }
        const wait = BACKOFF_S[attempts - 1];
        const why = error || `answered ${status}`;
        if (wait == null) await db.query("UPDATE robot_webhook_deliveries SET state = 'failed', attempts = $2, last_status = $3, last_error = $4, updated_at = $5 WHERE id = $1", [d.id, attempts, status, why, at]);
        else await db.query('UPDATE robot_webhook_deliveries SET attempts = $2, last_status = $3, last_error = $4, due_at = $5, updated_at = $6 WHERE id = $1', [d.id, attempts, status, why, iso(now() + wait * 1000), at]);
    }

    async function sendDue() {
        if (busy) return 0;
        busy = true;
        try {
            const due = await db.many("SELECT * FROM robot_webhook_deliveries WHERE state = 'pending' AND due_at <= $1 ORDER BY due_at LIMIT 25", [iso(now())]);
            for (const d of due) await sendOne(d).catch((e) => log.warn(`[Bot] webhook ${d.id}: ${e.message}`));
            return due.length;
        } finally { busy = false; }
    }

    const recent = (hookId) => db.many('SELECT id, event_type, state, attempts, last_status, last_error, created_at, updated_at FROM robot_webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 10', [hookId]);

    function start() {
        if (timer || !tickMs) return;
        timer = setInterval(() => { sendDue().catch((e) => log.warn(`[Bot] webhooks: ${e.message}`)); }, tickMs);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    return { list, create, remove, enqueueIn, sendDue, recent, start, stop, EVENTS };
}

module.exports = { createWebhooks, EVENTS, BACKOFF_S };
