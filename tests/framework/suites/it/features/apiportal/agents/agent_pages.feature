# --------------------------------------------------------------------
# Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
# --------------------------------------------------------------------

@APIPORTAL @apiportal-agent-pages
Feature: Agents are shown in the API Portal catalogue and offered to AI clients
  As a developer, or an AI client acting for one
  I want to find agents, read how to use each one and fetch what describes it
  So that I can call an agent the way its publisher offers it, and publisher content stays inert

  # Scenarios APIPORTAL (scenarios/on-prem/APIPORTAL.yaml) at the API level. Agents are created
  # from resources/templates/api-portal-agent.yaml through /agents; their pages are public
  # catalogue content under /api-portal/default/views/<view>, fetched without a session. The
  # "card" fixture is a 1.0 Agent Card whose URL is https://agents.example.invalid/invoice and
  # whose skill is "Extract invoice fields". HTML attribute checks use "." for the quotes.

  @APIP-058 @type:smoke
  Scenario: The agent listing shows each agent with its ways of use, and filters and searches them
    Given I generate a unique resource name from "portal-page-rest" and store it as "restId"
    And I generate a unique resource name from "portal-page-local" and store it as "localId"
    And I generate a unique resource name from "portal-page-event" and store it as "eventId"
    And I generate a unique resource name from "portal-page-multi" and store it as "multiId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name                   | ${CTX:restId}       |
      | displayName            | Agent ${CTX:restId} |
      | types                  | ["API"]             |
      | spec.subscriptionPlans | ["Gold"]            |
      | spec.skills            | [{"id":"draft","name":"Draft a reply","description":"Writes a reply"}] |
      | spec.interfaces        | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "eventDefinition=asyncapi" with values:
      | name            | ${CTX:eventId}       |
      | displayName     | Agent ${CTX:eventId} |
      | types           | ["EVENT"]            |
      | spec.interfaces | [{"type":"EVENT"}]   |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card, restDefinition=openapi, eventDefinition=asyncapi, localDefinition=run locally" with values:
      | name                   | ${CTX:multiId}          |
      | displayName            | Agent ${CTX:multiId}    |
      | types                  | ["API","EVENT","LOCAL"] |
      | spec.subscriptionPlans | ["Gold"]                |
      | spec.interfaces        | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:localId}       |
      | displayName | Agent ${CTX:localId} |
      | types       | ["LOCAL"]            |
    And the response status code should be 201

    # Cards with their kind chips, the search box and the way-of-use menu, newest first
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents?query=${CTX:localId}"
    Then the response status code should be 200
    And the response body should contain "agentCard-${CTX:localId}"
    And the response body should contain "agent-kind-chip--LOCAL"
    And the response body should contain "agent-card-kinds"
    And the response body should match pattern "id=.query."
    And the response body should match pattern "id=.agent-type-filter."
    And the response body should match pattern "name=.type. value=.LOCAL."
    And the response body should match pattern "data-href=./api-portal/default/views/default/agent/${CTX:localId}."
    And the response body should contain "paginate.js"
    And the response body should not contain "dp-badge--protocol"
    And the response body should not contain "No plans needed"
    And the response body should not contain "onchange="
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents"
    Then the response body should match pattern "(?s)agentCard-${CTX:localId}.*agentCard-${CTX:restId}"

    # The way-of-use filter: one way, then several (only an agent offering all of them)
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents?type=LOCAL"
    Then the response body should contain "agentCard-${CTX:localId}"
    And the response body should contain "agentCard-${CTX:multiId}"
    And the response body should not contain "agentCard-${CTX:restId}"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents?type=EVENT"
    Then the response body should contain "agentCard-${CTX:eventId}"
    And the response body should not contain "agentCard-${CTX:localId}"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents?type=EVENT&type=LOCAL"
    Then the response body should contain "agentCard-${CTX:multiId}"
    And the response body should not contain "agentCard-${CTX:eventId}"
    And the response body should not contain "agentCard-${CTX:localId}"
    And the response body should match pattern "value=.EVENT. checked"

    # A protocol link narrows the list, and search finds protocol labels and skill names
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents?protocol=OPENAI_RESPONSES"
    Then the response body should contain "agentCard-${CTX:restId}"
    And the response body should not contain "agentCard-${CTX:localId}"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents?query=OpenAI%20Responses"
    Then the response body should contain "agentCard-${CTX:restId}"
    And the response body should not contain "agentCard-${CTX:localId}"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents?query=Draft%20a%20reply"
    Then the response body should contain "agentCard-${CTX:restId}"
    And the response body should not contain "agentCard-${CTX:localId}"

    # Agents stay out of the API and MCP pages
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:restId}"
    Then the response status code should be 200
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/apis"
    Then the response status code should be 200
    And the response body should not contain "Agent ${CTX:restId}"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/api/${CTX:restId}"
    Then the response status code should be 404
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/mcp/${CTX:restId}"
    Then the response status code should be 404
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/api/${CTX:restId}.md"
    Then the response status code should be 404
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:restId}-missing"
    Then the response status code should be 404

  @APIP-058
  Scenario: An agent page shows how to use the agent, one tab per way of use, with its publisher content inert
    # An A2A agent: skills, transports and capabilities from its card, its agent ID, and no guessed card URL
    Given I generate a unique resource name from "portal-page-a2a" and store it as "a2aId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card" with values:
      | name                   | ${CTX:a2aId}       |
      | displayName            | Agent ${CTX:a2aId} |
      | types                  | ["API"]            |
      | spec.subscriptionPlans | ["Gold"]           |
      | spec.agentId           | agent-id-marker    |
      | spec.interfaces        | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:a2aId}"
    Then the response status code should be 200
    And the response body should contain "Extract invoice fields"
    And the response body should contain "From the Agent Card"
    And the response body should contain "agent-protocol-badges"
    And the response body should match pattern "agent-subhead.>Transports<"
    And the response body should match pattern "agent-transport-name.>JSON-RPC</span>\s*<code"
    And the response body should match pattern "agent-transport-url.>https://agents.example.invalid/invoice<"
    And the response body should not contain ">Preferred<"
    And the response body should match pattern "agent-subhead.>Capabilities<"
    And the response body should contain "Streaming"
    And the response body should not contain "Push notifications"
    And the response body should not contain "/.well-known/agent-card.json"
    And the response body should not contain "Sandbox Agent Card"
    And the response body should contain "agent-id-marker"
    And the response body should not match pattern "role=.tablist."
    And the response body should match pattern "href=.[^ ]*/agent/${CTX:a2aId}/docs/specification. data-agent-docs-link"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:a2aId}/docs/specification"
    Then the response status code should be 302
    And the response header "Location" should match pattern "/agent/${CTX:a2aId}/docs/specification/agent-card$"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:a2aId}/docs/specification/agent-card"
    Then the response status code should be 200
    And the response body should contain "SPECIFICATION"
    And the response body should contain "A2A · Agent Card"
    And the response body should contain "agent-spec-card"
    And the response body should contain "Extract invoice fields"
    And the response body should contain "/agent/${CTX:a2aId}/agent-card.json"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:a2aId}/docs/specification/openapi"
    Then the response status code should be 404

    # The live card URL is shown only when the document gives cardUrl
    Given I generate a unique resource name from "portal-page-cardurl" and store it as "cardUrlId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card" with values:
      | name            | ${CTX:cardUrlId}       |
      | displayName     | Agent ${CTX:cardUrlId} |
      | types           | ["API"]                |
      | spec.interfaces | [{"type":"A2A","cardUrl":"https://gw.example.invalid/agents/triage/card.json","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:cardUrlId}"
    Then the response body should contain "https://gw.example.invalid/agents/triage/card.json"
    And the response body should not contain "/.well-known/agent-card.json"

    # A card whose URLs are not under the endpoint is accepted, and the page shows the endpoint
    Given I generate a unique resource name from "portal-page-cardwarn" and store it as "cardWarnId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "a2aDefinition=card" with values:
      | name            | ${CTX:cardWarnId}       |
      | displayName     | Agent ${CTX:cardWarnId} |
      | types           | ["API"]                 |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://gateway.example.invalid/invoice"}}] |
    Then the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:cardWarnId}"
    Then the response body should match pattern "agent-transport-url.>https://gateway.example.invalid/invoice<"
    And the response body should not match pattern "agent-transport-url.>https://agents.example.invalid/invoice<"

    # A REST agent: its protocol label is a badge in How to use, its description is inert
    Given I generate a unique resource name from "portal-page-rest" and store it as "restId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name             | ${CTX:restId}                                     |
      | displayName      | Agent ${CTX:restId}                               |
      | types            | ["API"]                                           |
      | spec.description | Writes replies <script>alert(1)</script>          |
      | spec.interfaces  | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:restId}"
    Then the response body should contain "agent-protocol-badges"
    And the response body should contain "OpenAI Responses"
    And the response body should contain "dp-badge--protocol"
    And the response body should contain "Writes replies &lt;script&gt;"
    And the response body should not contain "<script>alert(1)"

    # A 0.3 card's API key auth is shown in words, with no invented credential
    Given I generate a unique resource name from "portal-page-a2a03" and store it as "a2a03Id"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card 0.3" with values:
      | name            | ${CTX:a2a03Id}       |
      | displayName     | Agent ${CTX:a2a03Id} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:a2a03Id}"
    Then the response body should contain "API key"
    And the response body should contain "Sent in"
    And the response body should contain "X-API-Key: &lt;your-key&gt;"
    And the response body should not contain "Key in header"
    And the response body should not contain "Authorization: Bearer"

    # A multi-way agent: one tab per interface in order, then Run it yourself
    Given I generate a unique resource name from "portal-page-multi" and store it as "multiId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card, restDefinition=openapi, eventDefinition=asyncapi, localDefinition=run locally" with values:
      | name            | ${CTX:multiId}          |
      | displayName     | Agent ${CTX:multiId}    |
      | types           | ["API","EVENT","LOCAL"] |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:multiId}"
    Then the response body should match pattern "role=.tablist."
    And the response body should match pattern "(?s)id=.agent-use-A2A-tab..*id=.agent-use-REST-tab..*id=.agent-use-EVENT-tab..*id=.agent-run-tab."
    And the response body should match pattern "href=.#agent-run."

    # An event agent is summarised from its AsyncAPI, with payloads in the AsyncAPI viewer
    Given I generate a unique resource name from "portal-page-event" and store it as "eventId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "eventDefinition=asyncapi" with values:
      | name            | ${CTX:eventId}       |
      | displayName     | Agent ${CTX:eventId} |
      | types           | ["EVENT"]            |
      | spec.interfaces | [{"type":"EVENT"}]   |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:eventId}"
    Then the response body should contain "invoices.received"
    And the response body should match pattern "aov-channel-badge--pub[^>]*>SEND<"
    And the response body should match pattern "class=.aov-channel-row[^\x22]*.>\s*<span class=.aov-resource-path.>invoices\.audit<"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:eventId}/docs/specification/asyncapi"
    Then the response status code should be 200
    And the response body should contain "AsyncApiStandalone"
    And the response body should contain "invoices.received"

    # Run it yourself: the Markdown is rendered with its HTML cleaned, and listed in Documentation
    Given I generate a unique resource name from "portal-page-local" and store it as "localId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "localDefinition=run locally with script" with values:
      | name        | ${CTX:localId}       |
      | displayName | Agent ${CTX:localId} |
      | types       | ["LOCAL"]            |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:localId}"
    Then the response body should contain "npx @acme/tool run"
    And the response body should match pattern "id=.agent-run."
    And the response body should not contain "aov-body-sidebar"
    And the response body should not contain "<script>alert"
    And the response body should not contain "javascript:alert"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:localId}/docs/specification/run-it-yourself"
    Then the response status code should be 200
    And the response body should contain "Run it yourself · Setup guide"
    And the response body should contain "run-locally.md"
    And the response body should contain "api-markdown-content"
    And the response body should match pattern "assets\?type(=|&#x3D;)AGENT_LOCAL_DEFINITION"
    And the response body should not contain "<script>alert"

  @APIP-058
  Scenario: An agent's landing page, icon, documents and views follow what its publisher uploads
    # An uploaded landing page replaces the generated overview, inert, and Documentation stays
    Given I generate a unique resource name from "portal-page-landing" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}"
    Then the response body should contain "How to use this agent"
    When I PUT API Portal content "agent-landing" for agent "${CTX:agentId}" as "publisher"
    Then the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}"
    Then the response body should contain "Our own landing page"
    And the response body should contain "api-md-content"
    And the response body should not contain "How to use this agent"
    And the response body should not contain "<script>alert"
    And the response body should match pattern "href=.[^ ]+/docs/specification. data-agent-docs-link"

    # The icon is served publicly, as an image only
    Given I generate a unique resource name from "portal-page-icon" and store it as "iconId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:iconId}       |
      | displayName | Agent ${CTX:iconId} |
      | types       | ["LOCAL"]           |
    And the response status code should be 201
    When I POST API Portal content "image-metadata" for agent "${CTX:iconId}" as "publisher"
    Then the response status code should be 201
    When I send an unauthenticated API Portal "GET" request to "/agents/${CTX:iconId}/assets?type=IMAGE&fileName=api-icon.png"
    Then the response status code should be 200
    When I send an unauthenticated API Portal "GET" request to "/agents/${CTX:iconId}/assets?type=DOC_OTHER&fileName=x.md"
    Then the response status code should be 401

    # A document from the agent ZIP opens in the docs layout, inert, and as Markdown with .md
    Given I generate a unique resource name from "portal-page-docs" and store it as "docsId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in ZIP form with files "localDefinition=run locally" with values:
      | name        | ${CTX:docsId}       |
      | displayName | Agent ${CTX:docsId} |
      | types       | ["LOCAL"]           |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:docsId}.md"
    Then the response status code should be 200
    And the response body should match pattern "\(\S*/agent/${CTX:docsId}/docs/[^)]*overview\.md\)"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:docsId}/docs/specification"
    Then the response status code should be 302
    And the response header "Location" should match pattern "/agent/${CTX:docsId}/docs/specification/run-it-yourself$"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:docsId}/docs/specification/run-it-yourself"
    Then the response status code should be 200
    And the response body should match pattern "href=.[^\x22]*/agent/${CTX:docsId}/docs/[^\x22]*overview[^\x22.]*."
    And the response body should contain "adoc-nav"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:docsId}/docs/AGENT_LOCAL_DEFINITION/run-locally.md"
    Then the response status code should be 404

    # An agent is shown only in the views its labels put it in
    Given I generate a unique resource name from "portal-agent-label" and store it as "labelId"
    And I generate a unique resource name from "portal-agent-view" and store it as "viewId"
    And I generate a unique resource name from "portal-page-labelled" and store it as "labelledId"
    And a unique API Portal resource is created at "/labels" as "admin" with values and stored as "labelId":
      | id          | ${CTX:labelId}    |
      | displayName | Agent Label       |
    And a unique API Portal resource is created at "/views" as "admin" with values and stored as "viewId":
      | id          | ${CTX:viewId}      |
      | displayName | Agent View         |
      | labels      | ["${CTX:labelId}"] |
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card" with values:
      | name            | ${CTX:labelledId}       |
      | displayName     | Agent ${CTX:labelledId} |
      | types           | ["API"]                 |
      | spec.labels     | ["${CTX:labelId}"]      |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/${CTX:viewId}/agent/${CTX:labelledId}"
    Then the response status code should be 200
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/${CTX:viewId}/agent/${CTX:labelledId}/agent-card.json"
    Then the response status code should be 200
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:labelledId}"
    Then the response status code should be 404
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:labelledId}.md"
    Then the response status code should be 404
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:labelledId}/agent-card.json"
    Then the response status code should be 404
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents.md"
    Then the response status code should be 200
    And the response body should not contain "/agent/${CTX:labelledId}.md"

  @APIP-059
  Scenario: AI clients read agents as Markdown, in llms.txt, as stored cards and in the ARD manifest, but never hidden ones
    Given I generate a unique resource name from "portal-ai-a2a" and store it as "a2aId"
    And I generate a unique resource name from "portal-ai-rest" and store it as "restId"
    And I generate a unique resource name from "portal-ai-multi" and store it as "multiId"
    And I generate a unique resource name from "portal-ai-hidden" and store it as "hiddenId"
    And I generate a unique resource name from "portal-ai-hidden-a2a" and store it as "hiddenA2aId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card" with values:
      | name            | ${CTX:a2aId}       |
      | displayName     | Agent ${CTX:a2aId} |
      | types           | ["API"]            |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:restId}       |
      | displayName     | Agent ${CTX:restId} |
      | types           | ["API"]             |
      | spec.interfaces | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card, restDefinition=openapi, eventDefinition=asyncapi, localDefinition=run locally" with values:
      | name            | ${CTX:multiId}          |
      | displayName     | Agent ${CTX:multiId}    |
      | types           | ["API","EVENT","LOCAL"] |
      | spec.subscriptionPlans | ["Gold"]        |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name                 | ${CTX:hiddenId}       |
      | displayName          | Agent ${CTX:hiddenId} |
      | types                | ["API"]               |
      | spec.agentVisibility | HIDDEN                |
      | spec.interfaces      | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card" with values:
      | name                 | ${CTX:hiddenA2aId}       |
      | displayName          | Agent ${CTX:hiddenA2aId} |
      | types                | ["API"]                  |
      | spec.agentVisibility | HIDDEN                   |
      | spec.interfaces      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201

    # The section and each agent as Markdown, with every way of use; hidden agents are left out
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents.md"
    Then the response status code should be 200
    And the response header "Content-Type" should contain "text/markdown"
    And the response body should contain "/agent/${CTX:a2aId}.md"
    And the response body should not contain "/agent/${CTX:hiddenId}.md"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:multiId}.md"
    Then the response status code should be 200
    And the response header "X-Content-Type-Options" should be "nosniff"
    And the response body should contain "## A2A"
    And the response body should contain "## REST"
    And the response body should contain "## Events"
    And the response body should contain "## Run it yourself"
    And the response body should contain "## Credentials"
    And the response body should contain "invoices.received"
    And the response body should contain "npx @acme/tool run"
    And the response body should contain "- Agent Card: "
    And the response body should contain "/agent/${CTX:multiId}/agent-card.json"
    And the response body should contain "OpenAPI definition:"
    And the response body should contain "AsyncAPI definition:"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:a2aId}.md"
    Then the response body should contain "  - JSON-RPC (preferred): https://agents.example.invalid/invoice"
    And the response body should contain "- Capabilities: Streaming"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:hiddenId}.md"
    Then the response status code should be 404

    # llms.txt lists the visible agents
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/llms.txt"
    Then the response status code should be 200
    And the response body should contain "## Agents"
    And the response body should contain "/agent/${CTX:restId}.md"
    And the response body should not contain "/agent/${CTX:hiddenId}.md"

    # The stored card is served byte for byte, and none for an agent without A2A or a hidden one
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:a2aId}/agent-card.json"
    Then the response status code should be 200
    And the response header "X-Content-Type-Options" should be "nosniff"
    And the response body should equal the API Portal agent file "card"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:restId}/agent-card.json"
    Then the response status code should be 404
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:hiddenA2aId}/agent-card.json"
    Then the response status code should be 404

    # One ARD manifest of the visible agents, at the domain root and under the base path
    When I send an unauthenticated API Portal "GET" request to the root path "/.well-known/ard.json"
    Then the response status code should be 200
    And the response header "Access-Control-Allow-Origin" should be "*"
    And the response body should match pattern "urn:air:[a-z0-9.-]+:[^:\x22]+:agent:${CTX:a2aId}\x22"
    And the response body should match pattern "/api-portal/default/views/default/agent/${CTX:a2aId}/agent-card.json"
    And the response body should match pattern "/api-portal/default/views/default/agent/${CTX:restId}.md"
    And the response body should contain "application/a2a-agent-card+json"
    And the response body should contain "Pull the total from this invoice"
    And the response body should not contain ":agent:${CTX:hiddenId}"
    And the response body should not contain ":agent:${CTX:hiddenA2aId}"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/.well-known/ard.json"
    Then the response status code should be 200
    And the response body should contain ":agent:${CTX:a2aId}"
    And the response body should not contain ":agent:${CTX:hiddenId}"
    When I send an unauthenticated API Portal "GET" request to "/api-portal/.well-known/ard.json" with header "X-Forwarded-Proto" set to "https"
    Then the response status code should be 200
    And the response body should not match pattern "\x22url\x22:\x22http://"
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agents"
    Then the response header "Link" should contain "</api-portal/.well-known/ard.json>; rel="
    And the response body should match pattern "rel=.ard. href=./api-portal/.well-known/ard.json."
    When I send an unauthenticated API Portal "GET" request to the root path "/llms.txt"
    Then the response body should contain "/api-portal/.well-known/ard.json"
    When I send an unauthenticated API Portal "GET" request to the root path "/robots.txt"
    Then the response body should contain "/api-portal/.well-known/ard.json"

    # Try with AI is offered on a visible agent only
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:restId}"
    Then the response body should contain "apiAgentPromptModal"
    And the response body should match pattern "data-bs-target=.#apiAgentPromptModal."
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:hiddenId}"
    Then the response status code should be 200
    And the response body should not match pattern "data-bs-target=.#apiAgentPromptModal."
