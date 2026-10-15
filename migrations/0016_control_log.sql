-- phase: expand
-- ADR-048 amendment 2026-10-15 (server/api/resource-control.js): the first answer to each control request
-- OpenVibe.Services sent for a person's robot, per (caller, idempotency_key), so a retry is never applied twice.
CREATE TABLE bot_control_log (
    caller          text COLLATE "C" NOT NULL,                    -- the service that asked (svc:services)
    idempotency_key text COLLATE "C" NOT NULL,
    owner_subject   text COLLATE "C" NOT NULL,                    -- the robot's owner the request named
    digest          text COLLATE "C" NOT NULL,                    -- the request without its delivery fields
    response        jsonb NOT NULL,
    created_at      timestamptz NOT NULL,
    PRIMARY KEY (caller, idempotency_key)
);
