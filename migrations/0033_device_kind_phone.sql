-- phase: expand
-- Link on the phone (plan 2026-11-07 §13.2): a Network-paired phone binds as a device of its own kind. It serves no
-- robot and publishes no video; it is the person's device, with their subject and no robot ids. Every kind made
-- before keeps it.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_kind_check;
ALTER TABLE devices ADD CONSTRAINT devices_kind_check
    CHECK (kind IN ('onboard', 'bridge', 'server', 'phone'));
