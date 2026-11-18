-- phase: expand
-- Machines lend more to other people (the owner, 2026-11-14: "desktop agents and running codes sessions and agents …
-- shared for all users"; OpenVibe.Link v0.65.0). Two more owner switches, off until the owner turns them on on
-- openvibe.link/machines, each only where the machine's own Link says it can keep the work away from the machine:
--   shared_desktops  lend whole desktops to other people's agents (the Link lends desktops: desk.kinds has desktop,
--                    desk.isolation sandbox), leased through OpenVibe.Run sessions like the browser desks;
--   shared_jobs      run other people's jobs, coding tasks and agents (the Link's worker.serve_others), placed by
--                    OpenVibe.Run on its community offer; such a job never gets the owner's sign-ins.
-- A lease may now be a whole desktop as well as a browser (contracts 0.433.0).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS shared_desktops boolean NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS shared_jobs boolean NOT NULL DEFAULT false;
ALTER TABLE desk_leases DROP CONSTRAINT IF EXISTS desk_leases_kind_check;
ALTER TABLE desk_leases ADD CONSTRAINT desk_leases_kind_check CHECK (kind IN ('browser', 'desktop'));
