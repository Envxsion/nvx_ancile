-- MCP tool-list fingerprints, version 2 (docs/plugins.md, "When a server changes its tools").
--
-- Version 1 hashed a tool's name, description and input schema. Version 2 also hashes its MCP
-- annotations and Ancile's own _meta (tier, action, destructive), because a server that can lower a
-- tool to auto after you approved it has changed the tool as much as one that rewrites its description.
--
-- Every row made before this migration is version 1 and stays comparable as it was made: the next time
-- the server lists its tools, a list that still matches is moved up to version 2 silently, once. A list
-- that does not match is a change, as before. No installed tool is asked about again because of the upgrade.
alter table core.mcp_tool_approvals add column if not exists fingerprint_version integer not null default 1;
