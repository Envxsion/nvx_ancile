// =============================================================================
//  Preset: Hands-off.
//  Writing a file inside the workspace does not ask. Cedar can only forbid or
//  raise a tier, so that easing is not here: it is PRESET_AUTO in
//  services/core/src/permissions/cedar.ts (fs.write, gated, not destructive,
//  inside the workspace, never for an outside app). Critical stays critical:
//  deleting, sending, paying, terminating, writing outside the workspace and
//  anything an unattended automation does still ask, because base.cedar
//  escalates them after the easing.
// =============================================================================

// Even hands-off, no agent deletes by wildcard ("docs/**", "*.md"): one named
// file or empty folder at a time. Whole trees go through the shell, where
// base.cedar makes rm -rf critical.
@id("hands-off.no-recursive-delete")
forbid (principal is Ancile::Agent, action == Ancile::Action::"fs.delete", resource)
when { resource.path like "*\**" };
