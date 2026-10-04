'use strict';

/**
 * Job metering (platform.job-frame@1 `job_usage` / `job_exit`): one platform.usage-sample@1 reading per
 * wall-clock second a job's process held, queued in run_usage_outbox and posted to OpenVibe.Billing's
 * billing.usage.record (POST /api/v1/usage, one reading per request).
 *
 * Every field of a reading is derived from the job and its second: id = idempotency_key = run:<job id>:<n>,
 * service run, operation function.invoke, unit s, quantity 1 (the partial last second (wall_ms mod 1000)/1000,
 * never 0), at = started_ms + n*1000, resource the job id, node the device id, source openvibe-node.worker, and
 * project, subject and provider from Bot's own record of the job. Nothing depends on when a frame arrived, so a
 * resend, a job_usage and the job_exit backfill of one second are one key: the outbox keeps the first
 * (ON CONFLICT DO NOTHING) and Billing replays an identical reading (200) and refuses a different one (409).
 *
 * The relay (openvibe-sdk createPgOutbox) runs while BOT_BILLING_URL and BOT_BILLING_TOKEN are set. If either is
 * unset, or Billing is down, has no grant for Bot yet or answers 401/403/404/429/5xx, readings wait and are
 * retried with backoff, across restarts: never dropped. Only Billing refusing the reading itself (400, 409, 413,
 * 422) marks a row rejected; it is kept with its error and never sent again, so nothing is billed twice.
 */
const { validate } = require('openvibe-contracts');
const { createPgOutbox } = require('openvibe-sdk/events');

const TABLE = 'run_usage_outbox';   // migrations/0004_run_jobs.sql
const SCHEMA = 'platform.usage-sample@1';
const SERVICE = 'run';
const OPERATION = 'function.invoke';
const UNIT = 's';
const SOURCE = 'openvibe-node.worker';
const REFUSED = new Set([400, 409, 413, 422]);

/** The reading for second `n` of a job; `quantity` is 1 except for the partial last second. */
function secondReading({ jobId, n, quantity = 1, startedMs, nodeId, project = null, subject = null, provider = null }) {
    if (!Number.isInteger(n) || n < 0) throw new TypeError(`second must be an integer >= 0, not ${n}`);
    if (!Number.isInteger(startedMs) || startedMs < 0) throw new TypeError('started_ms must be an integer >= 0');
    const key = `run:${jobId}:${n}`;
    const r = {
        id: key, idempotency_key: key, service: SERVICE, operation: OPERATION, unit: UNIT, quantity,
        at: new Date(startedMs + n * 1000).toISOString(), resource: jobId, node: nodeId, source: SOURCE,
    };
    if (project) r.project = project;
    if (subject) r.subject = subject;
    if (provider) r.provider = provider;
    return r;
}

/**
 * The readings job_exit's usage stands for: seconds 0 … floor(wall_ms/1000)-1 with quantity 1 and, when
 * wall_ms mod 1000 > 0, second floor(wall_ms/1000) with quantity (wall_ms mod 1000)/1000.
 */
function exitReadings({ wallMs, ...job }) {
    const full = Math.floor(wallMs / 1000);
    const out = [];
    for (let n = 0; n < full; n++) out.push(secondReading({ ...job, n }));
    const rest = wallMs % 1000;
    if (rest > 0) out.push(secondReading({ ...job, n: full, quantity: rest / 1000 }));
    return out;
}

/** Queue one reading inside the caller's transaction; a key already queued changes nothing. → inserted? */
async function enqueue(t, reading, at) {
    const v = validate(SCHEMA, reading);
    if (!v.valid) throw new Error(`reading ${reading.id} is not a valid ${SCHEMA}: ${JSON.stringify(v.errors)}`);
    const n = await t.exec(`INSERT INTO ${TABLE} (event_id, envelope, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
        [reading.idempotency_key, JSON.stringify(reading), at]);
    return n > 0;
}

// createPgOutbox's `events` seam pointed at Billing. isPermanent() reads err.status: 422 rejects the row, 503 retries.
function billingSink({ url, token, fetchImpl, timeoutMs }) {
    return {
        prepare: (reading) => reading,
        async publish(reading) {
            const res = await fetchImpl(`${url}/api/v1/usage`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(reading), signal: AbortSignal.timeout(timeoutMs),
            });
            // 201 written, 200 an identical reading replayed: either way Billing holds it.
            if (!res.ok) { const err = new Error(`billing.usage.record answered ${res.status}`); err.status = REFUSED.has(res.status) ? 422 : 503; throw err; }
            return { event_id: reading.id, seq: null };
        },
    };
}

/**
 * The relay from run_usage_outbox to Billing. enabled only with config.billing.url and .token; otherwise start(),
 * kick() and flush() do nothing and readings accumulate until a process with both set sweeps them.
 */
function createUsageRelay({ db, config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const { url, token, intervalMs, timeoutMs } = config.billing;
    const count = (where) => db.value(`SELECT count(*) FROM ${TABLE} WHERE ${where}`).then(Number);
    const counts = { pending: () => count('sent_at IS NULL AND rejected_at IS NULL'), rejected: () => count('rejected_at IS NOT NULL') };
    if (!url || !token) {
        const idle = async () => ({ sent: 0, failed: 0, rejected: 0 });
        return { enabled: false, start() {}, stop: async () => {}, kick() {}, flush: idle, ...counts };
    }
    let lastError = null;
    const relay = createPgOutbox(db, {
        events: billingSink({ url, token, fetchImpl, timeoutMs }), table: TABLE, batchSize: 1, intervalMs, now,
        onError: (err) => { const m = err && err.message; if (m !== lastError) log.warn(`[Bot] usage reading not delivered: ${m}`); lastError = m; },
    });
    return { enabled: true, start: relay.start, stop: relay.stop, kick: relay.kick, flush: relay.flush, ...counts };
}

module.exports = { secondReading, exitReadings, enqueue, createUsageRelay, TABLE, SERVICE, OPERATION, UNIT, SOURCE };
