/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → Private notebooks
 *  Ref      |  docs/privacy.md · DESIGN.md D29
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One place for what a private notebook may do beyond
 *           |  staying on this computer: a switch per capability.
 *  How      |  Reads GET /privacy/policy and saves each switch with
 *           |  PUT. The rows Core marks locked (cloud models, Claude
 *           |  Code, the web, hosted Auto reviewers) show as fixed
 *           |  text with no switch. Detail sits behind a help mark.
 *  Note     |  QU1: the intro is two sentences; a row is a label, one
 *           |  line and a switch. A local model that can serve a
 *           |  capability is said once, under the row it affects.
 * ------------------------------------------------------------------
 */

import type { PrivacyRow, PrivacySettings } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { Hint } from '../help/Hint';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';

const KEY = ['privacy', 'policy'] as const;

const INTRO =
  'Private means nothing leaves this computer unless you allow it here. Switches below apply only to notebooks marked Private.';

function useSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<PrivacySettings>('/privacy/policy'),
    staleTime: 30_000,
  });
}

function useToggle() {
  return useMutation({
    mutationFn: (v: { id: PrivacyRow['id']; on: boolean }) =>
      api.put<PrivacySettings>('/privacy/policy', { policy: { [v.id]: { allowed_in_private: v.on } } }),
    onSuccess: (s) => queryClient.setQueryData(KEY, s),
    onError: () =>
      notify({
        level: 'error',
        title: 'Not saved',
        body: 'Check that NVX Ancile is running, then try again.',
      }),
  });
}

/** Settings → Private notebooks. */
export function PrivateNotebooksGroup() {
  const q = useContext(SearchContext);
  const settings = useSettings();
  const toggle = useToggle();
  const rows = settings.data?.rows ?? [];
  const shown = rows.filter((r) => matches(q, r.label, r.description, 'private notebook privacy local'));
  const adjustable = shown.filter((r) => !r.locked);
  const fixed = shown.filter((r) => r.locked);
  if (settings.data && !shown.length && q) return null;
  return (
    <>
      <Block title="What private notebooks may use" lede={INTRO} tour="private-switches">
        {settings.isPending ? (
          <div className="setting" data-stack>
            <Skeleton lines={3} label="Loading private notebook settings" />
          </div>
        ) : settings.isError && !settings.data ? (
          <div className="setting" data-stack>
            <LoadFailed
              compact
              error={settings.error}
              what="Private notebook settings"
              onRetry={() => settings.refetch()}
            />
          </div>
        ) : (
          adjustable.map((r) => (
            <div className="setting" key={r.id}>
              <div className="setting__words">
                <div className="setting__label">
                  <span>{r.label}</span>
                  <Hint id={`privacy-${r.id}`} title={r.label} article="private-notebooks">
                    {r.detail}
                  </Hint>
                </div>
                <p className="setting__desc">
                  {r.description}
                  {r.local_available && !r.allowed_in_private
                    ? ' A model on this computer is set up, so it runs there.'
                    : ''}
                </p>
              </div>
              <div className="setting__control">
                <Switch
                  label={r.label}
                  checked={r.allowed_in_private}
                  onChange={(on) => toggle.mutate({ id: r.id, on })}
                />
              </div>
            </div>
          ))
        )}
      </Block>
      {fixed.length ? (
        <Block
          tour="private-fixed"
          title="Always off"
          lede="These are fixed for private notebooks. Turn off Private on a notebook to use them there."
        >
          {fixed.map((r) => (
            <div className="setting" key={r.id}>
              <div className="setting__words">
                <div className="setting__label">
                  <span>{r.label}</span>
                  <Hint id={`privacy-${r.id}`} title={r.label} article="private-notebooks">
                    {r.detail}
                  </Hint>
                </div>
              </div>
            </div>
          ))}
        </Block>
      ) : null}
    </>
  );
}
