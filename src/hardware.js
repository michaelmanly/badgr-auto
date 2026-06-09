import { execSync } from 'child_process';
import os from 'os';

// Conservative tiers. All thresholds are minimums required to safely run the model.
// Uses total VRAM/RAM — load check is a separate gate (see detectSystemLoad).
const MODEL_TIERS = [
  { name: 'qwen2.5-coder:32b', minVramGb: 24, minRamGb: 48, paramB: 32, label: 'top-end (32 B)' },
  { name: 'qwen2.5-coder:14b', minVramGb: 12, minRamGb: 24, paramB: 14, label: 'high-end (14 B)' },
  { name: 'qwen2.5-coder:7b',  minVramGb: 8,  minRamGb: 16, paramB: 7,  label: 'mid-range (7 B)' },
];

// Skip local entirely when GPU or system memory is already under pressure.
const HIGH_LOAD_VRAM_PCT = 70;
const HIGH_LOAD_RAM_PCT  = 85;

// Prefer models trained specifically for code generation.
const CODING_PATTERNS = [
  /qwen.*coder/i, /deepseek.*coder/i, /codellama/i, /starcoder/i, /codegemma/i,
];

function tryExec(cmd) {
  try { return execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}

/** Returns total VRAM in GB (for display), or 0 if no discrete GPU found. */
export function detectVramGb() {
  const nvOut = tryExec('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
  if (nvOut) {
    const mib = Number.parseFloat(nvOut.split('\n')[0]);
    if (!Number.isNaN(mib)) return mib / 1024;
  }
  const rocOut = tryExec('rocm-smi --showmeminfo vram --csv');
  if (rocOut) {
    const match = rocOut.match(/(\d+)/);
    if (match) return Number.parseInt(match[1], 10) / 1024;
  }
  if (process.platform === 'darwin') {
    const metalOut = tryExec('sysctl -n hw.memsize');
    if (metalOut) return Number.parseInt(metalOut, 10) / (1024 ** 3);
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
 * Snapshot of current memory pressure.
 * isHighLoad = true means skip local and route to cloud instead.
 */
export function detectSystemLoad() {
  const totalRam = os.totalmem();
  const freeRam  = os.freemem();
  const ramUsedPct = Math.round((1 - freeRam / totalRam) * 100);

  let vramUsedPct = 0;
  const nvInfo = tryExec('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits');
  if (nvInfo) {
    const parts = nvInfo.split('\n')[0].split(',').map(s => Number.parseFloat(s.trim()));
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1]) && parts[1] > 0) {
      vramUsedPct = Math.round((parts[0] / parts[1]) * 100);
    }
  }

  return {
    vramUsedPct,
    ramUsedPct,
    isHighLoad: vramUsedPct > HIGH_LOAD_VRAM_PCT || ramUsedPct > HIGH_LOAD_RAM_PCT,
  };
}

/**
 * Returns the recommended model tier for the given hardware, or null if:
 *  - total VRAM < 8 GB AND total RAM < 16 GB (too constrained for any supported model)
 *
 * Uses total VRAM/RAM; call detectSystemLoad() separately to gate on live pressure.
 */
export function recommendModel(vramGb = 0, ramGb = 0) {
  for (const tier of MODEL_TIERS) {
    if (vramGb >= tier.minVramGb || ramGb >= tier.minRamGb) return tier;
  }
  return null;
}

function isCodingModel(name) {
  return CODING_PATTERNS.some(p => p.test(name));
}

function estimateParamB(modelName) {
  const match = modelName.match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  return match ? Number.parseFloat(match[1]) : null;
}

/**
 * Auto-selects the best local model from installed ones.
 *
 * Rules (in priority order):
 *  1. If hardware is too constrained → null (caller routes to cloud)
 *  2. Coding models beat general models
 *  3. Largest model that fits within the hardware tier wins
 *  4. If no installed model fits, return null (don't guess)
 */
export function selectBestLocalModel(installedModels, vramGb = 0, ramGb = 0) {
  if (!installedModels || installedModels.length === 0) return null;

  const recommended = recommendModel(vramGb, ramGb);
  if (!recommended) return null;

  const maxParamB = recommended.paramB;

  const candidates = installedModels
    .map(name => ({
      name,
      paramB: estimateParamB(name),
      isCoding: isCodingModel(name),
    }))
    .filter(m => m.paramB === null || m.paramB <= maxParamB + 1);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.isCoding !== b.isCoding) return a.isCoding ? -1 : 1;
    return (b.paramB ?? 0) - (a.paramB ?? 0);
  });

  return candidates[0].name;
}

/** Collect all hardware + load info in one call. */
export function detectHardware() {
  const vramGb    = detectVramGb();
  const ramGb     = detectRamGb();
  const cpuCores  = detectCpuCores();
  const systemLoad = detectSystemLoad();
  const recommended = systemLoad.isHighLoad ? null : recommendModel(vramGb, ramGb);
  return { vramGb, ramGb, cpuCores, recommended, systemLoad };
}
