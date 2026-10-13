/**
 * Images in a thread (docs/images.md): image parts and local Markdown images
 * render inline, lazy, with alt text; a remote image is never loaded until
 * its host is allowed, then only through Core's proxy; where nothing may
 * leave the machine there is no button; the lightbox is a named dialog with
 * named controls that Escape closes; an image_generate step shows its images
 * with prompt, model and cost.
 */
import type { ImageGenerateResult, Part, RemoteImageHosts } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ImageGenBody, imageMeta } from '../src/images/ImageGenBody';
import { ImageThreadProvider, ThreadImage } from '../src/images/ThreadImage';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode, threadId: string | null = 'thr_1') =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <ImageThreadProvider threadId={threadId}>{ui}</ImageThreadProvider>
      </Tooltip.Provider>
    </QueryClientProvider>,
  );

const hosts = (h: Partial<RemoteImageHosts> = {}): RemoteImageHosts => ({
  remembered_in: 'notebook',
  hosts: [],
  allowed: true,
  ...h,
});

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
});

describe('images inline', () => {
  it('shows a stored image lazily with its alt text, and opens it in a named lightbox', async () => {
    wrap(<ThreadImage src="/api/v1/images/img_A" alt="A red pump" width={40} height={30} />);
    const img = screen.getByRole('img', { name: 'A red pump' });
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('src')).toBe('/api/v1/images/img_A');
    fireEvent.click(screen.getByRole('button', { name: 'Open image: A red pump' }));
    const dialog = await screen.findByRole('dialog', { name: 'A red pump' });
    for (const name of ['Zoom in', 'Zoom out', 'Copy image', 'Close'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download image' }).getAttribute('download')).toBe(
      'a-red-pump.png',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('150%')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows data: images directly', () => {
    wrap(<ThreadImage src="data:image/png;base64,iVBORw0KGgo=" alt="Chart" />);
    expect(screen.getByRole('img', { name: 'Chart' }).getAttribute('src')).toMatch(/^data:image\/png/);
  });

  it('never loads a remote image before its host is allowed, then loads it through Core', async () => {
    mocked.get.mockResolvedValue(hosts());
    mocked.post.mockResolvedValue(hosts({ hosts: ['tracker.example'] }));
    wrap(<ThreadImage src="https://tracker.example/pixel.png" alt="Logo" />);
    const load = await screen.findByRole('button', { name: 'Load image from tracker.example' });
    expect(screen.queryByRole('img', { name: 'Logo' })).toBeNull();
    expect(
      screen.getByText(/Loading it would tell tracker.example you read this. Remembered for this notebook./),
    ).toBeTruthy();
    fireEvent.click(load);
    expect(mocked.post).toHaveBeenCalledWith('/threads/thr_1/image-hosts', { host: 'tracker.example' });
    const img = await screen.findByRole('img', { name: 'Logo' });
    expect(img.getAttribute('src')).toBe(
      `/api/v1/threads/thr_1/images/remote?url=${encodeURIComponent('https://tracker.example/pixel.png')}`,
    );
  });

  it('offers no load where nothing may leave this machine, or outside a thread', async () => {
    mocked.get.mockResolvedValue(hosts({ allowed: false }));
    const { unmount } = wrap(<ThreadImage src="https://cdn.example/a.png" alt="" />);
    expect(await screen.findByText(/nothing leaves this machine here/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
    unmount();
    wrap(<ThreadImage src="https://cdn.example/a.png" alt="" />, null);
    expect(screen.getByText(/An image from cdn.example is not loaded here/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open link' }).getAttribute('rel')).toContain('noreferrer');
  });
});

describe('an image_generate step', () => {
  const call: Extract<Part, { type: 'tool_call' }> = {
    type: 'tool_call',
    call_id: 'c1',
    tool: 'image_generate',
    args: { prompt: 'A red pump on a white bench' },
  };
  const out: ImageGenerateResult = {
    images: [{ id: 'img_G', url: '/api/v1/images/img_G', width: 1024, height: 1024 }],
    prompt: 'A red pump on a white bench',
    model: 'gpt-image-1',
    provider: 'openai',
    provider_kind: 'cloud',
    cost_usd: 0.04,
  };

  it('shows the image with its prompt, model and cost', () => {
    wrap(<ImageGenBody call={call} result={{ type: 'tool_result', call_id: 'c1', ok: true, result: out }} />);
    expect(screen.getByRole('img', { name: 'A red pump on a white bench' })).toBeTruthy();
    expect(screen.getByText(/gpt-image-1 on openai \(cloud\) · \$0\.04/)).toBeTruthy();
    expect(imageMeta({ type: 'tool_result', call_id: 'c1', ok: true, result: out })).toBe('1 image · $0.04');
  });

  it('says what is happening while it runs, and why it failed', () => {
    const { unmount } = wrap(<ImageGenBody call={call} result={undefined} />);
    expect(screen.getByText('Making the image')).toBeTruthy();
    unmount();
    wrap(
      <ImageGenBody
        call={call}
        result={{ type: 'tool_result', call_id: 'c1', ok: false, result: 'No image provider is set up.' }}
      />,
    );
    expect(screen.getByText('No image provider is set up.')).toBeTruthy();
  });
});
