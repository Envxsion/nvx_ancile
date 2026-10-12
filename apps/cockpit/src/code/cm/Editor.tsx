/**
 * ------------------------------------------------------------------
 *  Title    |  CodeMirror editor
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One CodeMirror 6 view in React: a file, read-only or
 *           |  editable, highlighted in its language.
 *  How      |  The view is made once per mount. Read-only, wrapping
 *           |  and the grammar sit in compartments and switch without
 *           |  rebuilding it, so the cursor and history survive the
 *           |  Edit toggle. A new `value` from outside replaces the
 *           |  text (a reload); typing reports back through onChange.
 *  Note     |  Loaded lazily (CodeView.tsx): none of CodeMirror is in
 *           |  the first page load.
 * ------------------------------------------------------------------
 */

import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { languageOf, loadLanguage } from '../lang';
import { baseExtensions, editable } from './setup';

export interface CmEditorProps {
  value: string;
  /** A file path or a language name. */
  language: string | null;
  readOnly: boolean;
  wrap?: boolean;
  label: string;
  onChange?: ((value: string) => void) | undefined;
  onSave?: (() => void) | undefined;
}

export default function CmEditor({
  value,
  language,
  readOnly,
  wrap = false,
  label,
  onChange,
  onSave,
}: CmEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const parts = useRef({ edit: new Compartment(), lang: new Compartment(), wrap: new Compartment() });
  // Latest callbacks, without rebuilding the view when a parent re-renders.
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is built once; later props flow in through the effects below
  useEffect(() => {
    if (!host.current) return;
    const p = parts.current;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          baseExtensions({ wrap: false, onSave: () => cb.current.onSave?.() }),
          p.edit.of(editable(!readOnly)),
          p.lang.of([]),
          p.wrap.of(wrap ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void loadLanguage(languageOf(language)).then((ext) => {
      if (live) view.current?.dispatch({ effects: parts.current.lang.reconfigure(ext) });
    });
    return () => {
      live = false;
    };
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.edit.reconfigure(editable(!readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: parts.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const now = v.state.doc.toString();
    if (now !== value) v.dispatch({ changes: { from: 0, to: now.length, insert: value } });
  }, [value]);

  return <div ref={host} className="cm-host" data-readonly={readOnly || undefined} />;
}
