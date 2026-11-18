-- phase: expand
-- What a machine is (OpenVibe Link v0.66 sends it with its status; the owner, 2026-11-14: every operating system and
-- "aware of specs"): its OS and version, CPU, memory, GPUs, free disk, virtualization and display, bounded by
-- server/machine-specs.js. The owner's card shows it; placement sizes desks, jobs and models by it. NULL until a Link
-- that reads it connects.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS specs jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS specs_at timestamptz;
