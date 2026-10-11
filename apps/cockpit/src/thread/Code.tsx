/**
 * ------------------------------------------------------------------
 *  Title    |  Code blocks
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Code the way an editor shows it: a small header with
 *           |  the language (or file) and Copy, a real line-number
 *           |  gutter when the lines are numbered, quiet highlighting,
 *           |  and long files folded to their first lines.
 *  How      |  lib/highlight.ts tokenises; tokens are spans with a
 *           |  .tok-* class whose colour is a token in thread.css.
 *           |  MdCode replaces Streamdown's fenced code so answers and
 *           |  tool steps share one look. Inline code stays inline.
 * ------------------------------------------------------------------
 */

import { type ComponentProps, type ReactNode, useMemo, useState } from 'react';
import { highlight, langLabel } from '../lib/highlight';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';

export function CopyCode({ text, label = 'Copy code' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="code__copy"
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      data-done={done || undefined}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1_400);
          })
          .catch(() =>
            notify({
              level: 'error',
              title: 'Could not copy',
              body: 'Select the text and copy it yourself.',
            }),
          );
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={12} />
      <span className="code__copy-word" aria-hidden="true">
        {done ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

/** Lines shown before "Show all" in a long block. */
export const CODE_LINES = 24;

export function CodeBlock({
  code,
  lang,
  title,
  numbers,
  clamp = CODE_LINES,
  variant,
}: {
  code: string;
  lang?: string | null | undefined;
  /** Shown in the header instead of the language (a file name). */
  title?: ReactNode;
  /** The gutter: true counts from 1, a list gives each line its own number. */
  numbers?: boolean | number[] | undefined;
  /** Fold after this many lines; 0 never folds. */
  clamp?: number;
  variant?: 'terminal';
}) {
  const [all, setAll] = useState(false);
  const text = code.replace(/\n$/, '');
  const lines = useMemo(() => highlight(text, lang), [text, lang]);
  const long = clamp > 0 && lines.length > clamp + 4;
  const shown = long && !all ? lines.slice(0, clamp) : lines;
  const nums = numbers === true ? lines.map((_, i) => i + 1) : Array.isArray(numbers) ? numbers : null;
  const label = title ?? (lang ? langLabel(lang) : null);
  return (
    <figure className="code" data-variant={variant} data-numbered={nums ? true : undefined}>
      {label !== null || variant !== 'terminal' ? (
        <figcaption className="code__head">
          <span className="code__lang">{label ?? 'Text'}</span>
          <CopyCode text={text} />
        </figcaption>
      ) : null}
      <pre className="code__pre" data-clipped={(long && !all) || undefined}>
        <code>
          {shown.map((toks, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            <span key={i} className="code__line">
              {nums ? (
                <span className="code__no" aria-hidden="true" data-num>
                  {nums[i] ?? ''}
                </span>
              ) : null}
              <span className="code__text">
                {toks.length
                  ? toks.map((t, j) =>
                      t.k === 'plain' ? (
                        t.v
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                        <span key={j} className={`tok-${t.k}`}>
                          {t.v}
                        </span>
                      ),
                    )
                  : '\n'}
              </span>
            </span>
          ))}
        </code>
      </pre>
      {long ? (
        <button type="button" className="code__more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          <Icon name={all ? 'chevronDown' : 'chevronRight'} size={11} />
          {all ? 'Show less' : `Show all ${lines.length.toLocaleString('en-GB')} lines`}
        </button>
      ) : null}
    </figure>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/**
 * Streamdown's `code`: fenced blocks (it marks them `data-block`) become a
 * CodeBlock with the fence's language; inline code stays a quiet chip.
 */
export function MdCode({ className, children, ...rest }: ComponentProps<'code'> & { node?: unknown }) {
  const { node: _node, ...props } = rest as typeof rest & { node?: unknown };
  if (!('data-block' in props)) {
    return (
      <code className={className} data-streamdown="inline-code">
        {children}
      </code>
    );
  }
  const lang = /language-([\w+#.-]+)/.exec(className ?? '')?.[1] ?? null;
  return <CodeBlock code={textOf(children)} lang={lang} clamp={0} />;
}
