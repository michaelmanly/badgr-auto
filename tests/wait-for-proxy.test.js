import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { waitForProxy } from '../src/wait-for-proxy.js';

let mockPort;
let mockServer;

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === '/v1/models') {
      // Simulate slow upstream-backed models list
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"object":"list","data":[]}');
      }, 1200);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => {
    mockServer.listen(0, '127.0.0.1', resolve);
  });
  mockPort = mockServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => mockServer?.close(resolve));
});

describe('waitForProxy', () => {
  it('succeeds via /health before slow /v1/models would respond', async () => {
    const t0 = Date.now();
    const ready = await waitForProxy(mockPort, { timeoutMs: 3000, probeMs: 500 });
    expect(ready).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('returns false when nothing is listening', async () => {
    const ready = await waitForProxy(1, { timeoutMs: 400, probeMs: 100 });
    expect(ready).toBe(false);
  });
});
