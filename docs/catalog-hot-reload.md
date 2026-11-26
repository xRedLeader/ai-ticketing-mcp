# Tool catalog hot reload

The stdio relay checks the selected build before the next client request, after outstanding requests drain. It can accept added tools on an existing connection when that connection has received `capabilities.tools.listChanged: true` from `initialize` or `server/discover`.

The candidate must preserve every existing tool definition, including schemas, descriptions, annotations, and extension fields. New definitions must pass the installed MCP SDK's tool schema. Removed tools, duplicate names, malformed definitions, changed list metadata, and changed paginated catalogs are rejected. Other recorded discovery replies remain exact, apart from the existing build-version exception.

After the complete candidate passes validation and becomes active, the relay updates its cached catalog baseline and sends one `notifications/tools/list_changed`. A compatible client can then list and call the added tools on the same connection. Re-selecting the active build or switching to another build with the same catalog sends no notification. Rejected candidates send none. Once an addition is accepted, a later build cannot remove that tool from the connected session; reconnect for incompatible changes.

New connections discover the selected catalog normally. Discovery is replayed to candidates; tool calls, including interrupted mutations, are never replayed. Repeated requests with identical parameters and replies share one replay frame. The launcher logs `mcp_relay_pinned` if distinct discovery exceeds its session limit.

Completion requests and sequential logging settings can coexist with hot reload. Other stateful methods still pin the connection to its backend. In particular, modern SDK automatic list-change subscriptions use `subscriptions/listen` and retain that behavior. Modern stdio SDK negotiation may probe a sibling process; that probe does not advertise capabilities on the live relay connection. The modern SDK test explicitly calls `server/discover` on the live connection and refreshes tools from a notification handler.

The tests prove same-connection rediscovery with SDK clients. They do not prove that an installed desktop host refreshes its exposed tool registry. An already-running older relay also needs a reconnect to run this implementation.

## Update worker guidance on an open connection

For local stdio workers, set `MCP_WORKER_GUIDE_FILE` to the absolute path of an operator-controlled guide. Direct stdio and the relay both support it. The release ships its claim and recovery advice in `dist/worker-advice.json`. The same file is available in a source checkout at `src/worker-advice.json`.

1. Install a build with guide support. For a relay with `--sqlite-base`, use a compatible guide-aware build for both the trusted base and the selected backend on the first connection.
2. From the built checkout, publish the guide to a stable path in an existing private directory. The following PowerShell commands also publish future updates. Staging the copy in the destination directory lets readers see one complete version.

   ```powershell
   $guide = 'C:/ticketing/local/worker-advice.json'
   $staged = "$guide.$([guid]::NewGuid()).tmp"
   Copy-Item -LiteralPath ./dist/worker-advice.json -Destination $staged
   [System.IO.File]::Move($staged, $guide, $true)
   ```

3. Add this entry to the existing `[mcp_servers.ai-ticketing.env]` table in Codex and reconnect the MCP client once.

   ```toml
   MCP_WORKER_GUIDE_FILE = 'C:/ticketing/local/worker-advice.json'
   ```

Each publication takes effect on the next guide read or guarded mutation, including on connections pinned to an older guide-aware backend. To track a trusted checkout directly, point the setting at its `src/worker-advice.json` and publish updates there. The file accepts a UTF-8 JSON object with a nonempty `advice` string and an 8,192-byte total limit. Restrict writes to the operator because the text goes to workers as instructions.

Workers receive the current guide by calling `project_list`, reading `ticketing://guide`, or retrieving the `execution` prompt. If a worker tries to claim, checkpoint, note, or submit with stale guidance, it receives `WORKER_GUIDE_REQUIRED` before the ticket operation runs. Read the guide, reconsider the action, and reuse the idempotency key for an identical retry. A missing or invalid file returns `WORKER_GUIDE_UNAVAILABLE`; restore it at the configured path. Heartbeats and releases continue in either case.

Instructions already received by a model stay in that turn. A publication is observed at request admission, so work already admitted can finish. Changes to tool schemas and initialization still follow the relay compatibility checks above.
