-- phase: expand
-- Owner takeover (a LOOI driver's reviewers asked for it, 2026-10-24): an owner or operator who drives a queue robot while
-- someone holds the turn pauses that turn, and Bot halts the robot before their command. paused_at is when, paused_by
-- the role that took over (owner | operator). The turn's clock stops while paused: on resuming, turn_ends_at moves on
-- by the paused time (server/domain/index.js currentTurn).
ALTER TABLE robot_queue ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE robot_queue ADD COLUMN IF NOT EXISTS paused_by text;
