/**
 * ------------------------------------------------------------------
 *  Title    |  Artifacts: which one is open, and its data
 *  Ref      |  docs/artifacts.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One artifact panel at a time, opened from a card in an
 *           |  answer, plus the thread's artifact list from Core
 *           |  (versions and the network decision).
 *  How      |  openArtifact({ threadId, artifact, messageId }) keeps
 *           |  the artifact as the card parsed it, so the panel shows
 *           |  something at once (and in the demo, with no Core). The
 *           |  list from Core replaces it when it arrives.
 * ------------------------------------------------------------------
 */

import type { ArtifactNetwork, ParsedArtifact, ThreadArtifact, ThreadArtifacts } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';

export interface OpenArtifact {
  threadId: string | null;
  messageId: string | null;
  artifact: ParsedArtifact;
  /** The version chosen in the panel; null is the one the card showed. */
  version: number | null;
}

interface ArtifactsState {
  open: OpenArtifact | null;
  full: boolean;
  show: (o: Omit<OpenArtifact, 'version'>) => void;
  pick: (version: number | null) => void;
  setFull: (full: boolean) => void;
  close: () => void;
}

export const useArtifacts = create<ArtifactsState>((set) => ({
  open: null,
  full: false,
  show: (o) => set({ open: { ...o, version: null } }),
  pick: (version) => set((s) => (s.open ? { open: { ...s.open, version } } : s)),
  setFull: (full) => set({ full }),
  close: () => set({ open: null, full: false }),
}));

export const openArtifact = (o: Omit<OpenArtifact, 'version'>) => useArtifacts.getState().show(o);

export const artifactKeys = {
  thread: (threadId: string) => ['artifacts', threadId] as const,
};

export function useThreadArtifacts(threadId: string | null) {
  return useQuery({
    queryKey: artifactKeys.thread(threadId ?? 'none'),
    enabled: Boolean(threadId),
    staleTime: 15_000,
    retry: false,
    queryFn: () => api.get<ThreadArtifacts>(`/threads/${threadId}/artifacts`),
  });
}

/** The panel's artifact: Core's record when it has one, else the card's own copy as version 1. */
export function artifactRecord(
  o: OpenArtifact,
  list: ThreadArtifacts | undefined,
): ThreadArtifact & { local: boolean } {
  const found = list?.items.find((a) => a.key === o.artifact.key);
  if (found && found.versions.length) return { ...found, local: false };
  return {
    key: o.artifact.key,
    type: o.artifact.type,
    title: o.artifact.title,
    allow_network: false,
    network_changed_at: null,
    versions: [
      {
        version: 1,
        message_id: o.messageId ?? 'local',
        created_at: new Date().toISOString(),
        type: o.artifact.type,
        title: o.artifact.title,
        language: o.artifact.language,
        content: o.artifact.content,
      },
    ],
    local: true,
  };
}

export function useSetNetwork(threadId: string | null) {
  return useMutation({
    mutationFn: ({ key, allow }: { key: string; allow: boolean }) =>
      api.put<ArtifactNetwork>(`/threads/${threadId}/artifacts/${encodeURIComponent(key)}/network`, {
        allow,
      }),
    onSuccess: (r) => {
      if (!threadId) return;
      queryClient.setQueryData<ThreadArtifacts>(artifactKeys.thread(threadId), (old) =>
        old
          ? {
              items: old.items.map((a) =>
                a.key === r.key
                  ? { ...a, allow_network: r.allow_network, network_changed_at: r.network_changed_at }
                  : a,
              ),
            }
          : old,
      );
    },
  });
}
