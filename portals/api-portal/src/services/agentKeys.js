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
 * AI agent keys, as the OAuth2 keys service sees them.
 *
 * An agent key is an ordinary OAuth2 key (an oauth2_consumer_keys row) whose client
 * belongs to an agent in the identity server; an oauth2_consumer_key_agent_mappings
 * row says which agent. The OAuth2 keys service reads, lists, deletes and issues
 * tokens for every key; it asks this module whether a key is an agent key and how to
 * describe one. Creating and rotating agent keys live in agentKeyService.js.
 *
 * No dependency on the OAuth2 keys service, so it can require this module.
 */

const keyAgentMappingDao = require('../dao/oauth2KeyAgentMappingDao');

// Who a key is for: an application (DCR) or an AI agent.
const SUBJECT = Object.freeze({ APPLICATION: 'APPLICATION', AGENT: 'AGENT' });

/*
 * Whether an agent key was linked rather than created is the key manager's to say, as
 * it is for application keys: a key manager whose keyCreation is `provide` records
 * credentials made elsewhere (an imported application, a linked agent) and never
 * changes them upstream; one that registers creates them, and deletes them again.
 */
const isLinkKeyManager = (km) => Boolean(km && km.keyCreation === 'provide');

/**
 * Which of these key managers link agents rather than create them (a Set of ids), for
 * a list of keys that names its key managers without their drivers. A key manager
 * that can't be resolved (removed since) counts as not linking.
 */
async function linkKeyManagerIds(orgId, keyManagerIds) {
    // Required here, not at the top: this module stays loadable without the
    // configuration the registry needs (its unit test loads it bare).
    const kmRegistry = require('./keyManagerRegistry');
    const result = new Set();
    for (const id of new Set(keyManagerIds)) {
        const km = await kmRegistry.resolveDriver(orgId, id, { allowDisabled: true }).catch(() => null);
        if (isLinkKeyManager(km)) result.add(id);
    }
    return result;
}

/** The agent behind a key ({agentId, actsForUsers}), or null when it is not an agent key. */
const findByKey = (keyId) => keyAgentMappingDao.getByKey(keyId);

/** keyId → agent, for the agent keys among these keys (one query). */
const findByKeys = (keyIds) => keyAgentMappingDao.getByKeys(keyIds);

/** The agent keys held for one client ID in an organization, across developers: [{keyId, keyManagerId}]. */
const findByClient = (orgId, clientId) => keyAgentMappingDao.listByClient(orgId, clientId);

/**
 * Mark a key DTO with who it is for, and whether the agent may act on behalf of users
 * (it holds a grant for that; stored when the key was made, so a list needs no call
 * to the identity server).
 */
function markSubject(dto, agent, km) {
    dto.subjectType = agent ? SUBJECT.AGENT : SUBJECT.APPLICATION;
    if (!agent) return dto;
    // A linked agent has no agent ID here: it is managed elsewhere.
    if (agent.agentId) dto.agentId = agent.agentId;
    if (agent.actsForUsers) dto.actsForUsers = true;
    if (isLinkKeyManager(km)) dto.linked = true;
    return dto;
}

/**
 * What an agent key's client is when the identity server can't be asked: its name
 * and the one grant every agent key holds. Only for a key whose key manager is gone
 * or can't read agents back; otherwise the driver's getAgent answers.
 */
function clientProperties(record) {
    return { client_name: record.name || '', grant_types: ['client_credentials'] };
}

module.exports = {
    SUBJECT, isLinkKeyManager, linkKeyManagerIds, findByKey, findByKeys, findByClient, markSubject, clientProperties,
};
