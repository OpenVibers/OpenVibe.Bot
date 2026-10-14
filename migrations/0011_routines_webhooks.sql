-- phase: expand
--
-- Robot routines and webhooks (plan T15 "schedules and automations … webhooks"). Additive only.
--
-- robot_routines: an owner's named sequence of steps (server/routines.js parses its text form against the robot's
-- profile), run on demand, on a schedule (every N minutes, or daily at a UTC time on chosen weekdays) or when the robot
-- comes online. Each step passes the same gate as a person's command, as the owner.
--
-- robot_webhooks / robot_webhook_deliveries: an owner's https endpoint for the robot's bot.* events. A delivery row is
-- written in the transaction that emits the event (server/domain emit), so it exists exactly when the event does; the
-- sender (server/webhooks.js) signs each with the hook's secret (X-OpenVibe-Signature-V2, as Events deliveries are) and
-- retries with backoff. The secret is shown once when the hook is made; deleting a robot deletes its hooks.

CREATE TABLE IF NOT EXISTS robot_routines (
    id           text PRIMARY KEY,                                        -- rtn_…
    robot_id     text NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
    name         text NOT NULL,
    source       text NOT NULL,                                           -- the steps as the owner wrote them
    steps        jsonb NOT NULL,                                          -- the parsed steps
    trigger      jsonb NOT NULL,                                          -- { type: manual | schedule | online, … }
    enabled      boolean NOT NULL DEFAULT true,
    next_run_at  timestamptz,                                             -- schedule only
    last_run_at  timestamptz,
    last_result  text,                                                    -- running | done | stopped: <why>
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL,
    updated_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS robot_routines_robot_idx ON robot_routines (robot_id);
CREATE INDEX IF NOT EXISTS robot_routines_due_idx ON robot_routines (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS robot_webhooks (
    id          text PRIMARY KEY,                                         -- whk_…
    robot_id    text NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
    url         text NOT NULL,
    events      text[] NOT NULL,
    secret      text NOT NULL,                                            -- whsec_…, shown once; signs deliveries
    enabled     boolean NOT NULL DEFAULT true,
    created_by  text NOT NULL,
    created_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS robot_webhooks_robot_idx ON robot_webhooks (robot_id);

CREATE TABLE IF NOT EXISTS robot_webhook_deliveries (
    id          text PRIMARY KEY,                                         -- whd_…
    webhook_id  text NOT NULL REFERENCES robot_webhooks(id) ON DELETE CASCADE,
    event_type  text NOT NULL,
    body        text NOT NULL,                                            -- the exact JSON that is signed and sent
    state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
    attempts    integer NOT NULL DEFAULT 0,
    due_at      timestamptz NOT NULL,
    last_status integer,
    last_error  text,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS robot_webhook_deliveries_due_idx ON robot_webhook_deliveries (due_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS robot_webhook_deliveries_hook_idx ON robot_webhook_deliveries (webhook_id, created_at DESC);
