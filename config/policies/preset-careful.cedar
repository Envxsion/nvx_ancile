// =============================================================================
//  Preset: Careful. Selected in onboarding or Settings → Permissions.
//  Every non-read action asks the first time per pattern, grants default to
//  thread scope (set in the UI), and network reads ask per host.
//  Only one preset file is active at a time; Core copies the chosen one to
//  preset.cedar.
// =============================================================================

// Shell is critical regardless of command.
@id("careful.shell-critical")
@escalate("critical")
permit (principal, action == Ancile::Action::"shell.exec", resource);

// Posting anywhere on the network is critical.
@id("careful.http-write-critical")
@escalate("critical")
permit (principal, action in [Ancile::Action::"http.post", Ancile::Action::"http.put",
                              Ancile::Action::"http.patch", Ancile::Action::"http.delete"], resource);

// Agents may not start GPU nodes on their own in Careful mode; you start them.
@id("careful.no-agent-compute-start")
forbid (principal is Ancile::Agent, action == Ancile::Action::"compute.start", resource);
