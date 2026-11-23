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
 * Tag: Agents
 *
 * Every operation answers 404 while `agents` is not in [api_portal.artifacts]
 * enabled_types, so a push into a portal that doesn't serve agents fails loudly.
 */
const agentService = require('../../../services/agentService');
const { requireCsrfForMutatingApi } = require('../../../middlewares/csrfProtection');
const { requireArtifactTypeForApi } = require('../../../utils/util');
const { compose } = require('./compose');

const agentsEnabled = requireArtifactTypeForApi('agents');

module.exports = {
    createAgent: compose(agentsEnabled, requireCsrfForMutatingApi, agentService.createAgent),
    getAgent: compose(agentsEnabled, agentService.getAgent),
    getAllAgentsForOrganization: compose(agentsEnabled, agentService.getAllAgentsForOrganization),
    updateAgent: compose(agentsEnabled, requireCsrfForMutatingApi, agentService.updateAgent),
    deleteAgent: compose(agentsEnabled, requireCsrfForMutatingApi, agentService.deleteAgent),
};
