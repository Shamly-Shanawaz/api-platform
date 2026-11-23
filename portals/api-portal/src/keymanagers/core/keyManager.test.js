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
 * Unit tests for the KeyManager base class: the agent key contract every driver inherits.
 */

const test = require('node:test');
const assert = require('node:assert');

const { KeyManager, KeyManagerCallError } = require('./keyManager');

class Bare extends KeyManager {
    constructor(cfg) {
        super(cfg);
        this.type = 'bare';
    }
    metadata() {
        return this._metaEnvelope([]);
    }
}

test('agent operations are refused (409) unless a driver implements them', async () => {
    const km = new Bare({});
    for (const op of ['createAgent', 'getAgent', 'rotateAgentSecret', 'deleteAgent']) {
        await assert.rejects(km[op]({}), (e) => e instanceof KeyManagerCallError
            && e.publicReason === 'unsupported_operation');
    }
});

test('agent keys: only a driver that declares them, with an agent registration endpoint, offers them', () => {
    const km = new Bare({});
    assert.equal(km.agentKeysEnabled(), false);
    assert.equal(km.metadata().agentKeys, undefined);
    km.agentKeys = { grantTypes: [{ value: 'client_credentials', label: 'Client credentials', forUsers: false }] };
    // Declared, but no endpoint to register agents at: still off.
    assert.equal(km.agentKeysEnabled(), false);
    km.agentRegistrationEndpoint = 'https://idp.example.com/agents';
    assert.equal(km.agentKeysEnabled(), true);
    // And an endpoint without a driver that can use it is off too.
    assert.equal(new Bare({ agentRegistrationEndpoint: 'https://idp.example.com/agents' }).agentKeysEnabled(), false);
    // A copy, so a caller can't change what the driver declares.
    const meta = km.metadata();
    meta.agentKeys.grantTypes[0].label = 'changed';
    assert.equal(km.agentKeys.grantTypes[0].label, 'Client credentials');
});
