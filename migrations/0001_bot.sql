-- phase: expand
--
-- OpenVibe.Bot on PostgreSQL (ADR-035, ADR-043): robots, devices, pairing, operators, the command audit,
-- the shipped profiles and the timed public turn queue. Bot is a new service, so this is written as the
-- final schema (no expand/migrate/contract window).
--
--   robots           what the owner sees and shares (rob_…)
--   devices          a running agent attached to one or more robots (dev_…)
--   pairing_codes    one-time pairing codes; only the hash is stored
--   robot_operators  owner / operator / viewer per robot
--   command_audit    every command, allowed or refused, pruned after 30 days
--   robot_profiles   the shipped profiles, validated before insert
--   robot_queue      the timed public turn queue (access_policy 'queue')
--   bot_event_outbox the openvibe-sdk transactional outbox (outboxSchema('bot_event_outbox'))
--
-- Every query shape the code runs has an index; the comment above each index names the queries.
-- Locks are always taken in one order: the robot row, then robot_queue, then devices (never the reverse).

-- ── Robots ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE robots (
    id              text PRIMARY KEY,                    -- rob_<ULID>
    owner_subject   text NOT NULL,                       -- usr_…
    name            text NOT NULL,
    profile_id      text NOT NULL,                       -- e.g. adeept.adr036
    profile_version integer NOT NULL DEFAULT 1,
    access_policy   text NOT NULL DEFAULT 'private' CHECK (access_policy IN ('private', 'invite', 'queue')),
    limits          jsonb NOT NULL DEFAULT '{}',         -- owner-set: max_speed, max_turn, max_command_ms, turn_ms, turn_budget, cooldown_ms, allow
    estop_latched   boolean NOT NULL DEFAULT false,
    estop_by        text,                                -- the principal that latched it, or 'device'
    estop_at        timestamptz,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL
);
-- The owner's robots, newest first; robots by profile (the gallery).
CREATE INDEX robots_owner ON robots (owner_subject, created_at DESC);
CREATE INDEX robots_profile ON robots (profile_id, created_at DESC);

-- ── Devices ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE devices (
    id                   text PRIMARY KEY,               -- dev_<ULID>
    robot_ids            jsonb NOT NULL DEFAULT '[]',    -- rob_… ids this device serves (first is primary)
    name                 text,
    kind                 text NOT NULL CHECK (kind IN ('onboard', 'bridge', 'server')),
    agent_version        text,
    drivers              jsonb NOT NULL DEFAULT '[]',    -- declared by the device at pairing
    capabilities         jsonb NOT NULL DEFAULT '{}',    -- declared by the device at pairing
    credential_hash      text NOT NULL,                  -- sha256 of the 32-byte device credential
    credential_prev_hash text,                           -- the previous credential, valid until prev_valid_until
    prev_valid_until     timestamptz,
    publish_key_hash     text,                           -- sha256 of the WHIP publish key (OpenRe)
    last_seen            timestamptz,
    revoked_at           timestamptz,
    created_at           timestamptz NOT NULL,
    updated_at           timestamptz NOT NULL
);
-- Credential lookup on every device upgrade; only live devices are candidates.
CREATE UNIQUE INDEX devices_credential ON devices (credential_hash) WHERE revoked_at IS NULL;
CREATE INDEX devices_prev_credential ON devices (credential_prev_hash) WHERE revoked_at IS NULL AND credential_prev_hash IS NOT NULL;
-- Devices for one robot (robot_ids contains rob_…): the owner's device list.
CREATE INDEX devices_robot ON devices USING gin (robot_ids jsonb_path_ops);

-- ── Pairing codes ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE pairing_codes (
    id          text PRIMARY KEY,                        -- pair_<ULID>
    robot_id    text NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
    code_hash   text NOT NULL,                           -- sha256 of the normalised code
    created_by  text,
    expires_at  timestamptz NOT NULL,
    tries       integer NOT NULL DEFAULT 0,              -- wrong tries against this code; 5 ends it
    used_at     timestamptz,
    created_at  timestamptz NOT NULL
);
-- Redeem looks a code up by its hash; create replaces a robot's unused code.
CREATE UNIQUE INDEX pairing_codes_hash ON pairing_codes (code_hash);
CREATE INDEX pairing_codes_robot ON pairing_codes (robot_id, created_at DESC);

-- ── Operators ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE robot_operators (
    robot_id   text NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
    subject    text NOT NULL,                            -- usr_… (owner, invited operator, viewer)
    role       text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
    added_by   text,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (robot_id, subject)
);
-- The role a signed-in person has on a robot (join), and "robots I may act on".
CREATE INDEX robot_operators_subject ON robot_operators (subject, robot_id);

-- ── Command audit ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE command_audit (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    robot_id         text NOT NULL,
    device_id        text,
    operator_subject text,                               -- the person, or the subject a service acted for
    operator_kind    text,                               -- user | service
    role             text,                               -- owner | operator | viewer | null
    kind             text,                               -- drive | actuator | ptz | say | display | halt | estop
    value            jsonb NOT NULL DEFAULT '{}',        -- a small summary (clamped axes, servo, text length), never a credential
    result           text NOT NULL CHECK (result IN ('ack', 'nack', 'refused', 'expired')),
    reason           text,
    latency_ms       integer,
    at               timestamptz NOT NULL
);
-- The owner's paged audit for one robot, newest first (keyset on (at, id)).
CREATE INDEX command_audit_robot ON command_audit (robot_id, id DESC);
-- The 30-day prune.
CREATE INDEX command_audit_at ON command_audit (at);

-- ── Profiles ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE robot_profiles (
    id         text NOT NULL,                            -- e.g. cozmo
    version    integer NOT NULL,
    profile    jsonb NOT NULL,                           -- validated server/profiles/*.json
    created_at timestamptz NOT NULL,
    PRIMARY KEY (id, version)
);

-- ── Turn queue ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE robot_queue (
    robot_id        text NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
    subject         text NOT NULL,                       -- usr_…
    joined_at       timestamptz NOT NULL,
    state           text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'active', 'done')),
    turn_started_at timestamptz,
    turn_ends_at    timestamptz,
    commands_used   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (robot_id, subject)
);
-- The active turn and the waiting order (promote the oldest waiting).
CREATE INDEX robot_queue_order ON robot_queue (robot_id, joined_at);
CREATE INDEX robot_queue_active ON robot_queue (robot_id) WHERE state = 'active';

-- ── Events: the openvibe-sdk outbox (outboxSchema('bot_event_outbox')) ───────────────────────────
CREATE TABLE IF NOT EXISTS bot_event_outbox (
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
CREATE INDEX IF NOT EXISTS bot_event_outbox_due ON bot_event_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS bot_event_outbox_sent ON bot_event_outbox (sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_event_outbox_rejected ON bot_event_outbox (id) WHERE rejected_at IS NOT NULL;
