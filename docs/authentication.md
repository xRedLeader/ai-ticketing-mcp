# Authentication and client setup

## Trusted local stdio

Run `npm run build`. Supply `DATABASE_URL` and `ACTOR_ID`, then launch `node dist/cli.js stdio` from an MCP client. Logs use stderr; stdout contains protocol messages only. This mode is for a trusted operator: possession of database credentials is not an isolation boundary between agents.

Create a local owner with `node dist/cli.js actor --issuer local --subject owner --name Owner --kind human --admin`. Save the returned identifier as `ACTOR_ID`. Use the CLI `call` command to create projects and grant memberships. Local operator commands deliberately bypass OAuth; restrict access to the host and its database credentials.

## Shared remote MCP

The HTTP resource is `${PUBLIC_URL}/mcp`. Tokens must match the configured issuer and audience, be unexpired, have a registered subject, and include `ticketing:read`. Mutations additionally need `ticketing:write`. Project roles are checked independently of OAuth scopes.

The server exposes RFC 9728 resource metadata at `/.well-known/oauth-protected-resource/mcp` and advertises the authorization server in authentication challenges. It accepts signed JWT access tokens using RS256, PS256, or ES256 and caches signing keys through `jose`. Opaque access tokens require a custom authenticator; they are not silently accepted.

## Included Keycloak setup

Start the `auth` Compose profile. Sign in to the administration console with `admin` and the generated `KEYCLOAK_ADMIN_PASSWORD` from your private `.env`, then select the `ticketing` realm.

1. Create human users and set their initial credentials through Keycloak.
2. For an agent, use the confidential `ai-ticketing-agent` client or create a separate service-account client for each independent identity. Read its secret in the administration console; no reusable client secret is committed in the realm template.
3. Locate the user's or service account's immutable Keycloak user ID. Register it with `actor --issuer http://localhost:8080/realms/ticketing --subject USER_ID --name NAME --kind human|agent` through the trusted operator CLI.
4. Create a project as a registered system administrator. For independent review, set `reviewer_actor_id` to the registered reviewer identity. Creation grants that identity verifier access. Use `member_set` to grant other identities project roles. Humans marked as verifiers can approve human-policy tickets. Agent identities cannot become humans by sending a claim in a tool request.

The built-in public client `ai-ticketing-cli` requires PKCE for authorization-code flow and also enables device authorization. Configure MCP clients to use that client ID and register their exact callback URLs in Keycloak. Loopback redirect examples are included; adjust them to match the client's documented callback. For a client requiring dynamic registration, configure Keycloak registration policy explicitly or use a compatible existing provider. Anonymous client registration is not enabled by this project.

The token endpoint is `/realms/ticketing/protocol/openid-connect/token`. Machine clients use `client_credentials` with scopes `ticketing:read ticketing:write`. Human clients use authorization code with PKCE or device authorization; never use a human password grant in an MCP client.

For a manually acquired access token, keep it in an environment variable and run:

```sh
node dist/cli.js call --url http://localhost:3000/mcp --token-env ACCESS_TOKEN --operation project_list --input '{}'
```

Use `--input-file` for larger payloads and reviews. The CLI invokes the same authenticated MCP tools; it does not grant extra review privileges.

## Existing providers

Set `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, and `PUBLIC_URL`. The server reads OpenID discovery unless `OAUTH_JWKS_URL` is explicitly configured. Inside Compose, set that override to your provider's actual JWKS address; its default points to the bundled Keycloak. Configure the provider to issue the two scopes and the exact audience. Register issuer/subject identities and project grants as above.

## Production HTTPS

The included Keycloak profile defaults to local development. For public hosting:

- Set `PUBLIC_URL=https://tickets.example.com`, `OAUTH_AUDIENCE=https://tickets.example.com/mcp`, `KEYCLOAK_PUBLIC_URL=https://login.example.com`, and `OAUTH_ISSUER=https://login.example.com/realms/ticketing`.
- Set `TICKETING_DOMAIN`, `LOGIN_DOMAIN`, and `ALLOWED_ORIGIN_HOSTS` to the intended hostnames.
- Update the Keycloak `ticketing:read` scope's audience mapper to the exact production MCP URL. An already imported realm must be updated in Keycloak; changing the template does not overwrite it.
- Run `docker compose -f compose.yaml -f deploy/compose.production.yaml --profile auth --profile local-ai up -d --build` with DNS pointing to the host. The override switches Keycloak out of development mode and supplies a Caddy TLS proxy.
- Keep database, embedding, and identity-provider management ports private. The default published service ports bind to loopback. Caddy is the public entry point.

The public HTTPS deployment requires operator-owned domains and DNS; the local quickstart does not publish a service to the Internet.
