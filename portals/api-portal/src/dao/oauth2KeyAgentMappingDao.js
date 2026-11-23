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
 * Data access for `oauth2_consumer_key_agent_mappings`: which OAuth2 keys are AI
 * agent keys, and the identity server's agent ID for each. A row present = agent key.
 *
 * Like oauth2_consumer_key_app_mappings, no `org_uuid`: the key row is org-scoped and
 * the service resolves it through oauth2ConsumerKeyDao (organization and owner
 * filters) before this module is reached.
 */

const db = require('../db/driver');
const { getPortalId } = require('../utils/orgContext');

const TABLE = 'oauth2_consumer_key_agent_mappings';

/**
 * Mark a key as an agent key: the agent `agentId`'s (the portal created it), or, with
 * no agent ID, a linked agent's (managed elsewhere). `actsForUsers`: the agent may
 * also get tokens on behalf of users.
 */
const create = async (keyId, agentId, actor, actsForUsers = false) => {
    await db.execute(
        `INSERT INTO ${TABLE} (key_uuid, portal_id, agent_id, acts_for_users, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [keyId, getPortalId(), agentId || null, actsForUsers ? 1 : 0, actor]
    );
};

const toAgent = (row) => ({
    agentId: row.agent_id || null,
    actsForUsers: Number(row.acts_for_users) === 1,
});

/** The agent behind an agent key, or null for any other key. */
const getByKey = async (keyId) => {
    const row = await db.queryOne(
        `SELECT agent_id, acts_for_users FROM ${TABLE} WHERE portal_id = ? AND key_uuid = ?`,
        [getPortalId(), keyId]
    );
    return row ? toAgent(row) : null;
};

/**
 * The agent behind each agent key among these, in one query.
 * @returns {Promise<Map<string, {agentId: string, actsForUsers: boolean}>>} agent keys only
 */
const getByKeys = async (keyIds) => {
    const result = new Map();
    if (!keyIds || !keyIds.length) return result;
    const placeholders = keyIds.map(() => '?').join(', ');
    const rows = await db.query(
        `SELECT key_uuid, agent_id, acts_for_users FROM ${TABLE} WHERE portal_id = ? AND key_uuid IN (${placeholders})`,
        [getPortalId(), ...keyIds]
    );
    for (const row of rows || []) {
        result.set(row.key_uuid, toAgent(row));
    }
    return result;
};

/**
 * The agent keys held for one client ID in an organization, across developers, with
 * the key manager each lives on. Checked before linking, so an agent the portal
 * created is not linked again.
 * @returns {Promise<Array<{keyId: string, keyManagerId: string}>>}
 */
const listByClient = async (orgId, clientId) => {
    const rows = await db.query(
        `SELECT m.key_uuid, k.key_manager_id FROM ${TABLE} m
           JOIN oauth2_consumer_keys k ON k.portal_id = m.portal_id AND k.uuid = m.key_uuid
          WHERE m.portal_id = ? AND k.org_uuid = ? AND k.consumer_key = ?`,
        [getPortalId(), orgId, clientId]
    );
    return (rows || []).map((row) => ({ keyId: row.key_uuid, keyManagerId: row.key_manager_id }));
};

/**
 * How many agent keys a key manager holds in this organization. Checked before its
 * agent registration endpoint is cleared: those keys would be left with nothing to
 * rotate or delete them through.
 */
const countByKeyManager = async (orgId, keyManagerId) => {
    const row = await db.queryOne(
        `SELECT COUNT(*) AS total FROM ${TABLE} m
           JOIN oauth2_consumer_keys k ON k.portal_id = m.portal_id AND k.uuid = m.key_uuid
          WHERE m.portal_id = ? AND k.org_uuid = ? AND k.key_manager_id = ?`,
        [getPortalId(), orgId, keyManagerId]
    );
    // COUNT comes back as a string on some drivers and a number on others.
    return Number((row && row.total) || 0);
};

module.exports = { create, getByKey, getByKeys, listByClient, countByKeyManager };
