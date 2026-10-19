/**
 * ------------------------------------------------------------------
 *  Title    |  Local model presets
 *  Ref      |  ROADMAP LM1 (Pro half) · pro/slot.tsx · docs/models.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Under "Loaded now" in Admin → Models: how long each
 *           |  local model stays in memory and how long a context it
 *           |  is loaded with, per notebook, and a forecast of
 *           |  whether it will sit beside what is already loaded.
 *  How      |  With Pro and the licence (fleet), Pro's own section
 *           |  (ProUi.parts.LocalPresets) fills this place, given the
 *           |  Ollama models you have and which are in memory now.
 *           |  Without them a card says what it is and what unlocks
 *           |  it. Shown only when a local model is installed, so a
 *           |  cloud-only setup is never nagged.
 *  Note     |  The forecast measures a model that is loaded; for one
 *           |  that is not, the section says so instead of guessing.
 * ------------------------------------------------------------------
 */

import { useNotebooks } from '../lib/data';
import { ProUpsell, useProFeature } from '../pro/slot';
import '../styles/pro-seams.css';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { useLoadedModels } from './LoadedNow';
import { useLocalModels } from './LocalModels';

const WORDS = {
  title: 'Local model presets',
  body: 'Keep a model in memory for as long as you want, load it with a longer context, per notebook, and see whether it will fit beside the models already loaded.',
};

export function LocalPresets() {
  const local = useLocalModels();
  const loaded = useLoadedModels();
  const notebooks = useNotebooks();
  const { ui, unlocked, build, loading } = useProFeature('fleet');
  const installed = (local.data?.items ?? []).filter(
    (m) => m.kind === 'chat' && m.via === 'ollama' && m.installed && m.model_id,
  );
  // Nothing to set on a setup with no local chat model.
  if (installed.length === 0) return null;
  const inMemory = new Set((loaded.data?.items ?? []).flatMap((l) => (l.model_id ? [l.model_id] : [])));
  const Section = ui?.parts?.LocalPresets;
  return (
    <section className="local-presets" aria-label="Local model presets">
      {loading ? (
        <Skeleton lines={2} label="Loading local model presets" />
      ) : Section && unlocked ? (
        <>
          <header className="local-presets__head">
            <Icon name="zap" size={14} />
            <h2 id="local-presets-h">Local model presets</h2>
          </header>
          <Section
            models={installed.map((m) => ({
              id: m.model_id as string,
              name: m.name,
              loaded: inMemory.has(m.model_id as string),
            }))}
            notebooks={(notebooks.data ?? [])
              .filter((n) => !n.archived)
              .map((n) => ({ id: n.id, title: n.title }))}
          />
        </>
      ) : (
        <ProUpsell feature="fleet" build={build} words={WORDS} />
      )}
    </section>
  );
}
