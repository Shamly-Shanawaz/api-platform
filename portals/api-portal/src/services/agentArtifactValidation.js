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
 * The single set of rules for a `kind: Agent` document (apiVersion v1alpha1). Every
 * intake path (JSON metadata, YAML metadata file plus definitions, ZIP) runs through
 * validateAgentArtifact before anything is written, so the rules can't drift.
 *
 * The document: `spec.types` (API | EVENT | LOCAL, one or more) says how the agent is
 * used; `spec.interfaces[]` are the ways to call it (A2A, REST, EVENT), at most one of
 * each type, which names it. Each type needs its part and each part needs its type: API
 * an A2A or REST interface, EVENT an EVENT interface, LOCAL the run-locally Markdown.
 *
 * Definition files are not named in the YAML. They are uploaded beside it, one field per
 * type, as APIs and MCP servers upload their `definition`. Every interface needs its
 * file: `a2aDefinition` (Agent Card) with A2A, `restDefinition` (OpenAPI) with REST,
 * `eventDefinition` (AsyncAPI) with EVENT, and `localDefinition` (Markdown) with LOCAL.
 * A file needs its interface (or LOCAL). On an update, no file keeps the stored one. The
 * YAML gives an interface only its URLs; transports, auth and operations come from its
 * file. The Agent Card supplies the skills and the listing defaults.
 *
 * Unknown fields are rejected and every problem is reported at once. An empty list,
 * an empty object or an empty string counts as absent. Messages name the field and
 * say what to do; never its value, the content, or a limit.
 *
 * Pure module: no config, DB or logger access. The caller supplies the size limit and
 * the stored state.
 */

const constants = require('../utils/constants');
const yaml = require('../utils/yaml');
const { ValidationError, CustomError } = require('../utils/errors/customErrors');

const { API, EVENT, LOCAL } = constants.AGENT_USE_TYPES;
const { A2A, REST } = constants.AGENT_INTERFACE_TYPES;
const EVENT_INTERFACE = constants.AGENT_INTERFACE_TYPES.EVENT;
const INTERFACE_TYPES = Object.values(constants.AGENT_INTERFACE_TYPES);
const USE_TYPES = Object.values(constants.AGENT_USE_TYPES);
const LIMITS = constants.AGENT_FIELD_LIMITS;
const { AGENT_CARD, API_DEFINITION, AGENT_EVENT_DEFINITION, AGENT_LOCAL_DEFINITION } = constants.DOC_TYPES;

// The upload field and stored content type of each kind of definition file.
const DEFINITION_FIELDS = {
    [A2A]: { field: 'a2aDefinition', docType: AGENT_CARD },
    [REST]: { field: 'restDefinition', docType: API_DEFINITION },
    [EVENT_INTERFACE]: { field: 'eventDefinition', docType: AGENT_EVENT_DEFINITION },
    [LOCAL]: { field: 'localDefinition', docType: AGENT_LOCAL_DEFINITION },
};
const UPLOAD_FIELDS = Object.values(DEFINITION_FIELDS).map((entry) => entry.field);

const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+(\s*;.*)?$/;
const HANDLE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Allowed keys per object. Anything else is "not allowed".
const METADATA_KEYS = new Set(['name', 'annotations']);
const SPEC_KEYS = new Set(['types', 'displayName', 'version', 'description', 'provider', 'referenceId', 'agentId',
    'status', 'agentVisibility', 'labels', 'tags', 'businessInformation', 'models', 'skills', 'subscriptionPlans',
    'interfaces']);
const INTERFACE_KEYS = {
    [A2A]: new Set(['type', 'cardUrl', 'endpoints']),
    [REST]: new Set(['type', 'protocol', 'endpoints']),
    [EVENT_INTERFACE]: new Set(['type']),
};
const SKILL_KEYS = new Set(['id', 'name', 'description', 'tags', 'examples', 'inputModes', 'outputModes']);

const isPresent = (value) => value !== undefined && value !== null;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/*
 * Refuses a document whose walk would be huge. YAML aliases are shared references, so
 * a small file can describe an enormous tree; every later step (pruning, checks,
 * serialising into metadata_search) walks the expanded tree.
 */
function assertDocumentSize(value, budget = LIMITS.documentNodes) {
    let seen = 0;
    const stack = [value];
    while (stack.length) {
        const node = stack.pop();
        if (node === null || typeof node !== 'object') {
            continue;
        }
        seen += 1;
        if (seen > budget) {
            throw new CustomError(413, 'Payload Too Large', 'The agent document is too large.');
        }
        for (const child of Array.isArray(node) ? node : Object.values(node)) {
            if (child !== null && typeof child === 'object') {
                stack.push(child);
            }
        }
    }
}

/*
 * "An empty list, an empty object or an empty string counts as absent": drops null,
 * blank strings, [] and {} recursively. Values inside arrays stay in place (a blank
 * list item is still an error); only emptied containers are dropped.
 *
 * Kept whole: `security` requirements (`bearer: []` means "no scopes", not absent),
 * OAuth `scopes`, and free-form `annotations`.
 *
 * Keys are copied as own properties (defineProperty), so a `__proto__` key stays a
 * plain, visible key that the unknown-field check rejects, never a prototype.
 */
const KEEP_WHOLE = new Set(['security', 'scopes', 'annotations']);

function pruneEmpty(value) {
    if (Array.isArray(value)) {
        return value.map((item) => (isPlainObject(item) || Array.isArray(item) ? pruneEmpty(item) : item));
    }
    if (!isPlainObject(value)) {
        return value;
    }
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        let item = raw;
        if (!KEEP_WHOLE.has(key) && (isPlainObject(raw) || Array.isArray(raw))) {
            item = pruneEmpty(raw);
        }
        if (item === null || item === undefined) {
            continue;
        }
        if (typeof item === 'string' && item.trim() === '') {
            continue;
        }
        if (Array.isArray(item) && item.length === 0) {
            continue;
        }
        if (isPlainObject(item) && Object.keys(item).length === 0) {
            continue;
        }
        Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return out;
}

/*
 * Collects every problem instead of stopping at the first, so a publisher sees the
 * whole list. Throws one ValidationError carrying all of them in `details`.
 */
class Problems {
    constructor() {
        this.list = [];
    }

    add(message) {
        if (!this.list.includes(message)) {
            this.list.push(message);
        }
    }

    required(field) { this.add(`Field '${field}' is required.`); }

    invalid(field) { this.add(`Field '${field}' is invalid.`); }

    tooLong(field) { this.add(`Field '${field}' is too long.`); }

    unique(field) { this.add(`Field '${field}' must be unique.`); }

    notAllowed(field) {
        this.add(`Field '${field}' is not allowed. Remove it.`);
    }

    notWithCard(field) {
        this.add(`Field '${field}' cannot be used when an agent card is provided. Remove it; the card supplies it.`);
    }

    unknownKeys(object, allowed, at) {
        for (const key of Object.keys(object)) {
            if (!allowed.has(key)) {
                this.notAllowed(at ? `${at}.${key}` : key);
            }
        }
    }

    throwIfAny() {
        if (this.list.length) {
            const error = new ValidationError(this.list[0]);
            error.details = [...this.list];
            throw error;
        }
    }
}

function checkHttpUrl(problems, value, field) {
    if (typeof value !== 'string') {
        problems.invalid(field);
        return;
    }
    if (value.length > LIMITS.url) {
        problems.tooLong(field);
        return;
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        problems.invalid(field);
        return;
    }
    // http(s) only, and no credentials in the URL: it is shown on public pages.
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
        problems.invalid(field);
    }
}

function checkString(problems, value, field, maxLength) {
    if (!isPresent(value)) {
        return;
    }
    if (typeof value !== 'string') {
        problems.invalid(field);
    } else if (maxLength && value.length > maxLength) {
        problems.tooLong(field);
    }
}

// A string, or a number written without quotes (YAML reads `1.0` as a number).
function checkVersionLike(problems, value, field, maxLength) {
    if (!isPresent(value)) {
        return;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
        problems.invalid(field);
    } else if (String(value).length > maxLength) {
        problems.tooLong(field);
    }
}

function checkStringList(problems, value, field) {
    if (!isPresent(value)) {
        return;
    }
    if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
        problems.invalid(field);
    }
}

function checkMediaTypes(problems, value, field) {
    if (!isPresent(value)) {
        return;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !MEDIA_TYPE.test(item))) {
        problems.invalid(field);
    }
}

// ---------------------------------------------------------------------------
// Definition files
// ---------------------------------------------------------------------------

// The upload's bytes, without a UTF-8 byte order mark (Windows editors add one), so the
// file parses and is stored and served without it.
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const toBuffer = (upload) => {
    const buffer = Buffer.isBuffer(upload.buffer)
        ? upload.buffer
        : Buffer.from(String(upload.buffer ?? ''), constants.CHARSET_UTF8);
    return buffer.subarray(0, 3).equals(UTF8_BOM) ? buffer.subarray(3) : buffer;
};

// JSON, else YAML (safe default schema: no custom tags, no code). Null when neither.
function parseJsonOrYaml(text) {
    try {
        return JSON.parse(text);
    } catch {
        try {
            return yaml.load(text);
        } catch {
            return null;
        }
    }
}

/*
 * Parses one uploaded definition for an interface of `interfaceType`; `field` is its
 * upload field. The size is
 * measured on the raw bytes before parsing (413, thrown: nothing else matters then).
 * A content problem is added to `problems` and returns null.
 */
function parseDefinition(problems, interfaceType, upload, field, maxDefinitionBytes) {
    const buffer = toBuffer(upload);
    if (buffer.length > maxDefinitionBytes) {
        throw new CustomError(413, 'Payload Too Large', 'The agent definition is too large.');
    }
    const text = buffer.toString(constants.CHARSET_UTF8);
    let parsed;
    if (interfaceType === A2A) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
        if (!isPlainObject(parsed)) {
            problems.add(`Field '${field}' must be an agent card (a JSON object).`);
            return null;
        }
    } else {
        parsed = parseJsonOrYaml(text);
        if (interfaceType === REST && (!isPlainObject(parsed) || (!isPresent(parsed.openapi) && !isPresent(parsed.swagger)))) {
            problems.add(`Field '${field}' must be an OpenAPI document.`);
            return null;
        }
        if (interfaceType === EVENT_INTERFACE
            && (!isPlainObject(parsed) || typeof parsed.asyncapi !== 'string' || !/^[23]\./.test(parsed.asyncapi))) {
            problems.add(`Field '${field}' must be an AsyncAPI 2 or 3 document.`);
            return null;
        }
    }
    assertDocumentSize(parsed);
    return { buffer, parsed };
}

/*
 * The LOCAL Markdown file: UTF-8 text without NUL bytes, within the size limit. It is stored as uploaded and rendered (sanitized) on the page; nothing is
 * read out of it.
 */
function parseLocalDefinition(problems, upload, field, maxDefinitionBytes) {
    const buffer = toBuffer(upload);
    if (buffer.length > maxDefinitionBytes) {
        throw new CustomError(413, 'Payload Too Large', 'The agent definition is too large.');
    }
    const text = buffer.toString(constants.CHARSET_UTF8);
    if (text.includes('\u0000') || text.includes('\ufffd') || !text.trim()) {
        problems.add(`Field '${field}' must be a Markdown text file.`);
        return null;
    }
    return { buffer };
}

// The URLs a card tells callers to use: A2A 1.0 supportedInterfaces, else the 0.3 top-level url.
function cardUrls(card) {
    if (!isPlainObject(card)) {
        return [];
    }
    const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces.filter(isPlainObject) : [];
    const urls = interfaces.map((entry) => entry.url).filter((url) => typeof url === 'string' && url);
    if (urls.length) {
        return urls;
    }
    return typeof card.url === 'string' && card.url ? [card.url] : [];
}

const trimSlash = (url) => String(url).replace(/\/+$/, '');

// True when every URL in the card sits under one of the interface's endpoints.
function cardMatchesEndpoints(card, endpoints) {
    const bases = [endpoints?.productionUrl, endpoints?.sandboxUrl].filter(isNonEmptyString).map(trimSlash);
    const urls = cardUrls(card);
    if (!bases.length || !urls.length) {
        return true;
    }
    return urls.every((url) => {
        const target = trimSlash(url);
        return bases.some((base) => target === base || target.startsWith(`${base}/`));
    });
}

// ---------------------------------------------------------------------------
// Parts of the document
// ---------------------------------------------------------------------------

function validateMetadata(problems, metadata) {
    problems.unknownKeys(metadata, METADATA_KEYS, 'metadata');
    if (!isNonEmptyString(metadata.name)) {
        problems.required('metadata.name');
    } else if (metadata.name.length > LIMITS.handle) {
        problems.tooLong('metadata.name');
    } else if (!HANDLE.test(metadata.name)) {
        problems.invalid('metadata.name');
    }
    if (isPresent(metadata.annotations)) {
        if (!isPlainObject(metadata.annotations)
            || Object.values(metadata.annotations).some((value) => typeof value !== 'string')) {
            problems.invalid('metadata.annotations');
        }
    }
}

function validateListing(problems, spec) {
    checkString(problems, spec.displayName, 'spec.displayName', LIMITS.displayName);
    checkVersionLike(problems, spec.version, 'spec.version', LIMITS.version);
    checkString(problems, spec.description, 'spec.description', LIMITS.description);
    if (isPresent(spec.provider)) {
        if (!isPlainObject(spec.provider)) {
            problems.invalid('spec.provider');
        } else {
            problems.unknownKeys(spec.provider, new Set(['organization', 'url']), 'spec.provider');
            if (!isNonEmptyString(spec.provider.organization)) {
                problems.required('spec.provider.organization');
            }
            checkString(problems, spec.provider.organization, 'spec.provider.organization', LIMITS.displayName);
            if (isPresent(spec.provider.url)) {
                checkHttpUrl(problems, spec.provider.url, 'spec.provider.url');
            }
        }
    }
    checkString(problems, spec.referenceId, 'spec.referenceId', LIMITS.referenceId);
    checkString(problems, spec.agentId, 'spec.agentId', LIMITS.agentId);
    if (isPresent(spec.status) && ![constants.API_STATUS.PUBLISHED, constants.API_STATUS.DEPRECATED].includes(spec.status)) {
        problems.invalid('spec.status');
    }
    if (isPresent(spec.agentVisibility)
        && !Object.values(constants.AGENT_VISIBILITY).includes(String(spec.agentVisibility).toUpperCase())) {
        problems.invalid('spec.agentVisibility');
    }
    checkStringList(problems, spec.labels, 'spec.labels');
    checkStringList(problems, spec.tags, 'spec.tags');
    if (isPresent(spec.businessInformation)) {
        const info = spec.businessInformation;
        if (!isPlainObject(info)) {
            problems.invalid('spec.businessInformation');
        } else {
            problems.unknownKeys(info, new Set(['businessOwner', 'businessOwnerEmail', 'technicalOwner',
                'technicalOwnerEmail']), 'spec.businessInformation');
            for (const key of ['businessOwner', 'technicalOwner']) {
                checkString(problems, info[key], `spec.businessInformation.${key}`, LIMITS.displayName);
            }
            for (const key of ['businessOwnerEmail', 'technicalOwnerEmail']) {
                if (isPresent(info[key]) && (typeof info[key] !== 'string' || !EMAIL.test(info[key])
                    || info[key].length > LIMITS.displayName)) {
                    problems.invalid(`spec.businessInformation.${key}`);
                }
            }
        }
    }
    if (isPresent(spec.models)) {
        if (!Array.isArray(spec.models)) {
            problems.invalid('spec.models');
        } else {
            spec.models.forEach((model, i) => {
                const at = `spec.models[${i}]`;
                if (!isPlainObject(model)) {
                    problems.invalid(at);
                    return;
                }
                problems.unknownKeys(model, new Set(['provider', 'name']), at);
                if (!isNonEmptyString(model.provider) && !isNonEmptyString(model.name)) {
                    problems.add(`Field '${at}' needs a provider or a name. Add at least one of them.`);
                }
                checkString(problems, model.provider, `${at}.provider`, LIMITS.modelField);
                checkString(problems, model.name, `${at}.name`, LIMITS.modelField);
            });
        }
    }
}

function validateSkills(problems, skills) {
    if (!Array.isArray(skills)) {
        problems.invalid('spec.skills');
        return;
    }
    const ids = new Set();
    skills.forEach((skill, i) => {
        const at = `spec.skills[${i}]`;
        if (!isPlainObject(skill)) {
            problems.invalid(at);
            return;
        }
        problems.unknownKeys(skill, SKILL_KEYS, at);
        for (const key of ['id', 'name', 'description']) {
            if (!isNonEmptyString(skill[key])) {
                problems.required(`${at}.${key}`);
            }
        }
        checkString(problems, skill.id, `${at}.id`, LIMITS.skillId);
        checkString(problems, skill.name, `${at}.name`, LIMITS.displayName);
        checkString(problems, skill.description, `${at}.description`, LIMITS.description);
        if (isNonEmptyString(skill.id)) {
            if (ids.has(skill.id)) {
                problems.unique(`${at}.id`);
            }
            ids.add(skill.id);
        }
        checkStringList(problems, skill.tags, `${at}.tags`);
        checkStringList(problems, skill.examples, `${at}.examples`);
        checkMediaTypes(problems, skill.inputModes, `${at}.inputModes`);
        checkMediaTypes(problems, skill.outputModes, `${at}.outputModes`);
    });
}

function validateEndpoints(problems, entry, at) {
    if (!isPlainObject(entry.endpoints) || !isPresent(entry.endpoints.productionUrl)) {
        problems.required(`${at}.endpoints.productionUrl`);
        return;
    }
    problems.unknownKeys(entry.endpoints, new Set(['productionUrl', 'sandboxUrl']), `${at}.endpoints`);
    checkHttpUrl(problems, entry.endpoints.productionUrl, `${at}.endpoints.productionUrl`);
    if (isPresent(entry.endpoints.sandboxUrl)) {
        checkHttpUrl(problems, entry.endpoints.sandboxUrl, `${at}.endpoints.sandboxUrl`);
    }
}

/*
 * One interface, already known to be an object with a valid type. Everything it says
 * beyond its URLs (transports, auth, operations, channels) comes from its definition
 * file. Returns the normalised interface.
 */
function validateInterface(problems, entry, at) {
    problems.unknownKeys(entry, INTERFACE_KEYS[entry.type], at);
    const normalized = { ...entry };
    if (entry.type === EVENT_INTERFACE) {
        return normalized;
    }
    validateEndpoints(problems, entry, at);
    if (entry.type === A2A) {
        if (isPresent(entry.cardUrl)) {
            checkHttpUrl(problems, entry.cardUrl, `${at}.cardUrl`);
        }
        return normalized;
    }
    // REST
    checkString(problems, entry.protocol, `${at}.protocol`, LIMITS.protocol);
    return normalized;
}

// ---------------------------------------------------------------------------
// The whole document
// ---------------------------------------------------------------------------

/**
 * Validates a kind: Agent document's `metadata` and `spec`, with its definition files.
 *
 * @param {object} metadataIn  the document's `metadata` block, as submitted
 * @param {object} specIn      the document's `spec` block, as submitted
 * @param {Object<string, {fileName?: string, buffer: Buffer|string}>} uploads
 *        definition files by upload field (a2aDefinition, restDefinition, eventDefinition, localDefinition)
 * @param {object} options
 * @param {number} options.maxDefinitionBytes  size limit for one definition file
 * @param {{definitions?: Object<string, {card?: object|null}>}} [options.existing]
 *        on update: the definitions stored, by content type (AGENT_CARD, ...)
 * @returns {{metadata: object, spec: object, types: string[], interfaces: object[], skills: object[]|undefined,
 *            definitions: object[], keep: string[], card: object|null, warnings: string[]}}
 *          `definitions` are the uploads to store ({docType, fileName, buffer, parsed}); `keep` the content
 *          types whose stored file stays; `card` the Agent Card in force (uploaded or stored).
 */
function validateAgentArtifact(metadataIn, specIn, uploads, { maxDefinitionBytes, existing } = {}) {
    if (!isPlainObject(specIn)) {
        throw new ValidationError("Field 'spec' is invalid.");
    }
    assertDocumentSize({ metadataIn, specIn });
    const metadata = pruneEmpty(isPlainObject(metadataIn) ? metadataIn : {});
    const spec = pruneEmpty(specIn);
    const problems = new Problems();
    const warnings = [];
    const stored = isPlainObject(existing?.definitions) ? existing.definitions : {};
    const files = isPlainObject(uploads) ? uploads : {};

    validateMetadata(problems, metadata);
    problems.unknownKeys(spec, SPEC_KEYS, 'spec');
    validateListing(problems, spec);

    // types
    let types = [];
    if (!isPresent(spec.types)) {
        problems.required('spec.types');
    } else if (!Array.isArray(spec.types)) {
        problems.invalid('spec.types');
    } else {
        types = spec.types;
        if (types.some((type) => !USE_TYPES.includes(type))) {
            problems.add(`Field 'spec.types' must list one or more of ${USE_TYPES.join(', ')}.`);
        }
        if (new Set(types).size !== types.length) {
            problems.unique('spec.types');
        }
    }

    // interfaces: at most one of each type
    const entries = [];
    if (isPresent(spec.interfaces) && !Array.isArray(spec.interfaces)) {
        problems.invalid('spec.interfaces');
    } else if (Array.isArray(spec.interfaces)) {
        const seen = new Set();
        spec.interfaces.forEach((entry, index) => {
            const at = `spec.interfaces[${index}]`;
            if (!isPlainObject(entry)) {
                problems.invalid(at);
                return;
            }
            if (!isPresent(entry.type)) {
                problems.required(`${at}.type`);
                return;
            }
            if (!INTERFACE_TYPES.includes(entry.type)) {
                problems.add(`Field '${at}.type' must be one of ${INTERFACE_TYPES.join(', ')}.`);
                return;
            }
            if (seen.has(entry.type)) {
                problems.add(`Field '${at}.type' must be unique: an agent has at most one ${entry.type} interface.`);
                return;
            }
            seen.add(entry.type);
            entries.push({ entry, at });
        });
    }
    const interfaceOf = (type) => entries.find(({ entry }) => entry.type === type) || null;

    // Definition files, one upload field per type. A file needs its part; on an update,
    // no file keeps the stored one.
    for (const name of Object.keys(files)) {
        if (name === 'definition') {
            // The field APIs and MCP servers use: an agent has one file per kind.
            problems.add("Field 'definition' is not allowed. Send the Agent Card as 'a2aDefinition', the OpenAPI as 'restDefinition', the AsyncAPI as 'eventDefinition' and the run-it-yourself Markdown as 'localDefinition'.");
        } else if (!UPLOAD_FIELDS.includes(name)) {
            problems.notAllowed(name);
        }
    }
    const definitions = [];
    const keep = [];
    const inForce = {};
    let card = null;
    for (const [kind, { field, docType }] of Object.entries(DEFINITION_FIELDS)) {
        const owned = kind === LOCAL ? types.includes(LOCAL) : Boolean(interfaceOf(kind));
        const upload = files[field];
        if (upload) {
            if (!owned) {
                problems.add(kind === LOCAL
                    ? `Field '${field}' was uploaded, but spec.types does not include LOCAL. Add LOCAL, or don't upload the file.`
                    : `Field '${field}' was uploaded, but spec.interfaces has no ${kind} interface. Add one, or don't upload the file.`);
                continue;
            }
            const parsed = kind === LOCAL
                ? parseLocalDefinition(problems, upload, field, maxDefinitionBytes)
                : parseDefinition(problems, kind, upload, field, maxDefinitionBytes);
            if (parsed) {
                definitions.push({ docType, fileName: String(upload.fileName || ''), buffer: parsed.buffer,
                    parsed: parsed.parsed ?? null });
                inForce[kind] = true;
                if (kind === A2A) {
                    card = parsed.parsed;
                }
            } else {
                // The file was there but unusable; its own problem is reported.
                inForce[kind] = true;
            }
        } else if (owned && isPlainObject(stored[docType])) {
            keep.push(docType);
            inForce[kind] = true;
            if (kind === A2A) {
                card = isPlainObject(stored[docType].card) ? stored[docType].card : null;
            }
        }
    }
    if (interfaceOf(A2A) && !inForce[A2A]) {
        problems.add("Field 'a2aDefinition' is required with an A2A interface. Upload its Agent Card.");
    }
    if (interfaceOf(REST) && !inForce[REST]) {
        problems.add("Field 'restDefinition' is required with a REST interface. Upload its OpenAPI document.");
    }
    if (interfaceOf(EVENT_INTERFACE) && !inForce[EVENT_INTERFACE]) {
        problems.add("Field 'eventDefinition' is required with an EVENT interface. Upload its AsyncAPI document.");
    }
    if (types.includes(LOCAL) && !inForce[LOCAL]) {
        problems.add("Field 'localDefinition' is required when spec.types includes LOCAL. Upload a Markdown file that says how to run the agent.");
    }

    const interfaces = entries.map(({ entry, at }) => validateInterface(problems, entry, at));

    // Each type needs its part, and each part needs its type.
    const callable = interfaces.filter((entry) => entry.type === A2A || entry.type === REST);
    if (types.includes(API) && callable.length === 0) {
        problems.add("Field 'spec.types' includes API, so an A2A or REST interface is required. Add one to spec.interfaces, or remove API.");
    }
    if (!types.includes(API) && callable.length > 0) {
        problems.add("Field 'spec.types' must include API when an A2A or REST interface is given. Add API to spec.types.");
    }
    const hasEventInterface = interfaces.some((entry) => entry.type === EVENT_INTERFACE);
    if (types.includes(EVENT) && !hasEventInterface) {
        problems.add("Field 'spec.types' includes EVENT, so an EVENT interface is required. Add one to spec.interfaces, or remove EVENT.");
    }
    if (!types.includes(EVENT) && hasEventInterface) {
        problems.add("Field 'spec.types' must include EVENT when an EVENT interface is given. Add EVENT to spec.types.");
    }

    // Plans, and with them subscriptions and keys, only for an agent that is called.
    checkStringList(problems, spec.subscriptionPlans, 'spec.subscriptionPlans');
    if (isPresent(spec.subscriptionPlans) && !types.includes(API)) {
        problems.add("Field 'spec.subscriptionPlans' is allowed only when spec.types includes API. Remove the plans, or add API and an interface.");
    }

    // Skills: from the Agent Card when there is an A2A interface, else optional in the YAML.
    if (isPresent(spec.skills)) {
        if (interfaceOf(A2A)) {
            problems.notWithCard('spec.skills');
        } else {
            validateSkills(problems, spec.skills);
        }
    }

    // Listing: what the YAML leaves out comes from the card; without one it is required.
    const fromCard = { displayName: 'name', version: 'version', description: 'description' };
    for (const [key, cardKey] of Object.entries(fromCard)) {
        if (!isPresent(spec[key]) && !(card && isNonEmptyString(card[cardKey]))) {
            problems.required(`spec.${key}`);
        }
    }

    // A card that points past its interface's endpoints is accepted with a warning:
    // the portal relies on the metadata the publisher gives it.
    const a2a = interfaces.find((entry) => entry.type === A2A);
    if (card && a2a && !cardMatchesEndpoints(card, a2a.endpoints)) {
        warnings.push('The agent card has URLs outside the A2A interface endpoints.');
    }

    problems.throwIfAny();
    return {
        metadata,
        spec,
        types,
        interfaces,
        skills: spec.skills,
        definitions,
        keep,
        card,
        warnings,
    };
}

module.exports = {
    validateAgentArtifact,
    pruneEmpty,
    assertDocumentSize,
    cardUrls,
    DEFINITION_FIELDS,
    UPLOAD_FIELDS,
};
