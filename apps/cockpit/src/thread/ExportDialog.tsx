/**
 * ------------------------------------------------------------------
 *  Title    |  Export a thread
 *  Ref      |  roadmap EX3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Choose what an export holds and save it: Markdown, a
 *           |  page that prints to PDF, or the whole tree as JSON.
 *  How      |  Nothing leaves the machine: the file is built here
 *           |  (the tree is fetched from Core). Thinking is off by
 *           |  default, tool steps and sources are on. Escape closes.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { api } from '../lib/api';
import { keys } from '../lib/data';
import { useExport } from '../lib/exportStore';
import { queryClient } from '../lib/query';
import {
  DEFAULT_EXPORT,
  type ExportFormat,
  type ExportOptions,
  exportHtml,
  exportMarkdown,
  exportName,
} from '../lib/threadExport';
import type { ThreadView } from '../lib/types';
import { notify } from '../state/notify';
import { Check, Segmented } from '../ui/controls';

const MIME: Record<ExportFormat, string> = {
  markdown: 'text/markdown',
  html: 'text/html',
  json: 'application/json',
};
const EXT: Record<ExportFormat, string> = { markdown: 'md', html: 'html', json: 'json' };

function save(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
}

/** Print a page without leaving this one: an off-screen frame prints, then goes. */
function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

export function ExportHost() {
  const threadId = useExport((s) => s.threadId);
  const close = useExport((s) => s.close);
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [o, setO] = useState<ExportOptions>(DEFAULT_EXPORT);
  const [busy, setBusy] = useState(false);
  useLayer(!!threadId);
  if (!threadId) return null;

  const go = async (print: boolean) => {
    const t = queryClient.getQueryData<ThreadView>(keys.thread(threadId));
    setBusy(true);
    try {
      if (format === 'json') {
        const full = await api.get<{ truncated: boolean }>(`/threads/${threadId}/export`);
        save(exportName(t?.title ?? 'thread', 'json'), JSON.stringify(full, null, 2), MIME.json);
        notify({
          level: full.truncated ? 'warn' : 'success',
          title: 'Whole thread exported',
          body: full.truncated
            ? 'This thread is very long, so the file holds its newest 5,000 messages.'
            : 'Every branch is in the file.',
        });
      } else {
        if (!t) {
          notify({
            level: 'warn',
            title: 'Open the thread first',
            body: 'Export saves the branch you are looking at.',
          });
          return;
        }
        const name = exportName(t.title, EXT[format]);
        if (format === 'html' && print) {
          printHtml(exportHtml(t, o));
        } else {
          save(name, format === 'html' ? exportHtml(t, o) : exportMarkdown(t, o), MIME[format]);
          notify({ level: 'success', title: 'Thread exported', body: `${name} is in your downloads.` });
        }
      }
      close();
    } catch {
      notify({
        level: 'error',
        title: 'Could not export this thread',
        body: 'Check that NVX Ancile Core is running, then try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<ExportOptions>) => setO((x) => ({ ...x, ...patch }));
  return (
    <Dialog.Root open onOpenChange={(v) => !v && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick" aria-describedby="export-desc">
          <Dialog.Title className="dialog__title">Export this thread</Dialog.Title>
          <div id="export-desc" className="dialog__lede">
            Saved on this computer. Nothing is sent anywhere.
          </div>
          <div className="export__body">
            <Segmented<ExportFormat>
              label="Format"
              value={format}
              onChange={setFormat}
              options={[
                { value: 'markdown', label: 'Markdown' },
                { value: 'html', label: 'Web page' },
                { value: 'json', label: 'Whole tree (JSON)' },
              ]}
            />
            {format === 'json' ? (
              <p className="mute">Every branch, with each message exactly as it is stored.</p>
            ) : (
              <>
                <p className="mute">The branch you are looking at.</p>
                <Check
                  label="Sources as footnotes"
                  checked={o.sources}
                  onChange={(v) => set({ sources: v })}
                />
                <Check label="Tool steps, folded" checked={o.steps} onChange={(v) => set({ steps: v })} />
                <Check label="Thinking" checked={o.thinking} onChange={(v) => set({ thinking: v })} />
                <Check
                  label="A receipt line under each answer"
                  checked={o.receipts}
                  onChange={(v) => set({ receipts: v })}
                />
              </>
            )}
          </div>
          <div className="dialog__actions">
            <button type="button" className="btn btn--ghost" onClick={close}>
              Cancel
            </button>
            {format === 'html' ? (
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void go(true)}>
                Print or save as PDF
              </button>
            ) : null}
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void go(false)}>
              {format === 'html' ? 'Save web page' : format === 'json' ? 'Save JSON' : 'Save Markdown'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
