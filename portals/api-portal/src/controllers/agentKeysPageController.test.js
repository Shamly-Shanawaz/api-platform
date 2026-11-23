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
 * The Agent Keys page lists only the caller's AI agent keys, and the OAuth2 Keys
 * page only the others. The template is never rendered: `renderTemplateWithView` is
 * replaced with a capture, so what is asserted is the model each page is handed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (file, exports) => {
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const local = (relative) => path.resolve(__dirname, relative);

let captured;
const RECORDS = [
    { keyId: 'k-app', name: 'web-app', keyType: 'PRODUCTION', keyManagerId: 'thunder', consumerKey: 'c-app', createdAt: 't1' },
    { keyId: 'k-bot', name: 'invoice-bot', keyType: 'PRODUCTION', keyManagerId: 'thunder', consumerKey: 'c-bot', createdAt: 't2' },
    { keyId: 'k-old', name: 'old-bot', keyType: 'SANDBOX', keyManagerId: 'retired', consumerKey: 'c-old', createdAt: 't3' },
    { keyId: 'k-ext', name: 'ext-bot', keyType: 'PRODUCTION', keyManagerId: 'imports', consumerKey: 'c-ext', createdAt: 't4' },
];
const AGENTS = new Map([
    ['k-bot', { agentId: 'agent-1', actsForUsers: true }],
    ['k-old', { agentId: 'agent-2', actsForUsers: false }],
    ['k-ext', { agentId: 'agent-3', actsForUsers: false }],
]);

stub(local('../config/logger.js'), { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
stub(local('../utils/util.js'), {
    renderTemplateWithView: async (_tpl, _layout, content) => { captured = content; return '<html></html>'; },
    resolveActor: () => 'alice',
    pageErrorStatus: () => 500,
});
stub(local('../dao/organizationDao.js'), { get: async () => ({ uuid: 'org-1' }) });
stub(local('../services/keyManagerRegistry.js'), {
    list: async () => [
        { handle: 'thunder', display_name: 'Thunder', enabled: 1 },
        { handle: 'retired', display_name: 'Retired', enabled: 0 },
        { handle: 'imports', display_name: 'Imports', enabled: 1 },
    ],
    // 'imports' records existing clients (a Provision key manager): its agent keys are linked.
    resolveDriver: async (_org, handle) => ({ id: handle, keyCreation: handle === 'imports' ? 'provide' : 'register' }),
});
stub(local('../dao/oauth2ConsumerKeyDao.js'), { listByCreator: async () => RECORDS });
// 'k-bot' is associated with the application 'shop'.
stub(local('../dao/oauth2KeyAppMappingDao.js'), {
    getByKeys: async (ids) => new Map(ids.filter((id) => id === 'k-bot').map((id) => [id, 'app-uuid-1'])),
});
stub(local('../dao/oauth2KeyAgentMappingDao.js'), {
    getByKeys: async (ids) => new Map(ids.filter((id) => AGENTS.has(id)).map((id) => [id, AGENTS.get(id)])),
});
stub(local('../dao/applicationDao.js'), {
    get: async (_org, uuid) => (uuid === 'app-uuid-1' ? { handle: 'shop', display_name: 'Shop' } : null),
    list: async () => [{ handle: 'shop', display_name: 'Shop' }, { handle: 'web', display_name: 'Web' }],
});

const { loadAgentKeys } = require('./agentKeysPageController');
const { loadOAuth2Keys } = require('./oauth2KeysPageController');

async function render(load) {
    captured = undefined;
    const req = { params: { orgName: 'acme', viewName: 'default' }, user: { sub: 'alice' } };
    await load(req, { send: () => {}, redirect: () => {} }, (err) => { throw err; });
    return captured;
}

test('the Agent Keys page lists the agent keys, with their agent ID and key manager', async () => {
    const model = await render(loadAgentKeys);
    assert.deepEqual(model.agentKeys.map((k) => k.keyId), ['k-bot', 'k-old', 'k-ext']);
    const bot = model.agentKeys[0];
    assert.equal(bot.agentId, 'agent-1');
    assert.equal(bot.actsForUsers, true);
    assert.equal(bot.keyManagerName, 'Thunder');
    assert.equal(bot.keyManagerEnabled, true);
    // Rotation goes through the key manager, so a disabled one doesn't offer it.
    assert.equal(model.agentKeys[1].keyManagerEnabled, false);
    // Linked: it lives on a key manager that records existing clients.
    assert.equal(bot.linked, false);
    assert.equal(model.agentKeys[2].linked, true);
    assert.equal(model.keysLoadError, false);
});

test('the OAuth2 Keys page leaves agent keys out', async () => {
    const model = await render(loadOAuth2Keys);
    assert.deepEqual(model.oauth2Keys.map((k) => k.keyId), ['k-app']);
});

test('agent keys can be associated with applications, as OAuth2 keys are', async () => {
    const model = await render(loadAgentKeys);
    const bot = model.agentKeys.find((k) => k.keyId === 'k-bot');
    assert.equal(bot.applicationId, 'shop');
    assert.equal(bot.applicationName, 'Shop');
    assert.equal(model.agentKeys.find((k) => k.keyId === 'k-old').applicationId, '');
    // The picker: 'shop' already holds a production key (this agent key), 'web' holds none.
    assert.deepEqual(model.applications, [
        { id: 'shop', displayName: 'Shop', takenTypes: ['PRODUCTION'] },
        { id: 'web', displayName: 'Web', takenTypes: [] },
    ]);
});
