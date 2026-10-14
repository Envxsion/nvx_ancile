/**
 * ------------------------------------------------------------------
 *  Title    |  Endpoint explorer
 *  Ref      |  docs/openrouter.md (Endpoint explorer)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every provider that serves one OpenRouter model, in
 *           |  plain columns, with what each limit costs you in words.
 *  How      |  Reads GET /openrouter/endpoints. Core keeps the list for
 *           |  a while and answers from its saved copy when offline;
 *           |  the table then says when it was read.
 * ------------------------------------------------------------------
 */

import type { EndpointsReport, OrEndpoint } from '@nvx/contracts';
import { useUi } from '../state/ui';
import { ErrorState } from '../ui/ErrorState';
import { Skeleton } from '../ui/primitives';
import { errorBody, tokensText, usd, useEndpoints } from './api';

export const EXPLAINER = 'openrouter-quality';

export function openExplainer() {
  useUi.getState().setHelp(true, EXPLAINER);
}

function precisionText(e: OrEndpoint): string {
  if (e.precision === 'unknown') return 'Unknown';
  const p = e.precision.toUpperCase();
  if (e.original_precision === true) return `${p}, original`;
  if (e.original_precision === false) return `${p}, reduced`;
  return p;
}

export function EndpointTable({ report }: { report: EndpointsReport }) {
  if (!report.endpoints.length)
    return (
      <p className="or-note">
        {report.model === 'openrouter/auto'
          ? 'Auto picks a model for each request, so it has no providers of its own. Which model and provider answered is shown on each answer.'
          : 'OpenRouter lists no providers for this model right now.'}
      </p>
    );
  return (
    <div className="or-table-wrap">
      <table className="or-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Precision</th>
            <th scope="col">Context</th>
            <th scope="col">Max output</th>
            <th scope="col">Tools</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cache read</th>
            <th scope="col">Uptime</th>
          </tr>
        </thead>
        <tbody>
          {report.endpoints.map((e) => (
            <EndpointRow key={`${e.provider}-${e.tag ?? ''}`} e={e} />
          ))}
        </tbody>
      </table>
      <p className="or-note or-note--small">
        Prices are US dollars per million tokens.{' '}
        {report.original_precision ? (
          <>
            The lab released it at {report.original_precision.precision.toUpperCase()} (
            <a href={report.original_precision.source} target="_blank" rel="noreferrer">
              source
            </a>
            ).
          </>
        ) : (
          'The lab’s own precision is not recorded, so “original” is not shown.'
        )}{' '}
        {report.offline
          ? `Offline: this list was read ${new Date(report.fetched_at).toLocaleString('en-GB')}.`
          : null}
      </p>
    </div>
  );
}

function EndpointRow({ e }: { e: OrEndpoint }) {
  return (
    <>
      <tr data-warn={e.warnings.length ? '' : undefined}>
        <th scope="row">{e.provider}</th>
        <td>{precisionText(e)}</td>
        <td>
          {tokensText(e.context)}
          {e.context_pct !== null && e.context_pct < 100 ? (
            <span className="or-dim"> ({Math.round(e.context_pct)}%)</span>
          ) : null}
        </td>
        <td>{tokensText(e.max_output)}</td>
        <td>{e.tools ? 'Yes' : 'No'}</td>
        <td>{usd(e.price.input)}</td>
        <td>{usd(e.price.output)}</td>
        <td>{e.price.cache_read === null ? 'None' : usd(e.price.cache_read)}</td>
        <td>{e.uptime === null ? 'Unknown' : `${Math.round(e.uptime)}%`}</td>
      </tr>
      {e.warnings.length ? (
        <tr className="or-table__warn">
          <td colSpan={9}>
            <ul>
              {e.warnings
                .filter((w) => w.code !== 'unknown_precision')
                .map((w) => (
                  <li key={w.code}>{w.text}</li>
                ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function EndpointExplorer({ model }: { model: string }) {
  const q = useEndpoints(model);
  return (
    <section className="or-section" aria-label="Providers for this model">
      <p className="or-note">
        The same model is served by several providers. They differ in how much they can read, how long they
        can answer and whether they can use tools.{' '}
        <button type="button" className="link-btn" onClick={openExplainer}>
          Why the same model can feel worse
        </button>
      </p>
      {q.isPending ? <Skeleton lines={4} label="Reading providers" /> : null}
      {q.error ? <ErrorState error={errorBody(q.error)} onRetry={() => q.refetch()} retry="always" /> : null}
      {q.data ? <EndpointTable report={q.data} /> : null}
    </section>
  );
}
