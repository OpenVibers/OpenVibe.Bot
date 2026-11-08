-- phase: expand
-- The guided first run (OpenVibe Link's `openvibe-node`, docs/install.md#first-run-guided-and-measured): one row per
-- device and step, from the `node.first_run` telemetry events the Link sends over its existing device link. It powers
-- the machines page's figures for a machine's first job and the admin funnel (how many installs reach each step, and
-- how long each took). The fields are an allowlist: no path, username or address is stored.
CREATE TABLE IF NOT EXISTS device_first_run (
    device_id     text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    step          text NOT NULL CHECK (step IN ('installed', 'paired', 'self_check', 'first_job')),
    at            timestamptz NOT NULL,
    agent_version text,
    os            text,
    ok            boolean,
    reason        text,
    info          jsonb NOT NULL DEFAULT '{}'::jsonb,
    received_at   timestamptz NOT NULL,
    PRIMARY KEY (device_id, step)
);
-- The admin funnel reads every step in time order; the machines page reads one machine's first_job (the primary key).
CREATE INDEX IF NOT EXISTS device_first_run_at ON device_first_run (at);
