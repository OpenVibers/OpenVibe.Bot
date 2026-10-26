# OpenVibe.Bot

The open control panel for robots (openvibe.bot). Design: OpenVibe.Contracts docs/adr/ADR-043-bot-devices-and-control.md; plan track T15.

## Purpose

OpenVibe.Bot pairs a robot's machines, keeps their state and gates every operator command. A device opens one outbound WebSocket to `/device`; a person drives it from `/control` or the REST API, through the same gate — roles, per-robot limits, cooldowns and the turn budget — over a panel built from the robot's profile rather than per-robot code.

## Owns

- Robots, their profiles and each robot's limits, `allow` lists, roles and operators.
- The curated kit catalogue (`server/kits/*.json`, `GET /api/v1/kits`, `/kits/:id`): each kit's parts list and build guide, bound to a shipped profile (the Adeept ADR036 first). Metadata only — pricing, shipping and returns are the owner's (O29).
- Devices (the machines that serve a robot) and the credentials that identify them: hashed at rest, rotated and revoked, never readable back.
- Pairing: one-time codes with a short expiry, minted by Bot or, with `BOT_PAIRING_AUTHORITY=network`, by OpenVibe.Network.
- The `/device` and `/control` WebSockets, the command gate and the latched e-stop.
- The front page, `GET /` (`server/web/home.js`, `public/home.css`): the OpenVibe Frame (`openvibe-shared/shell`) around `openvibe-shared/showcase` sections that say only what works today (pairing, the panel's controls, the gate and the e-stop, people and the queue, the read-only embed, the simulator, routines, webhooks and the agent switch), and data sections rendered on the server, each left out when it has nothing to show: numbers from the catalogue, the simulated rover and the listed robots with their online state, every catalogue model with its connection kind and controls, the connection kinds with their models, the first kit's parts list, robotics jobs from OpenVibe.Search (`server/web/network-reads.js`: OpenVibe.Work's documents, read anonymously with `BOT_SEARCH_URL`, cached 15 minutes) and the questions people ask first (JSON-LD WebSite, WebApplication, ItemList and FAQPage). It has its own CSP for the Frame's calls to the Network; the rest of the site keeps `default-src 'self'`. `/shared/` is openvibe-shared's serve handler.
- The signed-in pages (`server/web/routes.js`): `/robots` to list and add robots, `/pair/:id` for a pairing code and the installer command, and `/panel/:id`, the panel rendered from the profile. A `sim.rover` robot is driven by an in-process simulator (`server/sim`), so the panel works before any hardware exists. It gets no jobs, and it is not counted as a device or reported online in the outbox. The rover lives in a small arena (`public/sim-world.js`, shared by the server and the browser): walls and crates stop it, its telemetry carries a range finder (`distance_cm`), three line sensors over a strip of tape and its pose, and its panel draws the camera from that pose (`public/sim-view.js`) with a map of the arena in the corner.
- The robot directory (`server/web/directory.js`, inside the OpenVibe Frame): `/robots` is public and lists the robots their owners list (online state, model, owner, who may drive), every model Bot drives and, signed in, your own robots; `/models` and `/models/:id` say how each model connects, its setup steps, its guide and the controls its panel gets; `/r/:id` is a listed robot's public page, watching it live through the embeddable panel; `/robots/new` adds one (name, what it is, who may drive). The owner lists a robot from its panel (`POST /robots/:id/listing`, migration 0009): listing turns on watching (`embed_public`), and turning watching off unlists it.
- Routines (`server/routines.js`): an owner writes a robot's steps one per line (`forward 2`, `right 0.5`, `wait 1`, `say Hello`, `face happy`, `headlights #ff8800`, `horn A4 0.3`, `press horn`, `pan 0.5 1`, … only what its profile has) and runs them on demand, every N minutes, daily at a UTC time on chosen weekdays, or each time the robot comes online. Every step passes the same gate as a person's command, as the owner (limits, cooldowns, e-stop, audit); held steps are re-sent inside the deadman window and released at the end; anything refused stops the routine with its reason. One routine runs per robot at a time. The owner's panel card and `GET|POST /api/v1/robots/:id/routines`, `POST …/routines/:rid/run`, `DELETE …/routines/:rid`.
- The owner's agent: the panel's **Your agent** card ("Let my OpenVibe.Actor agent drive this robot", `robots.agent_control`, migration 0012) lets `svc:actor`, acting for the robot's owner and nobody else, read the robot (`GET /api/v1/robots/:id/steps`: online, the e-stop, battery, sensors and the step lines it takes) and drive it with plain step lines (`POST …/steps`, at most 20 steps and 30 seconds, answered when they end) or one command (`POST …/commands`). Every step passes the same gate as the owner's own commands and is audited as the service. Off, or for anyone but the owner, it answers `403 bot.agent_not_allowed`.
- Webhooks (`server/webhooks.js`, `server/net/webhook-post.js`): up to five https endpoints per robot for its bot.* events, each with its own `whsec_` secret shown once. Deliveries are written in the transaction that emits the event, signed like OpenVibe.Events deliveries (`X-OpenVibe-Signature-V2`), posted only to public addresses with no redirects, and retried after 30 s, 2, 10, 30 and 120 minutes. The owner's panel card and `GET|POST /api/v1/robots/:id/webhooks`, `DELETE …/webhooks/:hid`.
- Community robots (`server/submissions.js`): anyone signed in submits a profile (id `community.<name>`, driver `plugin` for their own OpenVibe Node plugin, named in `mapping.plugin`, Contracts 0.160.0) with the driver's source, a setup guide and a licence at `/robots/submit`; `/robots/submissions` shows where each stands, and an OpenVibe admin approves or rejects (with a note) there. Approving signs the profile (Ed25519 over its canonical JSON, `BOT_PROFILE_SIGNING_KEY`) and puts it in the catalogue: `/models` "From the community", `/robots/new`, `GET /api/v1/profiles/:id` with its `signature`, and Bot's key at `GET /api/v1/profiles/signing-key`. Account deletion removes a person's unapproved submissions and keeps approved ones authorless.
- A phone as the robot (`phone.camera`, driver `phone`): the pairing page shows a QR code (`server/web/qr.js`) that opens `/device/phone` with the robot and code in the URL fragment; the phone pairs over `POST /api/v1/pair` and its browser is the device (`public/phone-device.js`): `/device` with the credential offered as the subprotocol `ov.device.<credential>` (a browser cannot set `Authorization`), its camera published over WHIP to OpenRestream, `say` through speech synthesis, `display` faces and text full-screen, a torch and a chime, battery and tilt telemetry, and a Stop button that latches a local stop. Nothing to install.
- `/try`, public and without an account: the same panel on a rover that runs in the visitor's own browser (`public/try-device.js` answers the panel's `/control` frames with the gate's shaping, deadman and latched e-stop), so anyone can drive before owning hardware. Nothing after the page reaches the server. The panel (`public/panel.js`, no build step) drives with a touch joystick, the keyboard or a gamepad, shows a latency meter and one camera tile per camera the profile lists; a tile plays the robot's OpenRestream WebRTC session when one is live (the mediasoup-client viewer flow OpenVibe.Live runs, against the session's playback descriptor), and stays the placeholder when there is none.
- The legal pages (`/terms`, `/privacy`, `/dmca`, `openvibe-shared/legal`), `/sitemap.xml`, `/manifest.webmanifest`, `/robots.txt` and the browser-facing 404 (`server/app.js`, `server/web/routes.js`): Bot serves them all itself, and the nginx vhost has no static root.
- The public build pages (`server/web/docs.js`): `/docs` (an index), `/docs/drivers` (write a driver for the OpenVibe Node — the plugin protocol, every message, the safety rules and how to test), and `/docs/profiles` (the `bot.robot-profile@1` fields, a full example and a validator). The validator answers `POST /docs/profiles/validate` (a form) and `POST /api/v1/profiles/validate` (JSON in, `{ valid, problems[] }` out) by running the same checks a shipped profile gets (`server/profiles` `checkProfile`); the pages carry no script and run under the site-wide CSP.
- Server-side ONVIF cameras (`camera.onvif`, `mapping.driver: onvif`): an in-process connector beside the simulator (`server/onvif`) attaches a camera configured with `BOT_ONVIF_CAMERAS`, writes a real `kind: server` device row, translates a `ptz` command into ONVIF `ContinuousMove`/`Stop` (with the profile's deadline as a deadman) and carries the camera's `GetStatus` readout in telemetry. Its credentials are secret references only (`username_ref`/`password_ref`).
- The command audit (`command_audit`, kept 30 days) and the `bot.*` outbox events.
- Operators and viewers from the panel: the owner adds a person to a robot by `@username` (OpenVibe.Network resolves the name to a subject) and removes them again, each listed on the panel's People card. On an open-queue robot a signed-in visitor sees their turn — or their place in line — and can leave the queue, which promotes the next person at once (`POST /robots/:id/operators`, `POST /robots/:id/operators/:subject/remove`, `POST /robots/:id/queue/leave`, all plain forms that work without JavaScript).
- The robot's streaming and recording toggles, off by default: `media` records live sessions to OpenVibe.Media and `live` shows them on the owner's OpenVibe.Live channel. They live only on the robot's OpenRestream stream (`recording_mode`, `mirror_to_live`); Bot stores no copy and the owner, not an operator, flips them (`GET`/`POST /api/v1/robots/:id/streaming`).
- Dispatching `platform.job@1` jobs to a paired Node over `/device` (`server/jobs/index.js` over `server/jobs/dispatch.js`; the internal `bot.job.dispatch` API is `POST /api/v1/jobs`, `POST /jobs/:id/cancel`, `GET /jobs/:id`) and metering them per wall-clock second (`run_jobs`, `run_usage_outbox`; docs/protocol.md §1.2).

Sitemap entries use the release commit time for these code-backed pages.

## Does not own

- Identity, subjects and tokens (OpenVibe.Network) and the robot's record on Network.
- Video: a device publishes over WHIP to OpenRestream; Bot only hands out the URL at pairing.
- The agent that runs on the robot; it ships with the T15 device-agent job.

## Devices

- A device (the machine that serves a robot) pairs with one pasted command, shown on the robot's pairing page: `curl -fsSL <BOT_INSTALLER_URL> | sh -s -- --robot rob_… --code XXXX-XXXX [--driver …]` (the Network form in `docs/protocol.md` §1). The `--driver` follows the robot's profile: `adeept` for `adeept.adr036`, `adeept-mecanum` for `adeept.adr036.mecanum`, `cozmo` for `cozmo`, `looi` for `looi` (the community's Generic LOOI driver, a Bluetooth bridge; OpenVibe.Node `docs/hardware-looi.md`); `ros2` for `ros2.diffdrive` and `ros2-holonomic` for `ros2.holonomic` (any ROS 2 robot on `cmd_vel`, through rosbridge or rclpy; OpenVibe.Node `plugins/ros2`); any other profile gets none (`server/domain/index.js` `driverForProfile`), the installer's dry-run `none`.
- **The one command on the robot** (`server/claims.js`, migration 0019): `curl -fsSL <BOT_INSTALLER_URL> | sh` with no robot and no code. The installer finds the kit on the machine (OpenVibe.Node `docs/install.md`) and starts a claim, `POST /api/v1/claims` (anyone, counted by address: a code like `KQ7M-2XRD`, a poll secret, 15 minutes). The owner enters the code at `/link` (signed in; the QR opens `/link?code=…`), sees what the machine found (shown escaped, it only pre-selects the model) and approves it with a name, a model the installer has a driver for (or the generic relay), who may drive, and **Show its camera on my OpenVibe.Live channel**, or denies it. Approving makes the robot exactly as Add robot does and keeps its pairing on the claim; the machine reads it with `GET /api/v1/claims/:id` and its `X-OV-Claim-Secret`, then pairs the usual way. Once it has paired (`domain.pairing.onPaired`) the pairing is dropped and the Live mirror is turned on if the owner asked. The approval page links to the owner's channel with `?bind_robot=rob_…`, where Live asks them to let the channel's chat drive it.
- **A person's own machine that runs their jobs** (plan T14/T16) serves no robot. `openvibe.bot/machines` lists the person's machines (online, the job classes they run, the robot they serve if any), adds one with a one-time command, `curl -fsSL <BOT_INSTALLER_URL> | sh -s -- --network <Network> --pairing pair_… --code XXXX-XXXX --worker` (a Network pairing with ref `worker:<owner>`, so the device keeps `owner_subject` and has no robot; migration 0013), and removes one (revoked here and on Network). Every live machine with a job worker, a robot's included, is reported to Network as a `user-owned` resource offer naming its owner (`server/jobs/offers.js`: one offer per device, `worker:<class>` per class, `up` while connected and `down` otherwise; the whole set as source `bot`, once a minute and two seconds after a device comes, goes or changes what it advertises). Run places a person's job only on that person's machines, and the dispatcher refuses any other (`bot.not_owner`).
- **A person's computer for their agents** (plan T14/T17, contracts 0.166.0): a machine installed with `--computer observe|ask|trusted|full` runs OpenVibe.Node's `computer` plugin as the person's own account, and the level set on the machine decides what may happen there (`ask` waits for `openvibe-node approve <id>`). `POST /api/v1/machines/:id/commands` sends `exec`, `fs` and `screen` (`bot.command@1`, the value checked against the contract) to it as its owner, or as their agent (`svc:actor` with `bot.computer.control`, acting as the owner) once the owner turned "Let my agent use this computer" on at `/machines` (migration 0014, `devices.agent_computer`). The answer comes back in `data` (the device socket takes frames up to 640 KB so it fits; a repeated id answers its result without the data). A machine whose plugin is off answers `bot.computer_off`. The audit keeps the program name and argument count, or the file op and path, never stdin, arguments or content. The machines page shows each machine's level, what waits for approval there, and the switch. OpenVibe.Watch (`svc:watch`, `bot.computer.control`, contracts 0.167.0) may send only `probe`: one GET or TCP connect from the machine to its own network, for a watch's `node` source. It works only where the owner turned on "Let my watches check things from this computer" (migration 0015, `devices.watch_probe`), and the audit keeps the probe's host, not its path. Every device's config lists the computer kinds, which only this route sends (a robot's operators never can).
- **The live screen** (plan T14, contracts 0.182.0, OpenVibe.Node v0.12.0): the machine's owner, signed in as themselves, watches its screen at `/machines/:id/screen` or through `POST|GET|DELETE /api/v1/machines/:id/screen` (`server/machine-screen.js`).
  - **The stream.** Each start makes or rotates the machine's own OpenRestream stream (external ref `bot:machine:<id>`, playback private, no recording, never mirrored to Live; `devices.screen_stream_id`, migration 0017). Rotating ends any session still open.
  - **The command.** `screen_stream` start goes to the machine with that stream's WHIP URL and key. It is not a `bot.command@1` kind, so the commands route, agents, watches and operators can never send it or choose where the screen goes.
  - **The audit** keeps the action, seconds and fps, never the URL or key.
  - **The viewer.** `GET` answers the session's viewer `signaling_url` once the machine publishes, and the page plays it with the panel's WebRTC viewer.
  - **Stop.** `DELETE` (or Stop) tells the machine to stop and retires the key. Removing a machine archives its stream.
  - **Refused** with `bot.computer_off` when the machine does not offer it (`screen.stream`), and no key is made.
- **The private desk** (contracts 0.214.0 `bot.command@1` kind `desk`, OpenVibe.Node v0.15.0 on Linux): a screen of its
  own on the machine (Xvfb with its own bus and window manager) where an agent works without touching the owner's.
  - **Commands.** `desk` `{ action: start | stop | status, width?, height? }` reaches a machine whose status lists
    `computer.desk`. `screen`, `input` and `browser` with `desk: "private"` act there. A machine without one answers
    `bot.computer_off` ("no private desk"), so `desk: private` never falls back to the owner's own screen.
  - **The audit** keeps the action and size, and marks `desk: private` on what acted there.
  - **The person always wins.** A person's mouse, keyboard or browser action on a screen (the owner's, or through a
    share link) holds that screen (main or the desk) for `BOT_PERSON_TURN_MS` (15 s). An agent's acting command there
    meanwhile answers `409 bot.person_driving` ("a person is using this screen right now"); reading goes on.
  - **The live screen** of the desk: `POST /machines/:id/screen` with `desk: "private"` (or the page's "Show the
    private desk" button) sends `screen_stream` with `desk: private`.
- **Vibe by voice** (`server/voice.js`, migration `0024_machine_voice.sql`, contracts 0.214.0 `voice_ask` /
  `voice_answer`; consumer plan §8). On a machine whose Node runs the voice plugin (`capabilities.voice`), the owner
  turns voice on and chooses a call word ("hey vibe" by default) on /machines or `POST /api/v1/machines/:id/voice`.
  - **Config** then carries `voice: true` and `call_word`, and the machine listens for the word on its own. Only what
    the person says after it comes as `voice_ask`.
  - **Answers:** Bot answers `working` at once, then asks Vibe as the owner through Chat (`POST <BOT_CHAT_INTERNAL_URL>
    /internal/chat/vibe/ask`, its own token for `openvibe.chat` with `chat.vibe.ask`, one source per machine, the
    device id and question id as the idempotency key). Vibe's answer, or why not, comes back as `voice_answer`.
  - **Limits:** with voice off or no owner, it's refused with where to turn it on. There are at most `BOT_VOICE_PER_HOUR`
    questions a machine an hour. Bot never stores the text.
- **Screen share links** (`server/screen-shares.js`, migration `0022_screen_shares.sql`; owner 2026-10-25: a screen a group
  watches and uses together). On the screen page the owner makes a link: **watch** (the live screen) or **watch and use**
  (also start or stop the screen, and the mouse and keyboard). It goes where the group works, such as a workspace room's
  Screen on OpenVibe.Chat. A link shows the owner's own screen or, on a machine with one, the **private desk**
  (migration `0023_screen_share_desk.sql`): a room watches the agent work there, and a use link's clicks go to the desk.
  - **The link** is shown once; Bot keeps its sha256. It lasts 1-365 days (30 by default), and stops at once when revoked
    or when the machine is removed. The owner's screen page lists the links (where each went, its kind, end date, last
    use) with a Stop button.
  - **The page** `/screen/:token` plays the screen like the owner's page. Its CSP lets it sit in a frame on
    `openvibe.chat`, `openvibe.network` and `BOT_EMBED_ORIGINS`. It sends `Referrer-Policy: no-referrer` and is noindex.
    `GET /screen/:token/state.json` is the state.
  - **Using it** (use links only, `public/screen-share.js`): `POST /screen/:token/start|stop`, and `POST /screen/:token/input` with a
    `bot.command@1` input value (click, double click, right click, move, scroll at a position in the picture, typed
    text, or a key or chord by name). Each is an `input` command to the machine **as its owner**, judged by the level
    the owner set there (`ask` waits for approval on the machine; `observe` refuses), 8 a second at most per link.
    The audit keeps the action and position (typed text only as a character count) under the machine. Nothing else
    passes: no programs, no files, no choice of where the screen goes.
- A server-side ONVIF camera (`camera.onvif`) is not installed on a machine: it gets no `--driver` and Bot attaches it itself from `BOT_ONVIF_CAMERAS` (see Deploy), so its panel works as soon as the camera answers.
- The robot's panel is `openvibe.bot/panel/<rob_…>` (`GET /panel/:id`, rendered from the profile; `docs/protocol.md` §3). The device-side bring-up steps for the Adeept ADR036 kit live with the driver, in OpenVibe.Node's `docs/hardware-adeept.md` (T15 step 1).
- A robot can use its own `local.rob_…` profile, stored with that robot and validated against `bot.robot-profile@1` and Bot's capability, driver and widget registries. On the owner's robot page, the Buttons form adds or removes rows and saves each button's name, label, optional keyboard key, cooldown in milliseconds and hold setting. The Video click checkbox enables a separate point cooldown. Only the owner can save or return to the robot's catalogue profile; each change is audited.
- Profiles declare `button` commands by name and `point` commands for normalised video coordinates in `[0, 1]`. A hold button sends `down` while pressed and `up` on release; each `down` has the device deadline used for held controls. The command gate checks declarations, roles, robot limits and control specific cooldowns. The panel and read-only embed render the profile's labels, with buttons disabled for anyone who cannot drive.

## Depends on

- PostgreSQL 18: robots, devices, profile rows, pairing codes, the command audit and the event outbox; `migrations/` applies on boot.
- Valkey (`VALKEY_URL`, optional): the shared per-actor limit counters; unset, limits are counted per process.
- OpenVibe.Network: user and service tokens, node tokens, pairing when the authority is `network`, and identity resolution (a `@username` to a subject, and subjects to names, for the panel's People card).
- OpenRestream: the WHIP ingest base (`BOT_WHIP_BASE`) devices publish to.
- OpenVibe.Billing: job usage readings go to `billing.usage.record` (`BOT_BILLING_URL`; Bot mints its own Network service token for audience `openvibe.billing` with `billing.usage.record`, and `BOT_BILLING_TOKEN` overrides it); unset, they wait in `run_usage_outbox`.
- `openvibe-contracts` v0.129.0, `openvibe-sdk` v0.65.0 and `openvibe-shared` v4.14.0 (package.json).
- Account export and deletion (ADR-033): Network grants `events.subscription.manage` (openvibe.events) for the two
  subscriptions created at boot, then, last and once the release is live, `network.account.export.contribute` and
  `network.account.deletion.confirm` (openvibe.network).

## Account export and deletion (ADR-033)

`network.account.export_requested` and `network.account.deleted` arrive at `POST /internal/events`. The route is
loopback-only (nginx answers 404 for `/internal/`, and the handler refuses a forwarded request) and signed with
`BOT_EVENTS_SECRET`. They are answered by `server/account-data.js` over `openvibe-sdk/account-data`, with one receipt
per export and deletion in `account_data_events` (migration 0008).

- **Export:** the person's robots, the roles they hold on other robots, their commands and their run jobs. Device
  credentials and publish keys are hashes and never exported.
- **Their robots:** each is removed the way its owner would remove it (`robots.remove`: the OpenRestream stream key is
  revoked and the stream archived first). Its pairing codes, operators, queue, local profile and Live conversion go
  with it, and so does its command history. A device that served only their robots is revoked and loses its name;
  the row stays because run jobs reference it.
- **Elsewhere:** their operator role and queue place on other robots go, and their id leaves other robots' command
  history, e-stop marks, pairing codes and invitations.
- **Kept:** run jobs they started, whose usage seconds were reported to Billing.

## Capabilities

| capability | guards |
|---|---|
| `bot.robot.read` | `GET /robots`, `GET /robots/:id`, operators, devices, the audit and the streaming toggles, for a service acting for an owner |
| `bot.robot.manage` | create, patch and delete a robot, pairing codes, operators, and the streaming toggles (`POST /robots/:id/streaming`) |
| `bot.computer.control` | an agent service (OpenVibe.Actor) uses a person's own machine: `GET /machines` (the person's machines whose owner allowed it), `GET /machines/:id/computer`, `POST /machines/:id/commands` (exec, fs, screen) acting as that owner, only where the owner turned "Let my agent use this computer" on |
| `bot.robot.control` | the e-stop set and clear (clear is owner-only), the control gate and `POST /robots/:id/commands` (so a bound channel's chat can forward a command over HTTP instead of a hardware socket) |
| `bot.device.connect` | rotate and revoke a device credential |
| `bot.job.dispatch` | the internal Run → Bot jobs API (`POST /jobs`, `POST /jobs/:id/cancel`, `GET /jobs/:id`); services only |
| `bot.resource.read` | the internal authority index (`GET /api/v1/resources`, `GET /api/v1/resources/:ovrn`); services only |

The authority index lists `bot.robot` summaries for OpenVibe.Services. A robot belongs to a person, so a project filter returns an empty page and individual OVRN lookups return 404. Services read it over loopback with `bot.resource.read`.

A person acts on their own robots with a Network user token; a service acts with a service token plus the capability, for the subject it names. The REST routes are in `docs/protocol.md` §3 and the two WebSockets in §§1–2.

## Tests

`npm test` runs `test/run.js`, the whole suite. `npm run test:pg` (`BOT_TEST_STORE=pg`) runs the same suite against PostgreSQL; the default store is in-process PGlite. The tests cover the device and operator WebSocket gates, the REST routes, the pairing paths, the profiles and the kit catalogue, the owner fence, the e-stop, the outbox and the server-side ONVIF camera (against a stub endpoint: `ptz` → `ContinuousMove`, telemetry → the `GetStatus` readout).

## Security

- A device credential is a secret: sent only in the `Authorization` header (never a query string), stored hashed, returned once by `pair` or a rotation, and revoking it closes the socket at once.
- A person acts only as themself; naming anyone else is refused, never ignored, and a node token is refused on the person and service routes.
- A person's machine runs only that person's jobs: the job dispatcher compares the job's requester (`user:usr_…`, as Run names it) with the machine's owner (a worker machine's own owner, else its robot's owner) and refuses anyone else's, a service's or nobody's job with `bot.not_owner`, whatever the placer chose. Its offer to Network names the owner and Network keeps it off the public offers list.
- Pairing codes are one-time and short-lived; the e-stop is latched and only the owner clears it, while `halt` always passes the gate.
- Every command, allowed or refused, is audited; the outbox carries ids, kinds and results — never a credential, a pairing code, a publish key or a WHIP URL.
- A server-side ONVIF camera is reached only at the one URL configured in `BOT_ONVIF_CAMERAS` (http(s), one host, no embedded credentials), with a timeout and no redirects, so a camera cannot steer Bot elsewhere. Its ONVIF user and password are named by secret reference (`username_ref`/`password_ref`), read only when a request is built, sent as a WS-Security digest and never stored, answered or logged.
- `/api/health` and `/api/ready` are loopback-only; nginx terminates TLS and upgrades `/device` and `/control`.

## Deploy

Production runs the Node process under systemd as `openvibe-bot.service` (unit reference: `deploy/systemd/openvibe-bot.service`), with `WorkingDirectory=/opt/openvibe.bot`, `ExecStart` running `server/index.js`, and secrets/config read from the environment file `/etc/openvibe/bot.env`. The app listens on port **4630** behind nginx (`deploy/nginx/openvibe.bot.conf`), which terminates TLS and upgrades the `/device`, `/control` and `/watch` WebSockets to `127.0.0.1:4630`. Readiness is `http://127.0.0.1:4630/api/ready` (liveness: `/api/health`); both are loopback-only.

To run the schema migrations before the service serves, start it once with the direct owner connection in `/etc/openvibe/bot.env` (`DATABASE_DIRECT_URL`); the boot applies `migrations/` and then serves on the pooled `DATABASE_URL`.

Search: every robot model page (`/models/<id>`) is an OpenVibe.Search document (owner `bot`, type `model`) written through Search's owner API with Bot's service token (`search.document.write`; `server/search-index.js`, `BOT_SEARCH_URL`), a minute after boot and every six hours; a model that leaves the catalogue is tombstoned.

Request telemetry: each HTTP request is aggregated by route template, method and status class, never by raw URL, and `/shared` files, static assets, health, readiness and `/metrics` are not counted. Once a minute one `http.request` sample per key, plus the active-requests, p95 latency and event-loop-lag gauges, is written to Bot's own `telemetry_samples` table (migration `0018_telemetry.sql`; openvibe-sdk 0.46 telemetry, the `platform.telemetry-sample@1` shape), and rows older than 14 days are deleted daily. `server/app.js` mounts openvibe-sdk's `telemetryMiddleware` (a no-op until init); `server/index.js` calls `telemetry.init()` at production start, runs the retention and flushes on stop.

Set `BOT_PAIRING_AUTHORITY` to `bot` (the default) or `network`; any other value refuses to boot.

Set `BOT_EMBED_ORIGINS` (comma or space separated; default `https://openvibe.live,https://www.openvibe.live`) to the pages that may frame a robot's read-only panel (the CSP `frame-ancestors` list). Each entry is a bare https origin, with no path, query or wildcard (`http://localhost:<port>` only outside production); an invalid entry refuses to boot. A robot is embeddable only after its owner turns on `embed_public` with the form on its panel (`POST /robots/:id/embed`); the flag is web-only and never appears in `/api/v1`. Migration `0005_embed_public.sql` adds the column, off for every robot.

The embeddable panel is `GET /panel/:id/embed` (framed only by `BOT_EMBED_ORIGINS`; no cookie needed to watch) and its read-only socket is `wss://openvibe.bot/watch` (docs/protocol.md §2.1); nginx must upgrade `/watch` like `/control`. Framing takes both sides: the embedding page must also list Bot's origin — its `BASE_URL`, `https://openvibe.bot` in production — in its own CSP `frame-src`, computed from that page's own configuration (OpenVibe.Live's `LIVE_BOT_URL`, default `https://openvibe.bot`), or the browser refuses the frame even though `BOT_EMBED_ORIGINS` allows the framer. Set `BOT_WATCH_MAX_PER_IP` (default 20) and `BOT_WATCH_MAX_PER_ROBOT` (default 500) to cap open `/watch` sockets per client address and watchers per robot; over a cap the socket closes 4003.

Set `BOT_WHIP_BASE` in `/etc/openvibe/bot.env` to the WHIP ingest base each device publishes to (`whip_url = <base>/<publish key>`, sent once with the pairing; OpenRestream's is `https://ingest.openre.stream/whip`); leave it unset to pair devices without video.

The publish key is always an ingest key OpenRestream issued for the robot's stream (OpenRestream's WHIP ingest admits no other): set `BOT_OPENRE_URL` and Bot mints its own Network service token for audience `openvibe.openre` from its OAuth client (`OV_OAUTH_CLIENT_ID`/`OV_OAUTH_CLIENT_SECRET` against `OV_NETWORK_INTERNAL_URL`), holding `openre.stream.read`, `openre.stream.write`, `openre.key.rotate` and `openre.session.read`/`openre.output.read`/`openre.output.write` — Network's grant to the `bot` client; `openre.session.read` is the panel's live video (the open session and its playback descriptor) and the output capabilities are for restreaming later. `BOT_OPENRE_TOKEN` (a Network service token with the same grant, or `openre.stream.*` with `openre.key.rotate`) is an optional operator override; `BOT_OPENRE_TIMEOUT_MS`, default 8000, bounds each call. The same token covers the streaming toggles: `GET /api/v1/robots/:id/streaming` reads the stream with `openre.stream.read`, `POST` PATCHes `recording_mode`/`mirror_to_live` with `openre.stream.write`. Pairing creates the robot's OpenRestream stream (or rotates the one it has), a credential rotation rotates its key, revoking a device or removing a robot revokes the key and ends the live session. Bot stores the stream id and the key's hint, never the key. With `BOT_OPENRE_URL` unset, or neither `BOT_OPENRE_TOKEN` nor the Network client credentials available, devices still pair but get no publish key and the answer says `"video": "not_configured"`; Bot mints no key of its own.

Set `BOT_BILLING_URL` in `/etc/openvibe/bot.env` to OpenVibe.Billing's base URL and Bot mints its own Network service token for audience `openvibe.billing` (`billing.usage.record`, Network's grant to the `bot` client) from the same OAuth client credentials, posting each job usage reading to `<BOT_BILLING_URL>/api/v1/usage`; `BOT_BILLING_TOKEN` is an optional operator-minted override, and `BOT_BILLING_TIMEOUT_MS`, default 5000, bounds each post. With `BOT_BILLING_URL` unset the relay stays off and the readings wait in `run_usage_outbox`, retried across restarts and never dropped.

Set `BOT_ONVIF_CAMERAS` (JSON, unset by default) to the server-side cameras Bot may connect to: a map from a robot id (each key names exactly one robot; there is no wildcard) to `{ "url": "http://<host>/onvif/ptz_service", "username_ref": "CAM_USER", "password_ref": "CAM_PASSWORD" }`. The refs are the *names* of the secrets (env vars, or keys a deployment resolves through a secret store), read per request; the URL must be http(s), on one host and carry no credentials, and `BOT_ONVIF_TIMEOUT_MS` (default 5000) bounds each request. Anything else — including a key that is not a robot id — refuses to boot. A robot whose profile is `camera.onvif` and that has a configured camera attaches server-side at boot and when its panel is opened.

`/install` is proxied to the app, which answers a 302 to OpenVibe.Node's installer script (`BOT_INSTALLER_SOURCE_URL`, by default the `install.sh` asset on OpenVibe.Node's [latest release](https://github.com/OpenVibers/OpenVibe.Node/releases/latest/download/) — a released, checksummed installer that never drifts with Node's `main`, whose CI keeps `dist/install.sh` byte-identical to `install/install.sh`; https on an allow-listed GitHub or openvibe.bot host, checked at boot, and no query parameter changes the target). The pairing's installer command adds `--driver adeept|adeept-mecanum|cozmo` for those profiles and nothing for the others (the dry-run `none`).

## Deploy files

- `deploy/systemd/openvibe-bot.service` — systemd unit (`EnvironmentFile=/etc/openvibe/bot.env`, `PORT=4630`, hardening and `Restart=always`).
- `deploy/nginx/openvibe.bot.conf` — nginx reference site for openvibe.bot: TLS, www→apex, rate limits, and WebSocket upgrade headers for the device (`/device`) and operator (`/control`) sockets, passing the `Authorization` header through. It proxies the front page (`location = /`), `/shared/`, `/robots.txt`, `/release.json` and everything else to the app, which serves the legal pages, `sitemap.xml`, `manifest.webmanifest` and the 404 page itself; there is no static root.

OpenVibe.Sites no longer generates `deploy/nginx/openvibe.bot.conf` (sites.json marks the vhost as owned by OpenVibe.Bot), and Bot serves nothing from a Sites checkout: the legal pages, `robots.txt`, `sitemap.xml`, `manifest.webmanifest` and the 404 page all come from the app. A Sites deploy leaves an installed vhost it no longer generates in place, so the current Sites vhost keeps serving openvibe.bot until Bot's first deploy installs this file over it; later Sites deploys never overwrite Bot's `/device` and `/control` routes.

<!-- versions:start -->
- openvibe-contracts: v0.214.0
- openvibe-sdk: v0.65.0
- openvibe-shared: v4.14.0
<!-- versions:end -->
