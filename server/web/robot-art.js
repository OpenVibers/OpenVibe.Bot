'use strict';

/**
 * A robot's picture, drawn from its own profile (the owner's phone, 11-18: every model card was the same gamepad on a
 * blue box, "dumb, no that"). No photos are kept for the models, so each is drawn from what its profile says it has: a
 * base that drives (two wheels and a caster, or four mecanum wheels), a pan-tilt or a head, a lift, a camera eye, a
 * screen face, lights, a range finder, a speaker; a phone, a PTZ camera and a relay box are drawn as what they are. A
 * simulated robot is drawn in dashes over a grid. The colour comes from the model's id, so each one is its own.
 *
 *   artFor(profile) → an SVG document (640×360), safe to serve as image/svg+xml
 */

const has = (caps, re) => caps.some((c) => re.test(String(c)));
const hueOf = (id) => { let h = 0; for (const ch of String(id || 'robot')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function rover(caps, p) {
    const out = [];
    const mecanum = has(caps, /^drive\.(mecanum|holonomic)/) || /holonomic|mecanum/.test(p.id);
    const drives = mecanum || has(caps, /^drive\./);
    const screenFace = has(caps, /^display\./) || (has(caps, /^head$/) && !has(caps, /^camera$/));
    const head = has(caps, /^head$|pan_tilt|^ptz$/);
    // the base: wheels behind first, then the body over them
    if (mecanum) {
        out.push('<g class="far"><rect x="200" y="222" width="70" height="46" rx="12"/><rect x="370" y="222" width="70" height="46" rx="12"/></g>');
        for (const x of [180, 390]) out.push(`<g class="wheel"><rect x="${x}" y="232" width="74" height="52" rx="13"/><path d="M${x + 12} 280 l18 -44 M${x + 30} 280 l18 -44 M${x + 48} 280 l18 -44"/></g>`);
    } else if (drives) {
        out.push('<g class="wheel"><circle cx="230" cy="256" r="34"/><circle cx="230" cy="256" r="10"/><circle cx="410" cy="256" r="34"/><circle cx="410" cy="256" r="10"/></g>');
        out.push('<circle class="part" cx="320" cy="280" r="9"/>');
    } else {
        out.push('<path class="part" d="M220 286 h200"/>');
    }
    out.push('<rect class="body" x="180" y="176" width="280" height="78" rx="22"/>');
    if (has(caps, /^lights\./)) out.push('<g class="glow"><circle cx="208" cy="214" r="7"/><circle cx="432" cy="214" r="7"/></g>');
    if (has(caps, /ultrasonic|range/)) out.push('<g class="part"><circle cx="292" cy="226" r="11"/><circle cx="348" cy="226" r="11"/></g>');
    if (has(caps, /^speaker\./)) out.push('<path class="thin" d="M386 200 v28 M396 200 v28 M406 200 v28"/>');
    if (has(caps, /^lift$/)) out.push('<path class="part" d="M180 210 h-46 v-34 M180 236 h-46"/><path class="part" d="M134 176 h-26"/>');
    if (head || screenFace) {
        out.push('<path class="part" d="M320 176 v-26"/>');
        out.push('<rect class="body" x="252" y="86" width="136" height="68" rx="18"/>');
        if (screenFace) out.push('<rect class="screen" x="266" y="98" width="108" height="44" rx="10"/><g class="eyes"><rect x="292" y="110" width="14" height="20" rx="7"/><rect x="334" y="110" width="14" height="20" rx="7"/></g>');
        else out.push('<circle class="lens" cx="320" cy="120" r="20"/><circle class="glint" cx="327" cy="113" r="5"/>');
    } else if (has(caps, /^camera$/)) {
        out.push('<circle class="lens" cx="320" cy="214" r="18"/><circle class="glint" cx="326" cy="208" r="4"/>');
    }
    return out.join('');
}

function phone(caps) {
    return ['<rect class="body" x="252" y="62" width="136" height="236" rx="26"/>',
        '<rect class="screen" x="266" y="96" width="108" height="168" rx="12"/>',
        '<circle class="lens" cx="320" cy="80" r="7"/>',
        has(caps, /^display\./) ? '<g class="eyes"><rect x="296" y="160" width="12" height="18" rx="6"/><rect x="332" y="160" width="12" height="18" rx="6"/></g>' : '',
        has(caps, /torch|lights/) ? '<circle class="glow" cx="356" cy="80" r="5"/>' : ''].join('');
}

function ptz() {
    return ['<path class="part" d="M260 92 h120"/><rect class="body" x="290" y="92" width="60" height="30" rx="6"/>',
        '<path class="body" d="M236 150 a84 84 0 0 0 168 0 Z"/><path class="part" d="M236 150 h168"/>',
        '<circle class="lens" cx="320" cy="190" r="26"/><circle class="glint" cx="329" cy="181" r="6"/>'].join('');
}

function relay() {
    return ['<rect class="body" x="220" y="130" width="200" height="120" rx="18"/>',
        '<rect class="screen" x="250" y="160" width="62" height="60" rx="12"/><rect class="eyes" x="262" y="168" width="38" height="22" rx="8"/>',
        '<circle class="glow" cx="372" cy="176" r="9"/><path class="part" d="M420 220 c40 0 40 60 80 60"/>'].join('');
}

function artFor(profile) {
    const p = profile || {};
    const caps = Array.isArray(p.capabilities) ? p.capabilities.map(String) : [];
    const h = hueOf(p.id);
    const sim = p.kind === 'sim' || /^sim\./.test(String(p.id || ''));
    const drawn = /^phone\./.test(String(p.id || '')) || (has(caps, /^camera$/) && has(caps, /^display\./) && !has(caps, /^drive\./)) ? phone(caps)
        : has(caps, /^ptz$/) && !has(caps, /^drive\./) ? ptz()
            : has(caps, /^relay$/) ? relay()
                : rover(caps, p);
    const grid = sim ? '<g class="grid">' + Array.from({ length: 9 }, (_, i) => `<path d="M${80 + i * 60} 300 L${320 + (i - 4) * 120} 360"/>`).join('') + '<path d="M40 312 H600 M0 336 H640"/></g>' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="${esc(p.name || 'A robot')}">
<defs><radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="hsl(${h} 45% 22%)"/><stop offset="1" stop-color="hsl(${(h + 30) % 360} 40% 9%)"/></radialGradient></defs>
<style>
.body{fill:hsl(${h} 70% 58% / .2);stroke:hsl(${h} 85% 74%);stroke-width:6;stroke-linejoin:round${sim ? ';stroke-dasharray:14 10' : ''}}
.far rect{fill:hsl(${h} 30% 30% / .5);stroke:hsl(${h} 50% 55% / .6);stroke-width:5}
.wheel circle,.wheel rect{fill:hsl(${h} 25% 14%);stroke:hsl(${h} 70% 70%);stroke-width:6}.wheel path{stroke:hsl(${h} 70% 70% / .7);stroke-width:4;fill:none}
.part{fill:none;stroke:hsl(${h} 85% 74%);stroke-width:6;stroke-linecap:round;stroke-linejoin:round}.thin{fill:none;stroke:hsl(${h} 70% 70% / .8);stroke-width:4;stroke-linecap:round}
.screen{fill:hsl(${(h + 180) % 360} 60% 12%);stroke:hsl(${h} 85% 74%);stroke-width:4}.eyes rect,.eyes{fill:hsl(${(h + 160) % 360} 90% 72%)}
.lens{fill:hsl(${h} 30% 10%);stroke:hsl(${h} 85% 74%);stroke-width:6}.glint{fill:#fff;opacity:.8}.glow,.glow circle{fill:hsl(${(h + 40) % 360} 95% 66%)}
.grid path{stroke:hsl(${h} 60% 60% / .22);stroke-width:2;fill:none}
</style>
<rect width="640" height="360" fill="url(#bg)"/>${grid}
<ellipse cx="320" cy="300" rx="190" ry="16" fill="#000" opacity=".35"/>
${drawn}
</svg>`;
}

module.exports = { artFor, hueOf };
