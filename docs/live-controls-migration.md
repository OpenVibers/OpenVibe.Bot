# Moving OpenVibe.Live's stream controls into Bot (plan T15, row R9)

Status: steps 1–3 built in Contracts 0.109.0 and Bot, 2026-10-07. Live still serves its controls; steps 4–6 remain.

## What Live has today

Live's "camp controls" (`server/controls/`, `public/js/controls.js`, `public/js/onvif-dashboard.js`, about 3,750
lines) let viewers drive a streamer's hardware from the channel page:

- **Buttons**: a viewer presses a labelled button (`{type:'command', command}`), optionally bound to a key, with a
  per-button cooldown; the server relays the command string to the streamer's **hardware client** (usually a
  Raspberry Pi script) over a WebSocket authenticated with the stream key.
- **Hold keys**: `key_down`/`key_up` become `key_held`/`key_released` on the hardware client.
- **Video click**: a click on the video sends normalised coordinates (`video_click`), with its own cooldown.
- **ONVIF cameras**: pan/tilt/zoom moves sent by the server itself to a configured camera.
- **Access**: controls on/off per stream, login required, an optional whitelist, a global per-viewer rate limit.
- **Data** (production, 2026-10-07): 4 `control_configs` (users 1, 80, 275), their `control_config_buttons`,
  11,725 `stream_controls` rows (each stream copies its owner's buttons; 1,390 streams), `control_whitelist`, and
  `cameras`/`camera_profiles`/`camera_presets` (0 profiles, 0 presets).

## Where each piece goes in Bot

| Live | Bot |
|---|---|
| A control config (an owner's set of buttons) | A **robot** owned by the same person, with a **robot-local profile** built from the buttons |
| A button (`command`, label, key, cooldown) | A `button` command (new kind, below): `commands.button.names.<name> = { label, key, cooldown_ms }`, rendered by a `buttons` widget |
| Hold keys | The same `button` command with `hold: true` (pressed → `{kind:'button', name, state:'down'}`, released → `up`), under the device-side deadman like every hold control |
| Video click | A `point` command (new kind): `{ kind: 'point', x, y }` with `x, y ∈ [0, 1]`, rendered as a click layer on the camera tile, with its own cooldown |
| ONVIF movement | Bot's server-side ONVIF camera (`camera.onvif`, `BOT_ONVIF_CAMERAS`), already built |
| Controls on/off, login required | The robot's access policy (`private` / `invite` / `queue`); controls are never anonymous |
| Whitelist | Operators added by @username (built) |
| Per-viewer rate limit, cooldowns | The command gate's per-robot limits and cooldowns (built), plus the per-button `cooldown_ms` |
| The hardware client and its stream-key socket | The OpenVibe **Node** paired to the robot, running a **relay** plugin (below); the stream key stops being a robot credential |
| The controls panel under the video | Bot's panel embedded on the Live channel page (`/panel/:id/embed`, `LIVE_BOT_EMBED`), already built |

## What has to be built

1. **Built — Contracts 0.109.0** (minor release): `bot.command@1` gains the kinds `button` (`name`, optional `state: down|up`) and
   `point` (`x`, `y` in `[0, 1]`); `bot.robot-profile@1` gains `commands.button.names` and `commands.point`, and the
   widget types `buttons` and `video_click`. Additive; existing profiles stay valid.
2. **Built — Bot robot-local profiles**: a robot may carry its own profile (`robot_profiles` row owned by the robot,
   `profile_id = 'local.<rob_…>'`) instead of a catalogue one; the owner edits its buttons on the robot page (a
   plain form: name, label, key, cooldown, hold). Validated by the same profile schema and registries.
3. **Built — Bot gate and panel**: the gate accepts `button`/`point` only for names and shapes the profile
   declares; the panel renders `buttons` (keyboard bindings, hold behaviour) and `video_click` (a click layer on the
   camera tile, normalised coordinates).
4. **Node — the relay plugin**: forwards `button`/`point` commands to the owner's local script in the shape Live's
   hardware clients already understand — one JSON line per command on stdout of a supervised child process, or a
   loopback WebSocket that speaks Live's `{type:'command'|'key_held'|'key_released'|'video_click'}` messages — so an
   existing Pi script keeps working with a one-line change of where it connects. Local policy and the kill switch
   apply as for every plugin.
5. **The conversion** (a script in Bot, run once by the operator with a JSON export from Live's database): for each
   `control_configs` row, create the robot for the owner's Network subject (Live `users.subject_id`), a robot-local
   profile from its buttons, operators from the whitelist, and the `stream_controls` overrides of that owner's most
   recent stream where they differ. Idempotent on the Live config id. The owner then pairs a Node (the five-minute
   path) and moves the script onto the relay plugin.
6. **Live**: `LIVE_BOT_EMBED=1`; the channel page shows the robot's embedded panel for a stream whose owner has a
   robot; then delete `server/controls/*`, the hardware WebSocket path and its stream-key auth, the controls tables
   and `public/js/controls.js` / `onvif-dashboard.js` (the embed stays).

## Order and cutover

Contracts → robot-local profiles → gate/panel → relay plugin → conversion run (owners notified) → Live embed on →
owners re-pair → Live deletion. The deletion waits for the three converted owners' robots to be paired, because the
hardware clients are physical devices only their owners can move; it does not wait on a date.
