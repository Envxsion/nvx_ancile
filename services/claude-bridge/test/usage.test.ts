/**
 * Plan usage from the SDK's experimental method: found by name, read
 * loosely, never trusted for shape, and never carrying an account.
 */
import { describe, expect, it } from 'vitest';
import { compactsAt, planUsage, readPlanUsage, USAGE_METHOD } from '../src/usage';

const answer = {
  session: { total_cost_usd: 1.25, total_api_duration_ms: 1, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: '2026-10-12T15:40:00Z' },
    seven_day: { utilization: 18.5, resets_at: '2026-10-19T09:00:00.000Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 140, resets_at: 'not a date' },
    model_scoped: [{ display_name: 'Opus', utilization: 7, resets_at: null }, { nope: true }],
    extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 3, utilization: 6 },
  },
  behaviors: null,
  account: { email: 'someone@example.com', organization: 'Org' },
};

describe('plan usage', () => {
  it('keeps the windows, the plan kind and the cost, and nothing about the account', () => {
    const u = readPlanUsage(answer);
    expect(u).toEqual({
      rate_limits_available: true,
      subscription_type: 'max',
      windows: {
        five_hour: { utilization: 42, resets_at: '2026-10-12T15:40:00.000Z' },
        seven_day: { utilization: 18.5, resets_at: '2026-10-19T09:00:00.000Z' },
        seven_day_sonnet: { utilization: 100, resets_at: null },
      },
      model_scoped: [{ label: 'Opus', utilization: 7, resets_at: null }],
      session_cost_usd: 1.25,
    });
    expect(JSON.stringify(u)).not.toMatch(/example\.com|Org/);
  });

  it('reads an API key sign-in, and survives any shape at all', () => {
    expect(
      readPlanUsage({ rate_limits_available: false, rate_limits: null, subscription_type: null }),
    ).toEqual({
      rate_limits_available: false,
      subscription_type: null,
      windows: {},
      model_scoped: [],
      session_cost_usd: null,
    });
    for (const odd of [null, 42, 'x', [], { rate_limits: [1, 2] }, { rate_limits: { five_hour: 'full' } }])
      expect(() => readPlanUsage(odd)).not.toThrow();
  });

  it('feature-detects the experimental method and asks without the transcript scan', async () => {
    await expect(planUsage({})).rejects.toThrow(/does not report plan usage/);
    let asked: unknown = null;
    const q = {
      async [USAGE_METHOD](o: unknown) {
        asked = o;
        return answer;
      },
    };
    const u = await planUsage(q);
    expect(asked).toEqual({ skipBehaviors: true });
    expect(u.windows.five_hour?.utilization).toBe(42);
  });

  it('turns the auto-compact threshold into a percent of the window', () => {
    expect(
      compactsAt({ autoCompactThreshold: 167_000, maxTokens: 200_000, isAutoCompactEnabled: true }),
    ).toBe(83.5);
    expect(compactsAt({ autoCompactThreshold: 0.92, maxTokens: 200_000 })).toBe(92);
    expect(
      compactsAt({ autoCompactThreshold: 167_000, maxTokens: 200_000, isAutoCompactEnabled: false }),
    ).toBe(null);
    expect(compactsAt({ maxTokens: 200_000 })).toBe(null);
  });
});
