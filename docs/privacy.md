# Private notebooks: what they may use

A notebook marked **Private** keeps its work on this computer (docs/scopes.md). This page is the one list of everything that could take work off the machine, and what a private notebook does about each. It is also one place to manage it: **Settings → Private notebooks**.

Nothing here changes a notebook that is not private.

## The capabilities

Contract: `packages/contracts/src/privacy.ts`. Saved in `core.settings` under `privacy.policy`.

| Capability | In a private notebook | Switchable |
|---|---|---|
| `decisions_off_machine` | Off. Hosted decision models (Jev, hosted Clef and Clef-flash) are not used. A decision model on this computer or on your own GPU node is, and so are the rules. | Yes |
| `passive_memory` | Off. Nothing is learned from things said in passing, unless a model on this computer or on your own GPU node can run it. | Yes |
| `verdict_cache_global` | Off. Fact-check verdicts stay in the notebook and are never shared across notebooks. Verdicts are kept per notebook everywhere. | Yes |
| `cloud_models` | Always off (the scope floor). | No |
| `claude_code` | Always off. | No |
| `web` | Always off (search and fetch). | No |
| `auto_reviewer_off_machine` | Always off: Auto mode asks only local reviewers, then the rules. | No |

Switchable ones default to `allowed_in_private: false`. The fixed ones are existing floors, shown so the list is complete.

A model or node on this machine, or a GPU node you run yourself, counts as private (`ModelConfig.runs_on`); a rented RunPod pod does not.

## The helper

`services/core/src/privacy/policy.ts`. Every feature asks it; none reads the private flag and decides alone.

```ts
privacy.allows(capability, { notebookId?, private?, local? }): Promise<boolean>
privacy.resolve(capability, ctx): Promise<{ allowed, via, must_run_local }>
privacy.require(capability, ctx): Promise<PrivacyAnswer>   // throws privacy.denied
privacy.setLocalAvailable((capability) => boolean | Promise<boolean>): void
allowsByDefault(lockedCapability, { private, local? }): boolean   // the floors, no service needed
```

- Not private: always allowed.
- Private: allowed when the call itself runs locally (`local: true`), when the person switched it on, or, for `decisions_off_machine` and `passive_memory`, when the local-model hook says one can serve it. Then `must_run_local` is true and the caller must use that model.
- Pass `private` when you already hold an `EffectiveScope`; pass `notebookId` otherwise.

## Routes and errors

`GET` and `PUT /api/v1/privacy/policy` (docs/api.md). Errors: `privacy.denied`, `privacy.locked` (docs/errors.md).
