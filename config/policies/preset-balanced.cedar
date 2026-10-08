// =============================================================================
//  Preset: Balanced (default).
//  Reads are automatic, writes inside the workspace ask once per pattern with
//  notebook scope suggested, network reads ask once per host, and anything
//  destructive asks every time. Most of that comes from tool tiers in
//  config/tools.yaml; this file only adds what tiers cannot express.
// =============================================================================

// Shell commands that only read are still gated, never auto; anything with
// sudo, rm or a pipe to a shell is critical.
@id("balanced.shell-dangerous")
@escalate("critical")
permit (principal, action == Ancile::Action::"shell.exec", resource)
when {
  resource.path like "*sudo*" ||
  resource.path like "*rm *" ||
  resource.path like "*| sh*" ||
  resource.path like "*| bash*" ||
  resource.path like "*curl*|*"
};
