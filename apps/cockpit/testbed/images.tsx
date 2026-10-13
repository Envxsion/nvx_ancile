/**
 * ------------------------------------------------------------------
 *  Title    |  Images testbed
 *  Ref      |  docs/images.md · tests/e2e/images.spec.ts
 *  ID       |  cockpit (dev server only, never built)
 * ------------------------------------------------------------------
 *  Purpose  |  Draw real thread messages (thread/Parts) with images:
 *           |  a question with an attached photo, an answer with a
 *           |  local chart, a remote image behind its consent
 *           |  placeholder, and an image_generate step, in the
 *           |  thread's own styles, for e2e, axe and screenshots.
 *  How      |  ?theme=dark|light. The page's CSP allows only 'self',
 *           |  data: and blob: images, as the app's does. Pictures are
 *           |  drawn on a canvas, so nothing is fetched from outside.
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
import '../src/styles/interpreter.css';
import '../src/styles/images.css';

import type { ImageGenerateResult, Part } from '@nvx/contracts';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { queryClient } from '../src/lib/query';
import { Parts } from '../src/thread/Parts';

/** A picture drawn here: a sky, a hill and a sun, in the given hues. */
function picture(w: number, h: number, sky: [string, string], hill: string, sun: string): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return '';
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, sky[0]);
  grad.addColorStop(1, sky[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = sun;
  g.beginPath();
  g.arc(w * 0.72, h * 0.32, h * 0.12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = hill;
  g.beginPath();
  g.moveTo(0, h);
  g.quadraticCurveTo(w * 0.3, h * 0.45, w * 0.62, h * 0.78);
  g.quadraticCurveTo(w * 0.85, h * 0.62, w, h * 0.7);
  g.lineTo(w, h);
  g.fill();
  return c.toDataURL('image/png');
}

/** A bar chart, as the interpreter would draw one. */
function chart(w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return '';
  g.fillStyle = '#f4f5f6';
  g.fillRect(0, 0, w, h);
  const bars = [320, 410, 980, 1412, 1210, 640, 380, 450];
  const bw = (w - 80) / bars.length;
  bars.forEach((v, i) => {
    g.fillStyle = i === 3 ? '#3b6ea8' : '#8aa4bf';
    const bh = (v / 1500) * (h - 60);
    g.fillRect(50 + i * bw + 6, h - 30 - bh, bw - 12, bh);
  });
  g.fillStyle = '#333';
  g.font = '14px system-ui';
  g.fillText('Mean load by hour (kW)', 50, 22);
  return c.toDataURL('image/png');
}

const photo = picture(960, 640, ['#c9d6e3', '#eef2f5'], '#5d7a5a', '#f2c46b');
const made = picture(1024, 1024, ['#26334a', '#7a5c7e'], '#1d2433', '#f7d9a4');
const made2 = picture(1024, 1024, ['#f3d9b1', '#e9a07a'], '#6d4c41', '#fff3d6');

const question: Part[] = [
  {
    type: 'text',
    text: 'Is this the site the survey describes? Make a poster of it at dusk for the board pack.',
  },
  { type: 'image', url: photo, mime: 'image/png', alt: 'Site photo, north gate', width: 960, height: 640 },
];

const result: ImageGenerateResult = {
  images: [
    { id: 'img_demo1', url: made, width: 1024, height: 1024 },
    { id: 'img_demo2', url: made2, width: 1024, height: 1024 },
  ],
  prompt: 'The Kingsford depot at dusk, two battery containers beside the charging bays, poster style',
  model: 'gpt-image-1',
  provider: 'openai',
  provider_kind: 'cloud',
  cost_usd: 0.08,
};

const answer: Part[] = [
  {
    type: 'text',
    text: `Yes: the gate, the substation and the slope match the survey's site plan. The peak it describes, from the load data:\n\n![Mean load by hour, peaking at 06:00](${chart(720, 360)})\n\nThe supplier's brochure has an aerial view as well:\n\n![Aerial view of the depot](https://tracker.example/brochure/aerial.png)\n\nHere is the poster, in two takes:`,
  },
  { type: 'tool_call', call_id: 'call_img', tool: 'image_generate', args: { prompt: result.prompt, n: 2 } },
  { type: 'tool_result', call_id: 'call_img', ok: true, result },
  { type: 'text', text: 'The second keeps the warmer palette of the board pack.' },
];

const running: Part[] = [
  {
    type: 'tool_call',
    call_id: 'call_live',
    tool: 'image_generate',
    args: { prompt: 'The same view in winter fog' },
  },
];

createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <main className="thread" style={{ padding: '24px 16px' }}>
        <div className="thread__measure">
          <article className="msg msg--user" aria-label="You">
            <div className="msg__body">
              <Parts
                parts={question}
                streaming={false}
                waiting={false}
                threadId="thr_testbed"
                messageId="msg_q"
              />
            </div>
          </article>
          <article className="msg msg--assistant" aria-label="GPT-5.5">
            <div className="msg__body">
              <Parts
                parts={answer}
                streaming={false}
                waiting={false}
                threadId="thr_testbed"
                messageId="msg_a"
              />
            </div>
          </article>
          <article className="msg msg--assistant" aria-label="GPT-5.5, still answering">
            <div className="msg__body">
              <Parts parts={running} streaming waiting threadId="thr_testbed" messageId="msg_b" />
            </div>
          </article>
        </div>
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
);
