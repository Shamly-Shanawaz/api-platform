/*
 * Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 */
/*
 * Tag: Agent Content
 *
 * Docs, landing content and images of an agent, as for MCP servers. 404 while
 * `agents` is not enabled.
 */
const agentService = require('../../../services/agentService');
const { requireCsrfForMutatingApi } = require('../../../middlewares/csrfProtection');
const { requireArtifactTypeForApi } = require('../../../utils/util');
const { compose } = require('./compose');

const agentsEnabled = requireArtifactTypeForApi('agents');

module.exports = {
    createAgentContent: compose(agentsEnabled, requireCsrfForMutatingApi, agentService.createAgentContent),
    replaceAgentContent: compose(agentsEnabled, requireCsrfForMutatingApi, agentService.replaceAgentContent),
    getAgentContentFile: compose(agentsEnabled, agentService.getAgentContentFile),
    deleteAgentContentFile: compose(agentsEnabled, requireCsrfForMutatingApi, agentService.deleteAgentContentFile),
};
