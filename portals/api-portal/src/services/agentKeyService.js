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
 * Creating and rotating AI agent keys (POST /oauth2-keys with subjectType AGENT,
 * POST /oauth2-keys/{keyId}/rotate-secret).
 *
 * On a key manager with an agent registration endpoint (its settings'
 * `agentRegistrationEndpoint`), the key is an agent with an OAuth client in the
 * identity server, made through the driver's agent operations rather than DCR. It is stored
 * as an ordinary oauth2_consumer_keys row (consumer key = the agent's client ID)
 * plus an oauth2_consumer_key_agent_mappings row with the agent ID. Everything else
 * about the key (list, read, delete, token) is the OAuth2 keys service's, which
 * reads agentKeys.js.
 *
 * Upstream first, and compensated: a portal write that fails after the agent exists
 * deletes the agent, so no live credential is left that the portal can't see.
 */

const db = require('../db/driver');
const oauth2KeyDao = require('../dao/oauth2ConsumerKeyDao');
const keyAgentMappingDao = require('../dao/oauth2KeyAgentMappingDao');
const keyAppMappingDao = require('../dao/oauth2KeyAppMappingDao');
const applicationDao = require('../dao/applicationDao');
const constants = require('../utils/constants');
const util = require('../utils/util');
const logger = require('../config/logger');
const { logUserAction } = require('../middlewares/auditLogger');
const kmRegistry = require('./keyManagerRegistry');
const agentKeys = require('./agentKeys');
const { forAgentKeys } = require('./oauth2KeyService');

const { toDetailDto, sendKeyManagerError } = forAgentKeys;
const { SUBJECT } = agentKeys;

// The key name of an AI agent key: what the developer calls it.
const AGENT_KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
// What an AI agent key's `properties` may carry.
const AGENT_KEY_PROPERTIES = Object.freeze(['client_name', 'grant_types', 'redirect_uris']);

async function _agentKeyManager(orgId, keyManagerId) {
    const km = await kmRegistry.resolveDriver(orgId, keyManagerId);
    if (!km) return { error: [404, constants.ERROR_MESSAGE.KEY_MANAGER_NOT_FOUND] };
    if (!km.agentKeysEnabled()) {
        return { error: [400, 'This key manager does not issue keys for AI agents.'] };
    }
    return { km };
}

// Callback URLs: as many as a developer reasonably registers, each a plain URL.
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2048;

/*
 * The grants and callback URLs asked for, checked against what this key manager
 * offers agent keys (declared by its driver). Client credentials is always
 * included: it is the agent's own identity, and what Get token uses.
 * @returns {{grants: string[], redirectUris: string[], forUsers: boolean} | {error: string}}
 */
function _checkAgentGrants(offered, properties) {
    const asked = properties.grant_types === undefined ? [] : properties.grant_types;
    if (!Array.isArray(asked) || asked.some((g) => typeof g !== 'string')) {
        return { error: '"grant_types" must be a list of grant type names.' };
    }
    const permitted = offered.map((g) => g.value);
    const rejected = asked.filter((g) => !permitted.includes(g));
    if (rejected.length) {
        return { error: `"grant_types" does not accept: ${rejected.join(', ')}. Permitted here: ${permitted.join(', ')}.` };
    }
    const grants = ['client_credentials', ...new Set(asked.filter((g) => g !== 'client_credentials'))];

    const uris = properties.redirect_uris === undefined ? [] : properties.redirect_uris;
    if (!Array.isArray(uris) || uris.some((u) => typeof u !== 'string')) {
        return { error: '"redirect_uris" must be a list of URLs.' };
    }
    const needsCallback = grants.includes('authorization_code');
    if (needsCallback && !uris.length) {
        return { error: 'The authorization code grant needs at least one callback URL ("redirect_uris").' };
    }
    if (!needsCallback && uris.length) {
        return { error: 'Callback URLs ("redirect_uris") are used only with the authorization code grant.' };
    }
    if (uris.length > MAX_REDIRECT_URIS) {
        return { error: `Give at most ${MAX_REDIRECT_URIS} callback URLs.` };
    }
    for (const uri of uris) {
        let parsed;
        try {
            parsed = uri.length <= MAX_URI_LENGTH ? new URL(uri) : null;
        } catch {
            parsed = null;
        }
        if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.hash) {
            return { error: 'Each callback URL must be an absolute http or https URL without a fragment.' };
        }
    }
    const forUsers = grants.some((g) => (offered.find((o) => o.value === g) || {}).forUsers === true);
    return { grants, redirectUris: uris, forUsers };
}

/**
 * POST /oauth2-keys with subjectType AGENT (the OAuth2 keys handler routes it here).
 *
 * `properties` takes the key's name (`client_name`), the grants the agent's client may
 * use (`grant_types`; client credentials always) and, for the authorization code
 * grant, its callback URLs (`redirect_uris`). A grant marked `forUsers` lets the agent
 * act on behalf of users.
 */
const createAgentKey = async (req, res) => {
    if (req.body && req.body.link !== undefined) return linkAgentKey(req, res);
    const orgId = req.orgId;
    const actor = util.resolveActor(req);
    const { keyManagerId } = req.body;
    const properties = req.body.properties && typeof req.body.properties === 'object' ? req.body.properties : {};
    const keyName = typeof properties.client_name === 'string' ? properties.client_name.trim() : '';
    try {
        const extra = Object.keys(properties).filter((k) => !AGENT_KEY_PROPERTIES.includes(k));
        if (extra.length) {
            return util.sendError(res, 400, `An AI agent key does not take: ${extra.join(', ')}. `
                + `It takes ${AGENT_KEY_PROPERTIES.join(', ')}.`);
        }
        if (!AGENT_KEY_NAME.test(keyName)) {
            return util.sendError(res, 400, 'Give the agent key a name of up to 63 letters, digits, dots, '
                + 'underscores or dashes, starting with a letter or digit.');
        }
        const { km, error } = await _agentKeyManager(orgId, keyManagerId);
        if (error) return util.sendError(res, error[0], error[1]);
        // The grants this key manager's driver offers agent keys.
        const checked = _checkAgentGrants(km.agentKeys.grantTypes || [], properties);
        if (checked.error) return util.sendError(res, 400, checked.error);
        const actsForUsers = checked.forUsers;

        const created = await km.createAgent({
            // As DCR sends client_name: the developer's key name, unchanged (K1).
            name: keyName, description: `API Portal key ${keyName}`,
            grantTypes: checked.grants, redirectUris: checked.redirectUris,
        });

        // The agent now exists upstream with working credentials. Said in the log before
        // anything is written, so that if this process stops before the rows below
        // commit, the agent can still be found and removed.
        logger.info('Agent created at the key manager; recording its key', {
            orgId, keyManagerId: km.id, agentId: created.agentId,
        });
        let record;
        try {
            // Both rows or neither: a key row without its mapping would be an agent key
            // the portal treats as an application key.
            record = await db.withTransaction(async () => {
                const row = await oauth2KeyDao.create({
                    orgId,
                    keyManagerId: km.id,
                    consumerKey: created.consumerKey,
                    name: keyName,
                    keyType: km.keyType || constants.KEY_TYPE.PRODUCTION,
                    createdBy: actor,
                    registration: null,
                });
                await keyAgentMappingDao.create(row.keyId, created.agentId, actor, actsForUsers);
                return row;
            });
        } catch (dbError) {
            logger.error('Failed to record a new agent key; deleting the agent at the key manager', {
                orgId, keyManagerId: km.id, agentId: created.agentId, error: dbError.message,
            });
            try {
                await km.deleteAgent(created.agentId);
            } catch (rollbackError) {
                logger.error('ORPHANED AGENT: created at the key manager, not recorded by the portal, and '
                    + 'could not be deleted. It must be deleted at the key manager by hand.', {
                    orgId, keyManagerId: km.id, agentId: created.agentId, rollbackError: rollbackError.message,
                });
            }
            throw dbError;
        }

        logUserAction('OAUTH2_KEY_CREATED', req, {
            orgId, keyId: record.keyId, keyManagerId: km.id, subjectType: SUBJECT.AGENT, agentId: created.agentId,
            actsForUsers, resourceUuid: record.keyId, resourceType: 'oauth2_key',
        });
        res.setHeader('Location', `${req.baseUrl}${req.path}/${encodeURIComponent(record.keyId)}`);
        const agent = { agentId: created.agentId, actsForUsers };
        const keyProperties = { client_name: keyName, grant_types: checked.grants };
        if (checked.redirectUris.length) keyProperties.redirect_uris = checked.redirectUris;
        // The only response that carries the secret: the identity server returns it once.
        return res.status(201).json(toDetailDto(record, km, {
            secret: created.consumerSecret,
            properties: keyProperties,
            agent,
        }));
    } catch (error) {
        if (sendKeyManagerError(res, error, constants.ERROR_MESSAGE.OAUTH2_KEY_CREATE_ERROR,
            { orgId, keyManagerId, operation: 'createAgent' })) {
            return undefined;
        }
        logger.error(constants.ERROR_MESSAGE.OAUTH2_KEY_CREATE_ERROR, { error });
        return util.sendError(res, 500, constants.ERROR_MESSAGE.OAUTH2_KEY_CREATE_ERROR);
    }
};

/*
 * Link an agent that already exists in the identity server (made there, or by
 * another system such as Agent Manager): POST /oauth2-keys with subjectType AGENT
 * and `link: { clientId }`.
 *
 * Exactly as an existing application is imported: on a key manager that records
 * existing clients (keyCreation `provide`), the client ID is recorded and nothing is
 * checked, created or changed upstream. Where it is added decides what it is: linked
 * here, it is an agent key. Get token asks for the secret (never stored), so a wrong
 * client ID shows there, as for an imported application. Deleting the key only
 * unlinks it, and its secret is rotated where it is managed (the key manager refuses
 * both upstream operations). No agent ID: nothing here uses one for a linked agent.
 *
 * Refused: a client the portal created an agent for (that key owns the agent's
 * lifecycle), and one this developer already linked.
 */
const LINK_FIELD = /^[^\s]{1,255}$/;

const linkAgentKey = async (req, res) => {
    const orgId = req.orgId;
    const actor = util.resolveActor(req);
    const { keyManagerId, link } = req.body;
    const properties = req.body.properties && typeof req.body.properties === 'object' ? req.body.properties : {};
    const keyName = typeof properties.client_name === 'string' ? properties.client_name.trim() : '';
    try {
        const extra = Object.keys(properties).filter((k) => k !== 'client_name');
        if (extra.length) {
            return util.sendError(res, 400, 'A linked agent key takes only a name (client_name): its settings are '
                + 'the agent\'s own.');
        }
        if (!AGENT_KEY_NAME.test(keyName)) {
            return util.sendError(res, 400, 'Give the agent key a name of up to 63 letters, digits, dots, '
                + 'underscores or dashes, starting with a letter or digit.');
        }
        const { clientId } = link && typeof link === 'object' ? link : {};
        if (typeof clientId !== 'string' || !LINK_FIELD.test(clientId)) {
            return util.sendError(res, 400, 'Give the client ID of the agent\'s OAuth client ("link.clientId").');
        }
        const km = await kmRegistry.resolveDriver(orgId, keyManagerId);
        if (!km) return util.sendError(res, 404, constants.ERROR_MESSAGE.KEY_MANAGER_NOT_FOUND);
        if (!agentKeys.isLinkKeyManager(km)) {
            return util.sendError(res, 400, 'Existing agents are linked on a key manager that records existing '
                + 'clients (keyCreation "provide"), as existing applications are imported.');
        }

        // Not a client the portal created an agent for, nor one this developer already linked.
        const held = await agentKeys.findByClient(orgId, clientId);
        for (const h of held) {
            const holder = h.keyManagerId === km.id ? km
                : await kmRegistry.resolveDriver(orgId, h.keyManagerId, { allowDisabled: true }).catch(() => null);
            if (!agentKeys.isLinkKeyManager(holder)) {
                return util.sendError(res, 409, 'The portal created this agent, so its key is already here. '
                    + 'Ask its owner, or generate a new agent key.');
            }
        }
        for (const h of held) {
            if (await oauth2KeyDao.get(orgId, h.keyId, actor)) {
                return util.sendError(res, 409, 'You have already linked this agent.');
            }
        }

        // Whether the agent may act for users isn't knowable here (nothing is read
        // upstream), so a linked key doesn't claim it.
        const actsForUsers = false;
        const record = await db.withTransaction(async () => {
            const row = await oauth2KeyDao.create({
                orgId,
                keyManagerId: km.id,
                consumerKey: clientId,
                name: keyName,
                keyType: km.keyType || constants.KEY_TYPE.PRODUCTION,
                createdBy: actor,
                registration: null,
            });
            await keyAgentMappingDao.create(row.keyId, null, actor, actsForUsers);
            return row;
        });

        logUserAction('OAUTH2_KEY_CREATED', req, {
            orgId, keyId: record.keyId, keyManagerId: km.id, subjectType: SUBJECT.AGENT,
            linked: true, resourceUuid: record.keyId, resourceType: 'oauth2_key',
        });
        res.setHeader('Location', `${req.baseUrl}${req.path}/${encodeURIComponent(record.keyId)}`);
        // No secret in the response: the developer already has it, and it was not kept.
        return res.status(201).json(toDetailDto(record, km, {
            properties: agentKeys.clientProperties(record),
            agent: { agentId: null, actsForUsers },
        }));
    } catch (error) {
        if (sendKeyManagerError(res, error, constants.ERROR_MESSAGE.OAUTH2_KEY_CREATE_ERROR,
            { orgId, keyManagerId, operation: 'linkAgent' })) {
            return undefined;
        }
        logger.error(constants.ERROR_MESSAGE.OAUTH2_KEY_CREATE_ERROR, { error });
        return util.sendError(res, 500, constants.ERROR_MESSAGE.OAUTH2_KEY_CREATE_ERROR);
    }
};

/**
 * POST /oauth2-keys/{keyId}/rotate-secret — operationId rotateOAuth2KeySecret.
 *
 * AI agent keys only: a new secret in the identity server, returned once; the old
 * one stops working at once. Any other key is answered 409 (its key manager's own
 * update decides whether a secret rotates).
 */
const rotateOAuth2KeySecret = async (req, res) => {
    const orgId = req.orgId;
    const { keyId } = req.params;
    try {
        const actor = util.resolveActor(req);
        const record = await oauth2KeyDao.get(orgId, keyId, actor);
        if (!record) {
            return util.sendError(res, 404, constants.ERROR_MESSAGE.OAUTH2_KEY_NOT_FOUND);
        }
        const agent = await agentKeys.findByKey(keyId);
        if (!agent) {
            return util.sendError(res, 409, 'Only an AI agent key can have its secret rotated here.');
        }
        const km = await kmRegistry.resolveDriver(orgId, record.keyManagerId);
        if (!km) {
            return util.sendError(res, 409, constants.ERROR_MESSAGE.OAUTH2_KEY_OPERATION_UNSUPPORTED);
        }
        if (agentKeys.isLinkKeyManager(km)) {
            return util.sendError(res, 409, 'This agent was linked, not created by the portal: rotate its secret '
                + 'where it is managed.');
        }
        const { consumerSecret, properties } = await km.rotateAgentSecret(agent.agentId);
        logUserAction('OAUTH2_KEY_SECRET_ROTATED', req, {
            orgId, keyId, keyManagerId: km.id, subjectType: SUBJECT.AGENT, agentId: agent.agentId,
            resourceUuid: keyId, resourceType: 'oauth2_key',
        });
        const appUuid = await keyAppMappingDao.getByKey(keyId);
        const app = appUuid ? await applicationDao.get(orgId, appUuid, actor) : null;
        return res.status(200).json(toDetailDto(record, km, {
            secret: consumerSecret,
            properties: properties || agentKeys.clientProperties(record),
            application: app ? { id: app.handle, displayName: app.display_name } : undefined,
            agent,
        }));
    } catch (error) {
        if (sendKeyManagerError(res, error, constants.ERROR_MESSAGE.OAUTH2_KEY_UPDATE_ERROR,
            { orgId, keyId, operation: 'rotateAgentSecret' })) {
            return undefined;
        }
        logger.error(constants.ERROR_MESSAGE.OAUTH2_KEY_UPDATE_ERROR, { error });
        return util.sendError(res, 500, constants.ERROR_MESSAGE.OAUTH2_KEY_UPDATE_ERROR);
    }
};

module.exports = { createAgentKey, rotateOAuth2KeySecret };
