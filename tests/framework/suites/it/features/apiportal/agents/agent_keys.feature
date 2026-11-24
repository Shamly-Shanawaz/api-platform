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

@APIPORTAL @apiportal-agent-keys
Feature: Developers get keys for their AI agents from a ThunderID key manager
  As a developer
  I want an AI agent key: a ThunderID agent with an OAuth client of its own
  So that my agent can get tokens, act for users when I allow it, and be rotated or removed

  # Scenarios APIPORTAL (scenarios/on-prem/APIPORTAL.yaml) at the API level. Key managers point at
  # this scenario's partition of the testbench OAuth2 service, which also answers ThunderID's agent
  # API (/agents) as ThunderID does. The portal's provisioning credential is the service's fixed
  # mock client "test-client" / "test-secret"; agents it creates are "agent-<n>" with clients
  # "agent-client-<n>". A key manager with an agentRegistrationEndpoint makes agent keys.

  Background:
    Given I generate a unique resource name from "portal-km-agents" and store it as "kmId"
    And I generate a unique resource name from "portal-km-plain" and store it as "plainKmId"
    And a unique API Portal resource is created at "/key-managers" as "admin" with values and stored as "kmId":
      | id            | ${CTX:kmId}                                                        |
      | displayName   | Thunder Agents                                                     |
      | tokenEndpoint | http://testbench:3011/${CTX:apiPortalRunnerPartition}/oauth2/token |
      | provisioning  | {"type":"thunderid","registrationEndpoint":"http://testbench:3011/${CTX:apiPortalRunnerPartition}/register","agentRegistrationEndpoint":"http://testbench:3011/${CTX:apiPortalRunnerPartition}/agents","auth":{"method":"client_credentials","clientId":"test-client","clientSecret":"test-secret"}} |
    And a unique API Portal resource is created at "/key-managers" as "admin" with values and stored as "plainKmId":
      | id            | ${CTX:plainKmId}                                                   |
      | displayName   | Thunder Plain                                                      |
      | tokenEndpoint | http://testbench:3011/${CTX:apiPortalRunnerPartition}/oauth2/token |
      | provisioning  | {"type":"thunderid","registrationEndpoint":"http://testbench:3011/${CTX:apiPortalRunnerPartition}/register","auth":{"method":"client_credentials","clientId":"test-client","clientSecret":"test-secret"}} |

  @APIP-061 @type:smoke
  Scenario: A developer creates an agent key, gets tokens with its secret, rotates it and deletes it
    # Only a key manager with an agent endpoint is offered for agent keys
    When I send an authenticated API Portal "GET" request to "/key-managers/${CTX:kmId}" as "admin"
    Then the response status code should be 200
    And the JSON response field "provisioning.type" should be "thunderid"
    And the JSON response field "provisioning.agentRegistrationEndpoint" should be "http://testbench:3011/${CTX:apiPortalRunnerPartition}/agents"
    When I send an authenticated API Portal "GET" request to "/key-managers/metadata" as "developer"
    Then the JSON response array "list" should contain an item with "id" equal to "${CTX:kmId}"
    And the JSON response array "list" should contain an item with "id" equal to "${CTX:plainKmId}"
    When I send an authenticated API Portal "GET" request to "/key-managers/metadata?subjectType=AGENT" as "developer"
    Then the JSON response array "list" should contain an item with "id" equal to "${CTX:kmId}"
    And the JSON response array "list" should not contain an item with "id" equal to "${CTX:plainKmId}"
    And the JSON response array "list" item with "id" equal to "${CTX:kmId}" should have "keyCreation" equal to "register"
    And the response body should contain "urn:ietf:params:oauth:grant-type:token-exchange"

    # The key is a new ThunderID agent named after it, with a client_credentials client; its secret is shown once
    When a unique API Portal resource is created at "/oauth2-keys" as "developer" with values and stored as "keyId":
      | keyManagerId | ${CTX:kmId}                   |
      | subjectType  | AGENT                         |
      | properties   | {"client_name":"invoice-bot"} |
    Then the response status code should be 201
    And the JSON response field "subjectType" should be "AGENT"
    And the JSON response field "agentId" should be "agent-1"
    And the JSON response field "consumerKey" should be "agent-client-1"
    And the JSON response field "consumerSecret" should match pattern "^agent-secret-1-"
    And the JSON response field "name" should be "invoice-bot"
    And I store the JSON response field "consumerSecret" as "secret"
    And the API Portal key manager mock should have received 1 agent registration
    And the API Portal key manager mock agent "agent-1" should have "attributes.name" equal to '"invoice-bot"'
    And the API Portal key manager mock agent "agent-1" should have "type" equal to '"default"'
    And the API Portal key manager mock agent "agent-1" should have "ouId" equal to '"ou-system"'
    And the API Portal key manager mock agent "agent-1" should have "delegated" equal to 'false'
    And the API Portal key manager mock agent "agent-1" should have "inboundAuthConfig[0].config.grantTypes" equal to '["client_credentials"]'

    # List and read never carry the secret
    When I send an authenticated API Portal "GET" request to "/oauth2-keys" as "developer"
    Then the JSON response array "list" item with "keyId" equal to "${CTX:keyId}" should have "subjectType" equal to "AGENT"
    And the JSON response array "list" item with "keyId" equal to "${CTX:keyId}" should have "agentId" equal to "agent-1"
    And the JSON response array "list" item with "keyId" equal to "${CTX:keyId}" should have "consumerSecret" equal to ""
    When I send an authenticated API Portal "GET" request to "/oauth2-keys/${CTX:keyId}" as "developer"
    Then the response status code should be 200
    And the JSON response field "consumerSecret" should be ""
    And the JSON response field "properties.client_name" should be "invoice-bot"
    And the JSON response field "properties.grant_types" should be "[client_credentials]"
    And the response body should not contain "${CTX:secret}"

    # The secret gets a token; rotating replaces it at once, and the agent keeps its other settings
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:keyId}/generate-token" as "developer" with JSON values:
      | consumerSecret | ${CTX:secret} |
    Then the response status code should be 200
    And the response body should contain "mock-token"
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:keyId}/rotate-secret" as "developer" with JSON values:
      | reason | rotation |
    Then the response status code should be 200
    And the JSON response field "consumerSecret" should not equal "${CTX:secret}"
    And I store the JSON response field "consumerSecret" as "rotatedSecret"
    And the API Portal key manager mock agent "agent-1" should have "inboundAuthConfig[0].config.scopeClaims" equal to '{"roles":["roles"]}'
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:keyId}/generate-token" as "developer" with JSON values:
      | consumerSecret | ${CTX:secret} |
    Then the response status code should be 400
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:keyId}/generate-token" as "developer" with JSON values:
      | consumerSecret | ${CTX:rotatedSecret} |
    Then the response status code should be 200

    # An agent key's settings are not edited in the portal
    When I send an authenticated API Portal "PUT" request to "/oauth2-keys/${CTX:keyId}" as "developer" with JSON values:
      | properties | {"client_name":"renamed"} |
    Then the response status code should be 409

    # Deleting the key deletes the ThunderID agent, then the key
    Then the API Portal key manager mock should hold the agent "agent-1"
    When I send an authenticated API Portal "DELETE" request to "/oauth2-keys/${CTX:keyId}" as "developer"
    Then the response status code should be 204
    And the API Portal key manager mock should not hold the agent "agent-1"
    When I send an authenticated API Portal "GET" request to "/oauth2-keys/${CTX:keyId}" as "developer"
    Then the response status code should be 404

  @APIP-061
  Scenario: An agent key acts for users with the grants chosen, and reads them back
    When a unique API Portal resource is created at "/oauth2-keys" as "developer" with values and stored as "keyId":
      | keyManagerId | ${CTX:kmId} |
      | subjectType  | AGENT       |
      | properties   | {"client_name":"web-bot","grant_types":["authorization_code","urn:ietf:params:oauth:grant-type:token-exchange"],"redirect_uris":["https://bot.example.com/callback"]} |
    Then the response status code should be 201
    And the JSON response field "actsForUsers" should be true
    And the API Portal key manager mock agent "agent-1" should have "delegated" equal to 'true'
    And the API Portal key manager mock agent "agent-1" should have "inboundAuthConfig[0].config.grantTypes" equal to '["client_credentials","authorization_code","urn:ietf:params:oauth:grant-type:token-exchange","refresh_token"]'
    And the API Portal key manager mock agent "agent-1" should have "inboundAuthConfig[0].config.redirectUris" equal to '["https://bot.example.com/callback"]'
    When I send an authenticated API Portal "GET" request to "/oauth2-keys/${CTX:keyId}" as "developer"
    Then the JSON response field "properties.redirect_uris" should be "[https://bot.example.com/callback]"
    And the JSON response field "properties.grant_types" should contain "urn:ietf:params:oauth:grant-type:token-exchange"
    When I send an authenticated API Portal "GET" request to "/oauth2-keys" as "developer"
    Then the JSON response array "list" item with "keyId" equal to "${CTX:keyId}" should have "actsForUsers" equal to "true"

  @APIP-061 @type:negative
  Scenario: Agent keys are refused on a key manager without an agent endpoint, for a bad or taken name and for extra settings
    # The positive control: the agent key manager makes a key for a good name
    When a unique API Portal resource is created at "/oauth2-keys" as "developer" with values and stored as "keyId":
      | keyManagerId | ${CTX:kmId}                |
      | subjectType  | AGENT                      |
      | properties   | {"client_name":"twin-bot"} |
    Then the response status code should be 201
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:plainKmId}           |
      | subjectType  | AGENT                      |
      | properties   | {"client_name":"nope-bot"} |
    Then the response status code should be 400
    And the response body should contain "does not issue keys for AI agents"
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:kmId}                 |
      | subjectType  | AGENT                       |
      | properties   | {"client_name":"bad name!"} |
    Then the response status code should be 400
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:kmId}                |
      | subjectType  | AGENT                      |
      | properties   | {"client_name":"twin-bot"} |
    Then the response status code should be 409
    And the response body should contain "conflict with an existing client"
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:kmId}                                   |
      | subjectType  | AGENT                                         |
      | properties   | {"client_name":"x-bot","scope":["openid"]} |
    Then the response status code should be 400
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:kmId}                                                      |
      | subjectType  | AGENT                                                            |
      | properties   | {"client_name":"y-bot","grant_types":["authorization_code"]} |
    Then the response status code should be 400
    And the API Portal key manager mock should have received 1 agent registration

    # A key manager type that cannot make agent keys refuses an agent endpoint
    Given I generate a unique resource name from "portal-km-wso2is" and store it as "isKmId"
    When I send an authenticated API Portal "POST" request to "/key-managers" as "admin" with JSON values:
      | id            | ${CTX:isKmId}                                                      |
      | displayName   | WSO2 IS Agents                                                     |
      | tokenEndpoint | http://testbench:3011/${CTX:apiPortalRunnerPartition}/oauth2/token |
      | provisioning  | {"type":"wso2is","registrationEndpoint":"http://testbench:3011/${CTX:apiPortalRunnerPartition}/register","agentRegistrationEndpoint":"http://testbench:3011/${CTX:apiPortalRunnerPartition}/agents","auth":{"method":"client_credentials","clientId":"test-client","clientSecret":"test-secret"}} |
    Then the response status code should be 400
    When I send an authenticated API Portal "GET" request to "/key-managers/${CTX:isKmId}" as "admin"
    Then the response status code should be 404

  @APIP-061
  Scenario: An agent made outside the portal is linked by its client ID, gets tokens, and is only unlinked
    Given an agent named "outside-bot" is registered directly in the API Portal key manager mock and stored as "outside"
    And I generate a unique resource name from "portal-km-imports" and store it as "importKmId"
    And a unique API Portal resource is created at "/key-managers" as "admin" with values and stored as "importKmId":
      | id            | ${CTX:importKmId}                                                  |
      | displayName   | Thunder Imports                                                    |
      | tokenEndpoint | http://testbench:3011/${CTX:apiPortalRunnerPartition}/oauth2/token |
    When I send an authenticated API Portal "GET" request to "/key-managers/metadata?subjectType=AGENT" as "developer"
    Then the JSON response array "list" item with "id" equal to "${CTX:importKmId}" should have "keyCreation" equal to "provide"

    # Linking is refused on the key manager that creates agents, and with a secret
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:kmId}                                  |
      | subjectType  | AGENT                                        |
      | properties   | {"client_name":"on-creator"}                 |
      | link         | {"clientId":"${CTX:outsideClientId}"}        |
    Then the response status code should be 400
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:importKmId}                                                                  |
      | subjectType  | AGENT                                                                              |
      | properties   | {"client_name":"old-shape"}                                                        |
      | link         | {"clientId":"${CTX:outsideClientId}","clientSecret":"${CTX:outsideClientSecret}"} |
    Then the response status code should be 400

    # Linking by client ID sends nothing upstream, and the agent's own secret gets a token
    When a unique API Portal resource is created at "/oauth2-keys" as "developer" with values and stored as "keyId":
      | keyManagerId | ${CTX:importKmId}                     |
      | subjectType  | AGENT                                 |
      | properties   | {"client_name":"outside-bot"}         |
      | link         | {"clientId":"${CTX:outsideClientId}"} |
    Then the response status code should be 201
    And the JSON response field "linked" should be true
    And the JSON response field "agentId" should not exist
    And the JSON response field "consumerSecret" should be ""
    And the API Portal key manager mock should have received 1 agent registration
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:keyId}/generate-token" as "developer" with JSON values:
      | consumerSecret | ${CTX:outsideClientSecret} |
    Then the response status code should be 200
    When I send an authenticated API Portal "POST" request to "/oauth2-keys" as "developer" with JSON values:
      | keyManagerId | ${CTX:importKmId}                     |
      | subjectType  | AGENT                                 |
      | properties   | {"client_name":"again"}               |
      | link         | {"clientId":"${CTX:outsideClientId}"} |
    Then the response status code should be 409

    # A linked agent's secret is not rotated, and deleting the key only unlinks it
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:keyId}/rotate-secret" as "developer" with JSON values:
      | reason | rotation |
    Then the response status code should be 409
    When I send an authenticated API Portal "DELETE" request to "/oauth2-keys/${CTX:keyId}" as "developer"
    Then the response status code should be 204
    And the API Portal key manager mock should hold the agent "${CTX:outsideAgentId}"

  @APIP-061 @type:negative
  Scenario: Only agent keys have their secret rotated
    When a unique API Portal resource is created at "/oauth2-keys" as "developer" with values and stored as "agentKeyId":
      | keyManagerId | ${CTX:kmId}                  |
      | subjectType  | AGENT                        |
      | properties   | {"client_name":"rotate-bot"} |
    Then the response status code should be 201
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:agentKeyId}/rotate-secret" as "developer" with JSON values:
      | reason | rotation |
    Then the response status code should be 200
    Given I generate a unique resource name from "portal-km-app-imports" and store it as "appKmId"
    And a unique API Portal resource is created at "/key-managers" as "admin" with values and stored as "appKmId":
      | id            | ${CTX:appKmId}                                                     |
      | displayName   | Application Imports                                                |
      | tokenEndpoint | http://testbench:3011/${CTX:apiPortalRunnerPartition}/oauth2/token |
    When a unique API Portal resource is created at "/oauth2-keys" as "developer" with values and stored as "appKeyId":
      | keyManagerId | ${CTX:appKmId}                                           |
      | properties   | {"client_name":"Imported client","consumerKey":"test-client"} |
    Then the response status code should be 201
    And the JSON response field "subjectType" should be "APPLICATION"
    When I send an authenticated API Portal "POST" request to "/oauth2-keys/${CTX:appKeyId}/rotate-secret" as "developer" with JSON values:
      | reason | rotation |
    Then the response status code should be 409
