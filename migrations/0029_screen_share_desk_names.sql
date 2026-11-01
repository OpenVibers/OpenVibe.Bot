-- phase: expand
-- A screen share link may show any desk the machine has (plan L55): main, private, or desk-<name> — the desk an
-- agent task works on, watched in a chat turn. The check grows; the links made before keep the desk they had.
ALTER TABLE machine_screen_shares DROP CONSTRAINT IF EXISTS machine_screen_shares_desk_check;
ALTER TABLE machine_screen_shares ADD CONSTRAINT machine_screen_shares_desk_check
    CHECK (desk IN ('main', 'private') OR desk ~ '^desk-[a-z0-9][a-z0-9-]{0,23}$');
