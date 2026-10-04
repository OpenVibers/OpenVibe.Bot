'use strict';

/**
 * run_jobs (migrations/0004_run_jobs.sql): the dispatcher's record of every job it handed to a device.
 *
 *   queued     stored; sent (again on every reconnect) until the Node acks it
 *   placed     the Node acked it
 *   running    job_started
 *   succeeded / failed / cancelled / expired   from job_exit (exited 0 / exited ≠ 0, limit, stopped, failed /
 *              cancelled / ttl); failed also when the Node nacked it
 *
 * A cancel before job_started marks the row cancelled at once; job_exit, which is authoritative, still sets the
 * final state and is still metered. exit_reason is written once, by the first job_exit: after it no usage frame
 * of the job is metered again. usage_read only moves forward (GREATEST).
 */
const STATE_OF_EXIT = { cancelled: 'cancelled', ttl: 'expired' };
const stateOfExit = (reason, code) => (reason === 'exited' && code === 0 ? 'succeeded' : STATE_OF_EXIT[reason] || 'failed');

/** Insert a new job; the same id again is a conflict unless it is the same job for the same device. → { row, created } */
async function put(db, { job, nodeId, project = null, subject = null, provider = null, at }) {
    const row = await db.maybe(
        `INSERT INTO run_jobs (id, node_id, project_id, subject, provider, class, job, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $8) ON CONFLICT (id) DO NOTHING RETURNING *`,
        [job.id, nodeId, project, subject, provider, job.class, JSON.stringify(job), at]);
    if (row) return { row, created: true };
    return { row: await get(db, job.id), created: false };
}

const get = (db, id) => db.maybe('SELECT * FROM run_jobs WHERE id = $1', [id]);
/** The job, only if it belongs to this device: a Node never reads or meters another device's job. */
const ofNode = (db, id, nodeId, { lock = false } = {}) => db.maybe(`SELECT * FROM run_jobs WHERE id = $1 AND node_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, nodeId]);

/** Unacked, uncancelled jobs of a device, oldest first: what a reconnect resends. */
const unacked = (db, nodeId) => db.many(`SELECT * FROM run_jobs WHERE node_id = $1 AND state = 'queued' AND NOT cancel_requested ORDER BY created_at, id`, [nodeId]);
/** Jobs a cancel was asked for that the device may still hold (sent, no job_exit yet). */
const cancelPending = (db, nodeId) => db.many(`SELECT id FROM run_jobs WHERE node_id = $1 AND cancel_requested AND sent_at IS NOT NULL AND exit_reason IS NULL AND finished_at IS NULL ORDER BY created_at, id`, [nodeId]);

const markSent = (db, id, at) => db.exec('UPDATE run_jobs SET sent_at = COALESCE(sent_at, $2), updated_at = $2 WHERE id = $1', [id, at]);
const markPlaced = (db, id, at) => db.exec(`UPDATE run_jobs SET state = 'placed', updated_at = $2 WHERE id = $1 AND state = 'queued'`, [id, at]);
/** The Node refused it (nack), or Bot stopped sending it: failed, ended, nothing to meter. */
const markRefused = (db, id, faultCode, at) => db.exec(
    `UPDATE run_jobs SET state = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END, fault_code = $2, finished_at = $3, updated_at = $3
     WHERE id = $1 AND state IN ('queued', 'placed', 'cancelled') AND exit_reason IS NULL AND finished_at IS NULL`, [id, faultCode, at]);
/** job_started: the first started_ms is kept (it anchors every second); running unless job_exit already came. */
const markStarted = (db, id, startedMs, at) => db.exec(
    `UPDATE run_jobs SET started_ms = COALESCE(started_ms, $2), state = CASE WHEN exit_reason IS NULL THEN 'running' ELSE state END, updated_at = $3
     WHERE id = $1`, [id, startedMs, at]);
/** A cancel: a job that has not started is cancelled now; a running one ends with its job_exit. → the row */
const requestCancel = (db, id, at) => db.maybe(
    `UPDATE run_jobs SET cancel_requested = true, state = CASE WHEN state IN ('queued', 'placed') THEN 'cancelled' ELSE state END, updated_at = $2
     WHERE id = $1 RETURNING *`, [id, at]);
/** Seconds queued so far; never moves back. */
const advanceUsage = (db, id, upTo, at) => db.exec('UPDATE run_jobs SET usage_read = GREATEST(usage_read, $2), updated_at = $3 WHERE id = $1', [id, upTo, at]);
/** The first job_exit: final state and exit fields, once. */
const finish = (db, id, { reason, code, result, wallMs, startedMs, at }) => db.exec(
    `UPDATE run_jobs SET state = $2, exit_reason = $3, exit_code = $4, result = $5, wall_ms = $6, started_ms = COALESCE(started_ms, $7),
            finished_at = COALESCE(finished_at, $8), updated_at = $8
     WHERE id = $1 AND exit_reason IS NULL`,
    [id, stateOfExit(reason, code), reason, code, result === undefined || result === null ? null : JSON.stringify(result), wallMs, startedMs, at]);

module.exports = { put, get, ofNode, unacked, cancelPending, markSent, markPlaced, markRefused, markStarted, requestCancel, advanceUsage, finish, stateOfExit };
