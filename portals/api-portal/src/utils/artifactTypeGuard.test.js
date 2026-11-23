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
 * requireArtifactTypeForApi: the admin REST guard that refuses a resource family
 * whose artifact type is switched off in [api_portal.artifacts] enabled_types.
 * The portal here serves APIs only, so agents and MCP servers are off.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-artifact-guard-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const cfgFile = path.join(tmpDir, 'config.toml');
fs.writeFileSync(cfgFile, `
[api_portal.security]
encryption_key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
session_secret = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

[api_portal.organization]
handle = "default"
portal_id = "test-portal"

[api_portal.database]
type = "sqlite"
path = ${JSON.stringify(path.join(tmpDir, 'portal.db'))}

[api_portal.artifacts]
enabled_types = ["apis"]
`);
process.argv.push('--config', cfgFile);

const util = require('./util');
const constants = require('./constants');

function run(type) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ next: false, status: this.statusCode, body }); return this; },
        };
        util.requireArtifactTypeForApi(type)({}, res, () => resolve({ next: true }));
    });
}

test('lets a call through when its artifact type is enabled', async () => {
    assert.deepEqual(await run('apis'), { next: true });
});

test('refuses a call with 404 when its artifact type is disabled', async () => {
    const result = await run('agents');
    assert.equal(result.next, false);
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'RESOURCE_NOT_FOUND');
});

test('refuses an unknown or missing type (fails closed)', async () => {
    assert.equal((await run('not-a-type')).status, 404);
    assert.equal((await run(undefined)).status, 404);
});

test('agents is a known type, off unless listed', () => {
    assert.equal(util.artifactFlags().showAgentsNav, false);
    assert.equal(util.resolveApiType('agent'), constants.API_TYPE.AGENT);
});

test('MCP servers and agents are the dedicated-family types', () => {
    assert.deepEqual(constants.DEDICATED_FAMILY_TYPES, [constants.API_TYPE.MCP, constants.API_TYPE.AGENT]);
});
