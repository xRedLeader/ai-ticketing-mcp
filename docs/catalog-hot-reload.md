# Tool catalog hot reload

The stdio relay checks the selected build before the next client request, after outstanding requests drain. It can accept added tools on an existing connection when that connection has received `capabilities.tools.listChanged: true` from `initialize` or `server/discover`.

The candidate must preserve every existing tool definition, including schemas, descriptions, annotations, and extension fields. New definitions must pass the installed MCP SDK's tool schema. Removed tools, duplicate names, malformed definitions, changed list metadata, and changed paginated catalogs are rejected. Other recorded discovery replies remain exact, apart from the existing build-version exception.

After the complete candidate passes validation and becomes active, the relay updates its cached catalog baseline and sends one `notifications/tools/list_changed`. A compatible client can then list and call the added tools on the same connection. Re-selecting the active build or switching to another build with the same catalog sends no notification. Rejected candidates send none. Once an addition is accepted, a later build cannot remove that tool from the connected session; reconnect for incompatible changes.

New connections discover the selected catalog normally. Discovery is replayed to candidates; tool calls, including interrupted mutations, are never replayed. Repeated requests with identical parameters and replies share one replay frame. The launcher logs `mcp_relay_pinned` if distinct discovery exceeds its session limit.

Completion requests and sequential logging settings can coexist with hot reload. Other stateful methods still pin the connection to its backend. In particular, modern SDK automatic list-change subscriptions use `subscriptions/listen` and retain that behavior. Modern stdio SDK negotiation may probe a sibling process; that probe does not advertise capabilities on the live relay connection. The modern SDK test explicitly calls `server/discover` on the live connection and refreshes tools from a notification handler.

The tests prove same-connection rediscovery with SDK clients. They do not prove that an installed desktop host refreshes its exposed tool registry. An already-running older relay also needs a reconnect to run this implementation.
