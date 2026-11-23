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
 * How a kind: Agent document becomes an api_metadata row and its definition files.
 * apiMetadataService's shared create/update path calls in here at three points:
 *   1. collectAgentUploads   — the definition files sent with the request, one per
 *                              upload field (a2aDefinition, restDefinition,
 *                              eventDefinition, localDefinition), or from the ZIP;
 *   2. prepareAgentArtifact  — validates the document (agentArtifactValidation) and
 *                              fills the listing columns and metadata_search.agent;
 *   3. storeAgentDefinitions — inside the write transaction, stores one file per type
 *                              under a fixed name and removes the ones no longer in
 *                              force (their interface, or LOCAL, was removed).
 * Nothing here talks to the network; files are stored byte for byte.
 */

const crypto = require('crypto');
const path = require('path');
const apiFileDao = require('../dao/apiFileDao');
const apiDao = require('../dao/apiDao');
const constants = require('../utils/constants');
const logger = require('../config/logger');
const { config } = require('../config/configLoader');
const { parseJsonColumn } = require('../db/rows');
const { ValidationError } = require('../utils/errors/customErrors');
const { validateAgentArtifact } = require('./agentArtifactValidation');

const { A2A, REST } = constants.AGENT_INTERFACE_TYPES;
const LIMITS = constants.AGENT_FIELD_LIMITS;
const DEFAULT_MAX_AGENT_DEFINITION_BYTES = 1048576;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cardString = (card, key) => (isPlainObject(card) && typeof card[key] === 'string' && card[key].trim()
    ? card[key].trim()
    : undefined);

// The JSON `metadata` field on /agents carries the same kind: Agent document as
// agent.yaml; `mapDocument` is apiMetadataService's YAML mapping, so every intake path
// runs one mapping.
function mapAgentJsonMetadata(parsed, mapDocument) {
    if (!isPlainObject(parsed) || parsed.kind !== constants.API_TYPE.AGENT) {
        throw new ValidationError("Field 'kind' must be 'Agent'.");
    }
    return mapDocument(parsed);
}

/*
 * The definition files sent with a request, by upload field: the multipart parts of
 * those names (one file each), or the files a ZIP carried. Any other `*Definition`
 * part, and a `definition` part (the field APIs and MCP servers use), is passed on
 * too, so the validator rejects it by name instead of dropping the file. A repeated
 * part is refused: each field takes one file.
 */
function collectAgentUploads(files, fullApiBundle) {
    if (isPlainObject(fullApiBundle?.agentDefinitions)) {
        return fullApiBundle.agentDefinitions;
    }
    const uploads = {};
    for (const [field, parts] of Object.entries(isPlainObject(files) ? files : {})) {
        if (!/(^d|D)efinition$/.test(field) || !Array.isArray(parts) || !parts.length) {
            continue;
        }
        if (parts.length > 1) {
            throw new ValidationError(`Field '${field}' takes one file.`);
        }
        uploads[field] = { fileName: path.basename(String(parts[0].originalname || '')), buffer: parts[0].buffer };
    }
    return uploads;
}

/*
 * What is stored for an agent, for the update rules: the definitions by content type
 * (no file uploaded keeps the stored one), and the skill UUIDs handed out so far.
 */
async function loadExistingAgentState(orgId, apiId) {
    const rows = await apiFileDao.listAgentDefinitions(orgId, apiId);
    const definitions = {};
    for (const row of rows) {
        const entry = { docType: row.type, card: null };
        if (row.type === constants.DOC_TYPES.AGENT_CARD && row.file_content) {
            try {
                entry.card = JSON.parse(Buffer.from(row.file_content).toString(constants.CHARSET_UTF8));
            } catch {
                logger.warn('Stored agent card could not be parsed', { apiId });
            }
        }
        definitions[row.type] = entry;
    }
    const [api] = await apiDao.get(orgId, apiId);
    const agent = parseJsonColumn(api?.metadata_search)?.agent;
    return { definitions, skillIds: isPlainObject(agent?.skillIds) ? agent.skillIds : {} };
}

/*
 * A stable UUID per skill id, kept across updates, for a future skills registry
 * (decision D3). The publisher's `id` stays the skill's name in the document.
 */
/*
 * The card's skills as plain text (name, description, tags), kept on the agent so the
 * listing can show and search them without reading every card. The card stays the source.
 */
function cardSkillSummary(card) {
    const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const skills = (isPlainObject(card) && Array.isArray(card.skills) ? card.skills : [])
        .filter(isPlainObject)
        .map((skill) => {
            const tags = (Array.isArray(skill.tags) ? skill.tags : []).map(text).filter(Boolean);
            return Object.fromEntries(Object.entries({
                name: text(skill.name) || text(skill.id),
                description: text(skill.description),
                tags: tags.length ? tags : undefined,
            }).filter(([, value]) => value !== undefined));
        })
        .filter((skill) => skill.name);
    return skills.length ? skills : undefined;
}

function assignSkillIds(skills, card, existingIds) {
    const cardSkills = isPlainObject(card) && Array.isArray(card.skills) ? card.skills : [];
    const ids = {};
    for (const skill of [...(Array.isArray(skills) ? skills : []), ...cardSkills]) {
        const id = isPlainObject(skill) && typeof skill.id === 'string' ? skill.id : null;
        if (id && !Object.hasOwn(ids, id)) {
            ids[id] = Object.hasOwn(existingIds || {}, id) ? existingIds[id] : crypto.randomUUID();
        }
    }
    return Object.keys(ids).length ? ids : undefined;
}

/*
 * Validates the document and carries it into the metadata row. Listing columns the
 * YAML leaves out come from the source card; `endPoints` holds the first A2A or REST
 * interface's URLs (shared code paths read the columns). Throws before anything is
 * written. Returns what storeAgentDefinitions needs.
 */
function prepareAgentArtifact(apiMetadata, uploads, existing) {
    const spec = apiMetadata.agentSpec;
    if (!spec) {
        // Only a kind: Agent document carries agentSpec.
        throw new ValidationError("Field 'kind' must be 'Agent'.");
    }
    const result = validateAgentArtifact(apiMetadata.agentDocumentMetadata, spec, uploads, {
        maxDefinitionBytes: config.uploads?.maxAgentDefinitionBytes || DEFAULT_MAX_AGENT_DEFINITION_BYTES,
        existing: existing || undefined,
    });
    const doc = result.spec;
    const card = result.card;
    // On create, empty counts as absent, as in the validator: `labels: []` gets the default
    // view (a new agent with no label would be in no view) and `referenceId: ""` stores none.
    // On update they stay: `labels: []` removes every label, as for APIs, and `""` clears the
    // reference ID.
    if (!existing && Array.isArray(apiMetadata.labels) && !apiMetadata.labels.length) {
        apiMetadata.labels = undefined;
    }
    if (!existing && typeof apiMetadata.referenceId === 'string' && !apiMetadata.referenceId.trim()) {
        apiMetadata.referenceId = undefined;
    }

    // The YAML wins; what it leaves out comes from the card, and is remembered so a
    // download returns the document as written rather than the defaults.
    const fromCard = [];
    const listing = {
        name: doc.displayName,
        version: doc.version !== undefined ? String(doc.version) : undefined,
        description: doc.description,
    };
    for (const [field, cardKey, docKey] of [['name', 'name', 'displayName'], ['version', 'version', 'version'],
        ['description', 'description', 'description']]) {
        if (listing[field] === undefined && cardString(card, cardKey)) {
            listing[field] = cardString(card, cardKey);
            fromCard.push(docKey);
        }
    }
    const cardLimits = { name: LIMITS.displayName, version: LIMITS.version, description: LIMITS.description };
    for (const [field, limit] of Object.entries(cardLimits)) {
        if (listing[field] && listing[field].length > limit) {
            if (field === 'description') {
                // A long card description is shortened for the column; the card keeps it whole.
                listing.description = listing.description.slice(0, limit);
            } else {
                throw new ValidationError(`Field 'spec.${field === 'name' ? 'displayName' : field}' is too long.`);
            }
        }
    }
    let provider = doc.provider;
    if (!provider && cardString(card?.provider, 'organization')) {
        provider = { organization: cardString(card.provider, 'organization') };
        if (cardString(card.provider, 'url')) {
            provider.url = cardString(card.provider, 'url');
        }
        fromCard.push('provider');
    }
    apiMetadata.name = listing.name;
    apiMetadata.version = listing.version;
    apiMetadata.description = listing.description;

    const agent = {
        types: result.types,
        annotations: result.metadata.annotations,
        agentId: doc.agentId,
        provider,
        models: doc.models,
        skills: result.skills,
        skillIds: assignSkillIds(result.skills, card, existing?.skillIds),
        interfaces: result.interfaces.length ? result.interfaces : undefined,
        fromCard: fromCard.length ? fromCard : undefined,
        cardSkills: cardSkillSummary(card),
    };
    apiMetadata.agent = Object.fromEntries(Object.entries(agent).filter(([, value]) => value !== undefined));

    const main = result.interfaces.find((entry) => entry.type === A2A || entry.type === REST);
    apiMetadata.endPoints = {
        productionURL: main?.endpoints?.productionUrl,
        sandboxURL: main?.endpoints?.sandboxUrl,
    };
    // A document without plans clears plans stored before: the YAML is the single source.
    if (!Array.isArray(doc.subscriptionPlans)) {
        apiMetadata.subscriptionPlans = [];
    }
    if (result.warnings.length) {
        logger.info('Agent accepted with warnings', { handle: apiMetadata.handle, warnings: result.warnings });
    }
    return {
        definitions: result.definitions,
        keep: new Set(result.keep),
    };
}

/*
 * The fixed name a definition is stored (and read through /assets) under, as in a ZIP:
 * agent-card.json, openapi.yaml|json, asyncapi.yaml|json, run-locally.md. YAML or JSON
 * follows the uploaded file's extension, else its first character.
 */
const STORED_BASE_NAMES = {
    [constants.DOC_TYPES.API_DEFINITION]: 'openapi',
    [constants.DOC_TYPES.AGENT_EVENT_DEFINITION]: 'asyncapi',
};

function storedFileName(definition) {
    if (definition.docType === constants.DOC_TYPES.AGENT_CARD) {
        return 'agent-card.json';
    }
    if (definition.docType === constants.DOC_TYPES.AGENT_LOCAL_DEFINITION) {
        return 'run-locally.md';
    }
    const extension = path.extname(definition.fileName || '').toLowerCase();
    const isJson = extension === '.json'
        || (!['.yaml', '.yml'].includes(extension) && Buffer.from(definition.buffer).toString('utf8').trimStart().startsWith('{'));
    return `${STORED_BASE_NAMES[definition.docType]}.${isJson ? 'json' : 'yaml'}`;
}

/*
 * Inside the write transaction: removes every stored definition that is no longer in
 * force (its interface or LOCAL was removed) or is replaced, then stores each uploaded
 * file under its fixed name. Bytes are stored as uploaded.
 */
async function storeAgentDefinitions(prepared, apiId, orgId, userId, t) {
    if (!prepared) {
        return;
    }
    const replaced = new Set(prepared.definitions.map((entry) => entry.docType));
    for (const row of await apiFileDao.listAgentDefinitions(orgId, apiId, t, { withContent: false })) {
        if (!prepared.keep.has(row.type) || replaced.has(row.type)) {
            await apiFileDao.deleteAll(row.type, orgId, apiId, t);
        }
    }
    for (const definition of prepared.definitions) {
        await apiFileDao.store(definition.buffer, storedFileName(definition), apiId, definition.docType, userId, t);
    }
}

module.exports = {
    mapAgentJsonMetadata,
    collectAgentUploads,
    loadExistingAgentState,
    prepareAgentArtifact,
    storeAgentDefinitions,
    assignSkillIds,
};
