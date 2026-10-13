/**
 * ------------------------------------------------------------------
 *  Title    |  Cost calculator
 *  Ref      |  docs/openrouter.md (Cost calculator)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What a turn, a day and a month cost on each provider of
 *           |  a model, ranked by the real invoice (cache included),
 *           |  beside Claude Code's plan and a rented GPU.
 *  How      |  POST /cost/estimate whenever a figure changes. The
 *           |  cache hit rate starts from this person's history for
 *           |  the model (Core fills it when left empty).
 * ------------------------------------------------------------------
 */

import type { CostEstimateRequest } from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorState } from '../ui/ErrorState';
import { errorBody, estimateCost, usd } from './api';

const START: CostEstimateRequest = {
  model: '',
  input_tokens: 8_000,
  output_tokens: 1_000,
  cache_write_tokens: 0,
  cache_hit_rate: null,
  messages_per_day: 50,
  gpu_usd_per_hour: null,
  gpu_tokens_per_second: null,
};

function Num({
  label,
  value,
  onChange,
  placeholder,
  step,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  placeholder?: string;
  step?: string;
}) {
  return (
    <label className="or-field">
      <span className="or-field__label">{label}</span>
      <input
        className="input"
        type="number"
        min={0}
        step={step ?? '1'}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </label>
  );
}

export function CostCalculator({ model, modelId }: { model: string; modelId?: string }) {
  const [req, setReq] = useState<CostEstimateRequest>({ ...START, model });
  const set = (patch: Partial<CostEstimateRequest>) => setReq((r) => ({ ...r, ...patch }));
  const q = useQuery({
    queryKey: ['cost', modelId ?? '', JSON.stringify(req)],
    queryFn: () => estimateCost(req, modelId),
    staleTime: 60_000,
  });
  const est = q.data;
  return (
    <section className="or-section" aria-label="Cost calculator">
      <div className="or-grid">
        <Num
          label="Input tokens a turn"
          value={req.input_tokens}
          onChange={(n) => set({ input_tokens: n ?? 0 })}
        />
        <Num
          label="Output tokens a turn"
          value={req.output_tokens}
          onChange={(n) => set({ output_tokens: n ?? 0 })}
        />
        <Num
          label="Cache writes a turn"
          value={req.cache_write_tokens}
          onChange={(n) => set({ cache_write_tokens: n ?? 0 })}
        />
        <Num
          label="Cache hit rate, %"
          value={req.cache_hit_rate === null ? null : Math.round(req.cache_hit_rate * 100)}
          placeholder={est ? `${Math.round(est.cache_hit_rate * 100)} (yours)` : 'From your history'}
          onChange={(n) => set({ cache_hit_rate: n === null ? null : Math.min(100, n) / 100 })}
        />
        <Num
          label="Messages a day"
          value={req.messages_per_day}
          onChange={(n) => set({ messages_per_day: n ?? 0 })}
        />
        <Num
          label="GPU $ an hour (RunPod)"
          step="0.01"
          value={req.gpu_usd_per_hour}
          placeholder="To compare"
          onChange={(n) => set({ gpu_usd_per_hour: n })}
        />
        <Num
          label="GPU tokens a second"
          value={req.gpu_tokens_per_second}
          placeholder="To compare"
          onChange={(n) => set({ gpu_tokens_per_second: n && n > 0 ? n : null })}
        />
      </div>
      {q.error ? <ErrorState error={errorBody(q.error)} compact /> : null}
      {est ? (
        <>
          <p className="or-note">
            {est.cache_hit_from === 'history'
              ? `Cache hit rate ${Math.round(est.cache_hit_rate * 100)}%, from your own use of this model.`
              : est.cache_hit_from === 'given'
                ? `Cache hit rate ${Math.round(est.cache_hit_rate * 100)}%, as you set it.`
                : 'No history for this model yet, so no cache hits are counted.'}{' '}
            Ranked by what you would really pay, not list price.
          </p>
          <div className="or-table-wrap">
            <table className="or-table">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">A turn</th>
                  <th scope="col">A day</th>
                  <th scope="col">A month</th>
                  <th scope="col">At list price</th>
                </tr>
              </thead>
              <tbody>
                {est.rows.map((r) => (
                  <tr key={r.provider} data-warn={r.fits ? undefined : ''}>
                    <th scope="row">
                      {r.provider}
                      {r.fits ? null : <span className="or-dim"> (too small for this turn)</span>}
                    </th>
                    <td>{usd(r.per_turn)}</td>
                    <td>{usd(r.per_day)}</td>
                    <td>{usd(r.per_month)}</td>
                    <td className="or-dim">{usd(r.list_per_turn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {est.runpod ? (
            <p className="or-note">
              A GPU at {usd(est.runpod.usd_per_hour)} an hour costs {usd(est.runpod.usd_per_hour * 24 * 30)} a
              month if it runs all day.{' '}
              {est.runpod.break_even_tokens_per_month !== null
                ? `It pays for itself above ${Math.round(est.runpod.break_even_tokens_per_month / 1e6).toLocaleString('en-GB')} million tokens a month.`
                : null}{' '}
              {est.runpod.hours_needed_per_month !== null
                ? `Your turns would keep it busy about ${est.runpod.hours_needed_per_month} hours a month.`
                : null}
            </p>
          ) : null}
          {est.claude_code ? <p className="or-note">{est.claude_code.note}</p> : null}
        </>
      ) : null}
    </section>
  );
}
