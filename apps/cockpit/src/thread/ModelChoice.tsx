/**
 * ------------------------------------------------------------------
 *  Title    |  A model, while a flow answers
 *  Ref      |  DESIGN.md §16.3 ("Interactions")
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Picking a model in a thread a flow answers is ambiguous:
 *           |  for one message, for the thread, or inside the flow?
 *           |  This asks, and says what each choice will do before it
 *           |  happens.
 *  How      |  chooseModel (lib/models) opens it when the thread's
 *           |  resolved flow is set. "Just the next message" puts the
 *           |  model on the composer as an @model chip (it answers
 *           |  instead of the flow, once). "This thread instead of the
 *           |  flow" saves the model on the thread and turns flows off
 *           |  there ('off'); the flow chip then says "Flow paused".
 *  Note     |  It never edits a flow's step models: that is the flow
 *           |  chip's "Change one step here only", or the editor.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { create } from 'zustand';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import type { ModelView } from '../lib/types';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { flowKeys } from './flowActions';

const FROM: Record<string, string> = {
  thread: 'this thread',
  notebook: 'this notebook',
  workspace: 'your workspace default',
  message: 'this message',
};

interface Ask {
  threadId: string;
  model: ModelView;
  flow: { id: string; name: string; from: string };
  notebookId: string | null;
}

interface ModelChoiceState {
  ask: Ask | null;
  /** A model to put on a thread's composer as @model for its next message. */
  next: Record<string, ModelView>;
  open: (ask: Ask) => void;
  close: () => void;
  takeNext: (threadId: string) => ModelView | undefined;
}

export const useModelChoice = create<ModelChoiceState>((set, get) => ({
  ask: null,
  next: {},
  open: (ask) => set({ ask }),
  close: () => set({ ask: null }),
  takeNext: (threadId) => {
    const m = get().next[threadId];
    if (m) {
      const { [threadId]: _taken, ...rest } = get().next;
      set({ next: rest });
    }
    return m;
  },
}));

/** Use the model for this thread instead of its flow: the flow is paused here, nowhere else. */
export async function pauseFlowForModel(threadId: string, model: ModelView, flowName: string): Promise<void> {
  try {
    await api.patch(`/threads/${threadId}`, { model: model.id, flow_id: 'off' });
    void queryClient.invalidateQueries({ queryKey: flowKeys.resolve(threadId) });
    void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
    notify({
      level: 'success',
      title: `${model.name} answers this thread`,
      body: `${flowName} is paused here only. Turn it back on from the flow chip.`,
    });
  } catch (error) {
    notify({
      level: 'error',
      title: error instanceof ApiCallError ? error.body.error.title : 'The thread was not changed',
      body: error instanceof ApiCallError ? error.body.error.hint : 'Try again.',
    });
  }
}

export function ModelChoiceDialog() {
  const ask = useModelChoice((s) => s.ask);
  const close = useModelChoice((s) => s.close);
  const navigate = useNavigate();
  useLayer(!!ask);
  if (!ask) return null;
  const { model, flow, threadId } = ask;

  const once = () => {
    useModelChoice.setState((s) => ({ next: { ...s.next, [threadId]: model }, ask: null }));
  };
  const instead = () => {
    close();
    void pauseFlowForModel(threadId, model, flow.name);
  };
  const edit = () => {
    close();
    void navigate({ to: '/flows/$flowId', params: { flowId: flow.id } });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog model-choice" aria-describedby="model-choice-desc">
          <Dialog.Title className="dialog__title">{flow.name} answers this thread</Dialog.Title>
          <p id="model-choice-desc" className="dialog__lede">
            The flow comes from {FROM[flow.from] ?? 'this thread'}. How should {model.name} take part?
          </p>
          <div className="model-choice__options">
            <button type="button" className="model-choice__option" onClick={once}>
              <Icon name="send" size={15} />
              <span>
                <strong>Just the next message</strong>
                <span className="mute">
                  {model.name} answers your next message on its own. After that, {flow.name} answers again.
                </span>
              </span>
            </button>
            <button type="button" className="model-choice__option" onClick={instead}>
              <Icon name="model" size={15} />
              <span>
                <strong>This thread instead of the flow</strong>
                <span className="mute">
                  {flow.name} is paused in this thread until you turn it back on. Other threads keep it.
                </span>
              </span>
            </button>
            <button type="button" className="model-choice__option" onClick={edit}>
              <Icon name="tree" size={15} />
              <span>
                <strong>Inside the flow</strong>
                <span className="mute">
                  Open {flow.name} to choose which step uses {model.name}. For this thread only, use the flow
                  chip's "Change one step here only".
                </span>
              </span>
            </button>
          </div>
          <div className="dialog__actions">
            <Dialog.Close className="btn btn--ghost" type="button">
              Cancel
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
