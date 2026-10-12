/**
 * ------------------------------------------------------------------
 *  Title    |  Context packs: the locked state
 *  Ref      |  DESIGN.md §9 · docs/notebooks.md (Context packs)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What Admin → Context packs shows without Pro: what a
 *           |  pack holds, attaching it in one click, sharing it as a
 *           |  signed file, and that it keeps to the same scopes as a
 *           |  context link. Public, so the free build has it; the real
 *           |  screen comes from pro/.
 *  How      |  Static: no request is made. The example pack is marked
 *           |  "Example", never your data. Gilt is the Pro mark; violet
 *           |  stays for the one primary action. Shares Engine
 *           |  insights' locked layout (styles/pro.css).
 * ------------------------------------------------------------------
 */

import { pro as proContract } from '@nvx/contracts';
import { Link } from '@tanstack/react-router';
import { Icon, type IconName } from '../ui/Icon';
import '../styles/pro.css';

const POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'archive',
    title: 'One pack, everything it needs',
    body: 'Chosen sources, notes, a thread’s summary, memory entries and instructions, saved under one name.',
  },
  {
    icon: 'link',
    title: 'Attach it in one click',
    body: 'To any thread or notebook. Its sources are searched and cited; its notes and summary are read as context.',
  },
  {
    icon: 'seal',
    title: 'Share it as a signed file',
    body: 'A manifest lists every item with its hash, signed by this computer. Importing shows what is inside first.',
  },
  {
    icon: 'shield',
    title: 'Scopes still hold',
    body: 'A pack made from a private notebook stays on this machine, and never reaches a cloud model.',
  },
];

const EXAMPLE = [
  'Pump manual (source)',
  'Commissioning checklist (note)',
  'Summary of “Trial at 40 bar”',
  'Answer briefly, cite every claim',
];

export function ContextPacksLocked({ build }: { build: 'free' | 'pro' | null }) {
  const words = proContract.PRO_FEATURE_WORDS.context_packs;
  return (
    <section className="eil" aria-labelledby="cpl-title">
      <header className="eil__hero gilt-frame">
        <span className="eil__pill gilt-pill">Pro</span>
        <h2 id="cpl-title" className="eil__title">
          {words.title}
        </h2>
        <p className="eil__lede">{words.body}</p>
        <div className="eil__cta">
          <Link
            to="/admin/$section"
            params={{ section: 'license' }}
            className="btn btn--primary btn--sm gilt-action"
          >
            {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
          </Link>
          <span className="mute eil__where">
            {build === 'pro'
              ? 'Part of NVX Ancile Pro: turn Pro on with your key to use it.'
              : 'Part of NVX Ancile Pro, which this build does not include. Context links and notebook merge are free.'}
          </span>
        </div>
      </header>

      <ul className="eil__grid">
        {POINTS.map((p) => (
          <li key={p.title} className="eil__card pro-card gilt-frame">
            <div className="eil__card-head">
              <span className="eil__glyph" aria-hidden="true">
                <Icon name={p.icon} size={14} />
              </span>
              <h3 className="eil__q">{p.title}</h3>
            </div>
            <p className="eil__body">{p.body}</p>
          </li>
        ))}
      </ul>

      <aside className="eil__suggestion gilt-frame gilt-frame--quiet" aria-label="An example pack">
        <Icon name="archive" size={14} />
        <div>
          <p className="eil__suggestion-title">“Pump commissioning”, attached to 3 threads</p>
          <p className="mute eil__suggestion-body">{EXAMPLE.join(' · ')}</p>
        </div>
        <span className="eil__example">Example</span>
      </aside>

      <p className="mute eil__foot">
        <Icon name="lock" size={12} /> Kept on this computer. A file leaves only when you export one.
      </p>
    </section>
  );
}
