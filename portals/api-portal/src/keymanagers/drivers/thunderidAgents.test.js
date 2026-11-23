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
 * Unit tests for AI agent keys on the ThunderID driver: the requests it puts on the
 * wire to Thunder's agent API (Thunder main), through the real _call and status
 * reading, with `authRequest` stubbed so nothing is dialled.
 */

const test = require('node:test');
const assert = require('node:assert');

const { ThunderIdKeyManager } = require('./thunderid');
const { KeyManagerCallError } = require('../core/keyManager');

const CFG = Object.freeze({
    id: 'thunder', displayName: 'Thunder', tokenEndpoint: 'https://idp.example.com/oauth2/token',
    registrationEndpoint: 'https://idp.example.com/oauth2/dcr/register',
});

function driver(responses, cfg) {
    const calls = [];
    const queue = Array.isArray(responses) ? responses.slice() : [responses];
    const km = new ThunderIdKeyManager(Object.assign({}, CFG, cfg), (url, opts) => {
        calls.push({ url, ...opts });
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
    });
    return { km, calls };
}


// ---------------------------------------------------------------------------
// AI agent keys: Thunder's /agents API (shapes of Thunder main, heading for 2.0.0)
// ---------------------------------------------------------------------------

const AGENT_CFG = { agentRegistrationEndpoint: 'https://idp.example.com/agents' };
const TX = 'urn:ietf:params:oauth:grant-type:token-exchange';
const CREATED = {
    status: 201,
    data: { id: 'agent-1', ouId: 'ou-system', type: 'default', attributes: { name: 'invoice-bot' },
        inboundAuthConfig: [{ type: 'oauth2', config: { clientId: 'cid', clientSecret: 'sec', grantTypes: ['client_credentials'] } }] },
};
// What GET /agents/{id} returns on main: read-only fields beside the writable ones.
const AGENT_GET = (grants, extra) => ({ status: 200, data: Object.assign({
    id: 'agent-1', ouId: 'ou-system', ouHandle: 'default', type: 'default', display: 'invoice-bot',
    description: 'API Portal key invoice-bot', clientId: 'cid', owner: { id: 'app-1', idType: 'uuid', isLocal: true },
    attributes: { name: 'invoice-bot' }, status: { status: 'ACTIVE' }, lastLoginAt: '2026-11-12T00:00:00Z',
    lifespan: { phase: 'ACTIVE' }, isReadOnly: false, isOwnedByOU: true, kind: 'default',
    allowedUserTypes: ['customer'],
    inboundAuthConfig: [{ type: 'oauth2', config: { clientId: 'cid', grantTypes: grants,
        token: { accessToken: { userAttributes: ['sub_type'] } }, scopeClaims: { roles: ['roles'] } } }],
}, extra || {}) });

test('agent keys are on only where an agent registration endpoint is set', async () => {
    const off = driver([]).km;
    assert.equal(off.agentKeysEnabled(), false);
    assert.equal(off.metadata().agentKeys, undefined);

    const on = driver([], AGENT_CFG).km;
    assert.equal(on.agentKeysEnabled(), true);
    // Still the ordinary ThunderID key manager: it registers applications as before.
    assert.equal(on.keyCreation, 'register');
    assert.ok(on.metadata().properties.some((p) => p.name === 'grant_types'));
    assert.deepEqual(on.metadata().agentKeys, { grantTypes: [
        { value: 'client_credentials', label: 'Client credentials', forUsers: false },
        { value: 'authorization_code', label: 'Authorization code', forUsers: true },
        { value: TX, label: 'Token exchange', forUsers: true },
    ] });
    // A copy: a caller narrowing the metadata can't change what the driver declares.
    on.metadata().agentKeys.grantTypes.length = 0;
    assert.equal(on.metadata().agentKeys.grantTypes.length, 3);
});

test('one key manager, two endpoints: applications over DCR, agents over the agent API', async () => {
    const { km, calls } = driver([
        { status: 201, data: { client_id: 'app-cid', client_secret: 'app-sec', client_name: 'shop' } },
        CREATED,
    ], AGENT_CFG);
    await km.createKey({ client_name: 'shop', grant_types: ['client_credentials'] });
    await km.createAgent({ name: 'invoice-bot' });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
        'POST https://idp.example.com/oauth2/dcr/register',
        'POST https://idp.example.com/agents',
    ]);
});

test('createAgent: one POST /agents, named as given in attributes.name, no OU and no owner (as DCR)', async () => {
    const { km, calls } = driver([CREATED], AGENT_CFG);
    const out = await km.createAgent({ name: 'invoice-bot', description: 'API Portal key invoice-bot' });
    assert.deepEqual(out, { agentId: 'agent-1', consumerKey: 'cid', consumerSecret: 'sec' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://idp.example.com/agents');
    assert.deepEqual(JSON.parse(calls[0].data), {
        type: 'default', attributes: { name: 'invoice-bot' }, description: 'API Portal key invoice-bot',
        inboundAuthConfig: [{ type: 'oauth2', config: { grantTypes: ['client_credentials'], tokenEndpointAuthMethod: 'client_secret_basic' } }],
    });
});

test('createAgent: a token exchange grant makes the agent delegated, nothing else', async () => {
    const { km, calls } = driver([CREATED], AGENT_CFG);
    await km.createAgent({ name: 'obo-bot', grantTypes: [TX] });
    const body = JSON.parse(calls[0].data);
    assert.equal(body.delegated, true);
    assert.deepEqual(body.inboundAuthConfig[0].config, {
        grantTypes: ['client_credentials', TX], tokenEndpointAuthMethod: 'client_secret_basic',
    });
});

test('createAgent: authorization code is set up as Thunder sets it up for delegated agents', async () => {
    const { km, calls } = driver([CREATED], AGENT_CFG);
    await km.createAgent({ name: 'web-bot', grantTypes: ['client_credentials', 'authorization_code'],
        redirectUris: ['https://bot.example.com/callback'] });
    const body = JSON.parse(calls[0].data);
    assert.equal(body.delegated, true);
    assert.deepEqual(body.inboundAuthConfig[0].config, {
        grantTypes: ['client_credentials', 'authorization_code', 'refresh_token'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: ['https://bot.example.com/callback'], responseTypes: ['code'], pkceRequired: true,
    });
});

test('getAgent: the client read back as key properties', async () => {
    const got = AGENT_GET(['client_credentials', 'authorization_code', 'refresh_token']);
    got.data.inboundAuthConfig[0].config.redirectUris = ['https://bot.example.com/callback'];
    const { km, calls } = driver([got], AGENT_CFG);
    assert.deepEqual(await km.getAgent('agent-1'), { clientId: 'cid', properties: {
        client_name: 'invoice-bot', grant_types: ['client_credentials', 'authorization_code', 'refresh_token'],
        redirect_uris: ['https://bot.example.com/callback'],
    } });
    assert.equal(calls[0].method, 'GET');
});

test('createAgent: a taken name is the same conflict a DCR key gets', async () => {
    const taken = { status: 409, data: { code: 'AGT-1014', message: 'Attribute conflict' } };
    await assert.rejects(driver([taken], AGENT_CFG).km.createAgent({ name: 'x' }),
        (e) => e instanceof KeyManagerCallError && e.publicReason === 'conflict');
});

test('createAgent: an agent created without credentials is deleted, not left behind', async () => {
    const bare = { status: 201, data: { id: 'agent-2', inboundAuthConfig: [] } };
    const { km, calls } = driver([bare, { status: 204, data: '' }], AGENT_CFG);
    await assert.rejects(km.createAgent({ name: 'x' }), (e) => e.publicReason === 'upstream_error');
    assert.equal(calls[1].method, 'DELETE');
    assert.equal(calls[1].url, 'https://idp.example.com/agents/agent-2');
});

test('createAgent: a clean-up that fails too is reported, not swallowed', async () => {
    const bare = { status: 201, data: { id: 'agent-3', inboundAuthConfig: [] } };
    await assert.rejects(driver([bare, { status: 500, data: {} }], AGENT_CFG).km.createAgent({ name: 'x' }),
        (e) => e.publicReason === 'upstream_error' && /agent-3 .*could not be deleted/.test(e.detail));
});

test('rotateAgentSecret: reads the agent and PUTs every writable field back with a new secret', async () => {
    const { km, calls } = driver([AGENT_GET(['client_credentials']), { status: 200, data: {} }], AGENT_CFG);
    const { consumerSecret, properties } = await km.rotateAgentSecret('agent-1');
    assert.ok(consumerSecret.length >= 32);
    assert.deepEqual(properties, { client_name: 'invoice-bot', grant_types: ['client_credentials'] });
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].url, 'https://idp.example.com/agents/agent-1');
    const body = JSON.parse(calls[1].data);
    for (const readOnly of ['id', 'ouHandle', 'display', 'clientId', 'status', 'lastLoginAt', 'lifespan',
        'isReadOnly', 'isOwnedByOU']) {
        assert.equal(body[readOnly], undefined, readOnly);
    }
    // A full replace clears what it omits, so everything writable goes back,
    // including fields this driver knows nothing about (allowedUserTypes).
    assert.equal(body.type, 'default');
    assert.equal(body.ouId, 'ou-system');
    assert.deepEqual(body.attributes, { name: 'invoice-bot' });
    assert.deepEqual(body.owner, { id: 'app-1', idType: 'uuid', isLocal: true });
    assert.deepEqual(body.allowedUserTypes, ['customer']);
    assert.equal(body.kind, 'default');
    const config = body.inboundAuthConfig[0].config;
    assert.equal(config.clientSecret, consumerSecret);
    assert.deepEqual(config.token, { accessToken: { userAttributes: ['sub_type'] } });
    assert.deepEqual(config.scopeClaims, { roles: ['roles'] });
    assert.equal(body.delegated, undefined);
});

test('rotateAgentSecret: an agent with a user grant is sent back delegated (Thunder never reads it back)', async () => {
    const { km, calls } = driver([AGENT_GET(['client_credentials', TX]), { status: 200, data: {} }], AGENT_CFG);
    await km.rotateAgentSecret('agent-1');
    assert.equal(JSON.parse(calls[1].data).delegated, true);
});

test('an agent a control plane deployed (AGT-1063) is refused as managed elsewhere', async () => {
    const managed = { status: 403, data: { code: 'AGT-1063', message: 'Cannot modify an agent deployed by the control plane' } };
    await assert.rejects(driver([managed], AGENT_CFG).km.deleteAgent('agent-1'),
        (e) => e.publicReason === 'managed_elsewhere');
    await assert.rejects(driver([AGENT_GET(['client_credentials']), managed], AGENT_CFG).km.rotateAgentSecret('agent-1'),
        (e) => e.publicReason === 'managed_elsewhere');
    // Any other 403 is still the portal's own credential being refused.
    await assert.rejects(driver([{ status: 403, data: {} }], AGENT_CFG).km.deleteAgent('agent-1'),
        (e) => e.publicReason === 'provisioning_credential_rejected');
});

test('deleteAgent: DELETE /agents/{id}; 404 is classified as already gone', async () => {
    const { km, calls } = driver({ status: 204, data: '' }, AGENT_CFG);
    await km.deleteAgent('agent-1');
    assert.equal(calls[0].url, 'https://idp.example.com/agents/agent-1');
    await assert.rejects(driver({ status: 404, data: {} }, AGENT_CFG).km.deleteAgent('gone'),
        (e) => e.publicReason === 'client_not_found');
});
