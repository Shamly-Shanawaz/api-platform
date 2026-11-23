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
 * The render view model for an agent's pages, computed per request, never stored.
 *
 * An agent has interfaces (A2A, REST, EVENT; each may have its own stored definition
 * file) and, when developers run it themselves (LOCAL), a Markdown file. The page has one tab per way of
 * use, in document order, then "Run it yourself". Each tab has exactly one source per
 * section: the interface's definition file when stored, otherwise the YAML. Skills
 * belong to the whole agent: the card of the first A2A interface with one, otherwise
 * the YAML.
 *
 * Subscriptions and keys follow the subscription plans, as for APIs and MCP servers. For
 * an agent with plans, the A2A and REST tabs list the portal credentials a caller sends
 * (an API key and the subscription token) and the example request carries both.
 *
 * Every value is plain data, rendered escaped by the templates, except `localHtml`,
 * which is Markdown rendered through the allowlist sanitizer. Definitions are parsed
 * with the safe YAML schema; nothing is fetched; the extended card is never surfaced.
 */

const { marked } = require('marked');
const constants = require('../utils/constants');
const yaml = require('../utils/yaml');
const { safeHref } = require('../utils/safeHref');
const { sanitizeRenderedHtml } = require('../utils/sanitizeRenderedHtml');

const { A2A, REST } = constants.AGENT_INTERFACE_TYPES;
const EVENT = constants.AGENT_INTERFACE_TYPES.EVENT;
const { AGENT_CARD, API_DEFINITION, AGENT_EVENT_DEFINITION, AGENT_LOCAL_DEFINITION } = constants.DOC_TYPES;
// The stored content type of each interface's definition file.
const DEFINITION_DOC_TYPE = {
    [constants.AGENT_INTERFACE_TYPES.A2A]: constants.DOC_TYPES.AGENT_CARD,
    [constants.AGENT_INTERFACE_TYPES.REST]: constants.DOC_TYPES.API_DEFINITION,
    [constants.AGENT_INTERFACE_TYPES.EVENT]: constants.DOC_TYPES.AGENT_EVENT_DEFINITION,
};
const OPENAPI_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const asString = (value) => (typeof value === 'string' ? value : undefined);
const domId = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, '-');

function protocolLabel(protocol) {
    if (typeof protocol !== 'string' || !protocol) {
        return null;
    }
    const known = constants.AGENT_PROTOCOL_LABELS[protocol.toUpperCase()];
    return { label: known || protocol, raw: protocol, recognized: Boolean(known) };
}

function parseDefinition(bytes) {
    if (bytes === null || bytes === undefined) {
        return null;
    }
    const text = Buffer.isBuffer(bytes) ? bytes.toString(constants.CHARSET_UTF8) : String(bytes);
    try {
        return { text, parsed: JSON.parse(text) };
    } catch {
        try {
            return { text, parsed: yaml.load(text) };
        } catch {
            return { text, parsed: null };
        }
    }
}

// ---------------------------------------------------------------------------
// EVENT interfaces: a read-only summary of the AsyncAPI document (2.x or 3.x)
// ---------------------------------------------------------------------------

// Follows a local `#/a/b` reference inside the same document; anything else is left alone.
function resolveRef(doc, value, depth = 0) {
    if (!isPlainObject(value) || typeof value.$ref !== 'string' || depth > 5) {
        return value;
    }
    const match = /^#\/(.+)$/.exec(value.$ref);
    if (!match) {
        return value;
    }
    let node = doc;
    for (const key of match[1].split('/').map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        node = isPlainObject(node) ? node[key] : undefined;
    }
    return node === undefined ? value : resolveRef(doc, node, depth + 1);
}

// A payload schema with local references followed (bounded), for display.
function expandSchema(doc, schema, depth = 0) {
    const resolved = resolveRef(doc, schema);
    if (depth > 4 || resolved === null || typeof resolved !== 'object') {
        return resolved;
    }
    if (Array.isArray(resolved)) {
        return resolved.map((item) => expandSchema(doc, item, depth + 1));
    }
    return Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, expandSchema(doc, v, depth + 1)]));
}

// The payload's top-level fields as name/type pairs: `APPROVE | HOLD` for an enum,
// `string[]` for an array. Empty when the payload isn't an object schema.
function payloadFields(payload) {
    if (!isPlainObject(payload) || !isPlainObject(payload.properties)) {
        return [];
    }
    const typeOf = (schema) => {
        if (!isPlainObject(schema)) {
            return '';
        }
        if (Array.isArray(schema.enum) && schema.enum.length) {
            return schema.enum.map(String).join(' | ');
        }
        if (schema.type === 'array') {
            const item = typeOf(schema.items);
            return item ? `${item}[]` : 'array';
        }
        return Array.isArray(schema.type) ? schema.type.join(' | ') : asString(schema.type) || '';
    };
    return Object.entries(payload.properties).slice(0, 50)
        .map(([name, schema]) => ({ name, type: typeOf(schema) }));
}

function messageItem(doc, message, fallbackName) {
    const m = resolveRef(doc, message);
    if (!isPlainObject(m)) {
        return null;
    }
    const payload = m.payload !== undefined ? expandSchema(doc, m.payload) : undefined;
    return {
        name: asString(m.name) || asString(m.title) || fallbackName || 'message',
        summary: asString(m.summary) || asString(m.description) || '',
        contentType: asString(m.contentType) || asString(doc.defaultContentType) || '',
        payload: payload === undefined ? '' : JSON.stringify(payload, null, 2),
        fields: payloadFields(payload),
    };
}

function v2Messages(doc, message) {
    const m = resolveRef(doc, message);
    if (isPlainObject(m) && Array.isArray(m.oneOf)) {
        return m.oneOf.map((x) => messageItem(doc, x)).filter(Boolean);
    }
    const item = messageItem(doc, m);
    return item ? [item] : [];
}

/*
 * What a developer needs from an AsyncAPI document: the brokers, and per channel what
 * they send and receive, with message names and payloads. Direction is the developer's:
 * in 2.x `publish` = you send, `subscribe` = you receive; in 3.x the agent's `receive`
 * = you send, its `send` = you receive.
 */
function asyncApiSummary(doc) {
    if (!isPlainObject(doc) || typeof doc.asyncapi !== 'string') {
        return null;
    }
    const v3 = doc.asyncapi.startsWith('3.');
    const servers = Object.entries(isPlainObject(doc.servers) ? doc.servers : {}).filter(([, v]) => isPlainObject(v))
        .map(([name, server]) => ({
            name,
            url: v3 ? `${asString(server.host) || ''}${asString(server.pathname) || ''}` : (asString(server.url) || ''),
            protocol: [asString(server.protocol), asString(server.protocolVersion)].filter(Boolean).join(' '),
            description: asString(server.description) || '',
        }));
    const channels = [];
    const rawChannels = isPlainObject(doc.channels) ? doc.channels : {};
    if (v3) {
        const operations = Object.entries(isPlainObject(doc.operations) ? doc.operations : {}).filter(([, v]) => isPlainObject(v));
        for (const [key, rawChannel] of Object.entries(rawChannels)) {
            const channel = resolveRef(doc, rawChannel);
            if (!isPlainObject(channel)) {
                continue;
            }
            const channelMessages = Object.entries(isPlainObject(channel.messages) ? channel.messages : {})
                .map(([name, m]) => messageItem(doc, m, name)).filter(Boolean);
            const ops = operations.filter(([, op]) => op.channel?.$ref === `#/channels/${key}`
                || resolveRef(doc, op.channel) === channel).map(([opId, op]) => {
                const msgs = asArray(op.messages).map((m) => messageItem(doc, m)).filter(Boolean);
                return {
                    direction: op.action === 'receive' ? 'You send' : 'You receive',
                    summary: asString(op.summary) || asString(op.description) || opId,
                    messages: msgs.length ? msgs : channelMessages,
                };
            });
            channels.push({
                address: asString(channel.address) || key,
                description: asString(channel.description) || '',
                operations: ops.length ? ops : [{ direction: 'Messages', summary: '', messages: channelMessages }],
            });
        }
    } else {
        for (const [address, rawChannel] of Object.entries(rawChannels)) {
            const channel = resolveRef(doc, rawChannel);
            if (!isPlainObject(channel)) {
                continue;
            }
            const ops = [];
            for (const [key, direction] of [['publish', 'You send'], ['subscribe', 'You receive']]) {
                if (isPlainObject(channel[key])) {
                    const op = channel[key];
                    ops.push({
                        direction,
                        summary: asString(op.summary) || asString(op.description) || asString(op.operationId) || '',
                        messages: v2Messages(doc, op.message),
                    });
                }
            }
            channels.push({ address, description: asString(channel.description) || '', operations: ops });
        }
    }
    return {
        version: doc.asyncapi,
        title: asString(doc.info?.title) || '',
        description: asString(doc.info?.description) || '',
        servers,
        channels,
    };
}

// ---------------------------------------------------------------------------
// Cards, auth and resources
// ---------------------------------------------------------------------------

// Card keys that describe or point at the authenticated extended card: at the top level
// (1.0 `extendedAgentCard`, 0.3 `supportsAuthenticatedExtendedCard`) and in `capabilities`
// (1.0 `extendedAgentCard`). Only there, so a security scheme or skill whose name happens
// to contain "extended" stays.
const isExtendedCardKey = (key) => /extended/i.test(key);

function withoutExtendedCard(card) {
    if (!isPlainObject(card)) {
        return card;
    }
    const copy = Object.fromEntries(Object.entries(card).filter(([key]) => !isExtendedCardKey(key)));
    if (isPlainObject(copy.capabilities)) {
        copy.capabilities = Object.fromEntries(Object.entries(copy.capabilities)
            .filter(([key]) => !isExtendedCardKey(key)));
    }
    return copy;
}

function toSkill(entry) {
    return {
        name: asString(entry.name) || asString(entry.id) || '',
        description: asString(entry.description) || '',
        tags: asArray(entry.tags).filter((tag) => typeof tag === 'string'),
        examples: asArray(entry.examples).filter((example) => typeof example === 'string'),
    };
}

// The kind of credential in plain words.
function schemeTypeLabel(type, body) {
    if (type === 'http') {
        const scheme = String(body?.scheme || '').toLowerCase();
        if (scheme === 'bearer') return 'HTTP bearer';
        if (scheme === 'basic') return 'HTTP basic';
        return 'HTTP auth';
    }
    if (type === 'apiKey') {
        return 'API key';
    }
    return { oauth2: 'OAuth 2.0', openIdConnect: 'OpenID Connect', mutualTLS: 'Client certificate' }[type] || type || 'Other';
}

// OAuth 2.0 flows and API key locations in words.
const FLOW_NAMES = {
    clientCredentials: 'Client credentials', authorizationCode: 'Authorization code', implicit: 'Implicit',
    password: 'Password', deviceCode: 'Device code',
};
const KEY_LOCATIONS = { header: 'Header', query: 'Query parameter', cookie: 'Cookie' };

/*
 * One auth card per scheme. A2A 1.0 cards wrap each scheme (`httpAuthSecurityScheme`,
 * `apiKeySecurityScheme`, ...); OpenAPI and the YAML use the flat `{ type, ... }` shape.
 * Each detail is a stacked row: `kind` says how the page shows it (text, mono, url with a
 * Copy button, tags); `value` is the same in words for the .md view.
 */
function normaliseScheme(name, scheme) {
    if (!isPlainObject(scheme)) {
        return { name, type: 'unknown', typeLabel: 'Other', details: [] };
    }
    const wrappers = {
        httpAuthSecurityScheme: 'http',
        apiKeySecurityScheme: 'apiKey',
        oauth2SecurityScheme: 'oauth2',
        openIdConnectSecurityScheme: 'openIdConnect',
        mtlsSecurityScheme: 'mutualTLS',
    };
    let type = scheme.type;
    let body = scheme;
    for (const [wrapper, wrappedType] of Object.entries(wrappers)) {
        if (isPlainObject(scheme[wrapper])) {
            type = wrappedType;
            body = scheme[wrapper];
            break;
        }
    }
    const details = [];
    // Where an API key goes (header, query, cookie), for the example request.
    let location;
    const push = (label, value, kind = 'text', extra = {}) => {
        if (typeof value === 'string' && value) {
            details.push({ label, value, kind, isUrl: kind === 'url', isMono: kind === 'mono', isTags: kind === 'tags', ...extra });
        }
    };
    if (type === 'http') {
        push('Bearer format', body.bearerFormat);
    } else if (type === 'apiKey') {
        const where = String(body.in || body.location || '').toLowerCase();
        location = where || undefined;
        push('Sent in', KEY_LOCATIONS[where] || where);
        push('Name', body.name, 'mono');
    } else if (type === 'oauth2') {
        for (const [flowName, flow] of Object.entries(isPlainObject(body.flows) ? body.flows : {})) {
            if (!isPlainObject(flow)) {
                continue;
            }
            push('Flow', FLOW_NAMES[flowName] || flowName);
            push('Token URL', flow.tokenUrl, 'url');
            push('Authorization URL', flow.authorizationUrl, 'url');
            const scopes = isPlainObject(flow.scopes) ? Object.keys(flow.scopes) : [];
            if (scopes.length) {
                push('Scopes', scopes.join(', '), 'tags', { tags: scopes });
            }
        }
    } else if (type === 'openIdConnect') {
        push('Discovery URL', body.openIdConnectUrl, 'url');
    }
    push('Description', body.description);
    return { name, type: type || 'unknown', typeLabel: schemeTypeLabel(type, body), details, location };
}

// The scheme names one requirement combines (all sent together).
function requirementSchemeNames(requirement) {
    if (!isPlainObject(requirement)) {
        return [];
    }
    return Object.keys(isPlainObject(requirement.schemes) ? requirement.schemes : requirement);
}

function buildAuth(schemes, requirements, source) {
    const schemeList = isPlainObject(schemes)
        ? Object.entries(schemes).map(([name, scheme]) => normaliseScheme(name, scheme))
        : [];
    const requirementList = asArray(requirements).filter(isPlainObject);
    if (!schemeList.length) {
        return null;
    }
    return {
        schemes: schemeList,
        anyOf: requirementList.length > 1,
        source,
        // For the example request: the schemes of the first requirement, sent together.
        firstRequirement: requirementSchemeNames(requirementList[0]),
    };
}

function openApiResources(document) {
    const items = [];
    for (const [path, operations] of Object.entries(isPlainObject(document?.paths) ? document.paths : {})) {
        if (!isPlainObject(operations)) {
            continue;
        }
        for (const method of OPENAPI_METHODS) {
            const operation = operations[method];
            if (isPlainObject(operation)) {
                items.push({
                    method: method.toUpperCase(),
                    path,
                    summary: asString(operation.summary) || asString(operation.operationId) || '',
                    description: asString(operation.description) || '',
                });
            }
        }
    }
    return items;
}

function buildModels(models) {
    const items = asArray(models).filter(isPlainObject)
        .map((model) => ({ label: [asString(model.provider), asString(model.name)].filter(Boolean).join(' · ') }))
        .filter((model) => model.label);
    return items.length ? items : null;
}

// ---------------------------------------------------------------------------
// Example requests (placeholders only, never credentials)
// ---------------------------------------------------------------------------

const BEARER_HEADER = ' \\\n  -H "Authorization: Bearer <your-token>"';

// What a caller sends when the portal issues the credentials (the agent has plans).
const PORTAL_CREDENTIALS = [
    { label: 'API key', from: 'From API Keys, after you subscribe', header: 'api-key', placeholder: '<your-api-key>' },
    { label: 'Subscription token', from: 'Shown when you subscribe', header: 'Subscription-Key',
        placeholder: '<your-subscription-token>' },
];
const PORTAL_HEADERS = PORTAL_CREDENTIALS.map((c) => ` \\\n  -H "${c.header}: ${c.placeholder}"`).join('');

const SAFE_KEY_NAME = /^[A-Za-z0-9._-]+$/;

/*
 * The credentials a caller sends: every scheme of the first requirement (a requirement
 * that combines two schemes needs both); with no requirement, the first scheme. An
 * apiKey scheme goes where it says (header, query parameter or cookie); any other
 * scheme is a bearer token.
 */
function authHeader(auth) {
    const schemes = auth?.schemes || [];
    const named = (auth?.firstRequirement || []).map((name) => schemes.find((s) => s.name === name)).filter(Boolean);
    const chosen = named.length ? named : schemes.slice(0, 1);
    const several = chosen.length > 1;
    const lines = [];
    for (const scheme of chosen) {
        let line = null;
        const where = scheme.location || 'header';
        const name = scheme.details.find((d) => d.label === 'Name')?.value;
        // Only a plain name goes into the copyable command; anything else could be shell text.
        if (scheme.type === 'apiKey' && name && SAFE_KEY_NAME.test(name)) {
            const placeholder = several ? `<your-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}>` : '<your-key>';
            const flag = { header: `-H "${name}: ${placeholder}"`, query: `--url-query "${name}=${placeholder}"`,
                cookie: `-b "${name}=${placeholder}"` }[where];
            line = flag ? ` \\\n  ${flag}` : null;
        } else if (scheme.type !== 'mutualTLS' && scheme.type !== 'apiKey') {
            line = BEARER_HEADER;
        }
        if (line && !lines.includes(line)) {
            lines.push(line);
        }
    }
    // No declared auth: no header (the page never invents a credential).
    return lines.join('');
}

const trimSlash = (url) => String(url).replace(/\/+$/, '');
const joinUrl = (base, path) => (path ? `${trimSlash(base)}${path}` : base);

/*
 * The card's transports, preferred first: A2A 1.0 `supportedInterfaces[]`, else the 0.3
 * shape (`url` with `preferredTransport`, then `additionalInterfaces[]`). Each URL is the
 * card's when it sits under the interface's productionUrl, else the productionUrl itself,
 * so the page only ever shows the endpoint the publisher gave (the gateway's).
 */
function buildTransports(card, productionUrl) {
    if (!isPlainObject(card)) {
        return [];
    }
    let entries = asArray(card.supportedInterfaces).filter(isPlainObject)
        .map((i) => ({ url: asString(i.url), binding: asString(i.protocolBinding) }));
    if (!entries.length && asString(card.url)) {
        entries = [{ url: card.url, binding: asString(card.preferredTransport) || 'JSONRPC' }]
            .concat(asArray(card.additionalInterfaces).filter(isPlainObject)
                .map((i) => ({ url: asString(i.url), binding: asString(i.transport) })));
    }
    const base = productionUrl ? trimSlash(productionUrl) : null;
    const seen = new Set();
    const transports = [];
    for (const entry of entries) {
        if (!entry.binding) {
            continue;
        }
        const binding = entry.binding.toUpperCase();
        const cardUrl = entry.url ? trimSlash(entry.url) : null;
        const url = base && cardUrl && (cardUrl === base || cardUrl.startsWith(`${base}/`)) ? cardUrl : base;
        const key = `${binding} ${url}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        transports.push({ binding, name: BINDING_NAMES[binding] || entry.binding, url, preferred: transports.length === 0 });
    }
    return transports;
}

/*
 * An example request. A2A: to the card's preferred transport, JSON-RPC or HTTP+JSON in
 * the shape of the card's A2A version; gRPC gets none (curl can't call it). REST: the
 * first operation of the OpenAPI.
 */
function exampleRequest(entry, transports, productionUrl, protocolVersion, resources, auth, portalCredentials) {
    const header = portalCredentials ? PORTAL_HEADERS : authHeader(auth);
    if (entry.type === A2A) {
        // The first transport curl can call: the preferred one, or after a preferred gRPC
        // the next JSON-RPC or HTTP+JSON one.
        const preferred = transports.find((t) => t.binding === 'JSONRPC' || t.binding === 'HTTP+JSON');
        if (!preferred || !preferred.url) {
            return null;
        }
        const firstVersion = protocolVersion ? String(protocolVersion).split(',')[0].trim() : '';
        const v03 = /^0\./.test(firstVersion);
        // A2A 1.0 names its version in a header; 0.3 has none.
        const versionHeader = firstVersion && !v03 ? ` \\\n  -H "A2A-Version: ${firstVersion}"` : '';
        const message = v03
            ? { role: 'user', messageId: 'msg-1', parts: [{ kind: 'text', text: 'Hello' }] }
            : { role: 'ROLE_USER', messageId: 'msg-1', parts: [{ text: 'Hello' }] };
        if (preferred.binding === 'HTTP+JSON') {
            const path = v03 ? '/v1/message:send' : '/message:send';
            return `curl -X POST "${preferred.url}${path}" \\\n  -H "Content-Type: application/json"`
                + `${versionHeader}${header} \\\n  -d '${JSON.stringify({ message })}'`;
        }
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: v03 ? 'message/send' : 'SendMessage', params: { message } });
        return `curl -X POST "${preferred.url}" \\\n  -H "Content-Type: application/json"${versionHeader}${header} \\\n  -d '${body}'`;
    }
    const first = resources?.[0];
    if (!first) {
        return `curl "${productionUrl}"${header}`;
    }
    return `curl -X ${first.method} "${joinUrl(productionUrl, first.path)}" \\\n  -H "Content-Type: application/json"${header}`;
}

/*
 * Where the live card is: only the interface's own cardUrl. The portal never guesses one
 * (no well-known fallback); without it the page shows no live card URL. Shown, never fetched.
 */
function cardLocation(entry) {
    return safeHref(entry.cardUrl) || null;
}

// ---------------------------------------------------------------------------
// Badges (listing card and page header)
// ---------------------------------------------------------------------------

// Each kind's label and icon: the icons of the Settings wizard's interface cards, as API
// type badges each carry one. LOCAL is shown as "Run it yourself" (the YAML value stays LOCAL).
const KINDS = {
    [A2A]: { label: 'A2A', icon: 'bi-diagram-3' },
    [REST]: { label: 'REST', icon: 'bi-braces' },
    [EVENT]: { label: 'Events', icon: 'bi-broadcast' },
    LOCAL: { label: 'Run it yourself', icon: 'bi-terminal' },
};
const SELF_HOSTED = KINDS.LOCAL.label;

/*
 * The badge row (listing card and page header, the same badges): one per interface type
 * offered (A2A, REST, Events), then "Run it yourself".
 */
function kindBadges(agent) {
    const badges = [];
    for (const entry of asArray(agent?.interfaces).filter(isPlainObject)) {
        if (KINDS[entry.type] && entry.type !== 'LOCAL' && !badges.some((b) => b.key === entry.type)) {
            badges.push({ key: entry.type, ...KINDS[entry.type] });
        }
    }
    if (asArray(agent?.types).includes(constants.AGENT_USE_TYPES.LOCAL)) {
        badges.push({ key: 'LOCAL', ...KINDS.LOCAL });
    }
    return badges;
}

function protocolsOf(agent) {
    const seen = new Map();
    for (const entry of asArray(agent?.interfaces).filter((e) => isPlainObject(e) && e.type === REST)) {
        const label = protocolLabel(entry.protocol);
        if (label && !seen.has(label.raw.toUpperCase())) {
            seen.set(label.raw.toUpperCase(), label);
        }
    }
    return [...seen.values()];
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/*
 * The LOCAL Markdown, rendered and sanitized. Code blocks get an id so the page can put
 * a Copy button on each.
 */
function textOf(bytes) {
    if (bytes === null || bytes === undefined) {
        return '';
    }
    return Buffer.isBuffer(bytes) ? bytes.toString(constants.CHARSET_UTF8) : String(bytes);
}

function renderLocal(bytes) {
    const text = textOf(bytes);
    return text.trim() ? sanitizeRenderedHtml(marked.parse(text)) : '';
}

// Human names for the A2A transports (protocolBinding values).
const BINDING_NAMES = { JSONRPC: 'JSON-RPC', GRPC: 'gRPC', 'HTTP+JSON': 'HTTP+JSON' };

/*
 * The A2A interface's transport and version as one plain line, like the REST "Protocol:"
 * line: "A2A version 0.3 · Transport: JSON-RPC". Unknown parts are left out.
 */
function a2aInfoLine(bindings, protocolVersion) {
    const names = asArray(bindings).filter(Boolean).map((b) => BINDING_NAMES[String(b).toUpperCase()] || String(b));
    const parts = [];
    if (protocolVersion) parts.push(`A2A version ${protocolVersion}`);
    if (names.length) parts.push(`${names.length > 1 ? 'Transports' : 'Transport'}: ${names.join(', ')}`);
    return parts.join(' · ') || null;
}

/*
 * The A2A protocol features the agent declares (A2A `capabilities`, from the card),
 * listed only when true, in their own section of the A2A tab: they
 * change how a developer calls it. Extensions and the extended card are left out
 * (decided 2026-11-09).
 */
const A2A_FEATURES = [
    { key: 'streaming', label: 'Streaming', description: 'Updates arrive while the task runs; no need to poll for them.' },
    { key: 'pushNotifications', label: 'Push notifications', description: 'The agent can send task updates to a webhook you register.' },
];
function a2aFeatures(capabilities) {
    if (!isPlainObject(capabilities)) return [];
    return A2A_FEATURES.filter((f) => capabilities[f.key] === true).map(({ label, description }) => ({ label, description }));
}

function callableTab(entry, base, definition, offersCredentials) {
    const productionUrl = entry.endpoints?.productionUrl || null;
    const sandboxUrl = entry.endpoints?.sandboxUrl || null;
    const parsed = definition ? parseDefinition(definition.content) : null;
    const card = entry.type === A2A && definition?.type === AGENT_CARD && isPlainObject(parsed?.parsed)
        ? withoutExtendedCard(parsed.parsed) : null;
    const openApi = entry.type === REST && definition?.type === API_DEFINITION && isPlainObject(parsed?.parsed)
        ? parsed.parsed : null;

    let protocolVersion = null;
    let transports = [];
    let features = [];
    let cardUrl = null;
    if (entry.type === A2A) {
        if (card) {
            const cardInterfaces = asArray(card.supportedInterfaces).filter(isPlainObject);
            protocolVersion = [...new Set(cardInterfaces.map((i) => i.protocolVersion).filter((v) => typeof v === 'string'))]
                .join(', ') || asString(card.protocolVersion) || null;
            transports = buildTransports(card, productionUrl);
            features = a2aFeatures(card.capabilities);
        }
        cardUrl = cardLocation(entry);
    }
    const bindings = [...new Set(transports.map((t) => t.binding))];
    // Operations and auth come only from the interface's definition file.
    const resources = openApi ? { items: openApiResources(openApi), source: 'openapi' } : null;
    let auth = null;
    if (card) {
        auth = buildAuth(card.securitySchemes, card.securityRequirements || card.security, 'card');
    } else if (openApi) {
        auth = buildAuth(openApi.components?.securitySchemes || openApi.securityDefinitions, openApi.security, 'openapi');
    }
    let rawDefinition = null;
    if (card) {
        rawDefinition = { title: 'Agent Card', text: JSON.stringify(card, null, 2) };
    } else if (openApi) {
        rawDefinition = { title: 'OpenAPI definition', text: parsed.text };
    }
    return {
        ...base,
        productionUrl,
        sandboxUrl,
        protocolVersion,
        bindings,
        a2aInfo: entry.type === A2A ? a2aInfoLine(bindings, protocolVersion) : null,
        a2aBadges: entry.type === A2A && protocolVersion ? [`A2A ${protocolVersion}`] : [],
        transports,
        // gRPC first: no curl example; say how to call it instead.
        grpcPreferred: transports[0]?.binding === 'GRPC',
        a2aFeatures: features,
        cardUrl,
        protocol: entry.type === REST ? protocolLabel(entry.protocol) : null,
        resources,
        // With plans, the portal's credentials are what a caller sends; the declared auth is the agent's own.
        portalCredentials: offersCredentials ? PORTAL_CREDENTIALS : null,
        auth: offersCredentials ? null : auth,
        snippet: productionUrl
            ? exampleRequest(entry, transports, productionUrl, protocolVersion, resources?.items, auth, offersCredentials)
            : null,
        snippetId: `${base.tabId}-snippet`,
        rawDefinition,
        rawDefinitionId: `${base.tabId}-definition`,
        card,
    };
}

/**
 * @param {object} metadata     the agent's APIDTO, with `.agent` from metadata_search
 * @param {Object<string, {type: string, content: Buffer|string}>} definitions
 *        stored definition files by content type (AGENT_CARD, API_DEFINITION, ...)
 */
function buildAgentViewModel(metadata, definitions = {}) {
    const offersCredentials = asArray(metadata?.subscriptionPlans).length > 0;
    const agent = metadata?.agent || {};
    const types = asArray(agent.types);
    const interfaces = asArray(agent.interfaces).filter(isPlainObject);
    const byKey = isPlainObject(definitions) ? definitions : {};

    const tabs = [];
    let sourceCard = null;
    for (const entry of interfaces) {
        if (!KINDS[entry.type] || entry.type === 'LOCAL') {
            continue;
        }
        const base = {
            tabId: `agent-use-${domId(entry.type)}`,
            label: KINDS[entry.type].label,
            isA2A: entry.type === A2A,
            isRest: entry.type === REST,
            isEvent: entry.type === EVENT,
            isLocal: false,
        };
        const definition = byKey[DEFINITION_DOC_TYPE[entry.type]] || null;
        if (entry.type === EVENT) {
            const parsed = definition?.type === AGENT_EVENT_DEFINITION ? parseDefinition(definition.content) : null;
            const summary = asyncApiSummary(parsed?.parsed);
            tabs.push({
                ...base,
                events: {
                    summary,
                    rawText: parsed?.text || '',
                    rawId: `${base.tabId}-asyncapi`,
                    empty: !summary || summary.channels.length === 0,
                },
            });
            continue;
        }
        const tab = callableTab(entry, base, definition, offersCredentials);
        if (tab.card && !sourceCard) {
            sourceCard = tab.card;
        }
        delete tab.card;
        tabs.push(tab);
    }
    const isLocal = types.includes(constants.AGENT_USE_TYPES.LOCAL);
    if (isLocal) {
        const local = byKey[AGENT_LOCAL_DEFINITION];
        tabs.push({
            tabId: 'agent-run',
            label: SELF_HOSTED,
            isLocal: true,
            localHtml: local?.type === AGENT_LOCAL_DEFINITION ? renderLocal(local.content) : '',
            // The Markdown as written, for the agent's .md view (text/markdown, never HTML).
            localText: local?.type === AGENT_LOCAL_DEFINITION ? textOf(local.content) : '',
        });
    }
    tabs.forEach((tab, i) => { tab.isFirst = i === 0; });
    // Authentication and the example request get their own section after Skills (Shamly,
    // 2026-11-12): one panel per way of calling the agent that has either.
    const accessTabs = tabs.filter((tab) => tab.portalCredentials || tab.auth || tab.snippet || tab.grpcPreferred)
        .map((tab, i) => ({ ...tab, accessId: `${tab.tabId}-access`, isFirstAccess: i === 0 }));

    const skills = sourceCard
        ? { items: asArray(sourceCard.skills).filter(isPlainObject).map(toSkill), source: 'card' }
        : { items: asArray(agent.skills).filter(isPlainObject).map(toSkill), source: 'yaml' };
    const isCallable = interfaces.some((entry) => entry.type === A2A || entry.type === REST);
    const hasEvents = interfaces.some((entry) => entry.type === EVENT);
    const provider = isPlainObject(agent.provider) && asString(agent.provider.organization)
        ? { organization: agent.provider.organization, url: safeHref(agent.provider.url) || null }
        : null;

    return {
        types,
        badges: kindBadges(agent),
        skills,
        tabs,
        tabsMany: tabs.length > 1,
        accessTabs,
        accessTabsMany: accessTabs.length > 1,
        isCallable,
        hasEvents,
        isLocal,
        isLocalOnly: isLocal && !isCallable && !hasEvents,
        isEventOnly: hasEvents && !isCallable,
        offersCredentials,
        provider,
        models: buildModels(agent.models),
        agentId: asString(agent.agentId) || null,
    };
}

module.exports = {
    buildAgentViewModel,
    asyncApiSummary,
    kindBadges,
    protocolsOf,
    protocolLabel,
};
