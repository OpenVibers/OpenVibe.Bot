-- phase: expand
--
-- The robot directory (plan T15, /robots): an owner may list a robot publicly. A listed robot has a public page
-- (/r/:id) and appears in the directory with its model and online state; anyone may watch it there (read-only, the
-- /watch view), so listing also turns on embed_public. Additive only: off for every existing robot.

ALTER TABLE robots ADD COLUMN listed boolean NOT NULL DEFAULT false;
ALTER TABLE robots ADD COLUMN listed_at timestamptz;
CREATE INDEX IF NOT EXISTS robots_listed_idx ON robots (listed_at DESC) WHERE listed;
