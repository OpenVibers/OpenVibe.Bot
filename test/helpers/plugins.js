'use strict';
/**
 * What each device plugin accepts, transcribed from OpenVibe.Node (2479ef1) so Bot's profiles are tested
 * against the device side. A value passes only when the plugin takes it as sent and inside its ranges —
 * never by leaning on the plugin's own clamp. accepts(kind, value) returns null, or why it would be refused.
 *
 *   ADEEPT = plugins/adeept_adr036/openvibe_adeept_adr036/__init__.py
 *   COZMO  = plugins/cozmo/openvibe_cozmo/__init__.py
 *   SDK    = plugins/sdk/openvibe_plugin/__init__.py
 *
 * camera.onvif and sim.rover are `kind: "server"` profiles with no Node plugin; their contract is the
 * value table in docs/protocol.md.
 */
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => Object.keys(v).every((k) => keys.includes(k));
const byte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;

// SDK:256 — the runtime answers halt itself (safe_stop) before any plugin sees it.
const halt = (v) => (v == null || (isObj(v) && !Object.keys(v).length) ? null : 'halt carries no value');

// ADEEPT:132 note_to_hz.
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteHz(note) {
    const m = /^([A-G])([#b]?)(-?\d+)$/.exec(String(note));
    if (!m) return null;
    return 440 * 2 ** ((12 * (Number(m[3]) + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) - 69) / 12);
}

/** ADEEPT:150 ADR036 with `wheels` ordinary|mecanum and the default config (buzzer octaves 1, 8 LEDs: ADEEPT:53–54). */
function adeept(wheels, { octaves = 1, leds = 8 } = {}) {
    const axes = wheels === 'mecanum' ? ['x', 'y', 'rotation'] : ['throttle', 'steer'];
    return {
        name: `adeept_adr036 (${wheels})`,
        accepts(kind, v) {
            if (kind === 'halt') return halt(v);
            if (!isObj(v)) return `${kind} value must be an object`;
            if (kind === 'drive') {
                // ADEEPT:294 — mecanum reads x/y/rotation when one is present (else converts throttle/steer and
                // loses strafe); ordinary reads throttle/steer (else x/rotation and ignores y).
                if (!axes.some((a) => a in v)) return `a ${wheels} drive carries ${axes.join('/')}`;
                if (!only(v, axes)) return `the ${wheels} drive ignores ${Object.keys(v).filter((k) => !axes.includes(k))}`;
                return axes.every((a) => !(a in v) || num(v[a], -1, 1)) ? null : 'drive axes are -1..1';
            }
            if (kind === 'ptz') {
                // ADEEPT:274
                if (!('pan' in v) && !('tilt' in v)) return 'ptz needs pan and/or tilt';
                return only(v, ['pan', 'tilt']) && ['pan', 'tilt'].every((a) => !(a in v) || num(v[a], -1, 1)) ? null : 'ptz is pan/tilt -1..1';
            }
            if (kind !== 'actuator') return `kind ${kind} not supported`;      // ADEEPT:291
            if (!only(v, ['name', 'value'])) return 'an actuator is {name, value}';
            const { name, value } = v;
            if (name === 'pan' || name === 'tilt') return num(value, -1, 1) ? null : `${name} is -1..1`;   // ADEEPT:90, 313
            if (name === 'buzzer') {
                // ADEEPT:317 — falsy is off; {note} or {hz} inside A4 ± octaves (ADEEPT:336).
                if (!value) return null;
                if (!isObj(value)) return 'buzzer value is {note}, {hz} or null';
                const hz = 'note' in value ? noteHz(value.note) : 'hz' in value ? value.hz : null;
                if (hz == null) return 'buzzer value is {note}, {hz} or null';
                if (hz === 0) return null;
                const lo = 440 / 2 ** octaves; const hi = 440 * 2 ** octaves;
                return num(hz, lo - 0.01, hi + 0.01) ? null : `tone ${hz} Hz outside ${lo}..${hi}`;
            }
            if (name === 'lights') {
                // ADEEPT:347 — falsy is off; {r,g,b} 0..255 and an optional LED index.
                if (!value) return null;
                if (!isObj(value) || !only(value, ['r', 'g', 'b', 'index'])) return 'lights value is {r,g,b[,index]} or null';
                if (!['r', 'g', 'b'].every((c) => byte(value[c]))) return 'r, g, b are integers 0..255';
                if (value.index != null && !(Number.isInteger(value.index) && value.index >= 0 && value.index < leds)) return `index must be 0..${leds - 1}`;
                return null;
            }
            return `no actuator ${name}`;                                      // ADEEPT:290
        },
    };
}

const COZMO_FACES = ['neutral', 'happy', 'sad', 'surprised', 'sleepy', 'angry'];   // render.py:16

/** COZMO plugin with the default config (max_say_chars 200). */
function cozmo({ maxSay = 200 } = {}) {
    // COZMO:314 _light_state — null/false is off, {r,g,b} 0..255.
    const light = (value) => {
        if (value == null || value === false) return null;
        if (!isObj(value) || !only(value, ['r', 'g', 'b'])) return 'light value is {r,g,b} or null';
        return ['r', 'g', 'b'].every((c) => byte(value[c])) ? null : 'r, g, b are integers 0..255';
    };
    return {
        name: 'cozmo',
        accepts(kind, v) {
            if (kind === 'halt') return halt(v);
            if (!isObj(v)) return `${kind} value must be an object`;
            if (kind === 'drive') {
                // COZMO:290 — throttle/steer (x/rotation is the dry-run's form; y is ignored).
                if (!('throttle' in v) && !('steer' in v)) return 'drive carries throttle/steer';
                return only(v, ['throttle', 'steer']) && ['throttle', 'steer'].every((a) => !(a in v) || num(v[a], -1, 1)) ? null : 'drive is throttle/steer -1..1';
            }
            if (kind === 'ptz') {
                // COZMO:265 — tilt moves the head; there is no pan axis.
                if ('pan' in v && v.pan !== 0 && v.pan != null) return 'Cozmo has no pan axis';
                return 'tilt' in v && num(v.tilt, -1, 1) ? null : 'ptz is tilt -1..1';
            }
            if (kind === 'actuator') {
                // COZMO:327
                const { name, value } = v;
                if (!only(v, name === 'cube_lights' ? ['name', 'value', 'cube'] : ['name', 'value'])) return 'an actuator is {name, value}';
                if (name === 'head') return num(value, -1, 1) ? null : 'head is -1..1';               // COZMO:303
                if (name === 'lift') return num(value, 0, 1) ? null : 'lift is 0..1';                 // COZMO:307
                if (name === 'backpack_lights' || name === 'cube_lights') return light(value);
                if (name === 'head_light') return typeof value === 'boolean' ? null : 'head_light is true or false';
                return `unknown actuator ${name}`;
            }
            if (kind === 'say') {
                // COZMO:371 — non-empty text; longer than max_say_chars would be cut.
                return typeof v.text === 'string' && v.text.trim() && v.text.length <= maxSay && only(v, ['text']) ? null : `say is {text} of 1..${maxSay} characters`;
            }
            if (kind === 'display') {
                // COZMO:407 — exactly one of image_png_b64, face, text (render.py: faces, 200 characters, 256 KB).
                const keys = Object.keys(v);
                if (keys.length !== 1) return 'display carries exactly one of image_png_b64, face, text';
                if ('image_png_b64' in v) return typeof v.image_png_b64 === 'string' && v.image_png_b64 && v.image_png_b64.length <= 256 * 1024 ? null : 'image_png_b64 is a base64 string';
                if ('face' in v) return COZMO_FACES.includes(v.face) ? null : `face is one of ${COZMO_FACES.join(', ')}`;
                if ('text' in v) return typeof v.text === 'string' && v.text.length <= 200 ? null : 'text is at most 200 characters';
                return 'display needs text, face or image_png_b64';
            }
            return `kind ${kind}`;                                                  // COZMO:277
        },
    };
}

/** The server-side drivers (docs/protocol.md, command values). */
const server = {
    'sim.rover': {
        name: 'sim (server)',
        accepts(kind, v) {
            if (kind === 'halt') return halt(v);
            if (kind !== 'drive') return `kind ${kind} not supported`;
            return isObj(v) && only(v, ['throttle', 'steer']) && num(v.throttle, -1, 1) && num(v.steer, -1, 1) ? null : 'drive is {throttle, steer} -1..1';
        },
    },
    'camera.onvif': {
        name: 'onvif (server)',
        accepts(kind, v) {
            if (kind === 'halt') return halt(v);
            if (kind !== 'ptz') return `kind ${kind} not supported`;
            const axes = isObj(v) ? Object.keys(v) : [];
            return axes.length && only(v, ['pan', 'tilt', 'zoom']) && axes.every((a) => num(v[a], -1, 1)) ? null : 'ptz is pan/tilt/zoom -1..1';
        },
    },
};

/** The contract a profile's commands must meet: its Node plugin, or the server driver. */
function contractFor(profile) {
    const m = profile.mapping || {};
    if (m.plugin === 'adeept_adr036') return adeept(m.wheels);
    if (m.plugin === 'cozmo') return cozmo();
    return server[profile.id] || null;
}

module.exports = { adeept, cozmo, server, contractFor, COZMO_FACES };
