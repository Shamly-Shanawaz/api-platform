# Publishing agents

The API Portal lists **agents** next to APIs and MCP servers. An agent is published as a `kind: Agent` document
(`apiVersion: api-portal.api-platform.wso2.com/v1alpha1`). "alpha" means the shape may still change.

An agent is a listing plus one or more ways to use it:

| Type (`spec.types`) | Means | Needs |
|---|---|---|
| `API` | Developers call it over the network | an A2A or REST interface |
| `EVENT` | It sends and receives events on a broker | an EVENT interface with an AsyncAPI document |
| `LOCAL` | Developers run it themselves | a Markdown file, uploaded as `localDefinition` |

An agent can have more than one type, for example a hosted endpoint **and** a Docker image (`types: [API, LOCAL]`).
Each type needs its part, and each part needs its type.

## Turning agents on

Agents are opt-in. Add `agents` to the artifact types in `config.toml`:

```toml
[api_portal.artifacts]
enabled_types = ["apis", "mcp-servers", "api-workflows", "agents"]
```

While `agents` is not enabled, every `/agents` operation answers `404`.

Each definition file may be at most `[api_portal.uploads] max_agent_definition_bytes` (default 1 MiB). A larger one is
refused with `413`.

## The agent document

```yaml
apiVersion: api-portal.api-platform.wso2.com/v1alpha1
kind: Agent
metadata:
  name: invoice-triage-agent            # handle: unique, used in URLs
  annotations:                          # optional: free key/values, stored and ignored
    acme.com/cost-centre: AP-114
spec:
  types: [API]
  displayName: Invoice Triage Agent     # name, version and description default from the Agent Card
  version: v1.2.0
  description: Reads supplier invoices and flags problems.
  provider: { organization: Acme Finance, url: https://acme-finance.com }
  referenceId: proxy-7f3a               # optional: the publishing system's own ID, as for APIs
  agentId: 2f9c4e1a-7b3d-4c8e-9a61-5d2b0e8f4c17   # optional: the agent's ID in its identity provider; shown only
  status: PUBLISHED                     # or DEPRECATED
  agentVisibility: VISIBLE              # HIDDEN keeps it out of the views AI tools read
  labels: [default]
  tags: [finance]
  businessInformation: { businessOwner: AP team, businessOwnerEmail: ap@acme-finance.com }
  models:                               # display only; each needs a provider or a name
    - { provider: Anthropic, name: claude-sonnet-4-5 }
  subscriptionPlans: [Bronze, Gold]     # only when types has API
  interfaces:                           # at most one per type: A2A, REST, EVENT
    - type: A2A                         # its Agent Card is uploaded as a2aDefinition
      cardUrl: https://gw.acme-finance.com/invoice-triage/.well-known/agent-card.json   # optional
      endpoints:
        productionUrl: https://gw.acme-finance.com/invoice-triage
        sandboxUrl: https://sandbox-gw.acme-finance.com/invoice-triage
```

Rules that apply everywhere:

- Unknown fields are rejected. Use `metadata.annotations` for anything extra.
- Every problem is reported at once, in the `errors` list of the `400` response.
- An empty list, an empty object or an empty string counts as absent.
- Errors name the field and say what to do, never the field's value.
- URLs are `http` or `https`, at most 255 characters, with no user name or password in them.

### Interfaces: how to call it

An agent has at most one interface of each type (`A2A`, `REST`, `EVENT`); the type names it. Definition files are
not named in the YAML: they are uploaded beside it, one field per kind (see [Uploading](#uploading)).

| Field | A2A | REST | EVENT |
|---|---|---|---|
| `endpoints.productionUrl` | required | required | — |
| Definition file | `a2aDefinition`, required: an Agent Card (JSON) | `restDefinition`, required: an OpenAPI document | `eventDefinition`, required: an AsyncAPI 2 or 3 document |
| `cardUrl` | optional: where A2A clients read the live card, e.g. at your gateway (shown, never fetched; the portal never guesses one) | — | — |
| `protocol` | — | optional label, any value | — |

Every interface needs its definition file, as every API needs its OpenAPI. The YAML gives an interface only its URLs:
transports, capabilities and auth come from the Agent Card, operations and auth from the OpenAPI, channels from the
AsyncAPI. Put the card's URLs at your gateway before uploading it; the portal shows them and never rewrites them.

### Skills

```yaml
  skills:
    - id: draft-reply
      name: Draft a reply
      description: Writes a reply to the latest customer message.
      tags: [writing]
      examples: ["Draft a reply to ticket #4821."]
```

An agent with an A2A interface takes its skills from its Agent Card, so `spec.skills` is rejected beside it. The card
also supplies the listing defaults (name, version, description). Agents without A2A (REST, events, run it yourself) may
list their skills in the YAML; they are optional. The portal gives each skill `id` a stable ID of its own, kept across
updates (`skillIds` in the response).

### Running it yourself

A `LOCAL` agent comes with a Markdown file that says how to run it, uploaded as `localDefinition` (`run-locally.md` in
a ZIP). The YAML has no block for it: `LOCAL` in `spec.types` is enough.

The portal shows the file as written (the HTML in it is cleaned, as for every document). It reads nothing out of it, so
write it for people. These headings work well: Requirements, Install, Configure, Run, Environment variables. Mark
secret environment variables as secret and don't put real values in the file.

### Credentials

Credentials work as for APIs and MCP servers. With `subscriptionPlans`, developers subscribe to a plan and get keys.
Plans are allowed only when `spec.types` includes `API`. Without plans, the portal offers no subscriptions or keys; say
in the description or a document where credentials come from, if any are needed.

### Icon

The icon is uploaded with the agent's content, as for APIs and MCP servers: an image named `api-icon` in the ZIP's `web/` folder, or
the `/agents/{agentId}/assets` upload with `imageMetadata` `{"api-icon": "<file name>"}`.

## Uploading

`POST /api-portal/api/v0.9/agents` (scope `dp:agent:create` or `dp:agent:manage`) accepts one of:

- a `metadata` field holding the document as JSON;
- a `metadata` file (`agent.yaml`);
- an `artifact` ZIP with `agent.yaml` and the definition files at its root under fixed names, plus optional `docs/` and
  `web/` folders, as for APIs. Any other top-level file or folder is rejected.

| Kind | Multipart field | Name in a ZIP | Needed |
|---|---|---|---|
| Agent Card | `a2aDefinition` | `agent-card.json` | required with an A2A interface |
| OpenAPI | `restDefinition` | `openapi.yaml`, `openapi.yml` or `openapi.json` | required with a REST interface |
| AsyncAPI | `eventDefinition` | `asyncapi.yaml`, `asyncapi.yml` or `asyncapi.json` | required with an EVENT interface |
| Run it yourself | `localDefinition` | `run-locally.md` | required when `spec.types` has `LOCAL` |

```bash
curl -X POST "https://portal.example.com/api-portal/api/v0.9/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@agent.yaml" \
  -F "a2aDefinition=@agent-card.json" \
  -F "restDefinition=@openapi.yaml" \
  -F "localDefinition=@run-locally.md"
```

A file without its interface (or without `LOCAL`) is rejected.

`PUT /agents/{agentId}` takes the same formats and replaces the document; `metadata.name` must be the agent's handle.
A field that isn't sent keeps the stored file. Removing an interface (or `LOCAL`) removes its file.

Other operations:

- `GET /agents`, with filters `type` (`API`, `EVENT`, `LOCAL`, `A2A`, `REST`), `protocol`, `query`, `tags`.
- `GET /agents/{agentId}`. Its `document` field is the agent as written: download it, edit it, send it back with `PUT`.
  Each A2A and REST interface in `interfaces` says whether a file is stored (`hasDefinition`); the document never
  carries that flag.
- `GET /agents/{agentId}/assets?type=AGENT_CARD` (or `API_DEFINITION`, `AGENT_EVENT_DEFINITION`,
  `AGENT_LOCAL_DEFINITION`): the stored file, exactly as uploaded.
- `DELETE /agents/{agentId}` (refused while the agent has subscriptions or active keys), and `/agents/{agentId}/assets`
  for documents and images.

`spec.referenceId` is stored as the reference ID that subscription and key events carry (`api.ref_id`), as for APIs. An
agent added in the portal without one has none.

## Managing agents in Settings

Admins manage agents under **Settings → Agents** (shown when `agents` is enabled):

- **Add Agent** and **Edit** open the same three-step form:
  - **Interfaces:** A2A, REST, Events and Run it yourself, at most one of each, each with its URLs and its definition
    file. An Agent Card fills the name, version and description in the next step (marked "From the Agent Card"; change
    them to use your own).
  - **Details:** General (always open), then optional sections that start folded: Model and identity (the models and
    agent ID shown in the agent page's About box), Skills (only without A2A), Labels and tags, Ownership and
    Subscription plans (with A2A or REST).
  - **Assets:** documents, or a content ZIP instead (a `web/api-content.md` landing page, Markdown only, and `docs/`), uploaded when you save.

  Fields the form doesn't show, such as `provider`, annotations or `referenceId`, are kept from the stored document when
  you edit. To set them, use the REST API.
- Each row's menu has Edit, Publish or Deprecate, and Delete.

As for APIs and MCP servers, Settings has no import from file: send `agent.yaml` with its files, or one ZIP, to
`POST /agents` or `PUT /agents/{agentId}` (above).

Every problem the portal finds is listed in the form, naming the field.

## What AI clients see

When the view's AI features are on, each published agent with `agentVisibility: VISIBLE` is also offered to AI
tools. `HIDDEN` agents appear on the portal's pages but in none of these:

- **Markdown views:** `/{org}/views/{view}/agent/{handle}.md` (one section per way of use, with example calls), and
  `/{org}/views/{view}/agents.md` (the list). The agent page's **Try with AI** button points an assistant at the
  agent's view.
- **`llms.txt`:** an Agents group linking each agent's Markdown view.
- **The agent's card:** `/{org}/views/{view}/agent/{handle}/agent-card.json`. This is the uploaded Agent Card, exactly
  as uploaded. Agents without A2A have no card.
- **ARD manifest:** `/.well-known/ard.json` at the domain root ([ARD](https://github.com/ards-project/ard-spec)), one
  manifest for the whole portal with one entry per agent. Views don't split it: each entry links through the default
  view, or another view that has the agent. An agent with a card points at it; any other agent points at its Markdown
  view. The same manifest is served at `/api-portal/.well-known/ard.json`, and every portal page links it with
  `rel="ard"` (a `Link` header and a `<link>` in the default layout), so ARD clients find it on a host whose root
  doesn't reach the portal. `llms.txt` and `robots.txt` name it too. Each entry's `identifier` is
  `urn:air:<domain>:<org>:agent:<handle>`, where the domain is the host of `[api_portal.server] base_url`; set that
  to the portal's public URL so identifiers don't change with the host name a request uses.

## Samples

`samples/agents/` has one sample per shape: `a2a` (with a card), `a2a-local` (hosted A2A and run-it-yourself),
`rest-openapi` (REST with its OpenAPI, deprecated), `event` (AsyncAPI), `multi` (A2A, REST, EVENT and LOCAL together)
and `other` (run-it-yourself only). `scripts/seed-samples.sh` uploads them.

See also [Agents: known limitations](agents-known-limitations.md).
