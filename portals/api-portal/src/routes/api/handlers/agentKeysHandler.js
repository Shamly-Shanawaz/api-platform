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
 * Tag: MCP Server Keys
/*
 * Tag: Agent Keys
 *
 * API keys for agents, delegating to the shared apiKeyController exactly as
 * mcpServerKeysHandler does for MCP servers. Handle resolution is scoped to agents.
 * As for APIs and MCP servers, keys follow the subscription plans: an agent without
 * plans has no keys, and every operation answers 404 for it, as for an unknown
 * handle. 404 for every operation while agents are not enabled.
 *
 * Mutating ops are CSRF-protected.
 */
const apiKeyController = require('../../../controllers/apiKeyController');
const apiDao = require('../../../dao/apiDao');
const util = require('../../../utils/util');
const constants = require('../../../utils/constants');
const { requireCsrfForMutatingApi } = require('../../../middlewares/csrfProtection');
const { compose } = require('./compose');

const agentsEnabled = util.requireArtifactTypeForApi('agents');

function asAgentRequest(req) {
    req.__forceApiType = constants.API_TYPE.AGENT;
    req.params.apiId = req.params.agentId;
    return req;
}

// The agent, when it offers keys (has subscription plans); otherwise null.
async function agentWithPlans(orgId, handle) {
    const apiId = await apiDao.getIdByType(orgId, handle, constants.API_TYPE.AGENT);
    if (!apiId) {
        return null;
    }
    const [row] = await apiDao.getByCondition({ orgId, uuid: apiId });
    return Array.isArray(row?.subscription_plans) && row.subscription_plans.length > 0 ? row : null;
}

function delegate(fn) {
    return async (req, res) => {
        try {
            if (!(await agentWithPlans(req.orgId, req.params.agentId))) {
                return util.sendError(res, 404, 'Agent not found');
            }
            return fn(asAgentRequest(req), res);
        } catch (error) {
            return util.handleError(res, error);
        }
    };
}

module.exports = {
    generateAgentApiKey: compose(agentsEnabled, requireCsrfForMutatingApi, delegate(apiKeyController.generateApiKey)),
    listAgentApiKeys: compose(agentsEnabled, delegate(apiKeyController.listApiKeys)),
    regenerateAgentApiKey: compose(agentsEnabled, requireCsrfForMutatingApi, delegate(apiKeyController.regenerateApiKey)),
    revokeAgentApiKey: compose(agentsEnabled, requireCsrfForMutatingApi, delegate(apiKeyController.revokeApiKey)),
    associateAgentApiKeyApplication: compose(agentsEnabled, requireCsrfForMutatingApi,
        delegate(apiKeyController.associateApiKeyApplication)),
    removeAgentApiKeyApplication: compose(agentsEnabled, requireCsrfForMutatingApi,
        delegate(apiKeyController.removeApiKeyApplication)),
};
