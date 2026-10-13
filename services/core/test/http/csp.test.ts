/**
 * The Cockpit's page header (http/csp.ts): pages may not be framed, and
 * their frames may load the frame host's exact URL only; the frame host is
 * sandboxed by header; anything that is not a page is left alone.
 */
import { FRAME_HOST_PATH } from '@nvx/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { cockpitPageHeaders } from '../../src/http/csp';

function app() {
  const a = new Hono();
  a.use('/*', cockpitPageHeaders());
  a.get('/assets/x.js', (c) => c.body('1', 200, { 'content-type': 'text/javascript' }));
  a.get('*', (c) => c.html('<!doctype html><p>page</p>'));
  return a;
}

describe('the Cockpit page header', () => {
  it('a page cannot be framed, and frames only the frame host at the address the browser used', async () => {
    const res = await app().request('/t/thr_1', { headers: { host: '127.0.0.1:17700' } });
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(`frame-ancestors 'none'; frame-src http://127.0.0.1:17700${FRAME_HOST_PATH}`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('the frame host is sandboxed by header, so it is opaque even opened on its own', async () => {
    const res = await app().request(FRAME_HOST_PATH, { headers: { host: '127.0.0.1:17700' } });
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
  });

  it('a Host header that is not a host name frames nothing', async () => {
    const res = await app().request('/', { headers: { host: "evil' 'unsafe-inline" } });
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'; frame-src 'none'");
  });

  it('leaves scripts and other files alone', async () => {
    const res = await app().request('/assets/x.js', { headers: { host: '127.0.0.1:17700' } });
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});
