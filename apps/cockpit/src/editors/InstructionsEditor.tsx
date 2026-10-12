/**
 * ------------------------------------------------------------------
 *  Title    |  Instructions and persona
 *  Ref      |  docs/engines.md (Instructions and persona)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  How to answer here, and who the assistant is here, for a
 *           |  notebook or one thread. Every engine follows them: the
 *           |  gateway's models in their system prompt, Claude Code in
 *           |  the note appended to its own.
 *  How      |  GET/PUT /threads/:id/instructions (InstructionsView:
 *           |  the thread's own, its notebook's, what engines receive)
 *           |  and GET/PUT /notebooks/:id/instructions. A thread wins
 *           |  over its notebook field by field, so an empty thread
 *           |  field shows the notebook's value as its placeholder:
 *           |  that is what applies until you write your own.
 * ------------------------------------------------------------------
 */

import type { AncileInstructions, InstructionsView } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { Skeleton } from '../ui/primitives';

export const INSTRUCTION_KEYS = {
  thread: (id: string) => ['instructions', 'thread', id] as const,
  notebook: (id: string) => ['instructions', 'notebook', id] as const,
};

const LIMITS = { instructions: 4_000, persona: 1_000 };

function useInstructions(level: 'notebook' | 'thread', id: string) {
  return useQuery({
    queryKey: level === 'thread' ? INSTRUCTION_KEYS.thread(id) : INSTRUCTION_KEYS.notebook(id),
    queryFn: async (): Promise<{ own: AncileInstructions; inherited: AncileInstructions | null }> => {
      if (level === 'thread') {
        const v = await api.get<InstructionsView>(`/threads/${id}/instructions`);
        return { own: v.thread, inherited: v.notebook };
      }
      return { own: await api.get<AncileInstructions>(`/notebooks/${id}/instructions`), inherited: null };
    },
    retry: false,
  });
}

/** The placeholder for a thread field: the notebook's value, which applies while the field is empty. */
export function inheritedPlaceholder(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v ? `From the notebook: ${v}` : fallback;
}

export function InstructionsEditor({
  level,
  id,
  onClose,
}: {
  level: 'notebook' | 'thread';
  id: string;
  onClose: () => void;
}) {
  const q = useInstructions(level, id);
  useLayer(true);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog instr-ed" aria-describedby="instr-ed-lede">
          <Dialog.Title className="dialog__title">
            {level === 'thread' ? 'Instructions for this thread' : 'Instructions for this notebook'}
          </Dialog.Title>
          <p id="instr-ed-lede" className="dialog__lede">
            {level === 'thread'
              ? "Every model and Claude Code follow these here. An empty field uses the notebook's."
              : 'Every model and Claude Code follow these in this notebook. A thread can set its own.'}
          </p>
          {q.data ? (
            <Fields level={level} id={id} own={q.data.own} inherited={q.data.inherited} onClose={onClose} />
          ) : q.isError ? (
            <p className="field__error" role="alert">
              {q.error instanceof ApiCallError
                ? `${q.error.body.error.title}. ${q.error.body.error.hint}`
                : 'These could not be read. Check that NVX Ancile is running, then open them again.'}
            </p>
          ) : (
            <Skeleton lines={5} label="Reading the instructions" />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Fields({
  level,
  id,
  own,
  inherited,
  onClose,
}: {
  level: 'notebook' | 'thread';
  id: string;
  own: AncileInstructions;
  inherited: AncileInstructions | null;
  onClose: () => void;
}) {
  const [persona, setPersona] = useState(own.persona);
  const [instructions, setInstructions] = useState(own.instructions);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const pid = useId();
  const iid = useId();

  const save = async () => {
    setBusy(true);
    setFail(null);
    try {
      const body = { persona: persona.trim(), instructions: instructions.trim() };
      await api.put(
        level === 'thread' ? `/threads/${id}/instructions` : `/notebooks/${id}/instructions`,
        body,
      );
      void queryClient.invalidateQueries({ queryKey: ['instructions'] });
      notify({
        level: 'success',
        title:
          level === 'thread' ? 'Instructions saved for this thread' : 'Instructions saved for this notebook',
        body: 'They apply from the next message, whichever model answers.',
      });
      onClose();
    } catch (error) {
      setFail(
        error instanceof ApiCallError
          ? `${error.body.error.title}. ${error.body.error.hint}`
          : "These didn't reach Core. Check that NVX Ancile is running, then try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="instr-ed__body">
      <label className="field" htmlFor={pid}>
        <span>Persona</span>
        <textarea
          id={pid}
          className="input instr-ed__input"
          rows={2}
          maxLength={LIMITS.persona}
          value={persona}
          placeholder={
            level === 'thread'
              ? inheritedPlaceholder(inherited?.persona, 'Who the assistant is here, in a sentence')
              : 'Who the assistant is here, in a sentence'
          }
          onChange={(e) => setPersona(e.target.value)}
        />
        <span className="field__hint" data-num>
          {persona.length.toLocaleString('en-GB')} / {LIMITS.persona.toLocaleString('en-GB')}
        </span>
      </label>
      <label className="field" htmlFor={iid}>
        <span>Instructions</span>
        <textarea
          id={iid}
          className="input instr-ed__input"
          rows={6}
          maxLength={LIMITS.instructions}
          value={instructions}
          placeholder={
            level === 'thread'
              ? inheritedPlaceholder(inherited?.instructions, 'How to answer here, in your words')
              : 'How to answer here, in your words'
          }
          onChange={(e) => setInstructions(e.target.value)}
        />
        <span className="field__hint" data-num>
          {instructions.length.toLocaleString('en-GB')} / {LIMITS.instructions.toLocaleString('en-GB')}
        </span>
      </label>
      {fail ? (
        <p className="field__error" role="alert">
          {fail}
        </p>
      ) : null}
      <div className="dialog__actions">
        <Dialog.Close className="btn btn--ghost" type="button">
          Cancel
        </Dialog.Close>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving' : 'Save instructions'}
        </button>
      </div>
    </div>
  );
}
