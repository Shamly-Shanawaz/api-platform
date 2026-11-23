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
 * AI agent keys on a ThunderID key manager: the agent operations the `thunderid`
 * driver takes on when its key manager has an agent registration endpoint
 * (`agentRegistrationEndpoint` in its settings; Thunder's `https://<thunder>/agents`).
 *
 * An AI agent key is a ThunderID *agent* with an OAuth client, made through
 * Thunder's own agent API rather than DCR (DCR only ever makes applications). The
 * same key manager, token endpoint and provisioning credential serve both kinds of
 * key; only where a client is registered differs. Kept in a module of its own so
 * the DCR driver itself changes by a few lines.
 */

const crypto = require('crypto');
const { KeyManagerCallError } = require('../core/keyManager');

// RFC 8693: how an agent swaps a user's token for one that acts on that user's behalf.
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
// The agent type Thunder creates at startup; its schema requires a unique `name`.
const AGENT_TYPE = 'default';
// Grants that let an agent act for a user. Thunder refuses a `delegated` agent without
// one (AGT-1044) and forgets `delegated` unless a replace sends it again.
const USER_GRANTS = new Set([
    'authorization_code', TOKEN_EXCHANGE_GRANT, 'urn:openid:params:grant-type:ciba',
    'urn:ietf:params:oauth:grant-type:device_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer',
]);
// What a GET of an agent returns that no write takes. Left out of the rotation PUT
// for tidiness: Thunder would ignore them anyway.
const AGENT_READ_ONLY_FIELDS = new Set([
    'id', 'ouHandle', 'display', 'clientId', 'status', 'lastLoginAt', 'lifespan', 'isReadOnly', 'isOwnedByOU',
]);
// Thunder's answer when a control plane deployed the agent: only it can change or delete it.
const MANAGED_AGENT_CODE = 'AGT-1063';
/*
 * What an agent key here can be. `forUsers` marks the grants that let the agent act
 * on behalf of a user (Thunder then marks the agent `delegated`). CIBA and the device
 * code grant need a notification or device flow set up in Thunder first, and
 * jwt-bearer a trusted issuer, so they are not offered.
 */
const AGENT_KEYS = Object.freeze({
    grantTypes: Object.freeze([
        Object.freeze({ value: 'client_credentials', label: 'Client credentials', forUsers: false }),
        Object.freeze({ value: 'authorization_code', label: 'Authorization code', forUsers: true }),
        Object.freeze({ value: TOKEN_EXCHANGE_GRANT, label: 'Token exchange', forUsers: true }),
    ]),
});

/*
 * The agent operations. Written as a class for its method syntax only: its methods
 * are copied onto the driver (withAgentOperations), where `this` is the ThunderID
 * key manager and `_call` and `agentRegistrationEndpoint` come from it.
 */
class AgentOperations {
    /*
     * Shapes follow Thunder `main` (heading for 2.0.0), and everything is chosen as
     * Thunder's DCR chooses it for applications:
     *
     *   - The name is the developer's key name, in `attributes.name` (the `default`
     *     agent type makes it required and unique). A taken name is 409, as for DCR.
     *   - No `ouId` and no owner: Thunder files the agent in its system OU, which is
     *     where the `default` agent type lives, and makes the caller (the portal's
     *     provisioning app) the owner.
     *   - The client id and secret come back once, in inboundAuthConfig[0].config.
     *   - Acting on behalf of users: the client also holds a user grant (authorization
     *     code, token exchange) and the agent is `delegated`. Thunder puts `act.sub` =
     *     the agent on every user token an agent gets, so nothing else is asked for.
     *     Authorization code is set up as Thunder sets it up for delegated agents: with
     *     a refresh token, `code` responses and PKCE required. `delegated` is
     *     write-only, so rotation sends it again.
     *   - Rotation has no REST operation of its own: PUT is a full replace that clears
     *     what it omits, so the agent is read and sent back whole with a new secret.
     *     Thunder ignores fields a request doesn't take, so what a GET returns can go
     *     back as it is; only fields that are read-only on every version are left out.
     *   - 404 on delete means already gone. 403 AGT-1063: a control plane deployed the
     *     agent, and only it can change it.
     * The calls authenticate with the portal's provisioning credential.
     */

    // The agent API: the configured endpoint (`…/agents`), or one agent under it.
    _agentUrl(agentId) {
        const base = String(this.agentRegistrationEndpoint || '').replace(/\/+$/, '');
        return agentId ? `${base}/${encodeURIComponent(agentId)}` : base;
    }

    /**
     * @param {{name: string, description?: string, grantTypes: string[], redirectUris?: string[]}} agent
     *        grantTypes from agentKeys.grantTypes (the service checks them); client
     *        credentials is always included.
     * @returns {Promise<{agentId: string, consumerKey: string, consumerSecret: string}>}
     */
    async createAgent({ name, description, grantTypes = [], redirectUris = [] }) {
        const grants = ['client_credentials', ...grantTypes.filter((g) => g !== 'client_credentials')];
        const oauth = { grantTypes: grants, tokenEndpointAuthMethod: 'client_secret_basic' };
        if (grants.includes('authorization_code')) {
            oauth.grantTypes.push('refresh_token');
            oauth.redirectUris = redirectUris;
            oauth.responseTypes = ['code'];
            oauth.pkceRequired = true;
        }
        const body = {
            type: AGENT_TYPE,
            attributes: { name },
            inboundAuthConfig: [{ type: 'oauth2', config: oauth }],
        };
        if (grants.some((grant) => USER_GRANTS.has(grant))) body.delegated = true;
        if (description) body.description = description;
        const created = await this._call('POST', this._agentUrl(), body, [200, 201]);
        const config = created && Array.isArray(created.inboundAuthConfig) && created.inboundAuthConfig[0]
            ? created.inboundAuthConfig[0].config || {}
            : {};
        if (!created || !created.id || !config.clientId || !config.clientSecret) {
            // Created without usable credentials: remove it rather than leave it behind,
            // and say so if that fails too.
            if (created && created.id) {
                await this.deleteAgent(created.id).catch((cleanupError) => {
                    throw new KeyManagerCallError('upstream_error',
                        `thunderid: agent ${created.id} was created without client credentials and could not `
                        + `be deleted (${cleanupError.message}); delete it in ThunderID by hand`, null);
                });
            }
            throw new KeyManagerCallError('upstream_error', 'thunderid: agent created without client credentials', null);
        }
        return { agentId: created.id, consumerKey: config.clientId, consumerSecret: config.clientSecret };
    }

    /**
     * What the agent's client is now, read from Thunder: its client ID, and its
     * settings in the shape of a key's `properties` (as getKey reads a DCR client back).
     * @returns {Promise<{clientId: string, properties: {client_name: string, grant_types: string[], redirect_uris?: string[]}}>}
     */
    async getAgent(agentId) {
        const current = await this._managedCall('GET', this._agentUrl(agentId), null, [200]);
        const auth = (current && Array.isArray(current.inboundAuthConfig) ? current.inboundAuthConfig : [])
            .find((entry) => entry && entry.type === 'oauth2');
        return {
            clientId: (auth && auth.config && auth.config.clientId) || '',
            properties: this._agentProperties(current),
        };
    }

    _agentProperties(agent) {
        const auth = (agent && Array.isArray(agent.inboundAuthConfig) ? agent.inboundAuthConfig : [])
            .find((entry) => entry && entry.type === 'oauth2');
        const config = (auth && auth.config) || {};
        const properties = {
            client_name: (agent && agent.attributes && agent.attributes.name) || '',
            grant_types: Array.isArray(config.grantTypes) ? config.grantTypes : [],
        };
        if (Array.isArray(config.redirectUris) && config.redirectUris.length) {
            properties.redirect_uris = config.redirectUris;
        }
        return properties;
    }

    /**
     * A new secret for the agent's client; the old one stops working at once.
     * @returns {Promise<{consumerSecret: string, properties: object}>} the client as getAgent reads it
     */
    async rotateAgentSecret(agentId) {
        const url = this._agentUrl(agentId);
        const current = await this._managedCall('GET', url, null, [200]);
        const auth = (current && Array.isArray(current.inboundAuthConfig) ? current.inboundAuthConfig : [])
            .find((entry) => entry && entry.type === 'oauth2');
        if (!auth || !auth.config || !auth.config.clientId) {
            throw new KeyManagerCallError('upstream_error', 'thunderid: agent has no OAuth client to rotate', null);
        }
        const secret = crypto.randomBytes(32).toString('base64url');
        const body = {};
        for (const [field, value] of Object.entries(current)) {
            if (!AGENT_READ_ONLY_FIELDS.has(field)) body[field] = value;
        }
        body.inboundAuthConfig = current.inboundAuthConfig.map((entry) => (entry === auth
            ? { ...entry, config: { ...entry.config, clientSecret: secret } }
            : entry));
        // `delegated` is never read back: an agent that acts for users keeps it only if
        // the replace sends it again.
        const grants = Array.isArray(auth.config.grantTypes) ? auth.config.grantTypes : [];
        if (grants.some((grant) => USER_GRANTS.has(grant))) body.delegated = true;
        await this._managedCall('PUT', url, body, [200]);
        return { consumerSecret: secret, properties: this._agentProperties(current) };
    }

    async deleteAgent(agentId) {
        await this._managedCall('DELETE', this._agentUrl(agentId), null, [200, 202, 204]);
    }

    // _call, with Thunder's "deployed by a control plane" refusal named for what it is.
    async _managedCall(method, url, body, okStatuses) {
        try {
            return await this._call(method, url, body, okStatuses);
        } catch (err) {
            if (err instanceof KeyManagerCallError && err.upstreamStatus === 403
                && String(err.detail || '').includes(MANAGED_AGENT_CODE)) {
                throw new KeyManagerCallError('managed_elsewhere', err.detail, err.upstreamStatus);
            }
            throw err;
        }
    }
}

/** Give a driver class the agent operations. Its instances declare AGENT_KEYS. */
function withAgentOperations(DriverClass) {
    for (const name of Object.getOwnPropertyNames(AgentOperations.prototype)) {
        if (name === 'constructor') continue;
        Object.defineProperty(DriverClass.prototype, name,
            Object.getOwnPropertyDescriptor(AgentOperations.prototype, name));
    }
    return DriverClass;
}

module.exports = { AGENT_KEYS, withAgentOperations };
