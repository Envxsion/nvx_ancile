/**
 * ------------------------------------------------------------------
 *  Title    |  CodeMirror setup
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The one look and the one set of behaviours every
 *           |  CodeMirror surface in the Cockpit shares: the editor,
 *           |  the read-only view and both sides of a diff.
 *  How      |  Colours are never written here. The theme only points
 *           |  at Aperture's tokens (var(--…)), and highlighting maps
 *           |  each syntax tag to the same .tok-* classes the thread's
 *           |  code blocks use (styles/tools.css), so a file in the
 *           |  editor and a snippet in an answer read the same.
 * ------------------------------------------------------------------
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** Syntax tags → the thread's token classes (colours live in tools.css). */
export const ancileHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword], class: 'tok-kw' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 'tok-str' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'tok-com' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tok-num' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'tok-fn' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: 'tok-type' },
  { tag: [t.tagName, t.heading], class: 'tok-tag' },
  { tag: [t.attributeName, t.propertyName, t.labelName], class: 'tok-attr' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.invalid, class: 'tok-invalid' },
]);

/** The editor's frame, in tokens only. */
export const ancileTheme = EditorView.theme({
  '&': {
    color: 'var(--fg-2)',
    backgroundColor: 'transparent',
    fontSize: 'var(--code-size)',
    height: '100%',
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--signal-ink)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--signal-ink)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgb(var(--signal-rgb) / 0.22)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--mute)',
    border: 'none',
    borderRight: '1px solid var(--hair)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--wash)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--wash)', color: 'var(--fg-3)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--wash-2)',
    border: 'none',
    color: 'var(--mute)',
  },
  '.cm-searchMatch': { backgroundColor: 'rgb(var(--warn-rgb) / 0.22)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgb(var(--warn-rgb) / 0.42)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--chalk)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--chalk)', outline: '1px solid var(--edge)' },
  '.cm-panels': { backgroundColor: 'var(--lift-2)', color: 'var(--fg-2)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--hair)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--hair)' },
  '.cm-textfield': {
    backgroundColor: 'var(--wash)',
    border: '1px solid var(--edge)',
    borderRadius: 'var(--r-xs)',
    color: 'var(--fg)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--wash-2)',
    border: '1px solid var(--edge)',
    borderRadius: 'var(--r-xs)',
    color: 'var(--fg-2)',
  },
  '.cm-tooltip': { backgroundColor: 'var(--lift-2)', border: '1px solid var(--edge)' },
});

/** What every surface has: numbers, highlighting, search, folding, history. */
export function baseExtensions(opts: { wrap: boolean; onSave?: (() => void) | undefined }): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    foldGutter(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    history(),
    search({ top: true }),
    syntaxHighlighting(ancileHighlight),
    ancileTheme,
    opts.wrap ? EditorView.lineWrapping : [],
    keymap.of([
      ...(opts.onSave
        ? [
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                opts.onSave?.();
                return true;
              },
            },
          ]
        : []),
      ...defaultKeymap,
      ...historyKeymap,
      // Tab is left to move focus, so the editor is never a keyboard trap.
      ...searchKeymap,
    ]),
  ];
}

/** Read-only or editable, as one switchable piece. */
export function editable(on: boolean): Extension {
  return [EditorState.readOnly.of(!on), EditorView.editable.of(on)];
}
