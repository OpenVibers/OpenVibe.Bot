# Put a robot's controls on a page or over a video

The embeddable panel is `GET /panel/<rob_…>/embed`. It is a full page in an iframe, framed only by an origin the
robot's site allows (`BOT_EMBED_ORIGINS`; the robot's `data-parent-origins` lists them). A page can ask for three views:

| view | query | what it draws |
|---|---|---|
| `panel` | `/embed` or `?mode=panel` | the whole panel: header, camera, every widget, the e-stop and the readouts. This is the default and what existing pages get. |
| `overlay` | `?mode=overlay` | a transparent page that fills its frame and draws only the live controls: the robot's name and state (online, your turn, someone else driving, e-stop on) as one pill at the top left, the first stick in a 132 px circle at the bottom left, the first slider as a 44 × 132 vertical track at the bottom right, the e-stop as a 44 px round button at the top right, and a “more” button under it. Safe-area insets are applied. |
| `compact` | `?mode=compact` | one row for a narrow card: the same pill, a 96 px stick, the same slider across, the e-stop and “more”. |

Which stick and slider exist comes from the robot's profile (`server/profiles/*.json`): the first `drive`, `ptz` or
direction-button widget with a stick, and the first `number` actuator a widget drives. A robot with neither still gets
the pill, the e-stop (for its owner and operators) and “more”. A viewer sees the pill and “more” until they take the
controls the same way the full panel lets them.

Typical iframe:

```html
<iframe
  src="https://openvibe.bot/panel/rob_abc123/embed?mode=overlay"
  title="Robot controls"
  allow="gamepad"
  sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
  referrerpolicy="strict-origin-when-cross-origin"></iframe>
```

Do not add `allow-top-navigation`, and do not widen the sandbox. The panel needs scripts, its own origin (the
OpenVibe session cookie), forms and popups (Drive opens its own page). Commands go from the panel to OpenVibe.Bot as
the signed-in viewer; the page around the frame never sends a command and cannot.

## The messages

Every message the frame sends also carries `robot_id` when it knows it. The page accepts a message only when all three
match: `e.origin` is the Bot origin, `e.source` is the iframe's `contentWindow`, and `robot_id` is the robot the iframe
was given. Anything else is ignored.

| direction | type | fields | meaning |
|---|---|---|---|
| frame → page | `ov-bot-size` | `height`, `mode`, `minWidth`, `minHeight`, `hit?` | its content height (the full panel card grows to it), the current view, the smallest size that view stays usable in (`panel` 320×480, `overlay` 280×196, `compact` 320×112), and, for `overlay`, the rectangles the controls occupy: `hit: [{ x, y, w, h }, …]` in frame pixels. Sent on load and on change, at most five times a second. |
| frame → page | `ov-bot-open-panel` | — | the overlay's “more” was pressed; the page should show the full panel (`panel` view, under the video, or in a dialog). |
| frame → page | `ov-bot-blur-controls` | — | Escape was pressed in the overlay; focus should go back to the page (for a player, focus the video box). |
| page → frame | `ov-bot-mode` | `mode: 'panel' \| 'overlay' \| 'compact'` | switch view. A view is rendered on the server (its controls come from the profile), so the frame reloads itself in the new view; the page does not rebuild the iframe. |
| page → frame | `ov-bot-activity` | — | the pointer moved over the page, outside the frame's controls: the overlay wakes from its 45 % idle state. |
| page → frame | `ov-bot-theme` | `tokens` | the page's colours (see `public/embed-frame.js`); optional. |
| page → frame | `ov-bot-key` / `ov-bot-pad` | key or axes | optional: the page's keyboard and gamepad while the panel drives, after the frame's `ov-bot-controls` says it has the focus. |

## Over a video: let the presses through

The overlay page is transparent and its page is `pointer-events: none`; only the controls take a pointer. But a press
on an iframe never crosses into the page underneath, even when the iframe's own document is click-through. The page
that puts the controls over a picture therefore clips the iframe to the control rectangles from `ov-bot-size.hit`:

```js
function clipToControls(frame, hit) {
  if (!Array.isArray(hit) || !hit.length) return;           // no boxes: leave the frame whole
  const rects = hit.filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0).slice(0, 12);
  if (!rects.length) return;
  const path = rects.map((r) => `M${r.x} ${r.y} H${r.x + r.w} V${r.y + r.h} H${r.x} Z`).join(' ');
  frame.style.clipPath = `path("${path}")`;
}

window.addEventListener('message', (e) => {
  if (e.origin !== 'https://openvibe.bot' || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === 'ov-bot-size' && d.mode === 'overlay') clipToControls(frame, d.hit);
});
```

`clip-path` participates in hit testing: a press outside every rectangle reaches the video (or whatever is behind the
frame) and the player's own controls keep working. Put the frame in a layer above the video and **below** the player's
controls bar, unmute pill and chat button, and leave the bottom bar's height out of the layer, e.g.
`position:absolute; inset:0 0 var(--player-bar-height, 64px) 0; z-index:4`. The overlay's e-stop and pill then sit
above the picture but under those page controls. In full screen, keep the frame inside the element that goes full
screen (`requestFullscreen` on the player box), so the controls stay over the picture.

Do not use `pointer-events: none` on the iframe element itself as a click-through trick: it turns the controls off too.

## Security

- The frame is sandboxed exactly as above and accepts parent messages only from `data-parent-origins`.
- The page accepts frame messages only from the Bot origin **and** that exact iframe, and only the shapes below.
- A page never sends `estop`, `drive`, `actuator` or any other command to the frame: only OpenVibe.Bot's panel sends
  commands, through Bot's own gate, as the viewer. Chat commands on a bound OpenVibe.Live channel go through the
  channel route in Live, never through this protocol.
- Treat `hit` as layout data only: clamp it and ignore anything malformed.
