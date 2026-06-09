/**
 * Detect local hardware (VRAM, RAM, CPU) and recommend the best Ollama model
 * that can run without crashing the machine.
 */

import { execSync } from 'child_process';
import os from 'os';

// Ordered from most to least capable; pick first one that fits.
const MODEL_TIERS = [
  { name: 'qwen2.5-coder:14b', vramGb: 12, ramGb: 24, label: 'high-end (14 B)' },
  { name: 'qwen2.5-coder:7b',  vramGb: 6,  ramGb: 12, label: 'mid-range (7 B)' },
  { name: 'qwen2.5-coder:3b',  vramGb: 3,  ramGb: 6,  label: 'light (3 B)' },
  { name: 'phi3:mini',          vramGb: 2,  ramGb: 4,  label: 'minimal (phi3 mini)' },
];

function tryExec(cmd) {
  try { return execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}

/** Returns VRAM in GB, or 0 if no discrete GPU found. */
export function detectVramGb() {
  // NVIDIA
  const nvOut = tryExec('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
  if (nvOut) {
    const mib = Number.parseFloat(nvOut.split('\n')[0]);
    if (!Number.isNaN(mib)) return mib / 1024;
  }

  // AMD ROCm
  const rocOut = tryExec('rocm-smi --showmeminfo vram --csv');
  if (rocOut) {
    const match = rocOut.match(/(\d+)/);
    if (match) return Number.parseInt(match[1], 10) / 1024;
  }

  // Apple Metal — sysctl reports unified memory, treat as both RAM and VRAM
  const metalOut = tryExec('sysctl -n hw.memsize');
  if (metalOut && process.platform === 'darwin') {
    return Number.parseInt(metalOut, 10) / (1024 ** 3);
  }

  return 0;
}

/** Returns total system RAM in GB. */
export function detectRamGb() {
  return os.totalmem() / (1024 ** 3);
}

/** Returns CPU logical core count. */
export function detectCpuCores() {
  return os.cpus().length;
}

/**
 * Returns the recommended Ollama model tag given the detected hardware,
 * or null if the machine is too constrained even for phi3:mini.
 */
export function recommendModel(vramGb = 0, ramGb = 0) {
  for (const tier of MODEL_TIERS) {
    const fitsGpu = vramGb >= tier.vramGb;
    const fitsCpu = ramGb  >= tier.ramGb;
    if (fitsGpu || fitsCpu) return tier;
  }
  return null;
}

/** Collect all hardware info in one call. */
export function detectHardware() {
  const vramGb  = detectVramGb();
  const ramGb   = detectRamGb();
  const cpuCores = detectCpuCores();
  const recommended = recommendModel(vramGb, ramGb);
  return { vramGb, ramGb, cpuCores, recommended };
}
