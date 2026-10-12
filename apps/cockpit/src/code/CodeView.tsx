/**
 * ------------------------------------------------------------------
 *  Title    |  Code view
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's code surface anywhere it is needed (the
 *           |  file editor, an artifact's source): CodeMirror 6 with
 *           |  Aperture's look, read-only unless asked otherwise, and
 *           |  a before/after diff for an agent's edit.
 *  How      |  Both components load CodeMirror lazily, the first time
 *           |  one is drawn, and show a quiet skeleton meanwhile.
 * ------------------------------------------------------------------
 */

import { lazy, Suspense } from 'react';
import { Skeleton } from '../ui/primitives';

const CmEditor = lazy(() => import('./cm/Editor'));
const CmDiff = lazy(() => import('./cm/Diff'));

export interface CodeViewProps {
  value: string;
  /** A file path ("src/app.tsx") or a language name ("python"); null for plain text. */
  language?: string | null;
  /** True unless the person chose to edit. */
  readOnly?: boolean;
  /** Wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
  /** What a screen reader calls the text, e.g. "Contents of app.tsx". */
  label?: string;
  onChange?: (value: string) => void;
  /** Ctrl or Cmd S while focused. */
  onSave?: () => void;
  className?: string;
}

export function CodeView({
  value,
  language = null,
  readOnly = true,
  wrap = false,
  label = 'Code',
  onChange,
  onSave,
  className,
}: CodeViewProps) {
  return (
    <div className={`codeview${className ? ` ${className}` : ''}`}>
      <Suspense fallback={<Skeleton lines={8} label="Opening the editor" />}>
        <CmEditor
          value={value}
          language={language}
          readOnly={readOnly}
          wrap={wrap}
          label={label}
          onChange={onChange}
          onSave={onSave}
        />
      </Suspense>
    </div>
  );
}

export function CodeDiff({
  before,
  after,
  language = null,
  unified = false,
  label = 'Changes',
}: {
  before: string;
  after: string;
  language?: string | null;
  unified?: boolean;
  label?: string;
}) {
  return (
    <div className="codeview codeview--diff">
      <Suspense fallback={<Skeleton lines={8} label="Comparing" />}>
        <CmDiff before={before} after={after} language={language} unified={unified} label={label} />
      </Suspense>
    </div>
  );
}
