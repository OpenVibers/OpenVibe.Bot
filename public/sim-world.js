'use strict';

/**
 * The simulated rover's world (sim.rover): one small arena that Bot's in-process simulator (server/sim) and the
 * browser (the /try page's local rover, and the camera of every sim robot's panel) share, so the picture a panel
 * draws and the pose the server keeps always agree. No DOM, no Node API: it loads as a CommonJS module on the
 * server and as `window.OVSimWorld` in a page.
 *
 * Units are metres, seconds and degrees, with +y "up" a top-down view and +x to its right. Heading 0 faces +y and
 * 90 faces +x, so a positive steer turns right (the simulator's convention since Bot#20): forward at full throttle is
 * 0.5 m/s and a full steer turns 90 °/s, as before. MAP's text rows run from y = 0 at the top of the text.
 *
 *   step(pose, drive, dt)  → { pose, bumped }   one kinematic step with collisions (a bumper stops the move)
 *   distanceCm(pose)       → the ultrasonic reading ahead, in cm (≤ 400), from a 12° cone
 *   line(pose)             → { left, middle, right }: whether each line sensor is over the tape
 *   floorAt(x, y)          → 'line' | 'tile' | 'tile2'
 *   cast(x, y, angle, max) → the cells a ray crosses, nearest first ({ dist, cell, side, u })
 *   solid(cx, cy), cellAt(cx, cy), MAP, CELL, COLS, ROWS, START, ROVER_RADIUS, CAMERA_HEIGHT, heights
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OVSimWorld = factory();
}(typeof self !== 'undefined' ? self : this, () => {
    const CELL = 0.5;
    // '#' arena wall, 'r' 'b' 'g' 'y' crates, '.' floor. Row r covers y ∈ [r·CELL, (r+1)·CELL); column c covers x.
    const MAP = [
        '################',
        '#..............#',
        '#..r.......b...#',
        '#..............#',
        '#.....##.......#',
        '#.....##....g..#',
        '#..............#',
        '#..y...........#',
        '#..........b...#',
        '#......r.......#',
        '#..............#',
        '################',
    ];
    const COLS = MAP[0].length;
    const ROWS = MAP.length;
    const ROVER_RADIUS = 0.14;
    const CAMERA_HEIGHT = 0.12;
    const SPEED = 0.5;             // m/s at full throttle
    const TURN = 90;               // °/s at full steer
    /** How tall each solid is, in metres: the arena wall stands above the rover's camera, crates are lower. */
    const heights = { '#': 0.42, r: 0.26, b: 0.3, g: 0.22, y: 0.26 };
    // Parked on the tape at the near left corner, facing along it (+y).
    const START = Object.freeze({ x: 1.0, y: 1.5, heading: 0 });

    // The tape loop: a rectangle with rounded corners, 5 cm wide, around the crates.
    const LOOP = { x0: 1.0, y0: 0.75, x1: 7.0, y1: 5.25, r: 0.45, half: 0.025 };

    const cellAt = (cx, cy) => (cy < 0 || cy >= ROWS || cx < 0 || cx >= COLS ? '#' : MAP[cy][cx]);
    const solid = (cx, cy) => cellAt(cx, cy) !== '.';
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const rad = (deg) => (deg * Math.PI) / 180;

    /** Distance from (x, y) to the loop's centre line. */
    function loopDistance(x, y) {
        const { x0, y0, x1, y1, r } = LOOP;
        // Distance to a rounded rectangle's outline: clamp to the inner rectangle, then subtract the radius.
        const ix0 = x0 + r; const iy0 = y0 + r; const ix1 = x1 - r; const iy1 = y1 - r;
        const dx = Math.max(ix0 - x, 0, x - ix1);
        const dy = Math.max(iy0 - y, 0, y - iy1);
        if (dx > 0 || dy > 0) return Math.abs(Math.hypot(dx, dy) - r);
        // Inside the inner rectangle: the nearest straight edge.
        return Math.min(x - ix0, ix1 - x, y - iy0, iy1 - y) + r;
    }
    function floorAt(x, y) {
        if (loopDistance(x, y) <= LOOP.half) return 'line';
        return (Math.floor(x / CELL) + Math.floor(y / CELL)) % 2 ? 'tile2' : 'tile';
    }

    /** Does a rover of radius `r` at (x, y) touch a solid cell? */
    function blocked(x, y, r = ROVER_RADIUS) {
        for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
            for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
                if (!solid(cx, cy)) continue;
                const nx = Math.max(cx * CELL, Math.min(x, (cx + 1) * CELL));
                const ny = Math.max(cy * CELL, Math.min(y, (cy + 1) * CELL));
                if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
            }
        }
        return false;
    }

    /**
     * One kinematic step: forward speed from throttle (or y), turn rate from steer (or rotation), sideways from x
     * (a holonomic drive). Each axis of the move is tried on its own, so the rover slides along a wall; a move a
     * solid stops is `bumped`.
     */
    function step(pose, drive = {}, dt = 0) {
        const speed = num(drive.throttle != null ? drive.throttle : drive.y);
        const turn = num(drive.steer != null ? drive.steer : drive.rotation);
        const strafe = num(drive.x);
        const t = Math.max(0, Math.min(1, dt));
        const heading = (((num(pose.heading) + turn * TURN * t) % 360) + 360) % 360;
        const a = rad(heading);
        const dx = (speed * Math.sin(a) + strafe * Math.cos(a)) * SPEED * t;
        const dy = (speed * Math.cos(a) - strafe * Math.sin(a)) * SPEED * t;
        let x = num(pose.x); let y = num(pose.y);
        let bumped = false;
        if (dx) { if (blocked(x + dx, y)) bumped = true; else x += dx; }
        if (dy) { if (blocked(x, y + dy)) bumped = true; else y += dy; }
        return { pose: { x, y, heading }, bumped };
    }

    /**
     * Every cell a ray from (x, y) at `angle` (degrees, the heading convention) crosses until an arena wall or
     * `max` metres, nearest first: { dist (along the ray), cell, side ('x' | 'y'), u (0..1 across the face) }.
     */
    function cast(x, y, angle, max = 12) {
        const a = rad(angle);
        const rx = Math.sin(a); const ry = Math.cos(a);
        let cx = Math.floor(x / CELL); let cy = Math.floor(y / CELL);
        const stepX = rx > 0 ? 1 : -1; const stepY = ry > 0 ? 1 : -1;
        const dX = rx ? Math.abs(CELL / rx) : Infinity; const dY = ry ? Math.abs(CELL / ry) : Infinity;
        let tX = rx ? ((rx > 0 ? (cx + 1) * CELL - x : x - cx * CELL) / Math.abs(rx)) : Infinity;
        let tY = ry ? ((ry > 0 ? (cy + 1) * CELL - y : y - cy * CELL) / Math.abs(ry)) : Infinity;
        const hits = [];
        for (let i = 0; i < 64; i++) {
            let dist; let side;
            if (tX < tY) { dist = tX; tX += dX; cx += stepX; side = 'x'; } else { dist = tY; tY += dY; cy += stepY; side = 'y'; }
            if (dist > max) break;
            const cell = cellAt(cx, cy);
            if (cell === '.') continue;
            const hx = x + rx * dist; const hy = y + ry * dist;
            const u = side === 'x' ? (hy / CELL) % 1 : (hx / CELL) % 1;
            hits.push({ dist, cell, side, u, cx, cy });
            if (cell === '#') break;
        }
        return hits;
    }

    /** The ultrasonic sensor 0.1 m ahead of the centre: the nearest solid inside a 12° cone, in whole cm (≤ 400). */
    function distanceCm(pose) {
        const a = rad(pose.heading);
        const sx = pose.x + Math.sin(a) * 0.1; const sy = pose.y + Math.cos(a) * 0.1;
        let best = 4;
        for (const off of [-6, -3, 0, 3, 6]) {
            const h = cast(sx, sy, pose.heading + off, 4)[0];
            if (h && h.dist < best) best = h.dist;
        }
        return Math.round(best * 100);
    }

    /** Three line sensors 0.12 m ahead, 4 cm apart: whether each is over the tape. */
    function line(pose) {
        const a = rad(pose.heading);
        const fx = pose.x + Math.sin(a) * 0.12; const fy = pose.y + Math.cos(a) * 0.12;
        const at = (side) => floorAt(fx + Math.cos(a) * side, fy - Math.sin(a) * side) === 'line';
        return { left: at(-0.04), middle: at(0), right: at(0.04) };
    }

    return { MAP, CELL, COLS, ROWS, START, ROVER_RADIUS, CAMERA_HEIGHT, SPEED, TURN, LOOP, heights, cellAt, solid, blocked, floorAt, step, cast, distanceCm, line };
}));
