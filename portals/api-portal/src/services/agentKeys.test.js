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
 * Unit tests for agentKeys.js: how a key is marked as an application's or an agent's.
 */

const test = require('node:test');
const assert = require('node:assert');

const path = require('node:path');

// The DAO opens the database on load; these pure functions never touch it.
const daoPath = path.join(__dirname, '..', 'dao', 'oauth2KeyAgentMappingDao.js');
require.cache[daoPath] = { id: daoPath, filename: daoPath, loaded: true, exports: {} };

const { markSubject } = require('./agentKeys');

test('markSubject: application by default; an agent with its ID and on-behalf-of flag', () => {
    assert.deepEqual(markSubject({}, null), { subjectType: 'APPLICATION' });
    assert.deepEqual(markSubject({}, { agentId: 'a1', actsForUsers: false }), { subjectType: 'AGENT', agentId: 'a1' });
    assert.deepEqual(markSubject({}, { agentId: 'a1', actsForUsers: true }),
        { subjectType: 'AGENT', agentId: 'a1', actsForUsers: true });
});

test('markSubject: an agent key on a key manager that records existing clients is linked', () => {
    assert.deepEqual(markSubject({}, { agentId: 'a1' }, { keyCreation: 'provide' }),
        { subjectType: 'AGENT', agentId: 'a1', linked: true });
    assert.deepEqual(markSubject({}, { agentId: 'a1' }, { keyCreation: 'register' }),
        { subjectType: 'AGENT', agentId: 'a1' });
    // An application key on such a key manager is just an imported application.
    assert.deepEqual(markSubject({}, null, { keyCreation: 'provide' }), { subjectType: 'APPLICATION' });
});
