/**
 * The code editor: which grammar a file gets, how an agent's edit is
 * turned back into "before", where a step's relative path lands, and the
 * editor's save flow against Core's answers (saved, confirm first, changed
 * on disk). CodeMirror itself is replaced by a textarea here: jsdom has no
 * layout, and the editor's own behaviour is CodeMirror's to test.
 */
import type { FileContent } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

vi.mock('../src/code/CodeView', () => ({
  CodeView: ({
    value,
    readOnly,
    label,
    onChange,
  }: {
    value: string;
    readOnly?: boolean;
    label?: string;
    onChange?: (v: string) => void;
  }) => (
    <textarea
      aria-label={label}
      readOnly={readOnly}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
  CodeDiff: ({ before, after }: { before: string; after: string }) => (
    <div data-testid="diff">
      <pre data-testid="before">{before}</pre>
      <pre data-testid="after">{after}</pre>
    </div>
  ),
}));

import { editDiff, editFromArgs } from '../src/code/before';
import { FileEditor, sizeLabel } from '../src/code/FileEditor';
import { isMarkdownPath, languageOf } from '../src/code/lang';
import { resolveStepPath } from '../src/code/OpenInEditor';
import { closeFile, openFile, useFileEditor } from '../src/code/store';
import { ApiCallError, api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'put', ReturnType<typeof vi.fn>>;

describe('languages', () => {
  it('picks a grammar from a path or a language name', () => {
    expect(languageOf('src/app.tsx')).toBe('tsx');
    expect(languageOf('C:\\work\\main.py')).toBe('python');
    expect(languageOf('python')).toBe('python');
    expect(languageOf('notes/README.MD')).toBe('markdown');
    expect(languageOf('config.yml')).toBe('yaml');
    expect(languageOf('a.hpp')).toBe('cpp');
    expect(languageOf('Makefile')).toBeNull();
    expect(languageOf(null)).toBeNull();
    expect(isMarkdownPath('/workspace/a.md')).toBe(true);
    expect(isMarkdownPath('a.ts')).toBe(false);
  });

  it('says sizes plainly', () => {
    expect(sizeLabel(900)).toBe('900 bytes');
    expect(sizeLabel(12_400)).toBe('12 KB');
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe("an agent's edit, before and after", () => {
  it('reads Edit, MultiEdit and Write arguments', () => {
    expect(editFromArgs('Edit', { old_string: 'a', new_string: 'b' })).toEqual({
      edits: [{ before: 'a', after: 'b' }],
      replaceAll: false,
      written: null,
    });
    expect(
      editFromArgs('MultiEdit', {
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      })?.edits,
    ).toHaveLength(2);
    expect(editFromArgs('Write', { content: 'x' })?.written).toBe('x');
    expect(editFromArgs('Read', { file_path: 'a' })).toBeNull();
  });

  it('rebuilds the whole file before, undoing each edit last first', () => {
    const now = 'const a = 2;\nconst b = 3;\n';
    const edit = editFromArgs('MultiEdit', {
      edits: [
        { old_string: 'a = 1', new_string: 'a = 2' },
        { old_string: 'b = 1', new_string: 'b = 3' },
      ],
    });
    expect(edit).not.toBeNull();
    expect(editDiff(now, edit as never)).toEqual({
      before: 'const a = 1;\nconst b = 1;\n',
      after: now,
      whole: true,
    });
  });

  it('compares only the snippets when the new text repeats or is gone', () => {
    const edit = editFromArgs('Edit', { old_string: 'x', new_string: 'y' });
    expect(editDiff('y y', edit as never)).toEqual({ before: 'x', after: 'y', whole: false });
    expect(editDiff('nothing', edit as never).whole).toBe(false);
    expect(editDiff(null, edit as never).whole).toBe(false);
    const all = editFromArgs('Edit', { old_string: 'x', new_string: 'y', replace_all: true });
    expect(editDiff('y y', all as never)).toEqual({ before: 'x x', after: 'y y', whole: true });
  });

  it('cannot know what a Write replaced', () => {
    expect(editDiff('new', { edits: [], replaceAll: false, written: 'new' })).toEqual({
      before: '',
      after: 'new',
      whole: false,
    });
  });
});

describe('step paths', () => {
  it('joins a relative path to the session folder, and leaves absolute ones', () => {
    expect(resolveStepPath('src/a.ts', '/home/me/app')).toBe('/home/me/app/src/a.ts');
    expect(resolveStepPath('./a.ts', 'C:\\work\\app')).toBe('C:\\work\\app\\a.ts');
    expect(resolveStepPath('/etc/x', '/home')).toBe('/etc/x');
    expect(resolveStepPath('D:\\x.py', 'C:\\w')).toBe('D:\\x.py');
    expect(resolveStepPath('a.md', null)).toBe('a.md');
  });

  it('opens and closes through the store', () => {
    openFile({ path: '/workspace/a.md', threadId: 'thr_1' });
    expect(useFileEditor.getState().open?.path).toBe('/workspace/a.md');
    closeFile();
    expect(useFileEditor.getState().open).toBeNull();
  });
});

const FILE: FileContent = {
  path: '/work/app/main.py',
  name: 'main.py',
  root: { kind: 'repo', path: '/work/app', label: 'app' },
  content: 'print(1)\n',
  bytes: 9,
  sha256: 'aaa',
  modified_at: '2026-10-12T10:00:00Z',
  binary: false,
};

function apiError(code: string, context: Record<string, unknown> = {}) {
  return new ApiCallError(409, {
    error: { code, title: 'T', hint: 'H', retryable: false, trace_id: 't', attempts: [], context },
  });
}

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

describe('the file editor', () => {
  beforeEach(() => {
    queryClient.clear();
    mocked.get.mockReset();
    mocked.put.mockReset();
    mocked.get.mockResolvedValue(FILE);
  });

  it('opens read-only, edits, and saves through Core', async () => {
    mocked.put.mockResolvedValue({ path: FILE.path, bytes: 9, sha256: 'bbb', modified_at: FILE.modified_at });
    wrap(<FileEditor file={{ path: FILE.path, threadId: 'thr_1' }} onClose={() => {}} />);
    const box = await screen.findByLabelText('Contents of main.py');
    expect(box).toHaveAttribute('readonly');
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Contents of main.py'), { target: { value: 'print(2)\n' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() => expect(screen.getAllByText('Saved').length).toBeGreaterThan(0));
    expect(mocked.put.mock.calls[0]?.[1]).toMatchObject({
      path: FILE.path,
      content: 'print(2)\n',
      base_sha256: 'aaa',
      thread_id: 'thr_1',
      confirmed: false,
    });
  });

  it('asks before a save the gate would ask about, then confirms', async () => {
    mocked.put
      .mockRejectedValueOnce(
        apiError('files.needs_confirm', { reason: 'Writing outside the workspace asks first' }),
      )
      .mockResolvedValueOnce({ path: FILE.path, bytes: 1, sha256: 'ccc', modified_at: FILE.modified_at });
    wrap(<FileEditor file={{ path: FILE.path, threadId: null, editing: true }} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Contents of main.py'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    expect(await screen.findByText('Writing outside the workspace asks first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(mocked.put).toHaveBeenCalledTimes(2));
    expect(mocked.put.mock.calls[1]?.[1]).toMatchObject({ confirmed: true });
  });

  it('offers Reload or Keep editing when the file changed on disk', async () => {
    mocked.put.mockRejectedValueOnce(apiError('files.changed'));
    wrap(<FileEditor file={{ path: FILE.path, threadId: null, editing: true }} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Contents of main.py'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    expect(await screen.findByText('This file changed on disk since you opened it.')).toBeInTheDocument();
    mocked.get.mockResolvedValue({ ...FILE, sha256: 'zzz' });
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByText(/changed on disk/)).toBeNull());
    mocked.put.mockResolvedValueOnce({
      path: FILE.path,
      bytes: 1,
      sha256: 'q',
      modified_at: FILE.modified_at,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() => expect(mocked.put.mock.calls[1]?.[1]).toMatchObject({ base_sha256: 'zzz' }));
  });

  it("starts on an agent's changes when it came from an edit", async () => {
    wrap(
      <FileEditor
        file={{
          path: FILE.path,
          threadId: null,
          edit: { edits: [{ before: 'print(0)', after: 'print(1)' }], replaceAll: false, written: null },
        }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId('before')).toHaveTextContent('print(0)');
    expect(screen.getByTestId('after')).toHaveTextContent('print(1)');
  });

  it('asks before closing with unsaved changes', async () => {
    const onClose = vi.fn();
    wrap(<FileEditor file={{ path: FILE.path, threadId: null, editing: true }} onClose={onClose} />);
    fireEvent.change(await screen.findByLabelText('Contents of main.py'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close the file' }));
    expect(await screen.findByText('You have unsaved changes.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows Core’s refusal to open a file', async () => {
    mocked.get.mockRejectedValue(
      new ApiCallError(403, {
        error: {
          code: 'files.outside_roots',
          title: 'That file is outside the folders NVX Ancile can open',
          hint: 'Open files in the workspace.',
          retryable: false,
          trace_id: 't',
          attempts: [],
          context: {},
        },
      }),
    );
    wrap(<FileEditor file={{ path: '/etc/passwd', threadId: null }} onClose={() => {}} />);
    expect(
      await screen.findByText('That file is outside the folders NVX Ancile can open'),
    ).toBeInTheDocument();
  });
});
