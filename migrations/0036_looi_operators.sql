-- phase: expand
-- LOOI Operators card (Maticus's 2026-11-12 spec): a Mod role between the owner and operators, a per-person
-- on/off switch that the command gate reads before it forwards anything, sole control for one subject, and an
-- audit of who changed authority. A Stop is now one ordinary control (a halt command), not a latch; the old
-- robots.estop_* columns are left for a later contract migration and are no longer read or written.
ALTER TABLE robot_operators DROP CONSTRAINT IF EXISTS robot_operators_role_check;
ALTER TABLE robot_operators ADD CONSTRAINT robot_operators_role_check CHECK (role IN ('owner', 'operator', 'viewer', 'mod'));
ALTER TABLE robot_operators ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- Sole control: one controlling subject at a time, or no row/sole_subject for Everyone. The owner always overrides.
CREATE TABLE IF NOT EXISTS robot_operator_control (
    robot_id     text PRIMARY KEY REFERENCES robots(id) ON DELETE CASCADE,
    sole_subject text,
    sole_by      text,
    sole_at      timestamptz,
    updated_at   timestamptz NOT NULL
);

-- Authority changes: who granted sole control, switched someone on or off, promoted or demoted a Mod, or
-- granted or cleared sole control. Subjects and roles only: no command values, tokens or secrets.
CREATE TABLE IF NOT EXISTS robot_operator_audit (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    robot_id      text NOT NULL,
    actor_subject text,
    actor_kind    text,
    actor_role    text,
    action        text NOT NULL,
    subject       text,
    role          text,
    value         jsonb NOT NULL DEFAULT '{}'::jsonb,
    at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS robot_operator_audit_robot ON robot_operator_audit (robot_id, id DESC);
CREATE INDEX IF NOT EXISTS robot_operator_audit_at ON robot_operator_audit (at);
