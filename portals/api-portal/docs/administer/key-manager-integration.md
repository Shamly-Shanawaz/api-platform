# Key Manager Integration

A key manager is the OAuth2 authorization server used to issue access tokens for OAuth2-secured APIs. The API Portal does not create or register OAuth applications — developers create their OAuth application directly in the key manager, then link its client ID to an application in the portal. The portal only proxies `client_credentials` token requests to the key manager's token endpoint.

## Prerequisites

No encryption key is required for key manager configuration — the portal never stores a client secret or other key manager credential. (The encryption key in `config.toml` is still used for other secrets, such as webhook signing secrets.)

## Add a Key Manager

> **Authentication:** The examples below use a `$TOKEN` variable. Obtain a Bearer token first:
> ```bash
> TOKEN=$(curl -sk -X POST "https://localhost:9243/api/portal/v0.9/auth/login" \
>   -d "username=<admin-username>&password=<admin-password>" | jq -r .token)
> ```

Use the `KeyManager` manifest format:

```yaml
# keymanager.yaml
apiVersion: api-portal.api-platform.wso2.com/v1
kind: KeyManager

metadata:
  name: asgardeo-prod

spec:
  displayName: Asgardeo
  enabled: true
  tokenEndpoint: https://api.asgardeo.io/t/myorg/oauth2/token
```

```bash
curl -k -X POST https://localhost:9543/api-portal/api/v0.9/key-managers \
  -H "Authorization: Bearer $TOKEN" \
  -F "keymanager=@keymanager.yaml"
```

| Field | Required | Description |
|---|---|---|
| `metadata.name` | Yes | Unique handle for the key manager (used internally, e.g. in route segments) |
| `spec.displayName` | Yes | Display name shown to developers |
| `spec.tokenEndpoint` | Yes | OAuth2 token endpoint. The portal proxies `client_credentials` token requests here using the client ID/secret the developer supplies |
| `spec.enabled` | No | Whether the key manager is active. Defaults to `true` |

Every key manager is treated as a generic OAuth2 `client_credentials` provider.

## List Key Managers

```bash
curl -k https://localhost:9543/api-portal/api/v0.9/key-managers -H "Authorization: Bearer $TOKEN"
```

## Get a Key Manager

```bash
curl -k https://localhost:9543/api-portal/api/v0.9/key-managers/{kmId} -H "Authorization: Bearer $TOKEN"
```

## Update a Key Manager

```yaml
# keymanager-update.yaml
apiVersion: api-portal.api-platform.wso2.com/v1
kind: KeyManager

metadata:
  name: Asgardeo

spec:
  tokenEndpoint: https://api.asgardeo.io/t/myorg/oauth2/token
```

```bash
curl -k -X PUT https://localhost:9543/api-portal/api/v0.9/key-managers/{kmId} \
  -H "Authorization: Bearer $TOKEN" \
  -F "keymanager=@keymanager-update.yaml"
```

## Delete a Key Manager

```bash
curl -k -X DELETE https://localhost:9543/api-portal/api/v0.9/key-managers/{kmId} \
  -H "Authorization: Bearer $TOKEN"
```

> **Warning:** Deleting a key manager that has applications linked to it will prevent those applications from generating new tokens through it. Existing tokens issued by the key manager remain valid until they expire.

## Keys for AI Agents

A ThunderID key manager can also give developers keys for the **AI agents** they build. It is the same key manager that
registers applications: set its **Agent registration endpoint** (Settings → Key Managers → edit, shown for the ThunderID
type) to ThunderID's agent API. The token endpoint and the portal's credential are shared; only where the client is
registered differs. Through the API it is `agentRegistrationEndpoint` in the provisioning block:

```yaml
provisioning:
  type: thunderid
  registrationEndpoint: https://thunder.example.com/oauth2/dcr/register
  agentRegistrationEndpoint: https://thunder.example.com/agents
  auth: { method: client_credentials, clientId: <provisioner>, clientSecret: <secret>, scopes: [system] }
```

A key manager declared in `config.toml` sets it in an optional settings table, which takes the same settings, with the
same checks, as Settings → Key Managers:

```toml
[[api_portal.key_manager]]
id   = "thunder"
type = "thunderid"
# ... endpoints and [api_portal.key_manager.auth] as usual ...

  [api_portal.key_manager.settings]
  agent_registration_endpoint = "https://thunder.example.com/agents"
  supported_grant_types       = ["client_credentials", "authorization_code"]   # optional
```

The endpoint is refused (`400`, or a failed boot for `config.toml`) on a key manager type that can't make agent keys,
and goes through the same address checks as the other endpoints. It can't be removed while developers hold agent keys
on that key manager (`409`); delete those keys first.

Developers use it from **Keys → Agent Keys**; the same key manager still appears on the OAuth2 Keys page for
application keys. To let developers **link** agents that already exist (made in ThunderID or Agent Manager), add a
**Provision** key manager with ThunderID's token endpoint, as for importing existing applications: Link existing agent
uses it. As with an imported application, the portal records the client ID and checks nothing; it never changes a
linked agent in ThunderID.

**Generate agent key** creates a ThunderID **agent** through ThunderID's `/agents` API:

- the agent is named with the key name, as DCR names an application, and is created as DCR creates applications: in
  ThunderID's system organization unit, owned by the provisioning client. Agent names are unique in ThunderID, so a taken
  name is refused (`409`) as a taken application name is;
- its client always has the `client_credentials` grant (the agent's own identity). The developer may add grants that let
  the agent act **on behalf of users**: authorization code (with callback URLs; PKCE required) and token exchange.
  Tokens the agent gets for a user name the user as `sub` and the agent as `act.sub`;
- the developer sees the consumer key, the secret (once) and the **agent ID**. The agent's own tokens carry the agent ID as
  `sub` and `sub_type: agent`, so gateways and logs can tell its calls apart;
- **Rotate secret** sets a new secret in ThunderID (the old one stops working at once); an agent key can't be edited;
- deleting the key deletes the agent in ThunderID first. If ThunderID can't be reached, the key stays, so no working
  credential is left behind that the portal can't see;
- an agent deployed to ThunderID by a control plane can only be changed there: rotating or deleting it is refused.

This needs ThunderID 2.0 (its `main` line): the agent API changed after 1.1.0. The provisioning client needs the
`system` scope.

## How Developers Use Key Managers

1. The developer creates an OAuth application directly in the key manager's own console (outside the portal) and obtains a client ID.
2. In the portal, the developer opens their application's **Manage Keys** view, picks a key manager, and pastes the client ID. The portal stores only the client ID — never a secret.
3. To get an access token, the developer clicks **Generate access token**, enters the client secret when prompted, and the portal proxies a `client_credentials` token request to the key manager's token endpoint. The secret is never stored.
4. The **cURL** tab shows the equivalent `curl` command so the developer can request tokens directly without going through the portal.

When an application is deleted, the portal removes the stored client ID mappings. It does not contact the key manager — the OAuth application itself is owned and managed there independently.
