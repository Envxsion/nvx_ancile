/**
 * ------------------------------------------------------------------
 *  Title    |  Permission preset
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Which preset is on (Careful, Balanced, Hands-off), and
 *           |  a compact picker to change it after setup.
 *  How      |  GET/PUT /permissions/preset. Core reloads the policies
 *           |  at once; the approval dialog reads it to offer only the
 *           |  scopes the preset allows (Careful: thread at most).
 *  Note     |  The words match docs/permissions.md and Setup.
 * ------------------------------------------------------------------
 */

import type { PermissionPreset } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { Segmented } from '../ui/controls';

const KEY = ['permissions', 'preset'] as const;

export const PRESET_WORDS: Record<PermissionPreset, { name: string; line: string }> = {
  careful: {
    name: 'Careful',
    line: 'Anything beyond reading asks first, and an answer is remembered for this thread at most.',
  },
  balanced: {
    name: 'Balanced',
    line: 'Reading is free. Writing asks until you remember an answer. Deleting, sending and spending always ask.',
  },
  hands_off: {
    name: 'Hands-off',
    line: 'Writing a file in your workspace just happens. Deleting, sending and spending still always ask.',
  },
};

export function usePermissionPreset() {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<{ preset: PermissionPreset }>('/permissions/preset').then((r) => r.preset),
    enabled: !demo,
    staleTime: 60_000,
  });
}

/** One row: the three presets and what the chosen one means. */
export function PresetPicker() {
  const preset = usePermissionPreset();
  const change = useMutation({
    mutationFn: (next: PermissionPreset) =>
      api.put<{ preset: PermissionPreset }>('/permissions/preset', { preset: next }),
    onSuccess: (r) => {
      queryClient.setQueryData(KEY, r.preset);
      notify({
        level: 'success',
        title: `${PRESET_WORDS[r.preset].name} is on`,
        body: PRESET_WORDS[r.preset].line,
      });
    },
    onError: () =>
      notify({ level: 'error', title: 'The preset did not change', body: 'Nothing was changed. Try again.' }),
  });
  const value = change.isPending ? change.variables : (preset.data ?? 'balanced');
  return (
    <section className="preset-pick" aria-label="Permission preset">
      <Segmented<PermissionPreset>
        label="Permission preset"
        size="sm"
        value={value}
        onChange={(next) => next !== value && change.mutate(next)}
        options={(Object.keys(PRESET_WORDS) as PermissionPreset[]).map((id) => ({
          value: id,
          label: PRESET_WORDS[id].name,
        }))}
      />
      <p className="mute preset-pick__line">{PRESET_WORDS[value].line}</p>
    </section>
  );
}
