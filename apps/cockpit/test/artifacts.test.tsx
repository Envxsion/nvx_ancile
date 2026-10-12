/**
 * Artifacts in the Cockpit: the frame's document carries a CSP with the
 * network off (https only when allowed, never http), the bootstrap first,
 * content that cannot break out of its script; answers split into prose and
 * cards; the panel's record falls back to the card's own copy; downloads get
 * sensible names; the frame accepts only well-formed messages from itself.
 * The sandbox's real behaviour is proven in tests/e2e/artifacts.spec.ts.
 */
import type { ParsedArtifact, ThreadArtifacts } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ProseWithArtifacts } from '../src/artifacts/ArtifactCard';
import { ARTIFACT_SANDBOX, ArtifactFrame } from '../src/artifacts/ArtifactFrame';
import { artifactCsp, buildArtifactDocument, jsonText, scriptText } from '../src/artifacts/document';
import { fileName, mimeOf } from '../src/artifacts/meta';
import { artifactRecord, useArtifacts } from '../src/artifacts/store';
import { queryClient } from '../src/lib/query';

const theme = {
  scheme: 'dark' as const,
  bg: '#000',
  fg: '#fff',
  mute: '#888',
  edge: '#333',
  font: 'sans-serif',
  mono: 'monospace',
};

describe('artifact document', () => {
  it('keeps the network off by default and never allows plain http', () => {
    const off = artifactCsp('html', false);
    expect(off).toContain("default-src 'none'");
    expect(off).toContain("connect-src 'none'");
    expect(off).toContain("frame-src 'none'");
    expect(off).toContain("form-action 'none'");
    expect(off).not.toMatch(/https?:/);
    const on = artifactCsp('html', true);
    expect(on).toContain('connect-src https:');
    expect(on).not.toContain('http:');
    expect(on).not.toContain('localhost');
    expect(artifactCsp('react', false)).toContain("'unsafe-eval'");
  });

  it('puts the CSP first in the head and the bootstrap before the content', () => {
    const doc = buildArtifactDocument({
      type: 'html',
      content: '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>hi</p>',
      nonce: 'abcdef123456',
      allowNetwork: false,
      theme,
    });
    const csp = doc.indexOf('Content-Security-Policy');
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(doc.indexOf('<script>'));
    expect(doc.indexOf('<script>')).toBeLessThan(doc.indexOf('<p>hi</p>'));
    expect(doc).toContain('abcdef123456');
  });

  it('keeps compiled code and diagram text inside their script elements', () => {
    expect(scriptText('a("</script><img>")')).not.toContain('</script');
    expect(jsonText('</script><b>')).not.toMatch(/[<>]/);
    const doc = buildArtifactDocument({
      type: 'mermaid',
      content: 'graph TD; A["</script><script>alert(1)</script>"]-->B',
      nonce: 'abcdef123456',
      allowNetwork: false,
      theme,
      runtime: { mermaid: 'var mermaid={}' },
    });
    expect(doc.match(/<\/script>/g)?.length).toBe(doc.match(/<script[ >]/g)?.length);
  });
});

describe('artifact names', () => {
  it('names downloads by type and language', () => {
    expect(fileName('html', 'page', 'html')).toBe('page.html');
    expect(fileName('react', 'counter', 'tsx')).toBe('counter.tsx');
    expect(fileName('code', 'script', 'python')).toBe('script.py');
    expect(fileName('code', 'x', null)).toBe('x.txt');
    expect(mimeOf('svg')).toBe('image/svg+xml');
  });
});

const art: ParsedArtifact = {
  key: 'page',
  type: 'html',
  title: 'Landing page',
  language: 'html',
  content: '<h1>Hi</h1>',
  complete: true,
  start: 0,
  end: 10,
};

describe('artifact record', () => {
  it("falls back to the card's own copy, then uses Core's versions", () => {
    const local = artifactRecord(
      { threadId: 'thr_1', messageId: 'm1', artifact: art, version: null },
      undefined,
    );
    expect(local.local).toBe(true);
    expect(local.versions).toHaveLength(1);
    expect(local.allow_network).toBe(false);
    const list: ThreadArtifacts = {
      items: [
        {
          key: 'page',
          type: 'html',
          title: 'Landing page',
          allow_network: true,
          network_changed_at: '2026-10-12T10:00:00.000Z',
          versions: [
            {
              version: 1,
              message_id: 'm0',
              created_at: '2026-10-12T09:00:00.000Z',
              type: 'html',
              title: 'x',
              language: 'html',
              content: 'a',
            },
            {
              version: 2,
              message_id: 'm1',
              created_at: '2026-10-12T09:30:00.000Z',
              type: 'html',
              title: 'x',
              language: 'html',
              content: 'b',
            },
          ],
        },
      ],
    };
    const remote = artifactRecord({ threadId: 'thr_1', messageId: 'm1', artifact: art, version: null }, list);
    expect(remote.local).toBe(false);
    expect(remote.versions).toHaveLength(2);
    expect(remote.allow_network).toBe(true);
  });
});

describe('prose with artifacts', () => {
  beforeEach(() => useArtifacts.getState().close());

  it('renders a card for the artifact and opens the panel on click', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ProseWithArtifacts threadId="thr_1" messageId="m1" live={false}>
          {'Here you go:\n\n```html artifact title="Landing page"\n<h1>Hi</h1>\n```\n\nEnjoy.'}
        </ProseWithArtifacts>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Here you go:')).toBeInTheDocument();
    expect(screen.getByText('Enjoy.')).toBeInTheDocument();
    const card = screen.getByRole('button', { name: /Open Landing page, Web page/ });
    fireEvent.click(card);
    expect(useArtifacts.getState().open?.artifact.key).toBe('landing-page');
    expect(useArtifacts.getState().open?.messageId).toBe('m1');
  });

  it('shows an artifact still being written as such, and leaves plain answers alone', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ProseWithArtifacts messageId="m2" live>
          {'```svg artifact title="Logo"\n<svg>\n<circle/>'}
        </ProseWithArtifacts>
        <ProseWithArtifacts messageId="m3" live={false}>
          {'No artifact **here**.'}
        </ProseWithArtifacts>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Writing Logo' })).toBeDisabled();
    expect(screen.getByText(/Writing · 2 lines/)).toBeInTheDocument();
    expect(screen.getByText('here')).toBeInTheDocument();
  });
});

describe('artifact frame', () => {
  it('is sandboxed with scripts only, and ignores messages from anywhere else', async () => {
    const offers: unknown[] = [];
    render(
      <ArtifactFrame
        type="html"
        content="<p>x</p>"
        title="Sample"
        allowNetwork={false}
        onOffer={(o) => offers.push(o)}
      />,
    );
    const frame = await screen.findByTitle('Sample');
    expect(ARTIFACT_SANDBOX).toBe('allow-scripts');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    // From this window (not the frame), with a plausible shape: dropped.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { channel: 'nvx-ancile-artifact', nonce: 'abcdefgh', kind: 'copy', text: 'x' },
          origin: 'null',
          source: window,
        }),
      );
    });
    expect(offers).toEqual([]);
  });
});
