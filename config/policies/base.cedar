// =============================================================================
//  Base policies, always loaded (DESIGN.md §5.3).
//
//  How Ancile reads these:
//  - `forbid` is a hard deny. The model is told why and no prompt is shown.
//  - A `permit` annotated @escalate("critical") does not allow anything by
//    itself. It raises the tier of matching requests, so they ask every time.
//  - Ordinary allow/ask decisions come from tool tiers plus remembered
//    grants, not from Cedar.
//
//  Entities:
//    principal  Ancile::User::"usr_…", Ancile::Agent::"<persona>", Ancile::External::"<client>"
//    action     Ancile::Action::"fs.write", "http.get", "shell.exec", "mcp.github.create_issue", …
//    resource   Ancile::Resource::"<normalised uri>" with attributes
//               { scheme: String, path: String, host: String, workspace: Bool }
//    context    { thread: String, notebook: String, run_kind: String, automation: Bool }
// =============================================================================

// Nothing may touch Ancile's own secrets, database files or memory internals
// through tools. Memory changes go through the memory API, which commits.
@id("base.protect-internals")
forbid (principal, action, resource)
when {
  resource.scheme == "fs" &&
  (resource.path like "*/.git/*" ||
   resource.path like "*/data/memory/*" ||
   resource.path like "*/.env*" ||
   resource.path like "*.pem")
};

// Outside apps (MCP clients of Ancile's /mcp, `mcp:<id>`, and `external:`
// principals) only read, whatever they have been granted: a grant can narrow
// what they read, never let them write. Keep in step with
// EXTERNAL_READ_ACTIONS in services/core/src/permissions/cedar.ts.
@id("base.external-read-only")
forbid (principal is Ancile::External, action, resource)
unless {
  action in [Ancile::Action::"knowledge.search", Ancile::Action::"notebooks.read",
             Ancile::Action::"memory.read"]
};

// Writing anywhere outside the workspace root is always critical.
@id("base.escalate-outside-workspace")
@escalate("critical")
permit (principal, action in [Ancile::Action::"fs.write", Ancile::Action::"fs.delete"], resource)
when { resource.scheme == "fs" && !resource.workspace };

// Anything raised by an unattended automation that has side effects is critical:
// nobody is watching the screen, so it must wait for a deliberate yes.
@id("base.escalate-automations")
@escalate("critical")
permit (principal is Ancile::Agent, action, resource)
when { context.automation && action != Ancile::Action::"fs.read" && action != Ancile::Action::"fs.list" };

// Terminating a compute node destroys its container disk. Always critical.
@id("base.escalate-terminate")
@escalate("critical")
permit (principal, action == Ancile::Action::"compute.terminate", resource);
