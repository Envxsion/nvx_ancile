-- MC2: MCP servers can use the older server-sent-events transport (sse) as well as stdio and http.
alter table core.mcp_servers drop constraint if exists mcp_servers_transport_check;
alter table core.mcp_servers add constraint mcp_servers_transport_check
  check (transport in ('stdio','http','sse'));
