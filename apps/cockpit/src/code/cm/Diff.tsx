/**
 * ------------------------------------------------------------------
 *  Title    |  CodeMirror diff
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Before and after an agent's edit, the way a careful
 *           |  reviewer reads it: side by side with unchanged lines
 *           |  folded on a wide screen, one column on a phone.
 *  How      |  @codemirror/merge: MergeView for side by side, the
 *           |  unifiedMergeView extension for one column. Both sides
 *           |  are read-only; colours come from code.css (tokens).
 * ------------------------------------------------------------------
 */

import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { languageOf, loadLanguage } from '../lang';
import { baseExtensions, editable } from './setup';

export interface CmDiffProps {
  before: string;
  after: string;
  language: string | null;
  /** One column (phones, narrow panels) instead of two. */
  unified: boolean;
  label: string;
}

export default function CmDiff({ before, after, language, unified, label }: CmDiffProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let destroy: (() => void) | null = null;
    let live = true;
    void loadLanguage(languageOf(language)).then((lang) => {
      if (!live) return;
      const common = (side: string): Extension[] => [
        baseExtensions({ wrap: false }),
        editable(false),
        lang,
        EditorView.contentAttributes.of({ 'aria-label': `${label}: ${side}` }),
      ];
      if (unified) {
        const v = new EditorView({
          parent: el,
          state: EditorState.create({
            doc: after,
            extensions: [
              common('after, with removed lines shown'),
              unifiedMergeView({
                original: before,
                mergeControls: false,
                gutter: true,
                collapseUnchanged: { margin: 3, minSize: 6 },
              }),
            ],
          }),
        });
        destroy = () => v.destroy();
      } else {
        const m = new MergeView({
          parent: el,
          a: { doc: before, extensions: common('before') },
          b: { doc: after, extensions: common('after') },
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        });
        destroy = () => m.destroy();
      }
    });
    return () => {
      live = false;
      destroy?.();
    };
  }, [before, after, language, unified, label]);

  return <div ref={host} className="cm-host cm-diff" data-unified={unified || undefined} />;
}
