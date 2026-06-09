/**
 * Send one chat request through the local proxy during onboarding probes.
 * Cloud probes must pass the saved Badgr API key; only HTTP 2xx counts as success.
 */
export async function probeProxy(proxyPort, prompt, { apiKey } = {}) {
  try {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(`http://localhost:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'badgr-auto',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      route: res.headers.get('x-badgr-route-tier') || '—',
      tokensBefore: Number.parseInt(res.headers.get('x-badgr-original-tokens') || '0', 10),
      tokensAfter: Number.parseInt(res.headers.get('x-badgr-optimized-tokens') || '0', 10),
    };
  } catch {
    return { ok: false, status: 0, route: '—', tokensBefore: 0, tokensAfter: 0 };
  }
}
