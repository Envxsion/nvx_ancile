// =============================================================================
//  Preset: Hands-off.
//  Writes inside the workspace are automatic (tools.yaml tiers are lowered by
//  the preset to auto for fs.write within the workspace root). Critical stays
//  critical: deleting, sending, paying, terminating and writing outside the
//  workspace still ask every time, because base.cedar escalates them.
// =============================================================================

// Even hands-off, nothing an agent does may delete a whole directory tree.
@id("hands-off.no-recursive-delete")
forbid (principal is Ancile::Agent, action == Ancile::Action::"fs.delete", resource)
when { resource.path like "*/**" };
