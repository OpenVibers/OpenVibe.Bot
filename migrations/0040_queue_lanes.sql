-- phase: expand
-- A robot's line with a fast lane (11-23, LOOI viewer turns): the owner may let people who follow their channel, or
-- their subscribers, go first. A row's lane is decided when the person joins (2 a subscriber, 1 a follower, 0 anyone)
-- and the next turn goes to the highest lane, then the earliest to join.
ALTER TABLE robot_queue ADD COLUMN IF NOT EXISTS lane smallint NOT NULL DEFAULT 0;
