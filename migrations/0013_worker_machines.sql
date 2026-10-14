-- phase: expand
-- Plan T14/T16: a person's own machine that runs jobs for them (a worker) and serves no robot. Its owner is stored on
-- the device; a robot's device keeps NULL here and is owned by its robot's owner.
ALTER TABLE devices ADD COLUMN owner_subject text;
CREATE INDEX devices_owner ON devices (owner_subject) WHERE owner_subject IS NOT NULL AND revoked_at IS NULL;
