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

/* Agent intake: what prepareAgentArtifact carries from the document and the Agent Card
   into the metadata row. The validator's rules are tested in agentArtifactValidation. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-agent-intake-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
const cfgFile = path.join(tmpDir, 'config.toml');
fs.writeFileSync(cfgFile, `
[api_portal.security]
encryption_key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
session_secret = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

[api_portal.organization]
handle = "default"
portal_id = "test-portal"
`);
process.argv.push('--config', cfgFile);

const { prepareAgentArtifact } = require('./agentIntake');

const URL = 'https://agents.example.com/a';
const CARD = {
    name: 'Invoice agent', version: '1.0.0', description: 'Sorts invoices',
    supportedInterfaces: [{ url: `${URL}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    skills: [
        { id: 'triage', name: 'Triage', description: 'Sorts invoices', tags: ['finance', ' '] },
        { id: 'nameless' },
        'not a skill',
    ],
};
const upload = (content) => ({ fileName: 'agent-card.json', buffer: Buffer.from(JSON.stringify(content)) });

function prepare(extra = {}, card = CARD, existing = null) {
    const apiMetadata = {
        agentDocumentMetadata: { name: 'invoice-agent' },
        agentSpec: { types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] },
        ...extra,
    };
    prepareAgentArtifact(apiMetadata, { a2aDefinition: upload(card) }, existing);
    return apiMetadata;
}

test('the card fills the listing and its skills are kept on the agent for the listing', () => {
    const meta = prepare();
    assert.equal(meta.name, 'Invoice agent');
    assert.deepEqual(meta.agent.fromCard, ['displayName', 'version', 'description']);
    assert.deepEqual(meta.agent.cardSkills, [
        { name: 'Triage', description: 'Sorts invoices', tags: ['finance'] },
        { name: 'nameless' },
    ]);
    // The agent's own skills stay YAML skills only.
    assert.equal(meta.agent.skills, undefined);
});

test('a card without skills keeps no card skills', () => {
    assert.equal(prepare({}, { ...CARD, skills: [] }).agent.cardSkills, undefined);
});

test('on update, empty labels and reference id clear them', () => {
    const meta = prepare({ labels: [], referenceId: '' }, CARD, { definitions: {}, skillIds: {} });
    assert.deepEqual(meta.labels, []);
    assert.equal(meta.referenceId, '');
});

test('on create, empty labels and reference id count as absent', () => {
    const meta = prepare({ labels: [], referenceId: '  ' });
    assert.equal(meta.labels, undefined);
    assert.equal(meta.referenceId, undefined);
    const kept = prepare({ labels: ['partners'], referenceId: 'ref-1' });
    assert.deepEqual(kept.labels, ['partners']);
    assert.equal(kept.referenceId, 'ref-1');
});
