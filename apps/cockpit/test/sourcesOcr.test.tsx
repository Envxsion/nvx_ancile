/**
 * SR1: a scanned PDF's error points at a setting that exists. Settings →
 * Sources has the OCR switch and language; the failed source's card offers
 * Read with OCR (only for a scan); the help article says so.
 */
import type { OcrView, Source } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ARTICLES } from '../src/help/articles';
import { api } from '../src/lib/api';
import { toSourceView } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import { SourceCard } from '../src/sources/SourceCard';
import { enginesWords, SourcesGroup } from '../src/sources/SourcesGroup';

const mocked = vi.mocked(api);

const view = (over: Partial<OcrView> = {}): OcrView => ({
  enabled: false,
  language: 'en',
  installed: { rapidocr: true, tesseract: false },
  ...over,
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  queryClient.clear();
  for (const m of Object.values(mocked)) (m as ReturnType<typeof vi.fn>).mockReset();
});

describe('Settings → Sources', () => {
  it('turns OCR on with a switch that saves at once', async () => {
    mocked.get.mockResolvedValue(view());
    mocked.put.mockResolvedValue(view({ enabled: true }));
    wrap(<SourcesGroup />);
    const sw = await screen.findByRole('switch', { name: 'Read scanned PDFs with OCR' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/knowledge/ocr', { enabled: true, language: 'en' }),
    );
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
  });

  it('saves the language when you leave the field, in lower case', async () => {
    mocked.get.mockResolvedValue(view());
    mocked.put.mockResolvedValue(view({ language: 'de' }));
    wrap(<SourcesGroup />);
    const field = await screen.findByLabelText('Language of your scans');
    await waitFor(() => expect(field).not.toBeDisabled());
    fireEvent.change(field, { target: { value: 'DE' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/knowledge/ocr', { enabled: false, language: 'de' }),
    );
  });

  it('with no engine installed it says what to install and will not switch on', async () => {
    mocked.get.mockResolvedValue(view({ installed: { rapidocr: false, tesseract: false } }));
    wrap(<SourcesGroup />);
    expect(await screen.findByText(/No OCR engine is installed yet/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Read scanned PDFs with OCR' })).toBeDisabled();
    expect(enginesWords({ rapidocr: true, tesseract: true })).toMatch(/RapidOCR and Tesseract/);
  });
});

describe('a scanned PDF that failed', () => {
  const failed = (code: string) =>
    toSourceView({
      id: 'src_scan',
      kind: 'file',
      title: 'scan.pdf',
      status: 'failed',
      progress: null,
      error: { code, title: 'This PDF has no text layer', hint: 'It looks scanned.' },
      tags: [],
      chunks: 0,
      pages: null,
      stale: false,
      created_at: '2026-10-19T00:00:00Z',
      updated_at: '2026-10-19T00:00:00Z',
    } as unknown as Source);

  it('offers Read with OCR, which asks Knowledge to read this one source', async () => {
    mocked.post.mockResolvedValue({});
    wrap(<SourceCard s={failed('extract.scanned_pdf')} notebookId="nb_1" />);
    fireEvent.click(screen.getByRole('button', { name: /Read with OCR/ }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/sources/src_scan/ocr'));
  });

  it('does not offer it for a failure OCR cannot fix', () => {
    wrap(<SourceCard s={failed('extract.url_blocked')} notebookId="nb_1" />);
    expect(screen.queryByRole('button', { name: /Read with OCR/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('the help article names the real setting and the card button', () => {
    const body = ARTICLES.find((a) => a.id === 'source-failed')?.body ?? '';
    expect(body).toContain('Settings → Sources');
    expect(body).toContain('Read with OCR');
  });
});
