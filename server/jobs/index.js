'use strict';

/**
 * The jobs service (plan T14 step 6): one instance holds the device side of the dispatcher (createJobFrames,
 * with the stdout rings) for both the device socket (server/realtime.js, bound with hub.bindJobs) and the
 * internal jobs API (server/api/v1.js, bot.job.dispatch).
 *
 *   createJobs({ db, hub, usage, log, now }) → {
 *     dispatch(nodeId, job, { project, subject, provider })   → { job, sent }   validate, store, send (`job`)
 *     cancel(jobId)                                           → { job, sent }   `job_cancel`
 *     state(jobId)                                            → { job, stdout } or null when unknown
 *     frames                                                  the device side (onAck, onConnect, onFrame)
 *     stdout(jobId)                                           what is held of a job's stdout, or null
 *   }
 *
 * `db` is a getter (the domain's handle is bound after the hub exists); `hub` is the realtime hub, the link a
 * job and its cancel go out on. `job` in the answers is presentJob's view of the run_jobs row.
 */
const { dispatch, cancel, createJobFrames } = require('./dispatch');
const store = require('./store');
const { json } = require('../util');

function createJobs({ db: getDb, hub, usage = null, log = console, now = () => Date.now() }) {
    const frames = createJobFrames({ db: getDb, usage, log, now });
    const present = ({ job, sent }) => ({ job: presentJob(job), sent });
    return {
        frames,
        stdout: (jobId) => frames.stdout(jobId),
        dispatch: async (nodeId, job, opts = {}) => present(await dispatch(getDb(), nodeId, job, { link: hub, now, ...opts })),
        cancel: async (jobId, opts = {}) => present(await cancel(getDb(), jobId, { link: hub, now, ...opts })),
        async state(jobId) {
            const row = await store.get(getDb(), jobId);
            return row ? { job: presentJob(row), stdout: frames.stdout(row.id) } : null;
        },
    };
}

/** The job as the jobs API answers it: the run_jobs row (server/jobs/store.js) plus its original platform.job@1. */
function presentJob(row) {
    return {
        id: row.id, node_id: row.node_id, class: row.class, state: row.state,
        project_id: row.project_id, subject: row.subject, provider: row.provider,
        cancel_requested: row.cancel_requested, fault_code: row.fault_code,
        sent_at: row.sent_at, started_ms: row.started_ms, finished_at: row.finished_at,
        exit_reason: row.exit_reason, exit_code: row.exit_code, wall_ms: row.wall_ms,
        usage_read: row.usage_read, result: json(row.result, null), job: json(row.job, null),
        created_at: row.created_at, updated_at: row.updated_at,
    };
}

module.exports = { createJobs, presentJob };
