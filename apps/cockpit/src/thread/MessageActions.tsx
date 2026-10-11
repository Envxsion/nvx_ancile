/**
 * ------------------------------------------------------------------
 *  Title    |  Message actions
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Branch, fact-check, sources, edit, copy, regenerate,
 *           |  change model: on hover or focus, never in a menu.
 *  How      |  The selected message owns the thread-scope keys, so
 *           |  `b` branches whatever you are looking at. Tooltips read
 *           |  the keymap.
 *  Note     |  Regenerate, edit, copy and fact-check are live. Branch
 *           |  here opens the thread at this message, ready for the
 *           |  first message on the new branch; Delete asks with the
 *           |  size of what goes, and can be undone.
 * ------------------------------------------------------------------
 */

import { useBinding } from '../keys/dispatch';
import { branchHere } from '../lib/branching';
import { keys, useModels } from '../lib/data';
import { startFactcheck } from '../lib/factcheck';
import { partsText } from '../lib/mappers';
import { saveAnswerAsNote } from '../lib/notebooks';
import { queryClient } from '../lib/query';
import { regenerate, runInLab } from '../lib/turns';
import type { MessageView, ThreadView } from '../lib/types';
import { notify } from '../state/notify';
import { usePrefs } from '../state/prefs';
import { useUi } from '../state/ui';
import { askDelete } from '../tree/store';
import { Icon, type IconName } from '../ui/Icon';
import { DropMenu, type MenuEntry } from '../ui/Menu';
import { Tip } from '../ui/primitives';
import { regenerateRoute, routeAgain, useFlowList, useFlowVersions } from './flowActions';

interface Action {
  id: string;
  binding: string;
  label: string;
  icon: IconName;
  roles: MessageView['role'][];
}

const ACTIONS: Action[] = [
  {
    id: 'branch',
    binding: 'message.branch',
    label: 'Branch from here',
    icon: 'branch',
    roles: ['user', 'assistant'],
  },
  {
    id: 'factcheck',
    binding: 'message.factcheck',
    label: 'Fact-check',
    icon: 'factcheck',
    roles: ['assistant'],
  },
  { id: 'cite', binding: 'message.cite', label: 'Show sources', icon: 'cite', roles: ['assistant'] },
  { id: 'why', binding: 'message.why', label: 'Why did it say this?', icon: 'why', roles: ['assistant'] },
  { id: 'edit', binding: 'message.edit', label: 'Edit', icon: 'edit', roles: ['user'] },
  { id: 'lab', binding: 'message.lab', label: 'Run in the lab', icon: 'node', roles: ['user'] },
  { id: 'copy', binding: 'message.copy', label: 'Copy', icon: 'copy', roles: ['user', 'assistant'] },
  { id: 'note', binding: 'message.note', label: 'Save as note', icon: 'note', roles: ['assistant'] },
  {
    id: 'regenerate',
    binding: 'message.regenerate',
    label: 'Regenerate',
    icon: 'regenerate',
    roles: ['assistant'],
  },
  {
    id: 'model',
    binding: 'model.switch',
    label: 'Regenerate with another model',
    icon: 'model',
    roles: ['assistant'],
  },
  {
    id: 'delete',
    binding: 'message.delete',
    label: 'Delete from here',
    icon: 'trash',
    roles: ['user', 'assistant'],
  },
];

/** Copy for the developer menu, with the same words as Copy. */
async function copyDev(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify({ level: 'success', title: `Copied ${what}` });
  } catch {
    notify({ level: 'warn', title: 'Clipboard is blocked', body: 'Select the text and copy it by hand.' });
  }
}

/** Settings → Advanced → Developer details: ids and the raw message, one menu away. */
export function devEntries(m: MessageView): MenuEntry[] {
  return [
    { kind: 'label', label: 'Developer details' },
    { label: 'Copy message id', icon: 'hash', onSelect: () => void copyDev(m.id, 'the message id') },
    ...(m.runId
      ? [
          {
            label: 'Copy run id',
            icon: 'hash' as const,
            onSelect: () => void copyDev(m.runId ?? '', 'the run id'),
          },
        ]
      : []),
    {
      label: 'Copy raw JSON',
      icon: 'copyDebug',
      onSelect: () => void copyDev(JSON.stringify(m, null, 2), 'the raw JSON'),
    },
  ];
}

function plainText(m: MessageView): string {
  if (m.parts) return partsText(m.parts);
  return m.blocks
    .map((b) =>
      b.kind === 'h'
        ? b.text
        : b.kind === 'p'
          ? b.spans.map((s) => s.text).join('')
          : b.items.map((i) => `- ${i.map((s) => s.text).join('')}`).join('\n'),
    )
    .join('\n\n');
}

export function MessageActions({
  message,
  threadId,
  visible,
  armed = visible,
  onEdit,
}: {
  message: MessageView;
  threadId: string;
  visible: boolean;
  /** Whether the single-key shortcuts act on this message. Hover shows the bar; only selection arms the keys. */
  armed?: boolean;
  onEdit?: () => void;
}) {
  const demo = useUi((s) => s.demo);
  const developer = usePrefs((s) => s.prefs.advanced.developer);
  const openDrawer = useUi((s) => s.openDrawer);
  const openPalette = useUi((s) => s.openPalette);

  const run = async (id: string) => {
    switch (id) {
      case 'copy':
        try {
          await navigator.clipboard.writeText(plainText(message));
          notify({ level: 'success', title: 'Copied' });
        } catch {
          notify({
            level: 'warn',
            title: 'Clipboard is blocked',
            body: 'Select the text and copy it by hand.',
          });
        }
        return;
      case 'cite':
        return openDrawer('sources');
      case 'why':
        return useUi.getState().explain(message.id);
      case 'note': {
        const nb = queryClient.getQueryData<ThreadView>(keys.thread(threadId))?.notebookId;
        if (demo || !nb)
          return notify({
            level: 'info',
            title: 'Notes live in notebooks',
            body: 'Move this thread into a notebook (right-click it in the sidebar), then save the answer.',
          });
        return void saveAnswerAsNote(message.id, nb);
      }
      case 'factcheck':
        if (demo || !message.parts) return openDrawer('evidence');
        return startFactcheck(message.id);
      case 'model':
        // The picker is the menu on the button; the shortcut opens the
        // model switcher, which changes the thread (it asks if a flow answers).
        return openPalette('models');
      case 'regenerate':
        if (demo || !message.parts) break;
        // A flow answer is answered again by the flow, deciding afresh.
        if (flow) return regenerateRoute(threadId, message.id, 'again');
        return regenerate(threadId, message);
      case 'edit':
        if (demo || !message.parts || !onEdit) break;
        return onEdit();
      case 'lab':
        if (demo || !message.parts) break;
        return runInLab(threadId, message);
      case 'branch':
        if (demo || !message.parts) break;
        return void branchHere(threadId, message.id, {
          previousHead:
            queryClient.getQueryData<ThreadView>(keys.thread(threadId))?.messages.at(-1)?.id ?? null,
        });
      case 'delete':
        if (demo || !message.parts) break;
        return void askDelete(threadId, message.id);
      default:
        break;
    }
    switch (id) {
      case 'regenerate':
      case 'edit':
      case 'lab':
      case 'branch':
      case 'delete':
        return notify({
          level: 'info',
          title: 'Not available on demo data',
          body: 'Start NVX Ancile to work with real threads.',
        });
      default:
        return notify({
          level: 'info',
          title: `${ACTIONS.find((a) => a.id === id)?.label ?? 'That action'} isn't available yet`,
        });
    }
  };

  const flow = message.role === 'assistant' ? message.provenance?.flow : undefined;
  const models = useModels().data;

  /** Regenerate this reply with one model: it answers alone, without any flow. */
  const modelMenu: MenuEntry[] = [
    {
      kind: 'label',
      label: flow ? `Answers alone, without ${flow.name}` : 'Answer this again with',
    },
    ...(models ?? [])
      .filter((m) => m.chat !== false)
      .sort((a, b) => Number(b.status === 'ready' || !b.status) - Number(a.status === 'ready' || !a.status))
      .slice(0, 20)
      .map((m) => {
        const ready = !m.status || m.status === 'ready';
        return {
          label: ready ? m.name : `${m.name} (needs its key)`,
          disabled: !ready || demo || !message.parts,
          onSelect: () => void regenerate(threadId, message, m.id),
        };
      }),
  ];
  const flows = useFlowList(!!flow && visible).data;
  const versions = useFlowVersions(flow?.flow_id, !!flow && visible).data;

  /** For a flow answer, Regenerate is a split: same route, decide again, or another flow. */
  const routeMenu: MenuEntry[] = flow
    ? [
        { kind: 'label', label: `Answered by ${flow.name}, version ${flow.version}` },
        {
          label: 'Same route',
          icon: 'regenerate',
          onSelect: () => void regenerateRoute(threadId, message.id, 'same'),
        },
        {
          label: 'Route again',
          icon: 'branch',
          keys: 'r',
          onSelect: () => void regenerateRoute(threadId, message.id, 'again'),
        },
        {
          kind: 'sub',
          label: 'Route again with',
          icon: 'tree',
          items: [
            ...(versions ?? [])
              .filter((v) => v.version !== flow.version)
              .slice(0, 8)
              .map((v) => ({
                label: `${flow.name}, version ${v.version}${v.message ? `: ${v.message}` : ''}`,
                onSelect: () =>
                  void routeAgain(threadId, message.id, { flowId: flow.flow_id, version: v.version }),
              })),
            ...((versions ?? []).length > 1 ? [{ kind: 'separator' as const }] : []),
            ...(flows ?? [])
              .filter((f) => f.id !== flow.flow_id)
              .slice(0, 12)
              .map((f) => ({
                label: f.name,
                onSelect: () => void routeAgain(threadId, message.id, { flowId: f.id }),
              })),
            ...(!flows?.length && !(versions ?? []).length
              ? [{ label: 'No other flows yet', disabled: true, onSelect: () => undefined }]
              : []),
          ],
        },
      ]
    : [];

  const available = ACTIONS.filter((a) => a.roles.includes(message.role));
  for (const a of ACTIONS) {
    // Hooks run for every action so the hook order never changes; disabled ones do nothing.
    // biome-ignore lint/correctness/useHookAtTopLevel: fixed-length list, stable order
    useBinding(
      a.binding,
      () => void run(a.id),
      armed && a.roles.includes(message.role) && a.binding !== 'model.switch',
    );
  }

  return (
    <div
      className="msg__actions"
      data-visible={visible || undefined}
      role="toolbar"
      aria-label="Message actions"
    >
      {available.map((a) =>
        a.id === 'model' ? (
          <DropMenu
            key={a.id}
            items={modelMenu}
            trigger={
              <button type="button" className="icon-btn icon-btn--sm" aria-label={a.label}>
                <Icon name="model" size={14} />
              </button>
            }
          />
        ) : a.id === 'regenerate' && flow ? (
          <DropMenu
            key={a.id}
            items={routeMenu}
            trigger={
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label="Regenerate: same route, route again, or another flow"
              >
                <Icon name="regenerate" size={14} />
              </button>
            }
          />
        ) : (
          <Tip key={a.id} label={a.id === 'why' && flow ? 'Why this route?' : a.label} binding={a.binding}>
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label={a.label}
              data-tour={a.id === 'branch' ? 'branch-here' : undefined}
              onClick={() => void run(a.id)}
            >
              <Icon name={a.icon} size={14} />
            </button>
          </Tip>
        ),
      )}
      {developer ? (
        <DropMenu
          items={devEntries(message)}
          trigger={
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Developer details">
              <Icon name="copyDebug" size={14} />
            </button>
          }
        />
      ) : null}
    </div>
  );
}
