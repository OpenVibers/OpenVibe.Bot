-- phase: expand
--
-- Jobs on the device link (plan T14 step L1; platform.job@1 inside platform.job-frame@1): Bot is the dispatcher
-- that hands a job to a paired Node and meters it per wall-clock second for Billing. Additive only: two new
-- tables, nothing existing changes, nothing to backfill.
--
--   run_jobs          one row per job id: what was sent, to which device, its state and how far it is metered
--   run_usage_outbox  platform.usage-sample@1 readings waiting for Billing (the openvibe-sdk outboxSchema shape).
--                     event_id is the reading's idempotency_key run:<job id>:<second>, so a second is queued once
--                     however often the Node reports it.

CREATE TABLE IF NOT EXISTS run_jobs (
    id               text PRIMARY KEY CHECK (id ~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'),   -- platform.job@1 id
    node_id          text NOT NULL REFERENCES devices (id),   -- dev_…: the device whose Node runs it
    project_id       text,                                    -- prj_… of the payer; no FK, Bot holds no projects
    subject          text,                                    -- who the readings are for (user:usr_…)
    provider         text,
    class            text NOT NULL,
    job              jsonb NOT NULL,                          -- the platform.job@1 body, resent verbatim until acked
    state            text NOT NULL CHECK (state IN ('queued', 'placed', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
    cancel_requested boolean NOT NULL DEFAULT false,
    fault_code       text,                                    -- the Node's nack, or why Bot stopped sending it
    sent_at          bigint,                                  -- first time the job frame went out (ms)
    started_ms       bigint,                                  -- the Node's started_ms: anchors every usage second
    wall_ms          bigint,                                  -- job_exit.usage.wall_ms as billed (capped at limits.wall_ms)
    usage_read       integer NOT NULL DEFAULT 0 CHECK (usage_read >= 0),   -- seconds queued for Billing; never moves back
    exit_reason      text,                                    -- job_exit.reason; set once, by the first job_exit
    exit_code        integer,
    result           jsonb,
    created_at       bigint NOT NULL,
    updated_at       bigint NOT NULL,
    finished_at      bigint
);
-- Resend on reconnect: a device's unacked jobs, oldest first; the cancel sweep of the same device.
CREATE INDEX IF NOT EXISTS run_jobs_node_state ON run_jobs (node_id, state, created_at);

-- ── Usage readings for Billing: the openvibe-sdk outbox (outboxSchema('run_usage_outbox')) ─────────
CREATE TABLE IF NOT EXISTS run_usage_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS run_usage_outbox_due ON run_usage_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS run_usage_outbox_sent ON run_usage_outbox (sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_usage_outbox_rejected ON run_usage_outbox (id) WHERE rejected_at IS NOT NULL;
