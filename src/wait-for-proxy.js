/** Wait until the local proxy responds on /health (fast; do not use /v1/models — it blocks on upstream). */
export async function waitForProxy(port, { timeoutMs = 12_000, probeMs = 2_000 } = {}) {
  const ports = Array.isArray(port) ? port : [port];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const p of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(probeMs) });
        if (res.ok) return true;
      } catch {
        // proxy still starting or port not bound yet
      }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}
