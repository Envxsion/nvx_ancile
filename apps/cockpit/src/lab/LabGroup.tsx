/**
 * ------------------------------------------------------------------
 *  Title    |  Settings, Coding lab
 *  Ref      |  ROADMAP LB3 · docs/api.md (Lab)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The one choice about the lab that is not about a run:
 *           |  whether the files it edited are formatted with the
 *           |  project's own formatter.
 *  How      |  GET and PUT /lab/settings. The switch writes at once.
 *  Note     |  Off by default. Running a formatter runs the project's
 *           |  own tools, so each command still asks permission first.
 * ------------------------------------------------------------------
 */

import type { LabSettings } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';
import { InitAgents } from './InitAgents';

const KEY = ['lab', 'settings'] as const;
const KEYWORDS = 'lab format formatter prettier biome ruff black gofmt rustfmt code style';
const LABEL = 'Format files the lab edits';

export function LabGroup() {
  const q = useContext(SearchContext);
  const settings = useQuery({ queryKey: KEY, queryFn: () => api.get<LabSettings>('/lab/settings') });
  const save = useMutation({
    mutationFn: (format_on_edit: boolean) => api.put<LabSettings>('/lab/settings', { format_on_edit }),
    onSuccess: (next) => queryClient.setQueryData(KEY, next),
    onError: () =>
      notify({
        level: 'error',
        title: 'The setting was not saved',
        body: 'Check that NVX Ancile is running, then try again.',
      }),
  });
  const formatShown = matches(q, LABEL, KEYWORDS);
  if (!formatShown) return <InitAgents />;
  return (
    <>
      <Block title="Formatting" lede="Keep what the lab writes in your project's own style.">
        <div className="setting">
          <div className="setting__words">
            <div className="setting__label">
              <span>{LABEL}</span>
            </div>
            <p className="setting__desc">
              After a lab run, the formatter your project uses (Biome, Prettier, Ruff, Black, gofmt or
              rustfmt) runs on the files that run changed, and nothing else. The step says which one did it.
              If it is missing or fails, your edit stays as it was. The formatter is a command like any other,
              so NVX Ancile asks your permission policy before running it.
            </p>
          </div>
          <div className="setting__control">
            {settings.isError ? (
              <LoadFailed
                error={settings.error}
                what="Lab settings"
                onRetry={() => settings.refetch()}
                compact
              />
            ) : !settings.data ? (
              <Skeleton lines={1} />
            ) : (
              <Switch label={LABEL} checked={settings.data.format_on_edit} onChange={(v) => save.mutate(v)} />
            )}
          </div>
        </div>
      </Block>
      <InitAgents />
    </>
  );
}
