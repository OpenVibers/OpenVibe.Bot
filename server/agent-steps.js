'use strict';
/**
 * A robot command as an agent-stream step (Agent Streams S7, design 2026-11-06 §6).
 *
 * When an agent drives a robot through Bot, every command is also a step on the agent's stream: "Drive forward 1 m":
 * passed. The row keeps the command's kind and value, who drove (the owner the agent acted for), the stream the caller
 * named and Bot's own result. The gate, the audit and the kill switch stay Bot's: this is a record, never a second way
 * to command the robot.
 *
 * Chat never writes a step through S5 or S6: the command route refuses the agent-stream surface for a chat token
 * before the robot moves, and this table is written only after Bot's own gate has answered.
 */
const MAX_TITLE = 120;

/** "Drive forward (throttle 1) for 1000 ms" from a command Bot accepted (or refused). */
function titleOf(kind, value = {}) {
    const k = String(kind || 'command');
    const v = value && typeof value === 'object' ? value : {};
    let text;
    if (k === 'drive') {
        const bits = Object.entries(v).slice(0, 3).map(([key, val]) => `${key} ${typeof val === 'number' ? Math.round(val * 1000) / 1000 : String(val)}`);
        text = `Drive ${bits.length ? `(${bits.join(', ')})` : ''}`;
    } else if (k === 'say') {
        text = `Say ${String(v.text || '').slice(0, 80)}`;
    } else if (k === 'stop') {
        text = 'Stop';
    } else {
        const bits = Object.entries(v).slice(0, 2).map(([key, val]) => `${key} ${typeof val === 'number' ? Math.round(val * 1000) / 1000 : String(val)}`);
        text = `${k.charAt(0).toUpperCase()}${k.slice(1)}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    }
    return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, MAX_TITLE).join('');
}

/** Record one command after Bot's gate answered. A failure to record never changes the command's answer. */
async function record(database, { robot, subject = null, streamId = null, body = {}, result = {} } = {}) {
    if (!robot || !robot.id) return null;
    const status = result.result === 'ack' ? 'passed' : (result.result === 'refused' ? 'refused' : 'failed');
    const title = titleOf(body.kind, body.value);
    try {
        const inserted = await database.query(
            `INSERT INTO robot_agent_steps (robot_id, subject_id, agent_stream_id, kind, title, status, reason, value)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id, at`,
            [robot.id, subject, /^ags_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(streamId || '')) ? String(streamId) : null,
                String(body.kind || 'command').slice(0, 40), title, status, result.code || result.reason || null,
                JSON.stringify(body.value && typeof body.value === 'object' ? body.value : {})]
        );
        const row = inserted && inserted.rows && inserted.rows[0];
        return row ? { id: Number(row.id), title, status } : { title, status };
    } catch (err) {
        console.warn('[Bot] the agent step was not recorded:', err && err.message);
        return null;
    }
}

/** The recent commands of a robot as steps, newest last (the overlay reads them in order). */
async function recent(database, robotId, { streamId = null, limit = 20 } = {}) {
    const cap = Math.min(50, Math.max(1, Number(limit) || 20));
    const result = streamId
        ? await database.query('SELECT * FROM robot_agent_steps WHERE robot_id = $1 AND agent_stream_id = $2 ORDER BY id DESC LIMIT $3', [String(robotId), String(streamId), cap])
        : await database.query('SELECT * FROM robot_agent_steps WHERE robot_id = $1 ORDER BY id DESC LIMIT $2', [String(robotId), cap]);
    const rows = (result && result.rows) || [];
    return rows.reverse().map((r) => ({
        id: Number(r.id),
        at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
        title: r.title,
        status: r.status,
        kind: r.kind,
        agent_stream_id: r.agent_stream_id || null,
        ...(r.reason ? { reason: r.reason } : {}),
    }));
}

module.exports = { record, recent, titleOf, MAX_TITLE };
