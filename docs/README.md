# pharo-launcher-mcp Docs

Start with the README when you only need to install the server and connect it to
an MCP client. Use these docs when you need the details behind a specific
workflow.

## User Docs

- [Getting started](user/getting-started.md) covers the first local install,
  discovery checks, MCP client configuration, and safe first tools.
- [Profile mode](user/profile-mode.md) explains no-profile mode, isolated
  profiles, generated Launcher configuration, and cross-profile image copy.

## Reference

- [Tool reference](reference/tools.md) lists the MCP tools, arguments, result
  shape, confirmation gates, and special handling.
- [Troubleshooting](troubleshooting.md) maps common setup, profile, timeout, and
  live Launcher failures to concrete checks.

## Maintainer Docs

- [Development](development.md) covers source layout, test commands, local
  probes, live integration tests, and documentation upkeep.
- [Cleanup hook boundary](cleanup-hook-boundary.md) defines the status, timeout,
  stop, and cleanup contract for caller-managed live checks.
