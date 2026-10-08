/**
 * ------------------------------------------------------------------
 *  Title    |  Settings groups
 *  Ref      |  contracts/prefs.ts · DESIGN-UI.md §4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every preference, grouped the way people think about
 *           |  them, each with words that say what changes.
 *  Note     |  The defaults are the right answer for most people; the
 *           |  rows exist for the rest.
 * ------------------------------------------------------------------
 */

import { ACCENTS, type Preferences } from '@nvx/contracts';
import { type CSSProperties, useContext, useState } from 'react';
import { Hint } from '../../help/Hint';
import { CAPTURE_OPTIONS, CaptureControl } from '../../memory/MemoryScreen';
import { usePrefs } from '../../state/prefs';
import { Range, Segmented, Switch } from '../../ui/controls';
import { Kbd } from '../../ui/primitives';
import { Block, matches, Row, SearchContext, useSet } from './rows';

const ACCENT_LABEL: Record<(typeof ACCENTS)[number], string> = {
  ultraviolet: 'Ultraviolet',
  iris: 'Iris',
  orchid: 'Orchid',
  rose: 'Rose',
  ember: 'Ember',
  jade: 'Jade',
  graphite: 'Graphite',
};
/** The dark-ground fill of each accent, for the swatch (prefs.css holds the real tokens). */
const ACCENT_SWATCH: Record<(typeof ACCENTS)[number], string> = {
  ultraviolet: '#9d86ff',
  iris: '#8ea4ff',
  orchid: '#d28bff',
  rose: '#ff7fa6',
  ember: '#ff8f66',
  jade: '#4fd69e',
  graphite: '#d7dbe2',
};

function usePrefGroup<G extends keyof Preferences>(g: G): Preferences[G] {
  return usePrefs((s) => s.prefs[g]);
}

export function AppearanceGroup() {
  const a = usePrefGroup('appearance');
  const set = useSet('appearance');
  return (
    <>
      <Block title="Theme" lede="How NVX Ancile looks. Every change applies at once.">
        <Row
          group="appearance"
          k="theme"
          label="Theme"
          desc="Follow your system, or keep one."
          keywords="dark light mode"
        >
          <Segmented
            label="Theme"
            value={a.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: 'system', label: 'System', icon: 'monitor' },
              { value: 'dark', label: 'Dark', icon: 'moon' },
              { value: 'light', label: 'Light', icon: 'sun' },
            ]}
          />
        </Row>
        <Row
          group="appearance"
          k="accent"
          label="Accent"
          desc="The colour of focus, the main button and anything live. Ultraviolet is NVX Ancile's own."
          keywords="colour color signal violet"
          stack
        >
          <div className="swatches" role="radiogroup" aria-label="Accent">
            {ACCENTS.map((x) => (
              <button
                key={x}
                type="button"
                role="radio"
                aria-checked={a.accent === x}
                className="swatch"
                style={{ '--swatch': ACCENT_SWATCH[x] } as CSSProperties}
                onClick={() => set({ accent: x })}
              >
                <span className="swatch__chip" aria-hidden="true" />
                <span className="swatch__label">{ACCENT_LABEL[x]}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row
          group="appearance"
          k="tint"
          label="Ground"
          desc="The cast of the dark theme's surfaces."
          keywords="background tint graphite ink obsidian black"
        >
          <Segmented
            label="Ground"
            value={a.tint}
            onChange={(tint) => set({ tint })}
            options={[
              { value: 'graphite', label: 'Graphite' },
              { value: 'ink', label: 'Ink' },
              { value: 'obsidian', label: 'Obsidian' },
            ]}
          />
        </Row>
        <Row
          group="appearance"
          k="contrast"
          label="Contrast"
          desc="High contrast strengthens edges and quiet text."
          keywords="accessibility readability"
        >
          <Segmented
            label="Contrast"
            value={a.contrast}
            onChange={(contrast) => set({ contrast })}
            options={[
              { value: 'standard', label: 'Standard' },
              { value: 'high', label: 'High' },
            ]}
          />
        </Row>
      </Block>

      <Block title="Materials">
        <Row
          group="appearance"
          k="material"
          label="Surfaces"
          desc="Glass lets the screen behind a panel show through, softly. Solid is plainer and lighter on older machines."
          keywords="blur glass transparency solid"
        >
          <Segmented
            label="Surfaces"
            value={a.material}
            onChange={(material) => set({ material })}
            options={[
              { value: 'glass', label: 'Glass' },
              { value: 'solid', label: 'Solid' },
            ]}
          />
        </Row>
        <Row
          group="appearance"
          k="grain"
          label="Film grain"
          desc="A fine grain over everything, as on nvx.sh."
          keywords="noise texture"
        >
          <Switch label="Film grain" checked={a.grain} onChange={(grain) => set({ grain })} />
        </Row>
        <Row
          group="appearance"
          k="gilt"
          label="Gilt details"
          desc="A touch of brass on what is yours: pinned items, verified answers, finished milestones."
          keywords="gold brass accent pinned seal"
          hint={{
            title: 'Gilt',
            body: 'Gold in NVX Ancile means kept, earned or owned. It is never a button, a warning or a status.',
          }}
        >
          <Segmented
            label="Gilt details"
            value={a.gilt}
            onChange={(gilt) => set({ gilt })}
            options={[
              { value: 'on', label: 'On' },
              { value: 'subtle', label: 'Subtle' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Row>
        <Row
          group="appearance"
          k="corners"
          label="Corners"
          desc="Rounded, or tighter."
          keywords="radius sharp square"
        >
          <Segmented
            label="Corners"
            value={a.corners}
            onChange={(corners) => set({ corners })}
            options={[
              { value: 'rounded', label: 'Rounded' },
              { value: 'sharp', label: 'Sharp' },
            ]}
          />
        </Row>
        <Row
          group="appearance"
          k="mark"
          label="The mark"
          desc="The shield in the corner moves to show what the AI is doing."
          keywords="logo animation status light"
        >
          <Segmented
            label="The mark"
            value={a.mark}
            onChange={(mark) => set({ mark })}
            options={[
              { value: 'full', label: 'Alive' },
              { value: 'status', label: 'Status only' },
              { value: 'still', label: 'Still' },
            ]}
          />
        </Row>
      </Block>

      <Block title="Type and size">
        <Row
          group="appearance"
          k="font"
          label="Interface font"
          desc="Archivo is the NVX family face."
          keywords="typeface font archivo system"
        >
          <Segmented
            label="Interface font"
            value={a.font}
            onChange={(font) => set({ font })}
            options={[
              { value: 'archivo', label: 'Archivo' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>
        <Row
          group="appearance"
          k="width"
          label="Letter width"
          desc="Archivo can be set narrower or wider."
          keywords="condensed wide stretch"
        >
          <Range
            label="Letter width"
            value={a.width}
            min={88}
            max={112}
            step={4}
            onChange={(width) => set({ width })}
            format={(v) => (v === 100 ? 'Normal' : v < 100 ? 'Narrower' : 'Wider')}
          />
        </Row>
        <Row
          group="appearance"
          k="mono"
          label="Data font"
          desc="Used for numbers, keys and code."
          keywords="monospace code martian"
        >
          <Segmented
            label="Data font"
            value={a.mono}
            onChange={(mono) => set({ mono })}
            options={[
              { value: 'martian', label: 'Martian Mono' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>
        <Row
          group="appearance"
          k="zoom"
          label="Zoom"
          desc="Everything larger or smaller. Ctrl = and Ctrl - work anywhere."
          keywords="scale size bigger smaller"
        >
          <Range
            label="Zoom"
            value={a.zoom}
            min={0.8}
            max={1.4}
            step={0.05}
            onChange={(zoom) => set({ zoom })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Row>
      </Block>
    </>
  );
}

export function LayoutGroup() {
  const l = usePrefGroup('layout');
  const set = useSet('layout');
  const status = l.status;
  const STATUS: { k: keyof typeof status; label: string }[] = [
    { k: 'model', label: 'Model' },
    { k: 'context', label: 'Context used' },
    { k: 'node', label: 'Compute node' },
    { k: 'approvals', label: 'Decisions waiting' },
    { k: 'health', label: 'Health' },
    { k: 'clock', label: 'Clock' },
  ];
  return (
    <>
      <Block title="Density">
        <Row
          group="layout"
          k="density"
          label="Density"
          desc="How much fits on screen. Compact suits large monitors; spacious suits touch."
          keywords="compact comfortable spacious spacing rows"
        >
          <Segmented
            label="Density"
            value={l.density}
            onChange={(density) => set({ density })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'spacious', label: 'Spacious' },
            ]}
          />
        </Row>
      </Block>
      <Block title="Panels">
        <Row
          group="layout"
          k="railWidth"
          label="Sidebar width"
          desc="Or drag the sidebar's edge."
          keywords="rail sidebar width"
        >
          <Range
            label="Sidebar width"
            value={l.railWidth}
            min={200}
            max={360}
            step={4}
            onChange={(railWidth) => set({ railWidth })}
            format={(v) => `${v} px`}
          />
        </Row>
        <Row
          group="layout"
          k="drawerWidth"
          label="Side panel width"
          desc="Or drag the panel's edge."
          keywords="drawer panel width"
        >
          <Range
            label="Side panel width"
            value={l.drawerWidth}
            min={280}
            max={560}
            step={4}
            onChange={(drawerWidth) => set({ drawerWidth })}
            format={(v) => `${v} px`}
          />
        </Row>
        <Row
          group="layout"
          k="drawerTab"
          label="Side panel opens on"
          desc="The tab shown when you open a thread."
          keywords="drawer default tab"
        >
          <Segmented
            label="Side panel opens on"
            value={l.drawerTab}
            onChange={(drawerTab) => set({ drawerTab })}
            options={[
              { value: 'sources', label: 'Sources' },
              { value: 'notes', label: 'Notes' },
              { value: 'tree', label: 'Tree' },
              { value: 'why', label: 'Why' },
            ]}
          />
        </Row>
      </Block>
      <Block title="Status bar" lede="Choose what the bar along the bottom shows.">
        {STATUS.map((s) => (
          <Row key={s.k} group="layout" k="status" label={s.label} keywords="status bar footer">
            <Switch
              label={s.label}
              checked={status[s.k]}
              onChange={(on) => set({ status: { ...status, [s.k]: on } })}
            />
          </Row>
        ))}
      </Block>
    </>
  );
}

export function ReadingGroup() {
  const r = usePrefGroup('reading');
  const set = useSet('reading');
  return (
    <>
      <Block title="Text" lede="How answers read.">
        <Row group="reading" k="size" label="Text size" keywords="font size bigger">
          <Range
            label="Text size"
            value={r.size}
            min={13}
            max={20}
            step={0.5}
            onChange={(size) => set({ size })}
            format={(v) => `${v} px`}
          />
        </Row>
        <Row group="reading" k="lineHeight" label="Line spacing" keywords="leading line height">
          <Segmented
            label="Line spacing"
            value={r.lineHeight}
            onChange={(lineHeight) => set({ lineHeight })}
            options={[
              { value: 'tight', label: 'Tight' },
              { value: 'normal', label: 'Normal' },
              { value: 'loose', label: 'Loose' },
            ]}
          />
        </Row>
        <Row
          group="reading"
          k="width"
          label="Reading width"
          desc="Shorter lines are easier to follow."
          keywords="measure column width"
        >
          <Segmented
            label="Reading width"
            value={r.width}
            onChange={(width) => set({ width })}
            options={[
              { value: 'narrow', label: 'Narrow' },
              { value: 'normal', label: 'Normal' },
              { value: 'wide', label: 'Wide' },
              { value: 'full', label: 'Full' },
            ]}
          />
        </Row>
        <Row group="reading" k="codeSize" label="Code size" keywords="monospace code block">
          <Range
            label="Code size"
            value={r.codeSize}
            min={11}
            max={17}
            step={0.5}
            onChange={(codeSize) => set({ codeSize })}
            format={(v) => `${v} px`}
          />
        </Row>
        <Row
          group="reading"
          k="streaming"
          label="Streaming"
          desc="Smooth paces words evenly; raw shows them the moment they arrive."
          keywords="typing animation"
        >
          <Segmented
            label="Streaming"
            value={r.streaming}
            onChange={(streaming) => set({ streaming })}
            options={[
              { value: 'smooth', label: 'Smooth' },
              { value: 'raw', label: 'Raw' },
            ]}
          />
        </Row>
      </Block>
      <Block title="Details">
        <Row
          group="reading"
          k="citations"
          label="Citations"
          desc="How source numbers appear in answers."
          keywords="footnote reference"
        >
          <Segmented
            label="Citations"
            value={r.citations}
            onChange={(citations) => set({ citations })}
            options={[
              { value: 'inline', label: 'Inline' },
              { value: 'superscript', label: 'Superscript' },
              { value: 'hover', label: 'On hover' },
            ]}
          />
        </Row>
        <Row group="reading" k="timestamps" label="Times" keywords="date time clock relative">
          <Segmented
            label="Times"
            value={r.timestamps}
            onChange={(timestamps) => set({ timestamps })}
            options={[
              { value: 'relative', label: '5 min ago' },
              { value: 'absolute', label: '14:05' },
              { value: 'hidden', label: 'Hidden' },
            ]}
          />
        </Row>
        <Row group="reading" k="cost" label="Tokens and cost under answers" keywords="price usage tokens">
          <Switch label="Tokens and cost under answers" checked={r.cost} onChange={(cost) => set({ cost })} />
        </Row>
        <Row
          group="reading"
          k="collapseTools"
          label="Fold long tool output"
          desc="Steps that read or write files stay one line until opened."
          keywords="tool steps collapse"
        >
          <Switch
            label="Fold long tool output"
            checked={r.collapseTools}
            onChange={(collapseTools) => set({ collapseTools })}
          />
        </Row>
      </Block>
    </>
  );
}

export function ComposerGroup() {
  const c = usePrefGroup('composer');
  const set = useSet('composer');
  const [trigger, setTrigger] = useState(';');
  const [text, setText] = useState('');
  const valid = /^;[a-z0-9-]{1,24}$/.test(trigger) && text.trim().length > 0;
  return (
    <>
      <Block title="Writing">
        <Row
          group="composer"
          k="send"
          label="Send with"
          desc="The other one starts a new line."
          keywords="enter return newline submit"
        >
          <Segmented
            label="Send with"
            value={c.send}
            onChange={(send) => set({ send })}
            options={[
              { value: 'enter', label: 'Enter' },
              { value: 'mod-enter', label: 'Ctrl Enter' },
            ]}
          />
        </Row>
        <Row group="composer" k="spellcheck" label="Spellcheck" keywords="spelling">
          <Switch label="Spellcheck" checked={c.spellcheck} onChange={(spellcheck) => set({ spellcheck })} />
        </Row>
        <Row
          group="composer"
          k="pastePlain"
          label="Paste as plain text"
          desc="Drop formatting from anything you paste."
          keywords="clipboard formatting"
        >
          <Switch
            label="Paste as plain text"
            checked={c.pastePlain}
            onChange={(pastePlain) => set({ pastePlain })}
          />
        </Row>
        <Row
          group="composer"
          k="menus"
          label="Slash and @ menus"
          desc="Typing / or @ offers commands, sources and models."
          keywords="autocomplete mention command"
        >
          <Switch label="Slash and @ menus" checked={c.menus} onChange={(menus) => set({ menus })} />
        </Row>
        <Row
          group="composer"
          k="grounded"
          label="Answer from sources in notebooks"
          desc="Inside a notebook, questions are answered from its sources with citations."
          keywords="grounded retrieval rag citations"
          hint={{
            title: 'Grounded answers',
            body: 'NVX Ancile finds the passages that best match your question and asks the model to cite them by number.',
            article: 'citations',
          }}
        >
          <Switch
            label="Answer from sources in notebooks"
            checked={c.grounded}
            onChange={(grounded) => set({ grounded })}
          />
        </Row>
      </Block>
      <Block title="Snippets" lede="Type a trigger and a space in the composer, and it becomes the text.">
        <div className="snippets">
          {c.snippets.length === 0 ? <p className="mute snippets__empty">No snippets yet.</p> : null}
          {c.snippets.map((s) => (
            <div key={s.trigger} className="snippet">
              <code className="snippet__trigger">{s.trigger}</code>
              <span className="snippet__text">{s.text}</span>
              <button
                type="button"
                className="link-btn link-btn--danger"
                onClick={() => set({ snippets: c.snippets.filter((x) => x.trigger !== s.trigger) })}
              >
                Remove
              </button>
            </div>
          ))}
          <form
            className="snippet snippet--new"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              set({ snippets: [...c.snippets.filter((x) => x.trigger !== trigger), { trigger, text }] });
              setTrigger(';');
              setText('');
            }}
          >
            <input
              className="input input--sm input--mono"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value.toLowerCase())}
              aria-label="Trigger"
            />
            <input
              className="input input--sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="The text it stands for"
              aria-label="Snippet text"
            />
            <button type="submit" className="btn btn--ghost btn--sm" disabled={!valid}>
              Add snippet
            </button>
          </form>
        </div>
      </Block>
    </>
  );
}

export function NotificationsGroup() {
  const n = usePrefGroup('notifications');
  const set = useSet('notifications');
  const CATS: { k: keyof typeof n.categories; label: string; desc: string }[] = [
    { k: 'approvals', label: 'Decisions waiting', desc: 'When the AI needs your go-ahead.' },
    {
      k: 'runs',
      label: 'Answers finished',
      desc: 'When a long answer or lab run completes in another thread.',
    },
    { k: 'sources', label: 'Sources', desc: 'When a source is ready, or could not be added.' },
    { k: 'health', label: 'Health', desc: 'When a service stops or recovers.' },
    { k: 'memory', label: 'Memory', desc: 'When NVX Ancile proposes to remember something.' },
  ];
  return (
    <>
      <Block title="Toasts">
        <Row group="notifications" k="position" label="Where they appear" keywords="toast corner position">
          <Segmented
            label="Where they appear"
            value={n.position}
            onChange={(position) => set({ position })}
            options={[
              { value: 'bottom-right', label: 'Bottom right' },
              { value: 'top-right', label: 'Top right' },
              { value: 'bottom-centre', label: 'Bottom centre' },
            ]}
          />
        </Row>
        <Row
          group="notifications"
          k="durationMs"
          label="How long they stay"
          desc="Errors always stay at least 8 seconds."
          keywords="toast timeout duration"
        >
          <Segmented
            label="How long they stay"
            value={n.durationMs === null ? 'sticky' : String(n.durationMs)}
            onChange={(v) => set({ durationMs: v === 'sticky' ? null : Number(v) })}
            options={[
              { value: '3000', label: '3 s' },
              { value: '5000', label: '5 s' },
              { value: '8000', label: '8 s' },
              { value: 'sticky', label: 'Until closed' },
            ]}
          />
        </Row>
        <Row group="notifications" k="maxStacked" label="At most on screen" keywords="stack limit">
          <Range
            label="At most on screen"
            value={n.maxStacked}
            min={1}
            max={6}
            onChange={(maxStacked) => set({ maxStacked })}
          />
        </Row>
        <Row group="notifications" k="sound" label="A soft sound for decisions" keywords="audio chime">
          <Switch label="A soft sound for decisions" checked={n.sound} onChange={(sound) => set({ sound })} />
        </Row>
      </Block>
      <Block
        title="By kind"
        lede="Everything always lands in the notification centre (G I); this decides what also pops up."
      >
        {CATS.map((c) => (
          <Row
            key={c.k}
            group="notifications"
            k="categories"
            label={c.label}
            desc={c.desc}
            keywords="category kind"
          >
            <Segmented
              label={c.label}
              size="sm"
              value={n.categories[c.k]}
              onChange={(v) => set({ categories: { ...n.categories, [c.k]: v } })}
              options={[
                { value: 'toast', label: 'Pop up' },
                { value: 'centre', label: 'Centre only' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </Row>
        ))}
      </Block>
    </>
  );
}

export function AccessibilityGroup() {
  const x = usePrefGroup('accessibility');
  const set = useSet('accessibility');
  return (
    <Block title="Accessibility">
      <Row
        group="accessibility"
        k="motion"
        label="Motion"
        desc="Reduced keeps short fades and removes movement."
        keywords="animation reduce vestibular"
      >
        <Segmented
          label="Motion"
          value={x.motion}
          onChange={(motion) => set({ motion })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'reduced', label: 'Reduced' },
            { value: 'full', label: 'Full' },
          ]}
        />
      </Row>
      <Row
        group="accessibility"
        k="transparency"
        label="Transparency"
        desc="Reduced makes glass surfaces solid and removes the grain."
        keywords="blur glass"
      >
        <Segmented
          label="Transparency"
          value={x.transparency}
          onChange={(transparency) => set({ transparency })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'reduced', label: 'Reduced' },
          ]}
        />
      </Row>
      <Row group="accessibility" k="focus" label="Focus ring" keywords="outline keyboard">
        <Segmented
          label="Focus ring"
          value={x.focus}
          onChange={(focus) => set({ focus })}
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'thick', label: 'Thick' },
          ]}
        />
      </Row>
      <Row group="accessibility" k="underlineLinks" label="Underline links" keywords="links">
        <Switch
          label="Underline links"
          checked={x.underlineLinks}
          onChange={(underlineLinks) => set({ underlineLinks })}
        />
      </Row>
      <Row
        group="accessibility"
        k="largeTargets"
        label="Larger buttons"
        desc="At least 44 px, easier to hit."
        keywords="touch targets size"
      >
        <Switch
          label="Larger buttons"
          checked={x.largeTargets}
          onChange={(largeTargets) => set({ largeTargets })}
        />
      </Row>
      <Row
        group="accessibility"
        k="announce"
        label="Read answers aloud as they arrive"
        desc="For screen readers: how often new text is announced."
        keywords="screen reader live region"
      >
        <Segmented
          label="Read answers aloud as they arrive"
          value={x.announce}
          onChange={(announce) => set({ announce })}
          options={[
            { value: 'sentences', label: 'By sentence' },
            { value: 'paragraphs', label: 'By paragraph' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </Row>
    </Block>
  );
}

export function AdvancedGroup() {
  const v = usePrefGroup('advanced');
  const set = useSet('advanced');
  const [css, setCss] = useState(v.css);
  return (
    <>
      <Block title="Behaviour">
        <Row
          group="advanced"
          k="performance"
          label="Effects"
          desc="Automatic turns blur and grain off when the machine is struggling, and back on when it is not."
          keywords="performance lite fps blur"
        >
          <Segmented
            label="Effects"
            value={v.performance}
            onChange={(performance) => set({ performance })}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'full', label: 'Always on' },
              { value: 'lite', label: 'Light' },
            ]}
          />
        </Row>
        <Row
          group="advanced"
          k="hints"
          label="Help hints"
          desc="The small ? beside controls that need explaining."
          keywords="tips help"
        >
          <Switch label="Help hints" checked={v.hints} onChange={(hints) => set({ hints })} />
        </Row>
        <Row
          group="advanced"
          k="developer"
          label="Developer details"
          desc="Trace ids and raw JSON in message menus."
          keywords="debug trace json"
        >
          <Switch
            label="Developer details"
            checked={v.developer}
            onChange={(developer) => set({ developer })}
          />
        </Row>
      </Block>
      <MemoryBlock />
      <Block
        title="Custom style"
        lede="Your own CSS, applied after everything else. Open NVX Ancile with ?safe=1 to start without it."
      >
        <Row group="advanced" k="css" label="CSS" keywords="custom css theme style" stack>
          <div className="css-editor">
            <textarea
              className="input input--mono css-editor__text"
              rows={8}
              spellCheck={false}
              value={css}
              placeholder={
                ':root { --signal: #c9a362; }\n.msg[data-role="assistant"] { letter-spacing: 0.01em; }'
              }
              onChange={(e) => setCss(e.target.value)}
              aria-label="Custom CSS"
            />
            <div className="css-editor__bar">
              <span className="mute">
                Uses the same tokens as NVX Ancile: --signal, --lift, --fg and the rest.
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={css === v.css}
                onClick={() => set({ css })}
              >
                Apply
              </button>
            </div>
          </div>
        </Row>
      </Block>
      <p className="mute settings__kbd-note">
        Press <Kbd keys="mod+," /> to come back here from anywhere.
      </p>
    </>
  );
}

/** How memory learns: kept by Core (it governs what Core writes), so not a synced preference. */
function MemoryBlock() {
  const q = useContext(SearchContext);
  if (!matches(q, 'memory learn remember capture inbox corrections', 'advanced')) return null;
  return (
    <Block title="Memory" lede="What NVX Ancile may keep from your corrections and from its own mistakes.">
      <div className="setting" data-stack>
        <div className="setting__words">
          <div className="setting__label">
            <span>How memory learns</span>
            <Hint id="setting-memory-capture" title="How memory learns" article="memory-learning">
              Whatever you choose, nothing from a web page, a file or a tool is kept without your yes.
            </Hint>
          </div>
          <p className="setting__desc">{CAPTURE_OPTIONS.map((o) => `${o.label}: ${o.desc}`).join(' ')}</p>
        </div>
        <div className="setting__control">
          <CaptureControl />
        </div>
      </div>
    </Block>
  );
}
