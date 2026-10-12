/**
 * ------------------------------------------------------------------
 *  Title    |  Answer testbed
 *  Ref      |  docs/artifacts.md · docs/interpreter.md
 *  ID       |  cockpit (dev server only, never built)
 * ------------------------------------------------------------------
 *  Purpose  |  Draw one real answer (thread/Parts) with an artifact
 *           |  card, a finished python_run step with output and a
 *           |  figure, and one still running, in the thread's own
 *           |  styles, for screenshots and design review. The demo
 *           |  thread is built from hand-made blocks and has none.
 *  How      |  ?theme=dark|light. Figures load from
 *           |  /api/v1/interpreter/figures/:id, which the screenshot
 *           |  script answers.
 * ------------------------------------------------------------------
 */

import '@nvx/aperture/tokens.css';
import '@nvx/aperture/ancile.css';
import '@nvx/aperture/prefs.css';
import '../src/styles/base.css';
import '../src/styles/shell.css';
import '../src/styles/thread.css';
import '../src/styles/overlays.css';
import '../src/styles/kit.css';
import '../src/styles/code.css';
import '../src/styles/artifacts.css';
import '../src/styles/interpreter.css';

import type { Part } from '@nvx/contracts';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { ArtifactPanel } from '../src/artifacts/ArtifactPanel';
import { useInterpreterLive } from '../src/interpreter/host';
import { queryClient } from '../src/lib/query';
import { Parts } from '../src/thread/Parts';

const PAGE = `<!doctype html><html><body style="font-family:system-ui;margin:0;padding:28px">
<h1 style="margin:0 0 8px;font-size:22px">Kingsford buffer: board summary</h1>
<p style="margin:0 0 18px;opacity:.7">Two quotes for a 2 MWh buffer, compared.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">
<tr><th style="text-align:left;padding:8px;border-bottom:1px solid #8884">Measure</th><th style="text-align:left;padding:8px;border-bottom:1px solid #8884">NA-280</th><th style="text-align:left;padding:8px;border-bottom:1px solid #8884">LF-305</th></tr>
<tr><td style="padding:8px">Capacity at −10 °C</td><td style="padding:8px">88%</td><td style="padding:8px">71%</td></tr>
<tr><td style="padding:8px">Containers</td><td style="padding:8px">3</td><td style="padding:8px">2</td></tr>
<tr><td style="padding:8px">Separation (FE-12)</td><td style="padding:8px">1.5 m</td><td style="padding:8px">3.0 m</td></tr>
</table></body></html>`;

const CODE = [
  'import pandas as pd',
  'import matplotlib.pyplot as plt',
  '',
  'df = pd.read_csv("load-survey.csv", parse_dates=["time"])',
  'peak = df.groupby(df.time.dt.hour).kw.mean()',
  'print(peak.idxmax(), round(peak.max()))',
  'peak.plot(title="Mean load by hour (kW)")',
  'plt.show()',
].join('\n');

const answer: Part[] = [
  {
    type: 'text',
    text: `Here is the board summary as a page you can open and share:\n\n\`\`\`html artifact id="board-summary" title="Board summary"\n${PAGE}\n\`\`\`\n\nI also checked when the peak falls, from the load survey:`,
  },
  {
    type: 'tool_call',
    call_id: 'call_done',
    tool: 'python_run',
    args: { code: CODE, files: ['load-survey.csv'] },
  },
  {
    type: 'tool_result',
    call_id: 'call_done',
    ok: true,
    result: {
      ok: true,
      stdout: '6 1412\n',
      stderr: '',
      figures: [{ id: 'fig_demo1', width: 640, height: 420, alt: 'Figure 1' }],
      error: null,
      duration_ms: 1840,
      truncated: false,
    },
  },
  {
    type: 'text',
    text: 'The peak is at 06:00, about 1.4 MW, which the 2 MWh buffer covers with room for the 17:30 return.',
  },
  {
    type: 'tool_call',
    call_id: 'call_live',
    tool: 'python_run',
    args: { code: 'import numpy as np\nprint(np.percentile(df.kw, [50, 95, 99]))' },
  },
] as Part[];

useInterpreterLive.getState().set('call_live', 'running');

function Answer() {
  return (
    <div style={{ height: '100vh', overflow: 'auto', background: 'var(--void)' }}>
      <main className="thread" style={{ maxWidth: '72ch', margin: '0 auto', padding: '28px 18px' }}>
        <article className="msg" data-role="assistant" aria-label="Assistant">
          <header className="msg__head">
            <span className="msg-model">GPT-5.5</span>
          </header>
          <div className="msg__body">
            <Parts
              parts={answer}
              streaming={false}
              waiting={false}
              messageId="msg_show"
              threadId="thr_show"
            />
          </div>
        </article>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Answer />
      <ArtifactPanel />
    </TooltipProvider>
  </QueryClientProvider>,
);
