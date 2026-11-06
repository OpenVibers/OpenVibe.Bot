-- phase: expand
-- Commissioned per-robot limits: the owner may raise max_speed/max_turn above the profile's default, up to
-- the profile's hardware ceiling, only after commissioning that robot. Without commissioning the profile
-- defaults still clamp every value; uncommissioning drops back to them at once.
ALTER TABLE robots ADD COLUMN commissioned_at timestamptz;
ALTER TABLE robots ADD COLUMN commissioned_by text;   -- the owner's usr_ subject
