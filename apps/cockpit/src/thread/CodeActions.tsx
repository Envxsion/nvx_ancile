/**
 * ------------------------------------------------------------------
 *  Title    |  Code block actions
 *  Ref      |  roadmap AN3
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Run (Python), Wrap and Save as file in a code block's
 *           |  header, and a Mermaid block drawn as a diagram with
 *           |  Show code.
 *  How      |  Loaded the first time an answer has a code block. Run
 *           |  does not run anything itself: it writes the request in
 *           |  the composer (lib/codeActions.ts) and you send it, so
 *           |  the model's python_run call meets the permission gate
 *           |  on the real code. Save as file writes through PUT
 *           |  /files, the gate the file editor uses; a save the gate
 *           |  asks about shows its reason and asks again. Mermaid
 *           |  loads on first diagram, renders in strict mode, and
 *           |  shows the code with a note when it does not parse.
 *  Note     |  Code from an answer is data: nothing in it is run by
 *           |  this page. TODO(phase-0.1.1): Pro "Apply to repo" in a
 *           |  repo-linked thread, opening the diff in the lab (Pro
 *           |  seam). Open a diagram as an artifact: TODO(phase-0.1.1).
 * ------------------------------------------------------------------
 */

import { useEffect, useId, useState } from 'react';
import { saveFile } from '../code/api';
import { openFile } from '../code/store';
import { defaultFileName, fileNameProblem, isPython, runRequest } from '../lib/codeActions';
import { insertInComposer } from '../lib/selectionActions';
import { useThreadId } from '../lib/threadContext';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { CodeBlock } from './Code';

export function CodeTools({
  code,
  lang,
  wrap,
  onWrap,
}: {
  code: string;
  lang: string | null | undefined;
  wrap: boolean;
  onWrap: () => void;
}) {
  const threadId = useThreadId();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(() => defaultFileName(lang));
  const [problem, setProblem] = useState<string | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const field = useId();

  const save = async (confirmed: boolean) => {
    const bad = fileNameProblem(name);
    if (bad) return setProblem(bad);
    const r = await saveFile({
      path: name.trim(),
      content: code,
      base_sha256: null,
      thread_id: threadId,
      confirmed,
    });
    if (r.kind === 'saved') {
      setSaving(false);
      setAsk(null);
      notify({ level: 'success', title: `Saved ${name.trim()}` });
      openFile({ path: name.trim(), threadId });
    } else if (r.kind === 'confirm') {
      setAsk(r.reason);
      setProblem(null);
    } else if (r.kind === 'changed') {
      setProblem('A file with that name is already there. Choose another name.');
    } else setProblem(`${r.title} ${r.hint}`);
  };

  return (
    <>
      {isPython(lang) && threadId ? (
        <button
          type="button"
          className="code__act"
          title="Writes a request to run this in your message; the run asks permission where it needs to"
          onClick={() => {
            insertInComposer(threadId, runRequest(code));
            notify({
              level: 'info',
              title: 'Ready to run',
              body: 'Send the message to run it in the sandbox.',
            });
          }}
        >
          <Icon name="play" size={12} />
          <span className="code__copy-word">Run</span>
        </button>
      ) : null}
      <button type="button" className="code__act" aria-pressed={wrap} onClick={onWrap}>
        <Icon name="text" size={12} />
        <span className="code__copy-word">Wrap</span>
      </button>
      <button type="button" className="code__act" aria-expanded={saving} onClick={() => setSaving((s) => !s)}>
        <Icon name="download" size={12} />
        <span className="code__copy-word">Save as file</span>
      </button>
      {saving ? (
        <form
          className="code__save"
          onSubmit={(e) => {
            e.preventDefault();
            void save(!!ask);
          }}
        >
          <label htmlFor={field}>File name</label>
          <input
            id={field}
            value={name}
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
              setAsk(null);
            }}
          />
          <button type="submit" className="btn btn--primary btn--sm">
            {ask ? 'Save anyway' : 'Save'}
          </button>
          {ask || problem ? (
            <p role="alert" className="code__save-note">
              {ask ?? problem}
            </p>
          ) : null}
        </form>
      ) : null}
    </>
  );
}

/** A Mermaid block as a diagram; the code a click away, and shown at once if it will not draw. */
export function MermaidView({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const id = useId().replace(/[^a-z0-9]/gi, '');
  useEffect(() => {
    let gone = false;
    // A fence still being written will not parse yet: wait for the writing to pause.
    const t = setTimeout(() => {
      void import('mermaid')
        .then(async ({ default: mermaid }) => {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
          const out = await mermaid.render(`mmd${id}`, code);
          if (!gone) {
            setSvg(out.svg);
            setFailed(false);
          }
        })
        .catch(() => !gone && setFailed(true));
    }, 400);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [code, id]);

  if (failed || !svg || showCode)
    return (
      <div className="mmd">
        {failed ? (
          <p className="mmd__note mute">This diagram could not be drawn. The code is below.</p>
        ) : null}
        {svg && showCode ? (
          <button type="button" className="code__act" onClick={() => setShowCode(false)}>
            Show diagram
          </button>
        ) : null}
        <CodeBlock code={code} lang="mermaid" clamp={0} />
      </div>
    );
  return (
    <figure className="mmd">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's strict mode sanitises the svg */}
      <div className="mmd__svg" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      <figcaption>
        <button type="button" className="code__act" onClick={() => setShowCode(true)}>
          Show code
        </button>
      </figcaption>
    </figure>
  );
}
