#!/bin/sh
# Export OpenVibe.Live's stream controls for the one-time conversion into Bot robots (plan T15 R9 step 5).
#
#   sudo -u postgres scripts/live-controls-export.sh ov_live > export.json
#   scripts/live-controls-export.sh 'postgresql://reader@host/ov_live' > export.json
#
# Live runs on PostgreSQL (ov_live, since 2026-10-08). The argument is anything `psql -d` takes: a database name
# (with the caller's own access, as above) or a connection string. Read-only: the session is opened with
# default_transaction_read_only, so nothing can be written, and the one statement reads one snapshot.
# The one document carries only what the conversion needs:
#
#   configs                 every control_configs row (id, user_id, name)
#   buttons                 every control_config_buttons row of those configs
#   whitelist               control_whitelist rows for the config owners' channels (user_id, owner_user_id)
#   latest_stream_controls  the stream_controls rows of each config owner's most recent stream only
#   owners                  only the config owners and whitelisted users: id, username, subject_id
#
# No other personal data (no email, no password hash, no addresses). It prints one JSON document to stdout and
# nothing else.
set -eu

DB=${1:-}
if [ -z "$DB" ]; then
    echo "usage: live-controls-export.sh <database name or connection string for Live's PostgreSQL (ov_live)>" >&2
    exit 2
fi
command -v psql >/dev/null 2>&1 || { echo "live-controls-export: psql is not installed" >&2; exit 1; }

# The Network subject of a Live account: linked_accounts (service 'network') first, then subject_projection by the
# linked Network user id, for an account whose link row is missing the subject.
SUBJECT="COALESCE(
    (SELECT la.subject_id FROM linked_accounts la WHERE la.service = 'network' AND la.user_id = u.id AND left(la.subject_id, 4) = 'usr_' LIMIT 1),
    (SELECT sp.subject_id FROM subject_projection sp
        WHERE sp.network_user_id::text = (SELECT la.service_user_id FROM linked_accounts la WHERE la.service = 'network' AND la.user_id = u.id LIMIT 1)
          AND left(sp.subject_id, 4) = 'usr_' LIMIT 1))"

# The config owners: an owner's channel is unique (channels.user_id UNIQUE), which is what the whitelist is
# keyed by. Whitelisted users are only those on a config owner's channel.
OWNERS="SELECT user_id FROM control_configs UNION SELECT w.user_id FROM control_whitelist w JOIN channels c ON c.id = w.channel_id WHERE c.user_id IN (SELECT user_id FROM control_configs)"

# The most recent stream per config owner (a live session's started_at, else when the row was created), then that
# stream's controls. stream_config_id says which config the copy came from, so the conversion can tell an override
# of this config from a stream bound to another one.
SQL="SELECT json_build_object(
  'exported_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'configs', COALESCE((SELECT json_agg(t ORDER BY t.id) FROM (SELECT id, user_id, name FROM control_configs) t), '[]'::json),
  'buttons', COALESCE((SELECT json_agg(t ORDER BY t.config_id, t.sort_order, t.id) FROM (
      SELECT b.id, b.config_id, b.label, b.command, b.control_type, b.key_binding, b.cooldown_ms, b.is_enabled, b.sort_order
      FROM control_config_buttons b JOIN control_configs c ON c.id = b.config_id) t), '[]'::json),
  'whitelist', COALESCE((SELECT json_agg(t ORDER BY t.id) FROM (
      SELECT w.id, w.user_id, c.user_id AS owner_user_id FROM control_whitelist w JOIN channels c ON c.id = w.channel_id
      WHERE c.user_id IN (SELECT user_id FROM control_configs)) t), '[]'::json),
  'latest_stream_controls', COALESCE((SELECT json_agg(t ORDER BY t.stream_id, t.sort_order, t.id) FROM (
      WITH latest AS (
          SELECT s.user_id, s.id AS stream_id, s.control_config_id,
                 ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id DESC) AS rn
          FROM streams s WHERE s.user_id IN (SELECT user_id FROM control_configs))
      SELECT sc.id, sc.stream_id, latest.user_id AS owner_user_id, latest.control_config_id AS stream_config_id,
             sc.label, sc.command, sc.control_type, sc.key_binding, sc.cooldown_ms, sc.is_enabled, sc.sort_order
      FROM latest JOIN stream_controls sc ON sc.stream_id = latest.stream_id
      WHERE latest.rn = 1) t), '[]'::json),
  'owners', COALESCE((SELECT json_agg(t ORDER BY t.id) FROM (
      SELECT u.id, u.username, $SUBJECT AS subject_id FROM users u WHERE u.id IN ($OWNERS)) t), '[]'::json)
);"

PGOPTIONS='-c default_transaction_read_only=on' psql -X -q -A -t -v ON_ERROR_STOP=1 -d "$DB" -c "$SQL"
