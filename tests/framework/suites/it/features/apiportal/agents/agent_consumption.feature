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

@APIPORTAL @apiportal-agent-consumption
Feature: Developers subscribe to agents and hold API keys for them
  As a developer
  I want to subscribe to an agent with plans and get API keys for it, as I do for an API
  So that I can call it, while an agent without plans offers neither

  # Scenarios APIPORTAL (scenarios/on-prem/APIPORTAL.yaml) at the API level. Agents are created
  # from resources/templates/api-portal-agent.yaml through /agents; "Gold" is one of the
  # organization's standard plans. Agent keys are under /agents/<id>/api-keys.

  @APIP-060 @type:smoke
  Scenario: A developer subscribes to an agent with plans and its keys are issued once, and an agent in use cannot be deleted
    Given I generate a unique resource name from "portal-consume-a2a" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "a2aDefinition=card" with values:
      | name                   | ${CTX:agentId}       |
      | displayName            | Agent ${CTX:agentId} |
      | types                  | ["API"]              |
      | spec.subscriptionPlans | ["Gold"]             |
      | spec.interfaces        | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}] |
    And the response status code should be 201

    # A subscription blocks the delete until it is removed
    When a developer subscription for API "${CTX:agentId}" using plan "Gold" is created and stored as "subscriptionId"
    Then the response status code should be 201
    And the JSON response field "subscriptionPlanName" should be "Gold"
    When I send an authenticated API Portal "DELETE" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 409
    And the response body should contain "Agent has subscriptions."
    When I send an API Portal session "GET" request to "/api-portal/default/views/default/subscriptions" as "developer"
    Then the response status code should be 200
    And the response body should contain "/agent/${CTX:agentId}"
    And the response body should not match pattern "sub-type-pill.>Agent"
    When I send an authenticated API Portal "DELETE" request to "/subscriptions/${CTX:subscriptionId}" as "developer"
    Then the response should be successful

    # A key is shown once and listed as metadata only; an active key blocks the delete
    When a publisher API key for agent "${CTX:agentId}" is generated and stored as "keyId"
    Then the response status code should be 201
    And I store the JSON response field "key" as "keyValue"
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/api-keys" as "publisher"
    Then the response status code should be 200
    And the JSON response array "list" should contain an item with "id" equal to "${CTX:keyId}"
    And the response body should not contain "${CTX:keyValue}"
    When I send an authenticated API Portal "GET" request to "/apis/${CTX:agentId}/api-keys" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "DELETE" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 409
    And the response body should contain "Agent has active keys."
    When I send an authenticated API Portal "POST" request to "/agents/${CTX:agentId}/api-keys/revoke" as "publisher" with JSON values:
      | keyId | ${CTX:keyId} |
    Then the response status code should be 204

    # A revoked key does not block it
    When I send an authenticated API Portal "DELETE" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response should be successful
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher" until status 404
    Then the response status code should be 404

  @APIP-060
  Scenario: An agent page offers its plans, credentials and keys page
    Given I generate a unique resource name from "portal-consume-rest" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name                   | ${CTX:agentId}       |
      | displayName            | Agent ${CTX:agentId} |
      | types                  | ["API"]              |
      | spec.subscriptionPlans | ["Gold"]             |
      | spec.interfaces        | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}"
    Then the response status code should be 200
    And the response body should match pattern "id=.subscriptionPlans."
    And the response body should match pattern "data-kind-label=.agent."
    And the response body should contain "Subscription-Key: &lt;your-subscription-token&gt;"
    And the response body should contain "api-key: &lt;your-api-key&gt;"
    And the response body should contain "/agent/${CTX:agentId}/api-keys"

    # The agent's keys page lists its keys against /agents; an API path does not open it
    When I send an API Portal session "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}/api-keys" as "developer"
    Then the response status code should be 200
    And the response body should match pattern "data-resource-base=./agents/."
    And the response body should contain "/agent/${CTX:agentId}"
    When I send an API Portal session "GET" request to "/api-portal/default/views/default/api/${CTX:agentId}/api-keys" as "developer"
    Then the response status code should be 404

  @APIP-060 @type:negative
  Scenario Outline: A <shape> agent without plans offers no keys and no subscriptions
    Given I generate a unique resource name from "portal-consume-noplans" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "<files>" with values:
      | name            | ${CTX:agentId}       |
      | displayName     | Agent ${CTX:agentId} |
      | types           | <types>              |
      | spec.interfaces | <interfaces>         |
    And the response status code should be 201
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}" as "publisher"
    Then the response status code should be 200
    When I send an authenticated API Portal "GET" request to "/agents/${CTX:agentId}/api-keys" as "publisher"
    Then the response status code should be 404
    When I send an authenticated API Portal "POST" request to "/agents/${CTX:agentId}/api-keys/generate" as "publisher" with JSON values:
      | id | ${CTX:agentId}-key |
    Then the response status code should be 404
    When I send an authenticated API Portal "POST" request to "/subscriptions" as "developer" with JSON values:
      | artifactId         | ${CTX:agentId} |
      | subscriptionPlanId | Gold           |
    Then the response status code should be 400
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}"
    Then the response status code should be 200
    And the response body should not contain "/agent/${CTX:agentId}/api-keys"
    And the response body should not contain "Subscription-Key: &lt;your-subscription-token&gt;"

    Examples:
      | shape        | types     | interfaces                                                                                                          | files                            |
      | REST         | ["API"]   | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] | restDefinition=openapi responses |
      | A2A 0.3      | ["API"]   | [{"type":"A2A","endpoints":{"productionUrl":"https://agents.example.invalid/invoice"}}]                              | a2aDefinition=card 0.3           |
      | Agent Protocol | ["API"] | [{"type":"REST","protocol":"AGENT_PROTOCOL","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}]   | restDefinition=openapi           |
      | event        | ["EVENT"] | [{"type":"EVENT"}]                                                                                                  | eventDefinition=asyncapi         |
      | run-it-yourself | ["LOCAL"] | null                                                                                                            | localDefinition=run locally      |

  @APIP-060
  Scenario: A deprecated agent is marked Deprecated and still takes subscriptions and keys
    Given I generate a unique resource name from "portal-consume-deprecated" and store it as "agentId"
    And I create an API Portal agent from "resources/templates/api-portal-agent.yaml" as "publisher" in JSON form with files "restDefinition=openapi responses" with values:
      | name                   | ${CTX:agentId}       |
      | displayName            | Agent ${CTX:agentId} |
      | types                  | ["API"]              |
      | spec.status            | DEPRECATED           |
      | spec.subscriptionPlans | ["Gold"]             |
      | spec.interfaces        | [{"type":"REST","protocol":"OPENAI_RESPONSES","endpoints":{"productionUrl":"https://agents.example.invalid/rest"}}] |
    And the response status code should be 201
    When a developer subscription for API "${CTX:agentId}" using plan "Gold" is created and stored as "subscriptionId"
    Then the response status code should be 201
    When a publisher API key for agent "${CTX:agentId}" is generated and stored as "keyId"
    Then the response status code should be 201
    When I send an unauthenticated API Portal public "GET" request to "/api-portal/default/views/default/agent/${CTX:agentId}"
    Then the response status code should be 200
    And the response body should contain "Deprecated"
