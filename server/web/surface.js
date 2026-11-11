'use strict';

/**
 * The panel's arrangeable surfaces (make your own controls, stage 2): the ui.surface@1 catalogs and the default
 * ui.layout@1 for the full panel (bot.controls) and the controls over a stream (bot.overlay), and the attributes
 * that put a person's layout on the parts the pages render.
 *
 * A catalog is built from the robot's profile: the parts a layout may place are exactly the controls this robot
 * has (the drive stick, Stop, a head slider, battery, latency, the camera, the buttons, ...). Stop and the
 * overlay's e-stop are required and carry their own minimum pixel size. The default layout keeps the panel's
 * familiar order: the camera, then the stick and Stop side by side, then the rest.
 *
 * A layout only arranges: every command still goes through the panel's one gate and the robot's limits.
 */
const THEME_TOKENS = ['surface', 'raised', 'bg', 'line', 'text', 'muted', 'accent', 'danger', 'ok', 'warn'];
const DEVICES = ['phone', 'tablet', 'computer'];
const GRID = { columns: { phone: 4, tablet: 8, computer: 12 }, cell_px: { phone: 72, tablet: 64, computer: 56 } };
const PRESSED = 44;

/** phone, tablet or computer from the request (a header first, then the browser's own user agent). */
function deviceClass(req) {
    const header = (req && req.headers && (req.headers['sec-ch-ua-mobile'] || '')) || '';
    const ua = String((req && req.headers && req.headers['user-agent']) || '');
    if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
    if (header === '?1' || /Mobi|iPhone|iPod|Android|Windows Phone|Mobile/i.test(ua)) return 'phone';
    return 'computer';
}

const STICK_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'];
const STICK_X = ['steer', 'x', 'rotation'];
const STICK_Y = ['throttle', 'y'];

function basePart(id, name, kind, extra = {}) {
    return {
        id, name, kind,
        required: false,
        pressed: kind === 'button' || kind === 'stick' || kind === 'slider',
        min: { w: 1, h: 1 },
        styles: { tints: ['surface', 'raised'], shapes: ['round', 'pill', 'square'], opacity: { min: 0.4, max: 1 }, label: true },
        bindings: { keys: [], gamepad: [] },
        ...extra,
    };
}

/** The parts one widget contributes: the drive is split into its stick, Stop and direction buttons. */
function driveParts(profile, widget) {
    const kind = widget && widget.command ? widget.command.kind : 'drive';
    const command = (profile.commands || {})[kind];
    const axes = (command && command.axes) || {};
    const x = STICK_X.find((a) => axes[a]);
    const y = STICK_Y.find((a) => axes[a]);
    const rest = Object.keys(axes).filter((a) => a !== x && a !== y);
    const parts = [];
    if (x || y) parts.push([basePart('stick', 'Drive stick', 'stick', {
        pressed: true, min: { w: 2, h: 2 }, never_covers: ['stop'],
        styles: { tints: ['surface', 'accent'], shapes: ['round', 'square'], opacity: { min: 0.4, max: 1 }, label: false },
        bindings: { keys: STICK_KEYS, gamepad: ['left-stick', 'dpad'] },
    }), { widgetIndex: null }]);
    parts.push([basePart('stop', 'Stop', 'button', {
        required: true, pressed: true, min: { w: 2, h: 2, px: 68 },
        styles: { tints: ['danger', 'surface'], shapes: ['round', 'pill'], opacity: { min: 0.7, max: 1 }, label: true },
        bindings: { keys: ['Space'], gamepad: ['south'] },
    }), { widgetIndex: null }]);
    if (rest.length) parts.push([basePart('pad', 'Direction buttons', 'button', {
        pressed: true, min: { w: 2, h: 2 }, never_covers: ['stop'],
        styles: { tints: ['surface'], shapes: ['round', 'square'], opacity: { min: 0.4, max: 1 }, label: true },
        bindings: { keys: [], gamepad: [] },
    }), { widgetIndex: null }]);
    return parts;
}

const ACTUATOR_WIDGETS = { 'pan-tilt': 'pan_tilt', servo: 'servo', head: 'head', lift: 'lift', lights: 'lights', horn: 'horn' };
const SIMPLE_WIDGETS = { battery: 'readout', latency: 'readout', telemetry: 'readout', camera: 'video', video_click: 'video', speaker: 'list', display: 'list', buttons: 'button', ptz: 'stick' };

/** Every part this profile's full panel offers, in the order the page draws its widgets. */
function partsOf(profile) {
    const widgets = (profile && profile.widgets) || [];
    const hasCamera = widgets.some((w) => w.type === 'camera');
    const out = [];
    const seen = new Set();
    const add = (part, meta = {}) => {
        let id = part.id;
        for (let n = 2; seen.has(id); n++) id = `${part.id}.${n}`;
        seen.add(id);
        out.push({ ...part, id, widgetIndex: meta.widgetIndex == null ? null : meta.widgetIndex, widgetType: meta.widgetType || null });
    };
    let drive = false;
    widgets.forEach((w, i) => {
        if (w.type === 'drive') {
            for (const [part, meta] of driveParts(profile, w)) add(part, { ...meta, widgetIndex: i });
            drive = true;
            return;
        }
        if (w.type === 'ptz') {
            add(basePart('ptz', w.label || 'Camera stick', 'stick', {
                pressed: true, min: { w: 2, h: 2 }, never_covers: ['stop'],
                styles: { tints: ['surface', 'accent'], shapes: ['round'], opacity: { min: 0.4, max: 1 }, label: true },
                bindings: { keys: [], gamepad: [] },
            }), { widgetIndex: i, widgetType: w.type });
            return;
        }
        if (ACTUATOR_WIDGETS[w.type]) {
            const kind = w.type === 'lights' || w.type === 'horn' ? 'button' : 'slider';
            add(basePart(ACTUATOR_WIDGETS[w.type], w.label || (w.type === 'pan-tilt' ? 'Pan and tilt' : w.type), kind, {
                min: { w: 2, h: kind === 'slider' ? 1 : 2 }, never_covers: ['stop'],
                styles: { tints: ['accent', 'surface'], shapes: ['pill', 'square', 'round'], opacity: { min: 0.4, max: 1 }, label: true },
                bindings: { keys: w.type === 'head' ? ['q', 'e'] : [], gamepad: [] },
            }), { widgetIndex: i, widgetType: w.type });
            return;
        }
        if (SIMPLE_WIDGETS[w.type]) {
            if (w.type === 'video_click' && hasCamera) return;
            const kind = SIMPLE_WIDGETS[w.type];
            add(basePart(w.type === 'video_click' ? 'camera' : w.type, w.label || (w.type === 'battery' ? 'Battery' : w.type === 'latency' ? 'Latency' : w.type === 'camera' || w.type === 'video_click' ? 'Camera' : w.type), kind, {
                pressed: kind === 'button' || kind === 'stick',
                min: w.type === 'latency' ? { w: 2, h: 1 } : w.type === 'camera' || w.type === 'video_click' ? { w: 2, h: 2 } : w.type === 'buttons' ? { w: 2, h: 2 } : { w: 1, h: 1 },
                never_covers: kind === 'button' || kind === 'stick' ? ['stop'] : [],
                styles: { tints: kind === 'readout' ? ['text', 'surface'] : ['surface', 'accent'], shapes: ['round', 'pill', 'square'], opacity: { min: 0.4, max: 1 }, label: true },
                bindings: { keys: [], gamepad: [] },
            }), { widgetIndex: i, widgetType: w.type });
        }
    });
    if (!drive) {
        // Every robot with a panel can be stopped, even one made only of a pan-tilt camera or buttons.
        if (!seen.has('stop')) add(basePart('stop', 'Stop', 'button', {
            required: true, pressed: true, min: { w: 2, h: 2, px: 68 },
            styles: { tints: ['danger', 'surface'], shapes: ['round', 'pill'], opacity: { min: 0.7, max: 1 }, label: true },
            bindings: { keys: ['Space'], gamepad: ['south'] },
        }));
    }
    return out;
}

/** The full panel's catalog: bot.controls. */
function controlsCatalog(profile) {
    return {
        id: 'bot.controls', version: 1, name: 'Robot controls',
        description: 'The full OpenVibe.Bot panel: the drive stick, Stop, the head or camera slider, the buttons, the camera and the readouts.',
        devices: DEVICES, grid: GRID, theme_tokens: THEME_TOKENS,
        parts: partsOf(profile).map((p) => {
            const { widgetIndex, widgetType, ...part } = p;   // eslint-disable-line no-unused-vars
            return part;
        }),
    };
}

/** The overlay's catalog: the stick, the slider, the e-stop, more and the pill (plus Drive for a watcher). */
function overlayCatalog(profile, { slider = null, hasStick = false, canDrive = false } = {}) {
    const parts = [
        basePart('pill', 'The robot', 'readout', { pressed: false, min: { w: 1, h: 1 }, styles: { tints: ['surface'], shapes: ['pill'], opacity: { min: 0.4, max: 1 }, label: true }, bindings: { keys: [], gamepad: [] } }),
        basePart('more', 'More', 'button', { pressed: true, min: { w: 1, h: 1 }, styles: { tints: ['surface'], shapes: ['round'], opacity: { min: 0.4, max: 1 }, label: false }, bindings: { keys: [], gamepad: [] } }),
        basePart('estop', 'E-stop', 'button', {
            required: true, pressed: true, min: { w: 2, h: 2, px: 56 }, never_covers: ['more', 'pill'],
            styles: { tints: ['danger'], shapes: ['round'], opacity: { min: 0.7, max: 1 }, label: true },
            bindings: { keys: ['Space'], gamepad: ['start'] },
        }),
    ];
    if (hasStick) parts.push(basePart('stick', 'Stick', 'stick', {
        pressed: true, min: { w: 2, h: 2 }, never_covers: ['estop', 'pill'],
        styles: { tints: ['surface', 'accent'], shapes: ['round'], opacity: { min: 0.4, max: 1 }, label: false },
        bindings: { keys: STICK_KEYS, gamepad: ['left-stick', 'dpad'] },
    }));
    if (slider) parts.push(basePart('slider', slider.name || 'Slider', 'slider', {
        pressed: true, min: { w: 2, h: 1 }, never_covers: ['estop'],
        styles: { tints: ['surface', 'accent'], shapes: ['pill'], opacity: { min: 0.4, max: 1 }, label: true },
        bindings: { keys: [], gamepad: [] },
    }));
    if (canDrive) parts.push(basePart('drive', 'Drive', 'button', { pressed: true, min: { w: 2, h: 1 }, styles: { tints: ['accent'], shapes: ['pill'], opacity: { min: 0.4, max: 1 }, label: true }, bindings: { keys: [], gamepad: [] } }));
    return {
        id: 'bot.overlay', version: 1, name: 'Robot over a stream',
        description: 'The controls over a robot’s stream: the stick, the slider, the e-stop, more and the robot’s pill.',
        devices: DEVICES, grid: GRID, theme_tokens: THEME_TOKENS, parts,
    };
}

/** The catalog's part, or a stand-in when a stored layout names one this robot no longer has. */
function partOf(catalog, id) {
    return (catalog.parts || []).find((p) => p.id === id) || null;
}

function entryOf(layout, id) {
    return ((layout && layout.parts) || []).find((p) => p.id === id) || null;
}

function styleOf(part, entry) {
    const st = (entry && entry.style) || {};
    const tints = (part.styles && part.styles.tints) || ['surface'];
    const shapes = (part.styles && part.styles.shapes) || ['square'];
    return {
        tint: tints.includes(st.tint) ? st.tint : tints[0],
        shape: shapes.includes(st.shape) ? st.shape : shapes[0],
        opacity: typeof st.opacity === 'number' ? st.opacity : 1,
        label: typeof st.label === 'boolean' ? st.label : (part.styles && part.styles.label) !== false,
    };
}

/** One part's entry in the layout shown now: the person's, else the default one. */
function resolvedEntry(catalog, layout, device, id) {
    const part = partOf(catalog, id);
    if (!part) return null;
    return entryOf(layout, id) || entryOf(defaultLayout(catalog, device), id) || null;
}

/**
 * The default layout: the camera, then the stick and Stop, then the rest in the catalog's order. Phone rows are
 * full width; a computer gives the camera eight of its twelve columns and keeps the stick and Stop beside it.
 */
function defaultLayout(catalog, device = 'computer') {
    const d = DEVICES.includes(device) ? device : 'computer';
    const cols = GRID.columns[d];
    const order = [...(catalog.parts || [])].sort((a, b) => {
        const rank = (p) => (p.id === 'camera' ? -3 : p.id === 'stick' ? -2 : p.id === 'stop' ? -1 : p.id === 'pad' ? 0 : 1);
        return rank(a) - rank(b);
    });
    let x = 0; let y = 0; let rowH = 0;
    const parts = order.map((p) => {
        const camera = p.id === 'camera';
        const side = p.id === 'stick' || p.id === 'stop';
        let w = camera ? (d === 'computer' ? 8 : cols) : side ? 2 : Math.min(cols, Math.max(p.min.w, d === 'phone' ? cols : 4));
        if (p.kind === 'readout' && d !== 'phone') w = Math.min(cols, Math.max(2, p.min.w));
        w = Math.min(cols, w);
        let h = camera ? 3 : p.kind === 'readout' ? 1 : p.id === 'stop' || p.id === 'stick' ? 2 : Math.max(p.min.h, 2);
        if (p.kind === 'slider') h = Math.max(1, p.min.h);
        if (p.id === 'latency') h = 2;
        if (x + w > cols) { x = 0; y += rowH; rowH = 0; }
        const place = { x, y, w, h };
        x += w;
        rowH = Math.max(rowH, h);
        const st = styleOf(p, null);
        return { id: p.id, visible: true, place, style: st, bindings: { keys: [], gamepad: [] } };
    });
    return { surface: catalog.id, surface_version: catalog.version, device: d, name: 'Default', author: { name: 'OpenVibe' }, sharing: 'private', parts };
}

/** The overlay's default layout: the pill and stick left, more and e-stop right, the slider at the bottom. */
function overlayDefaultLayout(catalog, device = 'computer') {
    const dockedOf = (id, dock, order, w = 1, h = 1) => {
        const p = partOf(catalog, id);
        if (!p) return null;
        return { id, visible: true, place: { dock, order, w: Math.max(p.min.w, w), h: Math.max(p.min.h, h) }, style: styleOf(p, null), bindings: { keys: [], gamepad: [] } };
    };
    const parts = [
        dockedOf('pill', 'left', 0, 2, 1),
        dockedOf('stick', 'left', 1, 2, 2),
        dockedOf('slider', 'bottom', 0, 2, 1),
        dockedOf('more', 'right', 0, 1, 1),
        dockedOf('estop', 'right', 2, 2, 2),
        dockedOf('drive', 'right', 0, 2, 1),
    ].filter(Boolean);
    return { surface: catalog.id, surface_version: catalog.version, device, name: 'Default', author: { name: 'OpenVibe' }, sharing: 'private', parts };
}

const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The attributes that put one part's entry on the element: its grid area (or dock edge), its style variables
 * and whether this person hid it. `roleHidden` marks a part the page hides for a role reason (the e-stop before
 * a watcher takes the controls): the editor must not unhide it.
 */
function attrsFor(catalog, layout, device, id, { apply = true } = {}) {
    if (!apply) return '';
    const part = partOf(catalog, id);
    const e = resolvedEntry(catalog, layout, device, id);
    if (!part || !e) return '';
    const st = styleOf(part, e);
    const bits = [
        `data-ov-tint="${escAttr(st.tint)}"`, `data-ov-shape="${escAttr(st.shape)}"`, `data-ov-label="${st.label ? 'true' : 'false'}"`,
    ];
    const css = [`--ov-part-opacity:${st.opacity}`];
    if (e.place && e.place.dock) {
        bits.push(`data-ov-dock="${escAttr(e.place.dock)}"`, `data-ov-order="${Number(e.place.order) || 0}"`);
        bits.push(`data-ov-size-w="${Number(e.place.w) || part.min.w}"`, `data-ov-size-h="${Number(e.place.h) || part.min.h}"`);
        css.push(`--ov-part-w:${Number(e.place.w) || part.min.w}`, `--ov-part-h:${Number(e.place.h) || part.min.h}`);
    } else if (e.place) {
        bits.push(`data-ov-grid="${e.place.x},${e.place.y},${e.place.w},${e.place.h}"`);
        css.push(`grid-column:${e.place.x + 1} / span ${e.place.w}`, `grid-row:${e.place.y + 1} / span ${e.place.h}`);
    }
    if (e.visible === false) bits.push('hidden');
    bits.push(`style="${css.join(';')}"`);
    return bits.join(' ');
}

/** The `.widgets` element's own attributes: the surface, its device class and its grid. */
function surfaceAttrs(catalog, layout, device, apply = true) {
    const cols = GRID.columns[device] || 12;
    const cell = GRID.cell_px[device] || 64;
    if (!apply) return `data-ov-surface="${escAttr(catalog.id)}" data-ov-device="${escAttr(device)}" data-ov-cols="${cols}" data-ov-cell="${cell}" style="--ov-cols:${cols};--ov-cell:${cell}px"`;
    return `data-ov-arranged="true" data-ov-surface="${escAttr(catalog.id)}" data-ov-device="${escAttr(device)}" data-ov-cols="${cols}" data-ov-cell="${cell}" style="--ov-cols:${cols};--ov-cell:${cell}px;grid-template-columns:repeat(${cols}, minmax(0, 1fr));grid-auto-rows:minmax(${cell}px, auto)"`;
}

/** The overlay surface's attributes (no grid template: its parts dock to the edges). */
function overlaySurfaceAttrs(catalog, layout, device, apply = true) {
    const cols = GRID.columns[device] || 4;
    const cell = GRID.cell_px[device] || 64;
    if (!apply) return `data-ov-surface="${escAttr(catalog.id)}" data-ov-device="${escAttr(device)}" data-ov-cols="${cols}" data-ov-cell="${cell}" style="--ov-cols:${cols};--ov-cell:${cell}px"`;
    return `data-ov-arranged="true" data-ov-custom="true" data-ov-surface="${escAttr(catalog.id)}" data-ov-device="${escAttr(device)}" data-ov-cols="${cols}" data-ov-cell="${cell}" style="--ov-cols:${cols};--ov-cell:${cell}px"`;
}

module.exports = { deviceClass, partsOf, controlsCatalog, overlayCatalog, defaultLayout, overlayDefaultLayout, attrsFor, surfaceAttrs, overlaySurfaceAttrs, styleOf, partOf, entryOf, THEME_TOKENS, GRID, DEVICES };
