-- phase: expand
--
-- The robot's OpenRe stream (T15 R5): OpenRe's WHIP worker admits only its own ingest keys, so a device's
-- publish key is the ingest key of its robot's OpenRe stream. Bot keeps the stream's id and, per device, the
-- key's hint (its last characters, as OpenRe shows them); never the key. Additive only: publish_key_hash stays
-- for rows written before this and is no longer written.

ALTER TABLE robots ADD COLUMN openre_stream_id text;    -- OpenRe stream definition id; NULL until a device gets a key
ALTER TABLE devices ADD COLUMN publish_key_hint text;   -- hint of the OpenRe key this device holds; NULL: it holds none
