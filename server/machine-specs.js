'use strict';
/**
 * What a machine is (OpenVibe Link v0.66 sends it with its status as `machine`; the owner, 2026-11-14: every operating
 * system supported and "aware of specs"). Bot keeps only these fields, typed and bounded, in devices.specs: the
 * operating system and its version, the CPU, memory, GPUs, the disk of the Link's state directory, the virtualization the
 * machine offers and its display. Nothing else the frame carries is stored, and a value of the wrong shape is dropped.
 *
 *   clean(frameMachine)   → the stored reading, or null when there is nothing usable
 *   summary(specs)        → the few facts placement needs: { memory_mb, threads, gpu_vram_mb, gpu, kvm, apple_vz, hyperv }
 *   words(specs)          → one short line for a card ("i7-7700 · 8 threads · 16 GB · Ubuntu 26.04")
 */
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : null);
const int = (v, max) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(max, Math.round(Number(v))) : null);
const num = (v, max) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(max, Math.round(Number(v) * 10) / 10) : null);
const DISPLAYS = new Set(['x11', 'wayland', 'quartz', 'windows', 'none']);

function clean(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const cpu = m.cpu && typeof m.cpu === 'object' ? m.cpu : {};
    const v = m.virtualization && typeof m.virtualization === 'object' ? m.virtualization : {};
    const out = {
        os_name: str(m.os_name, 80), os_version: str(m.os_version, 40), kernel: str(m.kernel, 80), arch: str(m.arch, 16), model: str(m.model, 60),
        cpu: { model: str(cpu.model, 120), cores: int(cpu.cores, 4096), threads: int(cpu.threads, 8192) },
        memory_mb: int(m.memory_mb, 1 << 30),
        gpus: (Array.isArray(m.gpus) ? m.gpus : []).slice(0, 8).filter((g) => g && typeof g === 'object' && str(g.model, 120))
            .map((g) => ({ vendor: str(g.vendor, 40), model: str(g.model, 120), vram_mb: int(g.vram_mb, 1 << 24) })),
        disk_total_gb: num(m.disk_total_gb, 1e6), disk_free_gb: num(m.disk_free_gb, 1e6),
        virtualization: { kvm: v.kvm === true, apple_vz: v.apple_vz === true, hyperv: v.hyperv === true, wsl: v.wsl === true, guest: v.guest === true, container: v.container === true },
        display: DISPLAYS.has(m.display) ? m.display : null,
    };
    if (!out.os_name && !out.cpu.threads && !out.memory_mb) return null;
    return out;
}

function summary(s) {
    if (!s) return null;
    const gpu = (s.gpus || [])[0] || null;
    return {
        memory_mb: s.memory_mb || null, threads: (s.cpu && s.cpu.threads) || null, gpu: gpu ? gpu.model : null,
        gpu_vram_mb: gpu && gpu.vram_mb ? gpu.vram_mb : null, disk_free_gb: s.disk_free_gb ?? null,
        kvm: !!(s.virtualization && s.virtualization.kvm), apple_vz: !!(s.virtualization && s.virtualization.apple_vz),
        hyperv: !!(s.virtualization && s.virtualization.hyperv),
    };
}

function words(s) {
    if (!s) return null;
    const cpu = s.cpu && s.cpu.model ? s.cpu.model.replace(/\((R|TM)\)/g, '').replace(/\s*CPU\s*@.*$/, '').replace(/\s+/g, ' ').trim() : null;
    const gb = s.memory_mb ? `${Math.round(s.memory_mb / 1024)} GB` : null;
    const gpu = (s.gpus || []).find((g) => g.vram_mb) || (s.gpus || [])[0];
    return [cpu, s.cpu && s.cpu.threads ? `${s.cpu.threads} threads` : null, gb,
        gpu ? `${gpu.model}${gpu.vram_mb ? ` ${Math.round(gpu.vram_mb / 1024)} GB` : ''}` : null,
        [s.os_name, s.os_version].filter(Boolean).join(' ') || null].filter(Boolean).join(' · ') || null;
}

/** Whether two readings are the same, whatever the order of their keys (jsonb reorders them). */
function same(a, b) {
    const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
    return canon(a) === canon(b);
}

module.exports = { clean, summary, words, same };
