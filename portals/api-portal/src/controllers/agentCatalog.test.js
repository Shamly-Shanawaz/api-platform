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
 * The agent's public card and its ARD entry: the stored source card byte for byte,
 * else a Markdown pointer.
 */

const test = require('node:test');
const assert = require('node:assert');
const { publicCard, ardEntry } = require('./agentCatalog');

const URL = 'https://agents.example.com/a';
const PAGE = 'https://portal.example.com/p/default/views/default/agent/a';
const CARD_BYTES = Buffer.from('{"name":"Card","skills":[{"id":"triage","name":"Triage","examples":["Check INV-9"]}]}');

const meta = (agent, extra = {}) => ({ id: 'a', name: 'Agent A', version: 'v1.2', description: 'Does things.', agent, ...extra });

test('the stored Agent Card is served byte for byte', () => {
    const m = meta({ types: ['API'], interfaces: [
        { type: 'REST', endpoints: { productionUrl: URL } },
        { type: 'A2A', endpoints: { productionUrl: URL } },
    ] });
    const card = publicCard(m, { AGENT_CARD: { type: 'AGENT_CARD', content: CARD_BYTES } });
    assert.equal(card.bytes.toString(), CARD_BYTES.toString());
    // A card left over without an A2A interface is not served.
    const restOnly = meta({ types: ['API'], interfaces: [{ type: 'REST', endpoints: { productionUrl: URL } }] });
    assert.equal(publicCard(restOnly, { AGENT_CARD: { type: 'AGENT_CARD', content: CARD_BYTES } }), null);
    // No card stored: none served (the portal never builds one).
    assert.equal(publicCard(m, {}), null);
});

test('ARD entries: card agents point at the card, others at the Markdown view', () => {
    const withCard = ardEntry(meta({}, { tags: ['finance'] }), {
        publisher: 'portal.example.com', orgHandle: 'acme', pageUrl: PAGE,
        card: { parsed: JSON.parse(CARD_BYTES.toString()) },
    });
    assert.deepEqual(withCard, {
        identifier: 'urn:air:portal.example.com:acme:agent:a',
        displayName: 'Agent A',
        type: 'application/a2a-agent-card+json',
        url: `${PAGE}/agent-card.json`,
        description: 'Does things.',
        version: 'v1.2',
        tags: ['finance'],
        capabilities: ['triage'],
        representativeQueries: ['Check INV-9'],
    });
    const plain = ardEntry(meta({ skills: [{ id: 'x', name: 'X' }] }), { publisher: 'p', pageUrl: PAGE, card: null });
    assert.equal(plain.type, 'text/markdown');
    assert.equal(plain.url, `${PAGE}.md`);
    assert.deepEqual(plain.capabilities, ['x']);
    assert.equal(plain.representativeQueries, undefined);
});

test('ARD entries: at most 5 representative queries; capabilities are skill ids only', () => {
    const skills = [
        { id: 'one', name: 'One', examples: ['q1', 'q2', 'q3'] },
        { name: 'No id', examples: ['q4', 'q5', 'q6'] },
    ];
    const entry = ardEntry(meta({ skills }), { publisher: 'p.example.com', orgHandle: 'acme', pageUrl: PAGE, card: null });
    assert.deepEqual(entry.representativeQueries, ['q1', 'q2', 'q3', 'q4', 'q5']);
    assert.deepEqual(entry.capabilities, ['one']);
});
