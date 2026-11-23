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
 * What machine readers get for an agent: its public Agent Card and its entry in the
 * portal's ARD manifest (Agentic Resource Discovery, `/.well-known/ard.json`). Pure: the
 * caller supplies the stored definitions and the URLs; nothing is fetched.
 *
 * The card is the agent's stored Agent Card (every A2A interface has one). Agents without
 * A2A (REST, events, run it yourself) point at their Markdown view, since ARD has no
 * entry type for them.
 */

const constants = require('../utils/constants');

const { A2A } = constants.AGENT_INTERFACE_TYPES;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const asString = (value) => (typeof value === 'string' ? value : undefined);

/*
 * The stored Agent Card, while the agent has an A2A interface. `definitions` maps
 * content type -> { type, content }.
 */
function sourceCardDefinition(metadata, definitions) {
    const hasA2a = asArray(metadata?.agent?.interfaces).some((entry) => isPlainObject(entry) && entry.type === A2A);
    return hasA2a ? definitions?.[constants.DOC_TYPES.AGENT_CARD] || null : null;
}

/*
 * The agent's public card as bytes (the stored card exactly as uploaded), or null when
 * it has none.
 */
function publicCard(metadata, definitions) {
    const stored = sourceCardDefinition(metadata, definitions);
    return stored ? { bytes: Buffer.from(stored.content), parsed: parseJson(stored.content) } : null;
}

function parseJson(bytes) {
    try {
        return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString(constants.CHARSET_UTF8) : String(bytes));
    } catch {
        return null;
    }
}

// ARD v0.91 §4.2: representativeQueries "SHOULD contain 2–5 examples".
const MAX_REPRESENTATIVE_QUERIES = 5;

/*
 * One ARD v0.91 entry. `identifier` is `urn:air:<publisher>:<org>:agent:<handle>`: the
 * org handle keeps identifiers unique when several organizations' portals share a
 * domain. `type` is the A2A card media type with a card, else text/markdown for the
 * Markdown view. `representativeQueries` are the skills' examples (at most 5);
 * `capabilities` the skill ids.
 */
function ardEntry(metadata, { publisher, orgHandle, pageUrl, card }) {
    const agent = metadata?.agent || {};
    const skills = asArray(card?.parsed?.skills).length ? card.parsed.skills : asArray(agent.skills);
    const examples = skills.filter(isPlainObject).flatMap((skill) => asArray(skill.examples))
        .filter((example) => typeof example === 'string').slice(0, MAX_REPRESENTATIVE_QUERIES);
    const capabilities = skills.filter(isPlainObject).map((skill) => asString(skill.id)).filter(Boolean);
    const entry = {
        identifier: `urn:air:${publisher}:${orgHandle}:agent:${metadata.id}`,
        displayName: metadata.name,
        type: card ? 'application/a2a-agent-card+json' : 'text/markdown',
        url: card ? `${pageUrl}/agent-card.json` : `${pageUrl}.md`,
        description: metadata.description || undefined,
        version: metadata.version || undefined,
        tags: asArray(metadata.tags).length ? metadata.tags : undefined,
        capabilities: capabilities.length ? capabilities : undefined,
        representativeQueries: examples.length ? examples : undefined,
        updatedAt: metadata.updatedAt || undefined,
    };
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

module.exports = {
    sourceCardDefinition,
    publicCard,
    ardEntry,
};
