export const LOCAL_SERVERS = [
  {
    name: 'ollama',
    url: 'http://localhost:11434',
    modelsPath: '/api/tags',
    extractModels: (data) => (data.models || []).map(m => m.name),
  },
  {
    name: 'lmstudio',
    url: 'http://localhost:1234',
    modelsPath: '/v1/models',
    extractModels: (data) => (data.data || []).map(m => m.id),
  },
];

export async function detectLocalServers() {
  const results = [];
  for (const server of LOCAL_SERVERS) {
    try {
      const response = await fetch(`${server.url}${server.modelsPath}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      results.push({ name: server.name, url: server.url, models: server.extractModels(data) });
    } catch {
      // Server not available — skip silently
    }
  }
  return results;
}
