-- phase: expand
-- Plan T14 (contracts 0.182.0): the machine's own private OpenRestream stream that shows its screen live to its owner
-- (playback private, never recorded or mirrored to Live; external ref bot:machine:<id>). Null until the owner first
-- shows the screen; each start rotates the stream's key.
ALTER TABLE devices ADD COLUMN screen_stream_id text;
