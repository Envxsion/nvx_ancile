// =============================================================================
//  Preset: Auto (docs/auto-mode.md).
//  Like Hands-off, writing a file inside the workspace does not ask
//  (PRESET_AUTO in services/core/src/permissions/cedar.ts). On top of that,
//  the gate's Auto mode settles other GATED calls with its floors, the
//  approved plan and an independent reviewer (services/core/src/permissions/
//  auto). Cedar can only forbid or raise a tier: critical stays critical, and
//  floors and scopes are checked before and after the reviewer.
// =============================================================================

// No agent deletes by wildcard, as in Hands-off.
@id("auto.no-recursive-delete")
forbid (principal is Ancile::Agent, action == Ancile::Action::"fs.delete", resource)
when { resource.path like "*\**" };
