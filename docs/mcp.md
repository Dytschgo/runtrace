# Read-only MCP

Production command: `D:/Code/Runtrace/t3ui.cmd mcp serve`. Newline-delimited JSON-RPC stdio; protocol version 2024-11-05. Logs go to stderr. Stop with EOF. It opens the database directly when free and falls back to the local HTTP analytics API when the server owns DuckDB's writer lock. Start the server first for concurrent dashboard/MCP access.

```json
{"mcpServers":{"t3-usage-intelligence":{"command":"D:\\Code\\Runtrace\\bin\\t3ui.exe","args":["mcp","serve"],"cwd":"D:\\Code\\Runtrace","env":{"T3UI_CONFIG":"D:\\Code\\Runtrace\\config\\default.toml"}}}}
```

No token or full-content scope is required or accepted. Full ciphertext is excluded in the common query layer. Administrative actions and unrestricted SQL are absent. Unknown argument properties are rejected. Accepted filters: since, until (RFC3339 UTC), project, instance, model, id, q, include_content, offset, limit (maximum 500). Null means unavailable. The twenty requested tool names, eight prompts, static resources and dynamic project/thread/agent templates are registered.

usage_by_project and compare_projects now aggregate actual prompt/run/tool/agent/token observations by project. usage_by_machine currently groups by configured instance identity; physical-machine discovery is still partial. Model summaries include normalized per-turn token observations and latency percentiles with explicit coverage. They do not establish task quality or individual model-call counts. get_agent_tree returns observed agent records; interactive full recursive graph traversal remains unfinished. Do not interpret these aliases as implemented efficiency calculations.

Proxy safety: a locked database only falls back to a running service whose canonical database identity matches the client configuration. A wrong-database service is rejected before content is returned; the matched and mismatched paths were exercised with two real local services.
