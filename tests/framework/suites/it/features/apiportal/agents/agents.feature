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

@APIPORTAL @apiportal-agents
Feature: Agents are managed through the API Portal's /agents API
  As an API publisher
  I want to add agents (kind: Agent) with their definition files, in any intake form
  So that developers find each agent and how to use it, and nothing else is mistaken for one

  # Scenarios APIPORTAL (scenarios/on-prem/APIPORTAL.yaml) at the API level. Agents are rendered
  # from resources/templates/api-portal-agent.yaml and sent to /agents as JSON metadata, an
  # agent.yaml file or a ZIP. Definition files are named "field=fixture": a2aDefinition (an Agent
  # Card), restDefinition (an OpenAPI), eventDefinition (an AsyncAPI) and localDefinition (the
  # run-it-yourself Markdown). A ZIP carries them at its root under fixed names, with
  # docs/overview.md. spec.types says how an agent is used and spec.interfaces how to call it.
  # Agents are enabled by the block's overlay (api-portal-agents.toml).

  @APIP-056 @type:smoke
  Scenario Outline: A publisher adds a <shape> agent from <form>, and it reads back with its ways of use
    Given I generate a unique resource name from "portal-agent" and store it as "agentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in <form> form with files "<files>" with values:
      | name                   | ${CTX:agentId}       |
      | displayName            | Agent ${CTX:agentId} |
      | types                  | <types>              |
      | spec.subscriptionPlans | <plans>              |
      | spec.skills            | <skills>             |
      | spec.interfaces        | <interfaces>         |
    Then the response status code should be 201
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 200
    And the JSON response field "id" should be "${CTX:agentId}"
    And the JSON response field "types" should be "<typesText>"
    And the JSON response field "interfaceTypes" should be "<interfaceTypes>"
    And the JSON response field "document.metadata.name" should be "${CTX:agentId}"
    And the JSON response field "document.spec.interfaces[0].hasDefinition" should not exist

    Examples:
      | shape    | form | types                       | typesText          | plans    | skills                                                                    | interfaces                                                                                                                                                                                           | files                                                                                        | interfaceTypes  |
      | A2A      | JSON | ["API"]                     | [API]              | ["Gold"] | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}]                                                                                                               | a2aDefinition=card                                                                           | [A2A]           |
      | A2A      | YAML | ["API"]                     | [API]              | ["Gold"] | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}]                                                                                                               | a2aDefinition=card                                                                           | [A2A]           |
      | A2A      | ZIP  | ["API"]                     | [API]              | ["Gold"] | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}]                                                                                                               | a2aDefinition=card                                                                           | [A2A]           |
      | A2A 0.3  | JSON | ["API"]                     | [API]              | null     | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}]                                                                                                               | a2aDefinition=card 0.3                                                                       | [A2A]           |
      | A2A 0.3  | YAML | ["API"]                     | [API]              | null     | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}]                                                                                                               | a2aDefinition=card 0.3                                                                       | [A2A]           |
      | A2A 0.3  | ZIP  | ["API"]                     | [API]              | null     | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}]                                                                                                               | a2aDefinition=card 0.3                                                                       | [A2A]           |
      | REST     | JSON | ["API"]                     | [API]              | ["Gold"] | [{"id":"draft","name":"Draft a reply","description":"Writes a reply"}] | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}]                                                                                   | restDefinition=openapi responses                                                             | [REST]          |
      | REST     | YAML | ["API"]                     | [API]              | ["Gold"] | [{"id":"draft","name":"Draft a reply","description":"Writes a reply"}] | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}]                                                                                   | restDefinition=openapi responses                                                             | [REST]          |
      | REST     | ZIP  | ["API"]                     | [API]              | ["Gold"] | [{"id":"draft","name":"Draft a reply","description":"Writes a reply"}] | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}]                                                                                   | restDefinition=openapi responses                                                             | [REST]          |
      | EVENT    | JSON | ["EVENT"]                   | [EVENT]            | null     | null                                                                      | [{"type":"EVENT"}]                                                                                                                                                                                   | eventDefinition=asyncapi                                                                     | [EVENT]         |
      | EVENT    | YAML | ["EVENT"]                   | [EVENT]            | null     | null                                                                      | [{"type":"EVENT"}]                                                                                                                                                                                   | eventDefinition=asyncapi                                                                     | [EVENT]         |
      | EVENT    | ZIP  | ["EVENT"]                   | [EVENT]            | null     | null                                                                      | [{"type":"EVENT"}]                                                                                                                                                                                   | eventDefinition=asyncapi                                                                     | [EVENT]         |
      | multiple | JSON | ["API","EVENT","LOCAL"]     | [API EVENT LOCAL]  | ["Gold"] | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] | a2aDefinition=card, restDefinition=openapi, eventDefinition=asyncapi, localDefinition=run locally | [A2A REST EVENT] |
      | multiple | YAML | ["API","EVENT","LOCAL"]     | [API EVENT LOCAL]  | ["Gold"] | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] | a2aDefinition=card, restDefinition=openapi, eventDefinition=asyncapi, localDefinition=run locally | [A2A REST EVENT] |
      | multiple | ZIP  | ["API","EVENT","LOCAL"]     | [API EVENT LOCAL]  | ["Gold"] | null                                                                      | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] | a2aDefinition=card, restDefinition=openapi, eventDefinition=asyncapi, localDefinition=run locally | [A2A REST EVENT] |
      | LOCAL    | JSON | ["LOCAL"]                   | [LOCAL]            | null     | null                                                                      | null                                                                                                                                                                                                 | localDefinition=run locally                                                                  | []              |
      | LOCAL    | YAML | ["LOCAL"]                   | [LOCAL]            | null     | null                                                                      | null                                                                                                                                                                                                 | localDefinition=run locally                                                                  | []              |
      | LOCAL    | ZIP  | ["LOCAL"]                   | [LOCAL]            | null     | null                                                                      | null                                                                                                                                                                                                 | localDefinition=run locally                                                                  | []              |

  @APIP-056
  Scenario: An agent's definition files are stored byte for byte, follow every update, and go with the agent
    # Each definition is read back through /assets by type, exactly as uploaded
    Given I generate a unique resource name from "portal-agent-files" and store it as "agentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "a2aDefinition=card, restDefinition=openapi, eventDefinition=asyncapi, localDefinition=run locally" with values:
      | name                   | ${CTX:agentId}          |
      | displayName            | Agent ${CTX:agentId}    |
      | types                  | ["API","EVENT","LOCAL"] |
      | spec.subscriptionPlans | ["Gold"]                |
      | spec.interfaces        | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] |
    Then the response status code should be 201
    And the JSON response field "document.metadata.name" should be "${CTX:agentId}"
    And the JSON response field "types" should be "[API EVENT LOCAL]"
    And the JSON response field "endPoints" should not exist
    And the JSON response field "interfaces[0].hasDefinition" should be true
    And the JSON response field "interfaces[1].hasDefinition" should be true
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_CARD" as "publisher"
    Then the response status code should be 200
    And the response header "Content-Type" should contain "application/json"
    And the response header "X-Content-Type-Options" should be "nosniff"
    And the response body should equal the API Portal agent file "card"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=API_DEFINITION" as "publisher"
    Then the response status code should be 200
    And the response header "Content-Type" should contain "yaml"
    And the response body should equal the API Portal agent file "openapi"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_EVENT_DEFINITION" as "publisher"
    Then the response body should equal the API Portal agent file "asyncapi"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_LOCAL_DEFINITION" as "publisher"
    Then the response status code should be 200
    And the response header "Content-Type" should contain "text/markdown"
    And the response header "X-Content-Type-Options" should be "nosniff"
    And the response body should equal the API Portal agent file "run locally"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/interfaces/a2a/definition" as "publisher"
    Then the response status code should be 404

    # A ZIP stores the same files from its fixed names
    Given I generate a unique resource name from "portal-agent-zip" and store it as "zipAgentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in ZIP form with files "a2aDefinition=card, localDefinition=run locally" with values:
      | name            | ${CTX:zipAgentId}       |
      | displayName     | Agent ${CTX:zipAgentId} |
      | types           | ["API","LOCAL"]         |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    Then the response status code should be 201
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:zipAgentId}/assets?type=AGENT_CARD" as "publisher"
    Then the response body should equal the API Portal agent file "card"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:zipAgentId}/assets?type=AGENT_LOCAL_DEFINITION" as "publisher"
    Then the response body should equal the API Portal agent file "run locally"

    # Replacing only the OpenAPI keeps every other stored file
    When I update the API Portal agent "${CTX:agentId}" from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "restDefinition=openapi v2" with values:
      | name                   | ${CTX:agentId}          |
      | displayName            | Agent ${CTX:agentId}    |
      | spec.description       | Changed.                |
      | types                  | ["API","EVENT","LOCAL"] |
      | spec.subscriptionPlans | ["Gold"]                |
      | spec.interfaces        | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"REST","protocol":"OPENAI_CHAT","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"EVENT"}] |
    Then the response status code should be 200
    And the JSON response field "interfaces[1].hasDefinition" should be true
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=API_DEFINITION" as "publisher"
    Then the response body should equal the API Portal agent file "openapi v2"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_CARD" as "publisher"
    Then the response body should equal the API Portal agent file "card"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_EVENT_DEFINITION" as "publisher"
    Then the response body should equal the API Portal agent file "asyncapi"

    # Replacing the agent's content keeps its definition files and interfaces
    When I PUT API Portal content "guide" for agent "${CTX:agentId}" as "publisher"
    Then the response should be successful
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_LOCAL_DEFINITION" as "publisher"
    Then the response body should equal the API Portal agent file "run locally"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the JSON response field "interfaces[0].hasDefinition" should be true
    And the JSON response field "interfaces[1].hasDefinition" should be true

    # Removing the REST interface removes its file; leaving LOCAL removes the run-it-yourself file
    When I update the API Portal agent "${CTX:agentId}" from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with values:
      | name                   | ${CTX:agentId}       |
      | displayName            | Agent ${CTX:agentId} |
      | types                  | ["API","EVENT"]      |
      | spec.subscriptionPlans | ["Gold"]             |
      | spec.interfaces        | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}},{"type":"EVENT"}] |
    Then the response status code should be 200
    And the JSON response field "interfaceTypes" should be "[A2A EVENT]"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=API_DEFINITION" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_LOCAL_DEFINITION" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_CARD" as "publisher"
    Then the response body should equal the API Portal agent file "card"

    # Deleting the agent removes it and its files
    When I send an authenticated API Portal "DELETE" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response should be successful
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher" until status 404
    Then the response status code should be 404
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/assets?type=AGENT_CARD" as "publisher"
    Then the response status code should be 404

  @APIP-056
  Scenario: An agent's document round-trips unchanged, and the card fills in what the document leaves out
    # GET and PUT the document back: the document, interfaces and skill ids are unchanged
    Given I generate a unique resource name from "portal-agent-trip" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name                   | ${CTX:agentId}                                                        |
      | displayName            | Agent ${CTX:agentId}                                                  |
      | types                  | ["API"]                                                               |
      | spec.subscriptionPlans | ["Gold"]                                                              |
      | spec.skills            | [{"id":"draft","name":"Draft a reply","description":"Writes a reply"}] |
      | spec.models            | [{"provider":"Anthropic","name":"claude-sonnet-4-5"}]                 |
      | spec.agentId           | 2f9c4e1a-7b3d-4c8e-9a61-5d2b0e8f4c17                                  |
      | spec.interfaces        | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the JSON response field "document.apiVersion" should be "api-portal.api-platform.wso2.com/v1alpha1"
    And the JSON response field "document.spec.agentId" should be "2f9c4e1a-7b3d-4c8e-9a61-5d2b0e8f4c17"
    And the JSON response field "skillIds.draft" should match pattern "^[0-9a-f-]{36}$"
    And I store the API Portal JSON response field "document" as "document"
    And I store the API Portal JSON response field "interfaces" as "interfaces"
    And I store the API Portal JSON response field "skillIds.draft" as "draftSkillId"
    When I send the API Portal agent "${CTX:agentId}" document back as "publisher"
    Then the response status code should be 200
    And the API Portal JSON response field "document" should equal stored "document"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the API Portal JSON response field "document" should equal stored "document"
    And the API Portal JSON response field "interfaces" should equal stored "interfaces"
    And the API Portal JSON response field "skillIds.draft" should equal stored "draftSkillId"

    # A new skill gets an id of its own and the old one keeps its id
    When I update the API Portal agent "${CTX:agentId}" from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with values:
      | name                   | ${CTX:agentId}       |
      | displayName            | Agent ${CTX:agentId} |
      | types                  | ["API"]              |
      | spec.subscriptionPlans | ["Gold"]             |
      | spec.skills            | [{"id":"draft","name":"Draft a reply","description":"Writes a reply"},{"id":"summarise","name":"Summarise","description":"Summarises a thread"}] |
      | spec.interfaces        | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 200
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the API Portal JSON response field "skillIds.draft" should equal stored "draftSkillId"
    And the JSON response field "skillIds.summarise" should match pattern "^[0-9a-f-]{36}$"

    # A PUT whose metadata.name names another agent is refused
    When I update the API Portal agent "${CTX:agentId}" from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with values:
      | name        | ${CTX:agentId}-other |
      | displayName | Agent ${CTX:agentId} |
      | types       | ["LOCAL"]            |
    Then the response status code should be 400
    And the response body should contain "Field 'metadata.name' must match the agent being updated."

    # displayName, version and description come from the card when the document leaves them out
    Given I generate a unique resource name from "portal-agent-card" and store it as "cardAgentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "a2aDefinition=card" with values:
      | name             | ${CTX:cardAgentId} |
      | displayName      | null               |
      | spec.version     | null               |
      | spec.description | null               |
      | types            | ["API"]            |
      | spec.interfaces  | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    Then the response status code should be 201
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:cardAgentId}" as "publisher"
    Then the JSON response field "displayName" should be "Invoice Triage Agent"
    And the JSON response field "version" should be "1.2.0"
    And the JSON response field "provider.organization" should be "Acme Finance"
    And the JSON response field "document.spec.displayName" should not exist
    And the JSON response field "document.spec.provider" should not exist

    # The reference id is set only from spec.referenceId, and an unrecognised protocol label is accepted
    Given I generate a unique resource name from "portal-agent-ref" and store it as "refAgentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name               | ${CTX:refAgentId}       |
      | displayName        | Agent ${CTX:refAgentId} |
      | types              | ["LOCAL"]               |
      | spec.referenceId   | proxy-${CTX:refAgentId} |
    Then the response status code should be 201
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:refAgentId}" as "publisher"
    Then the JSON response field "referenceId" should be "proxy-${CTX:refAgentId}"
    And the JSON response field "document.spec.referenceId" should be "proxy-${CTX:refAgentId}"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the JSON response field "referenceId" should not exist
    Given I generate a unique resource name from "portal-agent-proto" and store it as "protoAgentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:protoAgentId}       |
      | displayName     | Agent ${CTX:protoAgentId} |
      | types           | ["API"]                   |
      | spec.interfaces | [{"type":"REST","protocol":"MY_HOMEGROWN_PROTOCOL","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 201

  @APIP-056
  Scenario: Agents are listed as lightweight items, filtered by way of use and protocol, and shown on Settings → Agents
    Given I generate a unique resource name from "portal-agent-list-rest" and store it as "restId"
    And I generate a unique resource name from "portal-agent-list-local" and store it as "localId"
    And I generate a unique resource name from "portal-agent-list-a2a" and store it as "a2aId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:restId}       |
      | displayName     | Agent ${CTX:restId} |
      | types           | ["API"]             |
      | spec.skills     | [{"id":"draft","name":"Draft a reply","description":"Writes a reply"}] |
      | spec.interfaces | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:localId}       |
      | displayName | Agent ${CTX:localId} |
      | types       | ["LOCAL"]            |
    And the response status code should be 201
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card 0.3" with values:
      | name            | ${CTX:a2aId}       |
      | displayName     | Agent ${CTX:a2aId} |
      | types           | ["API"]            |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201

    When I send an authenticated API Portal "GET" request to "/agents?limit=100" as "publisher"
    Then the response status code should be 200
    And the JSON response array "list" item with "id" equal to "${CTX:restId}" should have "protocols" equal to "[OPENAI_RESPONSES]"
    And the JSON response array "list" item with "id" equal to "${CTX:restId}" should have "interfaceTypes" equal to "[REST]"
    And the JSON response array "list" item with "id" equal to "${CTX:restId}" should not have field "skills"
    And the JSON response array "list" item with "id" equal to "${CTX:restId}" should not have field "interfaces"
    When I send an authenticated API Portal "GET" request to "/agents?type=LOCAL&limit=100" as "publisher"
    Then the JSON response array "list" should contain an item with "id" equal to "${CTX:localId}"
    And the JSON response array "list" should not contain an item with "id" equal to "${CTX:restId}"
    When I send an authenticated API Portal "GET" request to "/agents?type=A2A&limit=100" as "publisher"
    Then the JSON response array "list" should contain an item with "id" equal to "${CTX:a2aId}"
    And the JSON response array "list" should not contain an item with "id" equal to "${CTX:restId}"
    When I send an authenticated API Portal "GET" request to "/agents?protocol=openai_responses&limit=100" as "publisher"
    Then the JSON response array "list" should contain an item with "id" equal to "${CTX:restId}"
    And the JSON response array "list" should not contain an item with "id" equal to "${CTX:localId}"

    # Settings → Agents lists the agent with how it is used, apart from the APIs table
    When I send an API Portal session "GET" request to "/api-portal/default/settings" as "admin"
    Then the response status code should be 200
    And the response body should match pattern "data-panel=.cfg-agents."
    And the response body should contain "cfg-agent-row-${CTX:restId}"
    And the response body should contain "technical-scripts/settings-agents.js"
    And the response body should not contain "cfg-api-row-${CTX:restId}"

  @APIP-056
  Scenario: Documents named in docsToRemove are removed when an agent is updated
    Given I generate a unique resource name from "portal-agent-docs" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in ZIP form with files "localDefinition=run locally" with values:
      | name        | ${CTX:agentId}       |
      | displayName | Agent ${CTX:agentId} |
      | types       | ["LOCAL"]            |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}.md"
    Then the response status code should be 200
    And the response body should contain "overview.md"

    # A value that is not a JSON list is refused, and the document stays
    When I send the API Portal agent "${CTX:agentId}" document back as "publisher" with form field "docsToRemove" set to 'overview.md'
    Then the response status code should be 400
    And the response body should contain "Field 'docsToRemove' must be a JSON list of document file names or { fileName, type } entries."
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}.md"
    Then the response body should contain "overview.md"

    When I send the API Portal agent "${CTX:agentId}" document back as "publisher" with form field "docsToRemove" set to '["overview.md"]'
    Then the response status code should be 200
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}.md"
    Then the response status code should be 200
    And the response body should not contain "overview.md"

  @APIP-057 @type:negative
  Scenario: Invalid agent documents are refused with every problem named, and store nothing
    # An unknown field is named, never its value, and nothing is stored
    Given I generate a unique resource name from "portal-agent-bad" and store it as "agentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:agentId}                         |
      | displayName | Agent ${CTX:agentId}                   |
      | types       | ["LOCAL"]                              |
      | spec.colour | https://leak-marker.example.invalid    |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.colour' is not allowed. Remove it."
    And the response body should not contain "leak-marker"
    And the response body should not contain "stack"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 404

    # Every problem is listed at once
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.colour     | blue                 |
      | spec.version    | null                 |
      | spec.interfaces | [{"type":"REST","protocolBinding":"JSONRPC","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.colour' is not allowed. Remove it."
    And the response body should contain "Field 'spec.version' is required."
    And the response body should contain "Field 'spec.interfaces[0].protocolBinding' is not allowed. Remove it."

    # Another apiVersion, a missing types and plans without API are refused
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:agentId}                      |
      | apiVersion  | api-portal.api-platform.wso2.com/v1 |
      | displayName | Agent ${CTX:agentId}                |
      | types       | ["LOCAL"]                           |
    Then the response status code should be 400
    And the response body should contain "Field 'apiVersion' is invalid."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:agentId}       |
      | displayName | Agent ${CTX:agentId} |
      | types       | null                 |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.types' is required."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:agentId}       |
      | displayName | Agent ${CTX:agentId} |
      | types       | ["API","LOCAL"]      |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.types' includes API, so an A2A or REST interface is required. Add one to spec.interfaces, or remove API."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "localDefinition=run locally" with values:
      | name                   | ${CTX:agentId}       |
      | displayName            | Agent ${CTX:agentId} |
      | types                  | ["LOCAL"]            |
      | spec.subscriptionPlans | ["Gold"]             |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.subscriptionPlans' is allowed only when spec.types includes API. Remove the plans, or add API and an interface."

    # Skills beside a card, and transports, auth or operations in the document are refused
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "a2aDefinition=card" with values:
      | name            | ${CTX:agentId}                             |
      | displayName     | Agent ${CTX:agentId}                       |
      | types           | ["API"]                                    |
      | spec.skills     | [{"id":"x","name":"x","description":"x"}] |
      | spec.interfaces | [{"type":"A2A","protocolVersion":"1.0","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.skills' cannot be used when an agent card is provided. Remove it; the card supplies it."
    And the response body should contain "Field 'spec.interfaces[0].protocolVersion' is not allowed. Remove it."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","protocol":"OPENAI_RESPONSES","resources":[{"method":"GET","path":"/x"}],"endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.interfaces[0].resources' is not allowed. Remove it."

    # One interface per type, no file without its interface, and no definition field in the document
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}},{"type":"REST","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.interfaces[1].type' must be unique: an agent has at most one REST interface."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "restDefinition=openapi responses, a2aDefinition=card" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'a2aDefinition' was uploaded, but spec.interfaces has no A2A interface. Add one, or don't upload the file."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "a2aDefinition=card" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"A2A","definition":"agent-card.json","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.interfaces[0].definition' is not allowed. Remove it."

    # The API's definition field is refused with the fields to use, instead of dropping the file
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "definition=card" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'definition' is not allowed. Send the Agent Card as 'a2aDefinition', the OpenAPI as 'restDefinition', the AsyncAPI as 'eventDefinition' and the run-it-yourself Markdown as 'localDefinition'."
    And the response body should contain "Field 'a2aDefinition' is required with an A2A interface. Upload its Agent Card."

    # A file whose content does not fit its field is refused
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in YAML form with files "restDefinition=asyncapi" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","protocol":"AGENT_PROTOCOL","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'restDefinition' must be an OpenAPI document."

    # Each way of use needs its file
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'restDefinition' is required with a REST interface. Upload its OpenAPI document."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["EVENT"]            |
      | spec.interfaces | [{"type":"EVENT"}]   |
    Then the response status code should be 400
    And the response body should contain "Field 'eventDefinition' is required with an EVENT interface. Upload its AsyncAPI document."
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with values:
      | name        | ${CTX:agentId}       |
      | displayName | Agent ${CTX:agentId} |
      | types       | ["LOCAL"]            |
    Then the response status code should be 400
    And the response body should contain "Field 'localDefinition' is required when spec.types includes LOCAL. Upload a Markdown file that says how to run the agent."

    # A URL with credentials in it is refused without echoing them
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","endpoints":{"productionUrl":"https://user:secret-marker@agents.example.invalid/x"}}] |
    Then the response status code should be 400
    And the response body should contain "Field 'spec.interfaces[0].endpoints.productionUrl' is invalid."
    And the response body should not contain "secret-marker"

    # The positive control: the same agent, valid, is stored
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 404
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"REST","endpoints":{"productionUrl":"https://agents.example.invalid/x"}}] |
    Then the response status code should be 201
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 200

  @APIP-057 @type:negative @type:security
  Scenario: Agents and APIs never resolve through each other's endpoints, and only agent scopes reach /agents
    Given I generate a unique resource name from "portal-agent-family-api" and store it as "apiId"
    And I create an API Portal API from "resources/templates/api-portal-api.yaml" as "publisher" with values:
      | id   | ${CTX:apiId} |
      | name | ${CTX:apiId} |
    And the response status code should be 201
    And I generate a unique resource name from "portal-agent-family" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card 0.3" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | ["API"]              |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201

    # An agent resolves only under /agents, and an API only under /apis
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 200
    When I send an authenticated API Portal "GET" request to "/apis/${CTX:apiId}" as "publisher"
    Then the response status code should be 200
    When I send an authenticated API Portal "GET" request to "/apis/${CTX:agentId}" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "GET" request to "/mcp-servers/${CTX:agentId}" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:apiId}" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "GET" request to "/apis?name=${CTX:agentId}" as "publisher"
    Then the response body should not contain "${CTX:agentId}"
    When I send an authenticated API Portal "GET" request to "/mcp-servers?name=${CTX:agentId}" as "publisher"
    Then the response body should not contain "${CTX:agentId}"

    # A kind: Agent document is refused through /apis, and an API document through /agents
    Given I generate a unique resource name from "portal-agent-via-apis" and store it as "viaApisId"
    When I create an API Portal API from "resources/templates/api-portal-agent.yaml" as "publisher" with definition "none" with values:
      | name        | ${CTX:viaApisId}       |
      | displayName | Agent ${CTX:viaApisId} |
      | types       | ["LOCAL"]              |
    Then the response status code should be 400
    When I send an authenticated API Portal "GET" request to "/apis/${CTX:viaApisId}" as "publisher"
    Then the response status code should be 404
    When I create an API Portal agent from "resources/templates/api-portal-api.yaml" as "publisher" in JSON form with values:
      | id   | ${CTX:viaApisId} |
      | name | ${CTX:viaApisId} |
    Then the response status code should be 400
    And the response body should contain "Field 'kind' must be 'Agent'."

    # A handle another kind of artifact uses is refused with a generic conflict
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card 0.3" with values:
      | name            | ${CTX:apiId}       |
      | displayName     | Agent ${CTX:apiId} |
      | types           | ["API"]            |
      | spec.interfaces | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    Then the response status code should be 409
    And the response body should not contain "${CTX:apiId}"

    # An anonymous caller is refused; a developer (dp:agent:read only) reads agents but cannot change them
    When I send an authenticated API Portal "GET" request to "/agents" as "publisher"
    Then the response status code should be 200
    When I send an unauthenticated API Portal "GET" request to "/agents"
    Then the response status code should be 401
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "developer"
    Then the response status code should be 200
    Given I generate a unique resource name from "portal-agent-dev" and store it as "devAgentId"
    When I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "developer" in JSON form with files "localDefinition=run locally" with values:
      | name        | ${CTX:devAgentId}       |
      | displayName | Agent ${CTX:devAgentId} |
      | types       | ["LOCAL"]               |
    Then the response status code should be 403
    When I send the API Portal agent "${CTX:agentId}" document back as "developer"
    Then the response status code should be 403
    When I PUT API Portal content "guide" for agent "${CTX:agentId}" as "developer"
    Then the response status code should be 403
    When I send an authenticated API Portal "DELETE" request to "/agents/${CTX:agentId}" as "developer"
    Then the response status code should be 403
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:devAgentId}" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 200
