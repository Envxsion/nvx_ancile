# config/

Everything Ancile can be taught without a code change. The onboarding wizard and the Settings screens write these files, so you never have to touch them. You can, though: they're plain, commented YAML and Cedar, and they're versioned in git with the rest of the repo.

Each file is validated against a schema in `packages/contracts/src/config.ts` at boot. If a value is wrong, startup stops and tells you the file, the key, and what it expected:

```
✗ config/models.yaml → models[3].id
  "OpenAI/GPT-5.5" must look like provider/model in lowercase, e.g. openai/gpt-5.5
```

| File | What it controls | Docs |
|---|---|---|
| `models.yaml` | Every model: provider, context window, price, capabilities, how it's reached | [configuration](../docs/configuration.md#models) |
| `routing.yaml` | Task classes and their fallback chains; retry and circuit-breaker settings | [self-healing](../docs/self-healing.md) |
| `tools.yaml` | Permission preset, workspace root, per-tool tier overrides | [permissions](../docs/permissions.md) |
| `policies/*.cedar` | Hard denies and tier escalations. `base.cedar` always loads, plus the chosen preset. | [permissions](../docs/permissions.md#policies) |
| `memory.yaml` | Memory types, budgets, the capture mode, and the backup remote | [memory](../docs/memory.md) |
| `mcp.yaml` | MCP servers, which is how all tools are added | [plugins](../docs/plugins.md) |
| `panels.yaml` | Plugin UI panels in the drawer or Admin | [plugins](../docs/plugins.md#panels) |
| `automations.yaml` | Auto-titling, tagging, stale checks, cleanup, backups and the rest | [configuration](../docs/configuration.md#automations) |
| `factcheck.yaml` | Confidence weights, thresholds, web search | [fact-checking](../docs/factcheck.md) |

Secrets never go in these files. A model entry names a secret (`secret: ANTHROPIC_API_KEY`), and the value lives in the encrypted store under `ANCILE_DATA_DIR`.
