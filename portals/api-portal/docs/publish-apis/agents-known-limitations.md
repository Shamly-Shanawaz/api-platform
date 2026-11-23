# Agents: known limitations

Agents are new in the API Portal and the `kind: Agent` document is `v1alpha1`: its shape may still change. These are
the limits of this release. Most are outside the portal (gateway, identity server, Platform API).

## The agent document

- **One interface of each type.** An agent has at most one A2A, one REST and one EVENT interface. Several transports for
  A2A come from its Agent Card.
- **Every interface needs its definition file.** An A2A interface needs its Agent Card and a REST interface its OpenAPI,
  as every API needs its OpenAPI. Transports, auth and operations are read only from those files.
- **Nothing is fetched or guessed.** `cardUrl` is shown, never read, and only when the publisher gives it: the portal
  doesn't assume `/.well-known/agent-card.json`. Definition files are stored as uploaded. The portal relies on what the
  publisher gives it.
- **A landing page is Markdown only.** An agent's content ZIP sets its landing page with `web/api-content.md`. Unlike
  an API, an `api-content.hbs` landing page is not used: the portal doesn't run uploaded templates on agent pages.

## Calling agents through the gateway

- **Subscriptions and plan limits are not enforced at the gateway for agents yet.** The gateway's subscription data
  covers REST APIs only, so agent calls carry no subscription or billing IDs.
- **Usage-based (metered) plans count nothing for agents** until the gateway supports it. Flat-rate plans work. Token
  pricing doesn't apply. Cost is per subscription, not per agent.
- **No spend cap.** An agent caller can loop, and plan limits don't throttle at the gateway, so a usage-priced
  subscription has no ceiling.
- **Publishing agent proxies from the AI Workspace** (Platform API and AI Workspace work) is a later phase. Agents are
  added in the portal today: through `/agents`, Settings → Agents, or the samples.

## AI agent keys

- **ThunderID only.** Keys for AI agents need a ThunderID key manager (ThunderID 2.0, its `main` line) with an agent
  registration endpoint set. Other key manager types can't make agent keys.
- **Linked agents are managed where they were made.** An agent is linked on a Provision key manager, as an existing
  application is imported: its secret can't be rotated from the portal, deleting the key only unlinks it, and whether
  it acts for users isn't shown (the portal doesn't read the agent).
- **A link isn't checked.** As with an imported application, only the client ID is recorded; a wrong one shows at Get
  token. Linking an application's client as an agent (or the reverse) just labels it wrongly.
- **No unique link:** two developers can link the same existing agent, each with their own key.
- **Secrets don't expire.** Rotate them by hand (Rotate secret).
- **Agent names are unique across the whole ThunderID**, as application names are: a name another developer already
  used is refused (`409`).
- **Get token gets the agent's own token** (client credentials). Tokens on behalf of a user come from the agent's own
  token exchange or authorization code flow; the portal doesn't run those.

## Discovery

- **The ARD manifest is at the domain root** (`/.well-known/ard.json`), where ARD clients look, like `/llms.txt`. A
  reverse proxy that forwards only the portal's base path (`/api-portal/*`) never routes the root to the portal; there
  clients find the copy at `/api-portal/.well-known/ard.json` only through the pages' `rel="ard"` link, `llms.txt` or
  `robots.txt`.
- **The ARD identifier's domain** (`urn:air:<domain>:<org>:agent:<handle>`) is the host of `[api_portal.server]
  base_url`. While that is a localhost address it is the request's host (logged once), so identifiers change with
  the host name a client uses.
- **ARD v0.91 is a proposal.** Identifier syntax and the well-known path are still under discussion (ARD #117, AI
  Catalog #138); identifiers may change with a later ARD version.
- **Agents without a card** are listed in the ARD manifest with their Markdown view, a choice of this portal: ARD has no
  entry type for REST, events or run-it-yourself agents.

## Not part of agents, found on the way

- On ThunderID 1.1.0 the DCR read, update and delete endpoints are missing, which affects ordinary OAuth2 keys on a
  ThunderID key manager (reading or editing a key fails; deleting one leaves the client in ThunderID). Agent keys don't
  use DCR. Reported separately.
