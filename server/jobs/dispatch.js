'use strict';

/**
 * The dispatcher (plan T14 step L1): Bot hands platform.job@1 jobs to a paired Node over the device link and
 * meters them (platform.job-frame@1, docs/protocol.md "Jobs"). The Run service, which owns run.job.*, calls it
 * over the internal HTTP API (bot.job.dispatch): POST /api/v1/jobs, POST /api/v1/jobs/:id/cancel and
 * GET /api/v1/jobs/:id (server/api/v1.js), through the jobs service server/jobs/index.js, which also holds the one
 * createJobFrames instance the device socket (server/realtime.js) uses.
 *
 *   dispatch(db, nodeId, job, { link, project, subject, provider })   validate, store, send (`job`)
 *   cancel(db, jobId, { link })                                        `job_cancel`
 *   createJobFrames({ db, usage, log, now })                           the device side: ack/nack of a job,
 *                                                                      job_started, job_stdout, job_usage,
 *                                                                      job_exit (→ job_exit_ack), and the resend
 *                                                                      on reconnect
 *
 * `link` is the realtime hub (sendToDevice). A job is sent only to a device whose stored
 * capabilities.worker.runtime_classes lists its class. An unacked job is resent on every reconnect (the Node acks
 * a job it already holds again, or answers with its job_exit, and never runs one twice). job_exit_ack goes out
 * once every reading of the job is committed to run_usage_outbox, from which the relay delivers it to Billing.
 */
const { validate } = require('openvibe-contracts');
const store = require('./store');
const metering = require('./metering');
const { fail, json } = require('../util');

const JOB = 'platform.job@1';
const FRAME = 'platform.job-frame@1';
const READING = 'platform.usage-sample@1';
const STDOUT_RING_BYTES = 1024 * 1024;   // the last 1 MiB of each job's stdout
const STDOUT_JOBS = 1024;                // rings kept, oldest dropped first

const brief = (errors) => (errors || []).slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ');
/** The classes a device's stored capabilities advertise (OpenVibe.Node status.capabilities.worker). */
function advertisedClasses(capabilities) {
    const worker = json(capabilities, {}).worker;
    return worker && Array.isArray(worker.runtime_classes) ? worker.runtime_classes.filter((c) => typeof c === 'string') : [];
}
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const liveDevice = (db, id) => db.maybe('SELECT id, capabilities FROM devices WHERE id = $1 AND revoked_at IS NULL', [id]);

/**
 * Validate `job` against platform.job@1, store it for device `nodeId` and send it if the device is connected
 * (else it goes out when the device connects). The same job again is idempotent; another body under the same
 * id is refused. → { job: row, sent }
 */
async function dispatch(db, nodeId, job, { link, project = null, subject = null, provider = null, now = () => Date.now() } = {}) {
    const v = validate(JOB, job);
    if (!v.valid) fail(422, 'bot.invalid_job', `the job is not a valid ${JOB}: ${brief(v.errors)}`);
    // The attribution every reading of the job will carry, checked now so a reading is never refused later.
    const probe = validate(READING, metering.secondReading({ jobId: job.id, n: 0, startedMs: 0, nodeId: String(nodeId), project, subject, provider }));
    if (!probe.valid) fail(422, 'bot.invalid_job', `project, subject or provider cannot attribute a reading: ${brief(probe.errors)}`);
    const device = await liveDevice(db, nodeId);
    if (!device) fail(404, 'bot.device_not_found', 'no such device, or it is revoked');
    if (!advertisedClasses(device.capabilities).includes(job.class)) fail(409, 'bot.class_unadvertised', `the device does not advertise the runtime class ${job.class}`);
    const { row, created } = await store.put(db, { job, nodeId, project, subject, provider, at: now() });
    if (!created && (row.node_id !== nodeId || canonical(row.job) !== canonical(job)
        || row.project_id !== project || row.subject !== subject || row.provider !== provider)) {
        fail(409, 'bot.job_id_reused', 'this job id already names another job');
    }
    let sent = false;
    if (row.state === 'queued' && !row.cancel_requested) {
        sent = !!(link && link.sendToDevice(nodeId, { type: 'job', job }));
        if (sent) await store.markSent(db, job.id, now());
    }
    return { job: await store.get(db, job.id), sent };
}

/** Ask the device to stop the job. A job not yet started is cancelled at once; job_exit still settles it. → { job, sent } */
async function cancel(db, jobId, { link, now = () => Date.now() } = {}) {
    const row = await store.requestCancel(db, String(jobId), now());
    if (!row) fail(404, 'bot.job_not_found', 'no such job');
    let sent = false;
    if (row.sent_at != null && row.exit_reason == null && row.finished_at == null) sent = !!(link && link.sendToDevice(row.node_id, { type: 'job_cancel', id: row.id }));
    return { job: row, sent };
}

/**
 * The device side of the job frames. Every handler takes `link` = { deviceId, send(type, fields), error(code,
 * detail) } for the device's socket; a frame naming a job of another device is answered bot.unknown_job and
 * changes nothing.
 */
function createJobFrames({ db: getDb, usage = null, log = console, now = () => Date.now() }) {
    const rings = new Map();   // job id → { nodeId, chunks, bytes, lastSeq, dropped }
    const kick = () => { if (usage) usage.kick(); };

    /** `ack`/`nack` keyed by a job id. */
    async function onAck(link, msg) {
        const db = getDb();
        const row = await store.ofNode(db, String(msg.id || ''), link.deviceId);
        if (!row) return;
        if (msg.type === 'nack') {
            await store.markRefused(db, row.id, String(msg.fault_code || 'nack').slice(0, 64), now());
            return;
        }
        await store.markPlaced(db, row.id, now());
        if (row.cancel_requested && row.exit_reason == null) link.send('job_cancel', { id: row.id });
    }

    /** After a device authenticates: resend its unacked jobs (still advertised) and the cancels it may not have seen. */
    async function onConnect(link) {
        const db = getDb();
        const device = await liveDevice(db, link.deviceId);
        if (!device) return;
        const classes = advertisedClasses(device.capabilities);
        for (const row of await store.unacked(db, link.deviceId)) {
            if (!classes.includes(row.class)) { await store.markRefused(db, row.id, 'bot.class_unadvertised', now()); continue; }
            if (link.send('job', { job: json(row.job, {}) })) await store.markSent(db, row.id, now());
        }
        for (const { id } of await store.cancelPending(db, link.deviceId)) link.send('job_cancel', { id });
    }

    async function onFrame(link, msg) {
        const v = validate(FRAME, msg);
        if (!v.valid) return link.error('bot.bad_frame', `not a valid ${FRAME} ${msg.type}: ${brief(v.errors)}`);
        switch (msg.type) {
            case 'job_started': return onStarted(link, msg);
            case 'job_stdout': return onStdout(link, msg);
            case 'job_usage': return onUsage(link, msg);
            case 'job_exit': return onExit(link, msg);
            default: return link.error('bot.unknown_message', `unknown type ${msg.type}`);
        }
    }
    const unknown = (link, id) => link.error('bot.unknown_job', `no job ${id} on this device`);

    async function onStarted(link, msg) {
        const db = getDb();
        const row = await store.ofNode(db, msg.id, link.deviceId);
        if (!row) return unknown(link, msg.id);
        await store.markStarted(db, row.id, msg.started_ms, now());
        // It started although a cancel was asked (the cancel crossed it, or the link dropped): ask again.
        if (row.cancel_requested && row.exit_reason == null) link.send('job_cancel', { id: row.id });
        return undefined;
    }

    /** Best effort, never metered: the last 1 MiB per job; a chunk_seq already held is dropped. */
    async function onStdout(link, msg) {
        let ring = rings.get(msg.id);
        if (!ring) {
            if (!await store.ofNode(getDb(), msg.id, link.deviceId)) return unknown(link, msg.id);
            ring = rings.get(msg.id) || { nodeId: link.deviceId, chunks: [], bytes: 0, lastSeq: 0, dropped: false };
            rings.set(msg.id, ring);
            if (rings.size > STDOUT_JOBS) rings.delete(rings.keys().next().value);
        }
        if (ring.nodeId !== link.deviceId) return unknown(link, msg.id);
        if (msg.chunk_seq <= ring.lastSeq) return undefined;
        const bytes = Buffer.byteLength(msg.chunk, 'utf8');
        ring.chunks.push({ seq: msg.chunk_seq, chunk: msg.chunk, bytes });
        ring.bytes += bytes; ring.lastSeq = msg.chunk_seq;
        while (ring.bytes > STDOUT_RING_BYTES) { const old = ring.chunks.shift(); ring.bytes -= old.bytes; ring.dropped = true; }
        return undefined;
    }

    /** The reading for one fully elapsed second, queued once; ignored after job_exit (it is authoritative). */
    async function onUsage(link, msg) {
        const db = getDb();
        let queued = false;
        const known = await db.tx(async (t) => {
            const row = await store.ofNode(t, msg.id, link.deviceId, { lock: true });
            if (!row) return false;
            if (row.exit_reason != null) return true;
            const job = json(row.job, {});
            // Never past the wall-clock cap the payer set: the Node kills the job there.
            if ((msg.second + 1) * 1000 > job.limits.wall_ms) { log.warn(`[Bot] job ${row.id}: job_usage second ${msg.second} beyond limits.wall_ms, not metered`); return true; }
            const startedMs = row.started_ms != null ? Number(row.started_ms) : msg.started_ms;
            if (row.started_ms == null) await store.markStarted(t, row.id, startedMs, now());
            queued = await metering.enqueue(t, metering.secondReading(readingFields(row, startedMs, msg.second)), now());
            await store.advanceUsage(t, row.id, msg.second + 1, now());
            return true;
        });
        if (!known) return unknown(link, msg.id);
        if (queued) kick();
        return undefined;
    }

    /**
     * The authoritative usage: write (or find already written) every second job_exit stands for, settle the job,
     * then job_exit_ack. A second job_exit writes nothing and is acked again.
     */
    async function onExit(link, msg) {
        const db = getDb();
        const known = await db.tx(async (t) => {
            const row = await store.ofNode(t, msg.id, link.deviceId, { lock: true });
            if (!row) return false;
            if (row.exit_reason != null) return true;
            const job = json(row.job, {});
            const wallMs = Math.min(msg.usage.wall_ms, job.limits.wall_ms);
            const startedMs = row.started_ms != null ? Number(row.started_ms) : (msg.usage.started_ms ?? null);
            if (wallMs > 0) {
                for (const r of metering.exitReadings({ wallMs, ...readingFields(row, startedMs) })) await metering.enqueue(t, r, now());
                await store.advanceUsage(t, row.id, Math.ceil(wallMs / 1000), now());
            }
            await store.finish(t, row.id, { reason: msg.reason, code: msg.code, result: msg.result, wallMs, startedMs, at: now() });
            return true;
        });
        if (!known) return unknown(link, msg.id);
        kick();
        link.send('job_exit_ack', { id: msg.id });
        return undefined;
    }

    function readingFields(row, startedMs, n) {
        return { jobId: row.id, n, startedMs, nodeId: row.node_id, project: row.project_id, subject: row.subject, provider: row.provider };
    }

    /** What is held of a job's stdout (the last 1 MiB), or null. */
    function stdout(jobId) {
        const ring = rings.get(jobId);
        if (!ring) return null;
        return { text: ring.chunks.map((c) => c.chunk).join(''), first_seq: ring.chunks.length ? ring.chunks[0].seq : null, last_seq: ring.lastSeq, truncated: ring.dropped };
    }

    return { onAck, onConnect, onFrame, stdout };
}

module.exports = { dispatch, cancel, createJobFrames, advertisedClasses };
