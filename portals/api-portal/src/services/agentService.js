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
 */
'use strict';

/*
 * Type-scoped wrapper around apiMetadataService for the /agents resource family,
 * following mcpServerService. Agents live in api_metadata with `type = 'Agent'`; the
 * agent-only fields (types, interfaces, packages, skills, ...) live in
 * metadata_search.agent. Delegation aliases the `agentId` path param to `apiId` and
 * sets `req.__forceApiType = 'Agent'`, which scopes handle resolution to agents only
 * (so /apis and /mcp-servers can't reach them, and /agents can't reach theirs).
 *
 * Responses are shaped here, in the agent YAML's own vocabulary, not by APIDTO.
 */
const apiMetadataService = require('./apiMetadataService');
const apiDao = require('../dao/apiDao');
const apiFileDao = require('../dao/apiFileDao');
const util = require('../utils/util');
const constants = require('../utils/constants');
const logger = require('../config/logger');

const { REST } = constants.AGENT_INTERFACE_TYPES;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function asAgentRequest(req) {
    req.__forceApiType = constants.API_TYPE.AGENT;
    req.params.apiId = req.params.agentId;
    return req;
}

// The kinds of interface an agent offers (A2A, REST, EVENT), in order, without repeats.
function interfaceTypesOf(agent) {
    return [...new Set((agent.interfaces || []).map((entry) => entry?.type).filter(Boolean))];
}

// The lightweight shape for listings: never any definition content.
function toAgentListItem(api) {
    const agent = api.agent || {};
    const item = {
        id: api.id,
        displayName: api.name,
        version: api.version,
        description: api.description,
        types: agent.types || [],
        interfaceTypes: interfaceTypesOf(agent),
        status: api.status,
        tags: api.tags || [],
        agentVisibility: api.agentVisibility,
    };
    const protocols = [...new Set((agent.interfaces || [])
        .filter((entry) => entry?.type === REST && typeof entry.protocol === 'string')
        .map((entry) => entry.protocol))];
    if (protocols.length) {
        item.protocols = protocols;
    }
    return item;
}

/*
 * The kind: Agent document as the publisher wrote it, rebuilt from storage, so
 * GET -> edit -> PUT round-trips (each interface keeps its `definition` file name, so
 * the stored file stays). Listing fields that were filled from the card are left out
 * again; server-side fields (dates, internal IDs) never go in.
 */
function toAgentDocument(api) {
    const agent = api.agent || {};
    const fromCard = new Set(agent.fromCard || []);
    const metadata = { name: api.id };
    if (isPlainObject(agent.annotations)) {
        metadata.annotations = agent.annotations;
    }
    const owners = api.owners || {};
    const businessInformation = Object.fromEntries(['businessOwner', 'businessOwnerEmail', 'technicalOwner',
        'technicalOwnerEmail'].filter((key) => owners[key]).map((key) => [key, owners[key]]));
    const spec = {
        types: agent.types,
        displayName: fromCard.has('displayName') ? undefined : api.name,
        version: fromCard.has('version') ? undefined : api.version,
        description: fromCard.has('description') ? undefined : (api.description || undefined),
        provider: fromCard.has('provider') ? undefined : agent.provider,
        referenceId: api.refId || undefined,
        agentId: agent.agentId,
        status: api.status,
        agentVisibility: api.agentVisibility,
        labels: api.labels?.length ? api.labels : undefined,
        tags: api.tags?.length ? api.tags : undefined,
        businessInformation: Object.keys(businessInformation).length ? businessInformation : undefined,
        models: agent.models,
        skills: agent.skills,
        subscriptionPlans: api.subscriptionPlans?.length ? api.subscriptionPlans.map((plan) => plan.id) : undefined,
        interfaces: agent.interfaces,
    };
    return {
        apiVersion: constants.AGENT_API_VERSION,
        kind: constants.API_TYPE.AGENT,
        metadata,
        spec: Object.fromEntries(Object.entries(spec).filter(([, value]) => value !== undefined)),
    };
}

// Interfaces whose response says whether their definition file is stored (the wizard
// reads it to know a PUT without the file keeps it).
const DEFINITION_FLAG = {
    [constants.AGENT_INTERFACE_TYPES.A2A]: constants.DOC_TYPES.AGENT_CARD,
    [REST]: constants.DOC_TYPES.API_DEFINITION,
};

/*
 * GET /agents/{id}: the agent's metadata and the document. Each A2A and REST interface
 * says whether a definition file is stored (`hasDefinition`); read it through
 * /agents/{id}/assets?type=AGENT_CARD|API_DEFINITION. The document never carries the
 * flag, so GET -> edit -> PUT round-trips.
 */
function toAgent(api, definitionRows) {
    const agent = api.agent || {};
    const storedTypes = new Set((definitionRows || []).map((row) => row.type));
    const full = {
        ...toAgentListItem(api),
        labels: api.labels || [],
        subscriptionPlans: (api.subscriptionPlans || []).map((plan) => plan.id),
    };
    if (api.refId) {
        full.referenceId = api.refId;
    }
    if (Array.isArray(agent.interfaces)) {
        full.interfaces = agent.interfaces.map((entry) => (DEFINITION_FLAG[entry?.type]
            ? { ...entry, hasDefinition: storedTypes.has(DEFINITION_FLAG[entry.type]) }
            : entry));
    }
    for (const key of ['agentId', 'annotations', 'provider', 'models', 'skills', 'skillIds']) {
        if (agent[key] !== undefined) {
            full[key] = agent[key];
        }
    }
    if (api.owners) {
        full.businessInformation = api.owners;
    }
    full.document = toAgentDocument(api);
    for (const key of ['createdAt', 'updatedAt', 'createdBy', 'updatedBy']) {
        if (api[key] !== undefined) {
            full[key] = api[key];
        }
    }
    return full;
}

async function loadAgent(orgId, agentHandle) {
    const apiId = await apiDao.getIdByType(orgId, agentHandle, constants.API_TYPE.AGENT);
    if (!apiId) {
        return null;
    }
    const api = await apiMetadataService.getMetadataFromDB(orgId, apiId);
    if (!api) {
        return null;
    }
    const definitions = await apiFileDao.listAgentDefinitions(orgId, apiId, undefined, { withContent: false });
    return toAgent(api, definitions);
}

/*
 * Create and update answer with the agent shape GET returns, not the generic API
 * shape. The shared handler writes its own response; a successful one is replaced by
 * the stored agent, read back by handle. Errors pass through unchanged.
 */
function agentShapedResponse(req, res) {
    // Only what the shared handlers call: status().send()/json(), and headers. Header
    // calls go straight to the real response.
    let statusCode = 200;
    const proxy = {
        status: (code) => {
            statusCode = code;
            return proxy;
        },
        set: (...args) => {
            res.set(...args);
            return proxy;
        },
        setHeader: (...args) => res.setHeader(...args),
        get headersSent() {
            return res.headersSent;
        },
    };
    const finish = (body) => {
        if (statusCode < 200 || statusCode >= 300) {
            return res.status(statusCode).send(body);
        }
        const handle = body?.id || body?.handle || req.params.agentId;
        return loadAgent(req.orgId, handle)
            .then((agent) => (agent ? res.status(statusCode).send(agent) : res.status(statusCode).send(body)))
            .catch((error) => {
                logger.error('Agent read-back failed', { error: error.message, orgId: req.orgId });
                util.handleError(res, error);
            });
    };
    proxy.send = finish;
    proxy.json = finish;
    return proxy;
}

const createAgent = async (req, res) => {
    return apiMetadataService.createAPIMetadata(asAgentRequest(req), agentShapedResponse(req, res));
};

const updateAgent = async (req, res) => {
    return apiMetadataService.updateAPIMetadata(asAgentRequest(req), agentShapedResponse(req, res));
};

const deleteAgent = async (req, res) => {
    return apiMetadataService.deleteAPIMetadata(asAgentRequest(req), res);
};

const getAgent = async (req, res) => {
    try {
        const agent = await loadAgent(req.orgId, req.params.agentId);
        if (!agent) {
            return util.sendError(res, 404, 'Agent not found');
        }
        res.status(200).send(agent);
    } catch (error) {
        logger.error('Agent retrieval failed', { error: error.message, orgId: req.orgId });
        util.handleError(res, error);
    }
};

const getAllAgentsForOrganization = async (req, res) => {
    try {
        const orgId = req.orgId;
        const { query: searchTerm, name, version, tags, view, type, protocol } = req.query;
        const agents = await apiMetadataService.getMetadataListFromDB(orgId, searchTerm, tags, name, version, view,
            { include: constants.API_TYPE.AGENT });
        let items = agents.map(toAgentListItem);
        if (type) {
            // A use type (API, EVENT, LOCAL) or an interface type (A2A, REST, EVENT).
            items = items.filter((item) => item.types.includes(type) || item.interfaceTypes.includes(type));
        }
        if (protocol) {
            // Protocol labels are free text, matched case-insensitively.
            const wanted = String(protocol).toUpperCase();
            items = items.filter((item) => (item.protocols || []).some((label) => label.toUpperCase() === wanted));
        }
        res.status(200).json(util.toPaginatedList(items, req));
    } catch (error) {
        logger.error('Agent list retrieval failed', { error: error.message, orgId: req.orgId });
        util.handleError(res, error);
    }
};

const createAgentContent = async (req, res) => {
    return apiMetadataService.createAPIContent(asAgentRequest(req), res);
};

const replaceAgentContent = async (req, res) => {
    return apiMetadataService.updateAPIContent(asAgentRequest(req), res);
};

// Definition files, one per type, read through /assets by type alone.
const DEFINITION_CONTENT_TYPES = {
    [constants.DOC_TYPES.AGENT_CARD]: () => constants.MIME_TYPES.JSON,
    [constants.DOC_TYPES.API_DEFINITION]: (name) => (/\.json$/i.test(name) ? constants.MIME_TYPES.JSON : constants.MIME_TYPES.YAML),
    [constants.DOC_TYPES.AGENT_EVENT_DEFINITION]: (name) => (/\.json$/i.test(name) ? constants.MIME_TYPES.JSON : constants.MIME_TYPES.YAML),
    [constants.DOC_TYPES.AGENT_LOCAL_DEFINITION]: () => 'text/markdown; charset=utf-8',
};

/*
 * GET /agents/{id}/assets. A definition type (AGENT_CARD, API_DEFINITION,
 * AGENT_EVENT_DEFINITION, AGENT_LOCAL_DEFINITION) returns the agent's one stored file
 * of that type, byte for byte, with `nosniff`; it needs a session, like every
 * non-image type. Anything else is the shared API content read.
 */
const getAgentContentFile = async (req, res) => {
    const contentTypeOf = DEFINITION_CONTENT_TYPES[req.query.type];
    if (!contentTypeOf) {
        if (!req.query.fileName) {
            return util.sendError(res, 400, "Query parameter 'fileName' is required for this type.");
        }
        return apiMetadataService.getAPIFile(asAgentRequest(req), res);
    }
    const orgId = req.orgId;
    if (!orgId) {
        return util.sendError(res, 401, 'Authentication required');
    }
    try {
        const apiId = await apiDao.getIdByType(orgId, req.params.agentId, constants.API_TYPE.AGENT);
        const row = apiId
            ? (await apiFileDao.listAgentDefinitions(orgId, apiId, undefined, { types: [req.query.type] }))[0]
            : null;
        if (!row) {
            return util.sendError(res, 404, 'Agent definition not found');
        }
        res.set('Content-Type', contentTypeOf(String(row.file_name)));
        res.set('X-Content-Type-Options', 'nosniff');
        return res.status(200).send(Buffer.from(row.file_content));
    } catch (error) {
        logger.error('Agent definition retrieval failed', { error: error.message, orgId });
        return util.handleError(res, error);
    }
};

const deleteAgentContentFile = async (req, res) => {
    return apiMetadataService.deleteAPIFile(asAgentRequest(req), res);
};

module.exports = {
    asAgentRequest,
    toAgentListItem,
    toAgent,
    toAgentDocument,
    createAgent,
    getAgent,
    getAllAgentsForOrganization,
    updateAgent,
    deleteAgent,
    createAgentContent,
    replaceAgentContent,
    getAgentContentFile,
    deleteAgentContentFile,
};
