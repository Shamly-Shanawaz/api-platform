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
 * Design mode: agents read from sample folders instead of the database
 * (`design_mode.agent_samples_path`, default ./samples/agents/). Each folder holds
 * agent.yaml plus its definition files under the fixed names a ZIP uses
 * (agent-card.json, openapi.*, asyncapi.*, run-locally.md) and an optional docs/.
 *
 * The YAML goes through the same mapping, validation and intake as
 * POST /agents, so a page in design mode is built from exactly what the portal
 * would store; a sample that would be refused there is left out here (logged).
 */

const fs = require('fs');
const path = require('path');
const constants = require('./constants');
const logger = require('../config/logger');
const { config } = require('../config/configLoader');

// Fixed file name -> upload field, as in seed-samples.sh and the ZIP intake.
const DEFINITION_FILES = Object.freeze({
    'agent-card.json': 'a2aDefinition',
    'openapi.yaml': 'restDefinition',
    'openapi.yml': 'restDefinition',
    'openapi.json': 'restDefinition',
    'asyncapi.yaml': 'eventDefinition',
    'asyncapi.yml': 'eventDefinition',
    'asyncapi.json': 'eventDefinition',
    'run-locally.md': 'localDefinition',
});
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function samplesDir() {
    const dir = (config.designMode && config.designMode.agentSamplesPath) || './samples/agents/';
    return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

function plansByHandle() {
    const plansPath = config.designMode && config.designMode.subscriptionPlansPath;
    if (!plansPath) return {};
    const file = path.isAbsolute(plansPath) ? plansPath : path.join(process.cwd(), plansPath);
    try {
        const plans = require('./yaml').load(fs.readFileSync(file, constants.CHARSET_UTF8));
        return Array.isArray(plans) ? Object.fromEntries(plans.map((p) => [p.handle, p])) : {};
    } catch (_) {
        return {};
    }
}

function docsOf(dir) {
    const docsDir = path.join(dir, constants.ARTIFACT_DIR.DOCS);
    if (!fs.existsSync(docsDir)) return [];
    const docs = [];
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
        if (entry.isFile()) {
            docs.push({ type: constants.DOC_TYPES.DOCS.OTHER, name: entry.name, file: path.join(docsDir, entry.name) });
        } else if (entry.isDirectory()) {
            for (const file of fs.readdirSync(path.join(docsDir, entry.name), { withFileTypes: true })) {
                if (file.isFile()) {
                    docs.push({ type: entry.name, name: file.name, file: path.join(docsDir, entry.name, file.name) });
                }
            }
        }
    }
    return docs;
}

/**
 * One sample folder -> { metadata, definitions, docs }, shaped as the page
 * controller reads an agent from the database. Null when the folder is not a valid agent.
 */
function parseSample(dir) {
    // Required lazily: these pull in the services, which need the loaded config.
    const apiMetadataService = require('../services/apiMetadataService');
    const { prepareAgentArtifact } = require('../services/agentIntake');
    const yamlFile = path.join(dir, 'agent.yaml');
    if (!fs.existsSync(yamlFile)) return null;
    try {
        const mapped = apiMetadataService.parseApiMetadataFromYamlFile('agent.yaml', fs.readFileSync(yamlFile));
        const uploads = {};
        for (const [fileName, field] of Object.entries(DEFINITION_FILES)) {
            const file = path.join(dir, fileName);
            if (fs.existsSync(file) && !uploads[field]) {
                uploads[field] = { fileName, buffer: fs.readFileSync(file) };
            }
        }
        const { definitions } = prepareAgentArtifact(mapped, uploads, null);
        const plans = plansByHandle();
        const metadata = {
            id: mapped.handle,
            handle: mapped.handle,
            name: mapped.name,
            version: mapped.version,
            description: mapped.description,
            type: constants.API_TYPE.AGENT,
            status: mapped.status || constants.API_STATUS.PUBLISHED,
            agentVisibility: mapped.agentVisibility,
            tags: mapped.tags || [],
            labels: mapped.labels || [],
            owners: mapped.owners,
            endPoints: mapped.endPoints,
            agent: mapped.agent,
            subscriptionPlans: (mapped.subscriptionPlans || []).map(({ id }) => ({
                handle: id,
                displayName: plans[id]?.displayName ?? id,
                description: plans[id]?.description ?? '',
                limits: Array.isArray(plans[id]?.limits) ? plans[id].limits : [],
            })),
        };
        return {
            metadata,
            definitions: Object.fromEntries(definitions.map((d) => [d.docType, { type: d.docType, content: d.buffer }])),
            docs: docsOf(dir),
        };
    } catch (error) {
        logger.warn('Design mode: sample agent left out', { dir: path.basename(dir), error: error.message });
        return null;
    }
}

function loadAll() {
    const dir = samplesDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => parseSample(path.join(dir, entry.name)))
        .filter(Boolean);
}

/** The sample whose metadata.name is `handle` (folder names need not match). */
function loadOne(handle) {
    if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
    return loadAll().find((sample) => sample.metadata.handle === handle) || null;
}

module.exports = { loadAll, loadOne, DEFINITION_FILES };
