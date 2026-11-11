-- phase: expand
-- The Run session's allowed browser origins are fixed when its desk is leased.
-- Null is an older unrestricted lease; an empty array permits no network origin.
ALTER TABLE desk_leases ADD COLUMN IF NOT EXISTS task_origins JSONB;
