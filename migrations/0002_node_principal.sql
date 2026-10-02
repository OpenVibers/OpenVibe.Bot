-- phase: expand
--
-- The node principal (T2 lane B, OpenVibe.Network docs/t2-cells-and-node-principal.md §9.2 B1): a device may
-- be bound to a Network node principal (nod_…) instead of holding a Bot credential. Dual-accept, additive only:
-- every credential device keeps working unchanged; a Network-paired device has node_principal and no
-- credential_hash. The existing devices_credential unique index already ignores revoked rows, and NULLs never
-- collide in it.

ALTER TABLE devices ADD COLUMN node_principal text;   -- nod_<ULID>, Network's principal; NULL for a credential device
-- bindNode: the live device of one principal (at most one).
CREATE UNIQUE INDEX devices_node_principal ON devices (node_principal) WHERE node_principal IS NOT NULL AND revoked_at IS NULL;
ALTER TABLE devices ALTER COLUMN credential_hash DROP NOT NULL;
