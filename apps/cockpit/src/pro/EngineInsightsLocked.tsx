/**
 * ------------------------------------------------------------------
 *  Title    |  Engine insights: the locked state
 *  Ref      |  DESIGN.md §9 · contracts proai.ts EngineInsightsReport
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What Admin → Engine insights shows without Pro: the four
 *           |  questions it answers from your own usage, each with a
 *           |  drawn example, one example suggestion, and the way to
 *           |  turn Pro on. Public, so the free build has it; the real
 *           |  screen and every figure in it come from pro/.
 *  How      |  Static: no request is made. The examples are drawings
 *           |  marked "Example", never your data. Gilt is the Pro mark;
 *           |  violet stays for the one primary action.
 * ------------------------------------------------------------------
 */

import { pro as proContract } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { Icon, type IconName } from '../ui/Icon';
import '../styles/pro.css';

interface Question {
  icon: IconName;
  title: string;
  body: string;
  art: 'bars' | 'line' | 'rings' | 'saved';
}

export const ENGINE_INSIGHT_QUESTIONS: Question[] = [
  {
    icon: 'model',
    title: 'Which engines you use for what',
    body: 'Claude Code, your local models and the cloud, split by coding, research and writing.',
    art: 'bars',
  },
  {
    icon: 'notebook',
    title: 'What each notebook costs over time',
    body: 'Spend by notebook and by thread, day by day, with the busiest ones named.',
    art: 'line',
  },
  {
    icon: 'clock',
    title: 'How much Claude Code plan is left',
    body: 'Headroom on the 5-hour and weekly limits over time, and whether it is shrinking.',
    art: 'rings',
  },
  {
    icon: 'zap',
    title: 'What context assembly saved',
    body: 'Tokens kept out of each call by digests and summaries, instead of the whole history.',
    art: 'saved',
  },
];

function Art({ kind }: { kind: Question['art'] }) {
  if (kind === 'bars')
    return (
      <svg viewBox="0 0 120 56" className="eil-art" aria-hidden="true">
        {[
          [8, 30, 14],
          [34, 18, 26],
          [60, 8, 36],
          [86, 24, 20],
        ].map(([x, a, b]) => (
          <g key={x}>
            <rect
              x={x}
              y={52 - (a as number) - (b as number)}
              width="18"
              height={a}
              rx="2"
              className="eil-art__a"
            />
            <rect x={x} y={52 - (b as number)} width="18" height={b} rx="2" className="eil-art__b" />
          </g>
        ))}
      </svg>
    );
  if (kind === 'line')
    return (
      <svg viewBox="0 0 120 56" className="eil-art" aria-hidden="true">
        <path
          d="M4 44 L22 38 L40 41 L58 26 L76 30 L94 16 L116 20 L116 52 L4 52 Z"
          className="eil-art__fill"
        />
        <path d="M4 44 L22 38 L40 41 L58 26 L76 30 L94 16 L116 20" className="eil-art__line" />
      </svg>
    );
  if (kind === 'rings')
    return (
      <svg viewBox="0 0 120 56" className="eil-art" aria-hidden="true">
        {[
          [36, 0.42],
          [84, 0.78],
        ].map(([cx, share]) => (
          <g key={cx}>
            <circle cx={cx} cy="28" r="20" className="eil-art__track" />
            <circle
              cx={cx}
              cy="28"
              r="20"
              className="eil-art__ring"
              strokeDasharray={`${(share as number) * 125.6} 125.6`}
              transform={`rotate(-90 ${cx} 28)`}
            />
          </g>
        ))}
      </svg>
    );
  return (
    <svg viewBox="0 0 120 56" className="eil-art" aria-hidden="true">
      <text x="60" y="34" textAnchor="middle" className="eil-art__big">
        62%
      </text>
      <text x="60" y="50" textAnchor="middle" className="eil-art__small">
        fewer tokens sent
      </text>
    </svg>
  );
}

export function EngineInsightsLocked({ build }: { build: 'free' | 'pro' | null }) {
  const words = proContract.PRO_FEATURE_WORDS.insights;
  return (
    <section className="eil" aria-labelledby="eil-title">
      <header className="eil__hero">
        <span className="eil__pill">Pro</span>
        <h2 id="eil-title" className="eil__title">
          Engine insights
        </h2>
        <p className="eil__lede">
          Your own usage, turned into answers: which engine to use for what, what it costs, and when a cheaper
          or local model would do as well.
        </p>
        <div className="eil__cta">
          <Link to="/admin/$section" params={{ section: 'license' }} className="btn btn--primary btn--sm">
            {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
          </Link>
          <span className="mute eil__where">
            {build === 'pro'
              ? 'Part of Insights in NVX Ancile Pro: turn Pro on with your key to use it.'
              : `Part of ${words.title} in NVX Ancile Pro, which this build does not include.`}
          </span>
        </div>
      </header>

      <ul className="eil__grid">
        {ENGINE_INSIGHT_QUESTIONS.map((q) => (
          <li key={q.title} className="eil__card">
            <div className="eil__card-head">
              <span className="eil__glyph" aria-hidden="true">
                <Icon name={q.icon} size={14} />
              </span>
              <h3 className="eil__q">{q.title}</h3>
            </div>
            <p className="eil__body">{q.body}</p>
            <div className="eil__sample">
              <Art kind={q.art} />
              <span className="eil__example">Example</span>
            </div>
          </li>
        ))}
      </ul>

      <aside className="eil__suggestion" aria-label="An example suggestion">
        <Icon name="sparkle" size={14} />
        <div>
          <p className="eil__suggestion-title">
            “Grant draft”: local answers were fact-checked as well as cloud ones
          </p>
          <p className="mute eil__suggestion-body">
            Over 30 days, 41 answers from Qwen3 8B on this computer scored 0.86 against 0.88 for the cloud.
            Consider Local only for this notebook.
          </p>
        </div>
        <span className="eil__example">Example</span>
      </aside>

      <p className="mute eil__foot">
        <Icon name="lock" size={12} /> Worked out on this computer from your own history. Nothing is sent
        anywhere.
      </p>
    </section>
  );
}
