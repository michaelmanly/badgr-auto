import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { probeProxy } from '../src/probe-proxy.js';

let mockPort;
let mockServer;

function getFreePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  mockPort = await getFreePort();
  mockServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }

    const auth = req.headers.authorization || '';
    if (auth === 'Bearer good-key') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-badgr-route-tier': 'premium',
        'x-badgr-original-tokens': '42',
        'x-badgr-optimized-tokens': '40',
      });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      return;
    }

    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_api_key' }));
  });

  await new Promise((resolve) => mockServer.listen(mockPort, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => mockServer?.close(resolve));
});

describe('probeProxy', () => {
  it('treats 401 as failure (not success)', async () => {
    const result = await probeProxy(mockPort, 'security review', { apiKey: 'bad-key' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('treats 200 with saved key as success', async () => {
    const result = await probeProxy(mockPort, 'security review', { apiKey: 'good-key' });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.route).toBe('premium');
    expect(result.tokensBefore).toBe(42);
  });
});
