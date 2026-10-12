/**
 * ------------------------------------------------------------------
 *  Title    |  Artifact runtimes
 *  Ref      |  docs/artifacts.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The libraries an artifact frame needs, loaded only when
 *           |  such an artifact is opened, and the JSX compile step.
 *  How      |  React 18's prebuilt UMD files and Mermaid's single-file
 *           |  build are imported as text (?raw, their own chunks) and
 *           |  inlined into the frame's document, since the frame has
 *           |  no network. JSX/TSX is compiled here with Sucrase (MIT),
 *           |  which only rewrites text and never runs it; the result
 *           |  runs inside the sandbox.
 * ------------------------------------------------------------------
 */

import type { Runtime } from './document';

let react: Promise<NonNullable<Runtime['react']>> | null = null;
let mermaid: Promise<string> | null = null;

export function reactRuntime(): Promise<NonNullable<Runtime['react']>> {
  react ??= Promise.all([
    import('../../node_modules/react-umd/umd/react.production.min.js?raw'),
    import('../../node_modules/react-dom-umd/umd/react-dom.production.min.js?raw'),
  ]).then(([r, d]) => ({ react: r.default, reactDom: d.default }));
  react.catch(() => {
    react = null;
  });
  return react;
}

export function mermaidRuntime(): Promise<string> {
  mermaid ??= import('mermaid/dist/mermaid.min.js?raw').then((m) => m.default);
  mermaid.catch(() => {
    mermaid = null;
  });
  return mermaid;
}

/** JSX or TSX → CommonJS JavaScript using React.createElement. Throws with the line on a syntax error. */
export async function compileComponent(code: string): Promise<string> {
  const { transform } = await import('sucrase');
  return transform(code, {
    transforms: ['jsx', 'typescript', 'imports'],
    jsxRuntime: 'classic',
    production: true,
  }).code;
}
