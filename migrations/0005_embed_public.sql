-- phase: expand
--
-- Embeddable panel (plan T15 step R9): an owner may opt a robot in to anonymous, read-only embedding, so a page
-- on an allow-listed origin (OpenVibe.Live's channel page) can show the robot's video and readouts to anyone.
-- Additive only: one new column, off for every existing robot, nothing to backfill. The controls are never
-- part of it. The flag is web-only: /api/v1 responses do not carry it.

ALTER TABLE robots ADD COLUMN embed_public boolean NOT NULL DEFAULT false;
