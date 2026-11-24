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

@APIPORTAL
Feature: API Portal agents in the catalogue, in Settings → Agents and on the Agent Keys page
  A developer finds agents in the catalogue, filters and searches them, and reads how to use one;
  an administrator adds, edits, deprecates and deletes agents in Settings → Agents; and a key
  manager that makes AI agent keys is offered on the developer's Agent Keys page. Agents are an
  opt-in artifact type, enabled for this stack by api-portal-agents.toml. Creating an agent key
  needs a ThunderID agent API, which the integration suite covers; this journey checks the forms.

  Background:
    Given the user is signed in to the API Portal

  @APIP-058
  Scenario: Journey: a developer finds agents, filters and searches them, and reads how to use one
    Given the API Portal has agent catalogue fixtures
    When the agent listing shows each agent with its ways of use, and no Subscribe without plans
    And the user filters the agent listing by Run it yourself, then also by REST
    And the agent listing search finds the REST agent by one of its skills
    Then the API listing does not list the agents
    And the multi-way agent page shows one tab per way of use, and the tabs follow the keyboard
    And Install opens Run it yourself, with the setup guide's HTML cleaned
    And the agent's Documentation opens its first definition, and the AsyncAPI offers Download
    And the Try with AI dialog speaks of the agent, not an API

  @APIP-056 @APIP-057
  Scenario: Journey: an administrator adds, edits, deprecates and deletes agents in Settings → Agents
    When the administrator adds an A2A agent in the wizard, and its Agent Card fills the details
    And the administrator edits that agent with the same steps, keeping what the form does not show
    And the administrator deprecates that agent from its row menu
    And the administrator adds a REST agent in the wizard, correcting what the form and the server refuse
    Then Settings → Agents offers no import or download actions, and a dialog closes when its background is clicked
    And the administrator deletes two agents together from the bulk bar, and one from its row menu

  @APIP-061
  Scenario: Journey: an administrator offers agent keys on a key manager, and a developer finds them on the Agent Keys page
    Given the API Portal has a key manager that makes agent keys and one that does not
    Then the key manager form offers an agent registration endpoint only for a type that makes agent keys
    And the developer's Agent Keys page offers only the key manager that makes agent keys, with the grants to choose
    And the developer's OAuth2 Keys page offers both key managers for application keys
