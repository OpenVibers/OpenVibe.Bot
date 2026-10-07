#!/bin/sh
# Export OpenVibe.Live's stream controls for the one-time conversion into Bot robots (plan T15 R9 step 5).
#
#   scripts/live-controls-export.sh <path to Live's SQLite file> > export.json
#
# Read-only: every read is `sqlite3 -readonly -json`, so the file is never written and no journal is made.
# The one document carries only what the conversion needs:
#
#   configs                 every control_configs row (id, user_id, name)
#   buttons                 every control_config_buttons row of those configs
#   whitelist               control_whitelist rows for the config owners' channels (user_id, owner_user_id)
#   latest_stream_controls  the stream_controls rows of each config owner's most recent stream only
#   owners                  only the config owners and whitelisted users: id, username, subject_id
#
# No other personal data (no email, no password hash, no addresses). Run it on the Live host, where DB_PATH
# points at the file; it prints one JSON document to stdout and nothing else.
set -eu

DB=${1:-}
if [ -z "$DB" ]; then
    echo "usage: live-controls-export.sh <path to Live's SQLite file>" >&2
    exit 2
fi
if [ ! -f "$DB" ]; then
    echo "live-controls-export: no such database file: $DB" >&2
    exit 1
fi
command -v sqlite3 >/dev/null 2>&1 || { echo "live-controls-export: sqlite3 is not installed" >&2; exit 1; }

# Rows as a JSON array (sqlite3's -json; an empty result prints nothing, normalised below).
rows() { sqlite3 -readonly -json "$DB" "$1"; }
# One scalar.
one() { sqlite3 -readonly "$DB" "$1"; }

# Which columns/tables this Live database has: the Network subject of a Live account lives in
# linked_accounts (service 'network'), with subject_projection as the fallback for an account whose link
# row is missing the subject; a future users.subject_id is honoured when present.
users_has_subject=$(one "SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'subject_id';")
has_linked=$(one "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'linked_accounts';")
has_projection=$(one "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'subject_projection';")

SUBJECT='NULL'
if [ "$users_has_subject" = "1" ]; then SUBJECT="NULLIF(u.subject_id, '')"; fi
if [ "$has_linked" = "1" ]; then
    LINKED="(SELECT la.subject_id FROM linked_accounts la WHERE la.service = 'network' AND la.user_id = u.id AND substr(la.subject_id, 1, 4) = 'usr_' LIMIT 1)"
    if [ "$SUBJECT" = 'NULL' ]; then SUBJECT="$LINKED"; else SUBJECT="COALESCE($SUBJECT, $LINKED)"; fi
    if [ "$has_projection" = "1" ]; then
        PROJECTED="(SELECT sp.subject_id FROM subject_projection sp WHERE sp.network_user_id = CAST((SELECT la.service_user_id FROM linked_accounts la WHERE la.service = 'network' AND la.user_id = u.id LIMIT 1) AS INTEGER) AND substr(sp.subject_id, 1, 4) = 'usr_' LIMIT 1)"
        SUBJECT="COALESCE($SUBJECT, $PROJECTED)"
    fi
fi

# The config owners: an owner's channel is unique (channels.user_id UNIQUE), which is what the whitelist is
# keyed by. Whitelisted users are only those on a config owner's channel.
OWNERS="SELECT user_id FROM control_configs UNION SELECT w.user_id FROM control_whitelist w JOIN channels c ON c.id = w.channel_id WHERE c.user_id IN (SELECT user_id FROM control_configs)"

CONFIGS=$(rows "SELECT id, user_id, name FROM control_configs ORDER BY id;")
BUTTONS=$(rows "SELECT b.id, b.config_id, b.label, b.command, b.control_type, b.key_binding, b.cooldown_ms, b.is_enabled, b.sort_order FROM control_config_buttons b JOIN control_configs c ON c.id = b.config_id ORDER BY b.config_id, b.sort_order, b.id;")
WHITELIST=$(rows "SELECT w.id, w.user_id, c.user_id AS owner_user_id FROM control_whitelist w JOIN channels c ON c.id = w.channel_id WHERE c.user_id IN (SELECT user_id FROM control_configs) ORDER BY w.id;")
# The most recent stream per config owner (a live session's started_at, else when the row was created),
# then that stream's controls. stream_config_id says which config the copy came from, so the conversion can
# tell an override of this config from a stream bound to another one.
LATEST=$(rows "WITH latest AS (
        SELECT s.user_id, s.id AS stream_id, s.control_config_id,
               ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id DESC) AS rn
        FROM streams s WHERE s.user_id IN (SELECT user_id FROM control_configs)
    )
    SELECT sc.id, sc.stream_id, latest.user_id AS owner_user_id, latest.control_config_id AS stream_config_id,
           sc.label, sc.command, sc.control_type, sc.key_binding, sc.cooldown_ms, sc.is_enabled, sc.sort_order
    FROM latest JOIN stream_controls sc ON sc.stream_id = latest.stream_id
    WHERE latest.rn = 1
    ORDER BY sc.stream_id, sc.sort_order, sc.id;")
OWNER_ROWS=$(rows "SELECT u.id, u.username, $SUBJECT AS subject_id FROM users u WHERE u.id IN ($OWNERS) ORDER BY u.id;")

printf '{"exported_at":"%s","configs":%s,"buttons":%s,"whitelist":%s,"latest_stream_controls":%s,"owners":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${CONFIGS:-[]}" "${BUTTONS:-[]}" "${WHITELIST:-[]}" "${LATEST:-[]}" "${OWNER_ROWS:-[]}"
