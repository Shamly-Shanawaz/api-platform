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
 * The agent page view model: one tab per way of use in document order, transports, auth
 * and operations from each interface's definition file, skills from the A2A card (else
 * the YAML), the LOCAL Markdown sanitized, placeholders only in examples.
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildAgentViewModel, asyncApiSummary, kindBadges, protocolsOf } = require('./agentViewModel');

const URL = 'https://agents.example.com/a';
const CARD = {
    name: 'Card', version: '1.0.0', description: 'From the card',
    supportedInterfaces: [{ url: `${URL}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        { url: `${URL}/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    securitySchemes: { key: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } } },
    securityRequirements: [{ schemes: { key: { list: [] } } }],
    skills: [{ id: 'triage', name: 'Triage', description: 'Sorts invoices' }],
    extendedAgentCard: { url: 'https://secret.example.com' },
};
const OPENAPI = 'openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths:\n  /chat:\n    post: {summary: Chat}\n';
const ASYNCAPI_V3 = JSON.stringify({
    asyncapi: '3.0.0', info: { title: 'Invoices', version: '1' },
    servers: { prod: { host: 'kafka.example.com:9092', protocol: 'kafka' } },
    channels: { received: { address: 'invoices.received', messages: { InvoiceReceived: { payload: { type: 'object' } } } },
        triaged: { address: 'invoices.triaged', messages: { InvoiceTriaged: { payload: { type: 'object' } } } } },
    operations: {
        sendInvoice: { action: 'receive', channel: { $ref: '#/channels/received' } },
        publishDecision: { action: 'send', channel: { $ref: '#/channels/triaged' } },
    },
});

const agent = (fields) => ({ name: 'Agent', agent: fields });
const cardDef = (card) => ({ AGENT_CARD: { type: 'AGENT_CARD', content: Buffer.from(JSON.stringify(card)) } });
const openApiDef = (doc) => ({ API_DEFINITION: { type: 'API_DEFINITION', content: JSON.stringify(doc) } });
const restAgent = (extra = {}) => agent({ types: ['API'], interfaces: [{ type: 'REST', endpoints: { productionUrl: URL } }], ...extra });

test('one tab per interface in document order, then Run it yourself', () => {
    const vm = buildAgentViewModel(agent({
        types: ['API', 'EVENT', 'LOCAL'],
        interfaces: [
            { type: 'REST', endpoints: { productionUrl: URL } },
            { type: 'A2A', endpoints: { productionUrl: URL } },
            { type: 'EVENT' },
        ],
    }), {});
    assert.deepEqual(vm.tabs.map((t) => t.label), ['REST', 'A2A', 'Events', 'Run it yourself']);
    assert.deepEqual(vm.tabs.map((t) => t.tabId), ['agent-use-REST', 'agent-use-A2A', 'agent-use-EVENT', 'agent-run']);
    assert.equal(vm.tabs[0].isFirst, true);
    assert.equal(vm.tabsMany, true);
    assert.deepEqual(vm.badges.map((b) => b.label), ['REST', 'A2A', 'Events', 'Run it yourself']);
    // Every kind badge has an icon, as API type badges do (the Settings wizard's icons).
    assert.deepEqual(vm.badges.map((b) => b.icon), ['bi-braces', 'bi-diagram-3', 'bi-broadcast', 'bi-terminal']);
});

test('authentication and the example request: one panel per callable way, after Skills', () => {
    const vm = buildAgentViewModel(agent({
        types: ['API', 'EVENT', 'LOCAL'],
        interfaces: [
            { type: 'REST', endpoints: { productionUrl: URL } },
            { type: 'A2A', endpoints: { productionUrl: URL } },
            { type: 'EVENT' },
        ],
    }), cardDef(CARD));
    // Events and Run it yourself have nothing to authenticate, so they get no panel.
    assert.deepEqual(vm.accessTabs.map((t) => t.label), ['REST', 'A2A']);
    assert.deepEqual(vm.accessTabs.map((t) => t.accessId), ['agent-use-REST-access', 'agent-use-A2A-access']);
    assert.equal(vm.accessTabs[0].isFirstAccess, true);
    assert.equal(vm.accessTabs[1].isFirstAccess, false);
    assert.equal(vm.accessTabsMany, true);
    assert.ok(vm.accessTabs.every((t) => t.snippet));
    // Ids stay distinct from the How to use panels, so both tab bars work.
    assert.ok(vm.accessTabs.every((t) => !vm.tabs.some((u) => u.tabId === t.accessId)));
});

test('each interface uses the definition file of its type; skills come from the card', () => {
    const vm = buildAgentViewModel(agent({
        types: ['API'],
        interfaces: [
            { type: 'A2A', endpoints: { productionUrl: URL } },
            { type: 'REST', endpoints: { productionUrl: URL } },
        ],
    }), {
        AGENT_CARD: { type: 'AGENT_CARD', content: Buffer.from(JSON.stringify(CARD)) },
        API_DEFINITION: { type: 'API_DEFINITION', content: OPENAPI },
    });
    const [a2a, chat] = vm.tabs;
    assert.equal(vm.skills.source, 'card');
    assert.deepEqual(vm.skills.items.map((s) => s.name), ['Triage']);
    assert.deepEqual(a2a.bindings, ['JSONRPC', 'HTTP+JSON']);
    assert.ok(a2a.a2aInfo.endsWith('Transports: JSON-RPC, HTTP+JSON'), a2a.a2aInfo);
    // No cardUrl in the YAML: no live card URL is guessed, even with a stored card.
    assert.equal(a2a.cardUrl, null);
    assert.ok(!a2a.rawDefinition.text.includes('secret.example.com'), 'extended card is never shown');
    assert.ok(a2a.snippet.includes(`"${URL}/rpc"`));
    assert.ok(a2a.snippet.includes('X-API-Key: <your-key>'));
    assert.equal(chat.resources.source, 'openapi');
    assert.deepEqual(chat.resources.items.map((r) => `${r.method} ${r.path}`), ['POST /chat']);
});

test('transports come from the card, preferred first, with URLs under the endpoint only', () => {
    const a2aAgent = agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] });
    const [tab] = buildAgentViewModel(a2aAgent, cardDef(CARD)).tabs;
    assert.deepEqual(tab.transports, [
        { binding: 'JSONRPC', name: 'JSON-RPC', url: `${URL}/rpc`, preferred: true },
        { binding: 'HTTP+JSON', name: 'HTTP+JSON', url: `${URL}/rest`, preferred: false },
    ]);
    // Only the version is a badge now; the transports have their own section.
    assert.deepEqual(tab.a2aBadges, ['A2A 1.0']);
    // A card URL outside the endpoint is never shown: the endpoint stands in for it.
    const elsewhere = buildAgentViewModel(a2aAgent, cardDef({ ...CARD,
        supportedInterfaces: [{ url: 'http://internal.local:9000/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })).tabs[0];
    assert.equal(elsewhere.transports[0].url, URL);
    assert.ok(!JSON.stringify(elsewhere.transports).includes('internal.local'));
});

test('the example request follows the preferred transport', () => {
    const a2aAgent = agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] });
    const httpFirst = buildAgentViewModel(a2aAgent, cardDef({ ...CARD,
        supportedInterfaces: [CARD.supportedInterfaces[1], CARD.supportedInterfaces[0]] })).tabs[0];
    assert.ok(httpFirst.snippet.startsWith(`curl -X POST "${URL}/rest/message:send"`), httpFirst.snippet);
    assert.ok(httpFirst.snippet.includes('A2A-Version: 1.0'));
    assert.equal(httpFirst.grpcPreferred, false);

    const grpcFirst = buildAgentViewModel(a2aAgent, cardDef({ ...CARD,
        supportedInterfaces: [{ url: `${URL}/grpc`, protocolBinding: 'GRPC', protocolVersion: '1.0' }, ...CARD.supportedInterfaces] }));
    // gRPC first: the example uses the next transport curl can call.
    assert.ok(grpcFirst.tabs[0].snippet.startsWith(`curl -X POST "${URL}/rpc"`), grpcFirst.tabs[0].snippet);
    assert.equal(grpcFirst.tabs[0].grpcPreferred, true);

    const grpcOnly = buildAgentViewModel(a2aAgent, cardDef({ ...CARD,
        supportedInterfaces: [{ url: `${URL}/grpc`, protocolBinding: 'GRPC', protocolVersion: '1.0' }] }));
    assert.equal(grpcOnly.tabs[0].snippet, null);
    assert.equal(grpcOnly.tabs[0].grpcPreferred, true);
    // The access panel still shows, to say how to call it.
    assert.equal(grpcOnly.accessTabs.length, 1);
});

test('an A2A 0.3 card: url and preferredTransport, then additionalInterfaces; 0.3 request shape', () => {
    const a2aAgent = agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] });
    const card = { name: 'Old', version: '1', protocolVersion: '0.3.0', url: `${URL}/rpc`, preferredTransport: 'JSONRPC',
        additionalInterfaces: [{ url: `${URL}/rpc`, transport: 'JSONRPC' }, { url: `${URL}/http`, transport: 'HTTP+JSON' }],
        skills: [] };
    const [tab] = buildAgentViewModel(a2aAgent, cardDef(card)).tabs;
    assert.deepEqual(tab.transports.map((t) => [t.name, t.url, t.preferred]),
        [['JSON-RPC', `${URL}/rpc`, true], ['HTTP+JSON', `${URL}/http`, false]]);
    assert.deepEqual(tab.a2aBadges, ['A2A 0.3.0']);
    assert.ok(tab.snippet.includes('"method":"message/send"'), tab.snippet);
    assert.ok(tab.snippet.includes('"kind":"text"'));
    assert.ok(!tab.snippet.includes('A2A-Version'), tab.snippet);
});

test('without its definition file an interface shows no operations, transports or auth', () => {
    const rest = buildAgentViewModel(restAgent(), {});
    assert.equal(rest.tabs[0].resources, null);
    assert.equal(rest.tabs[0].rawDefinition, null);
    assert.equal(rest.tabs[0].auth, null);
    const a2a = buildAgentViewModel(agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] }), {});
    assert.deepEqual(a2a.tabs[0].bindings, []);
    assert.equal(a2a.tabs[0].protocolVersion, null);
    assert.ok(!/Authorization|api-key|X-API-Key/i.test(a2a.tabs[0].snippet), a2a.tabs[0].snippet);
});

test('A2A protocol features are listed only when true, from the card', () => {
    const cardVm = buildAgentViewModel(agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] }), {
        AGENT_CARD: { type: 'AGENT_CARD', content: Buffer.from(JSON.stringify({ ...CARD,
            capabilities: { streaming: true, pushNotifications: false, extensions: [{ uri: 'urn:x' }] } })) },
    });
    assert.deepEqual(cardVm.tabs[0].a2aFeatures.map((f) => f.label), ['Streaming']);
    assert.ok(cardVm.tabs[0].a2aFeatures[0].description);
    // Features have their own section, not badges.
    assert.ok(!cardVm.tabs[0].a2aBadges.includes('Streaming'), cardVm.tabs[0].a2aBadges.join());

    // Anything but a strict true shows nothing.
    const offVm = buildAgentViewModel(agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] }),
        cardDef({ ...CARD, capabilities: { streaming: 'yes' } }));
    assert.deepEqual(offVm.tabs[0].a2aFeatures, []);
});

const BEARER_OPENAPI = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {},
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }] };

test('a bearer scheme in the OpenAPI gives a bearer placeholder, never a value', () => {
    const vm = buildAgentViewModel(restAgent(), openApiDef(BEARER_OPENAPI));
    assert.ok(vm.tabs[0].snippet.includes('Authorization: Bearer <your-token>'));
});

test('auth schemes are shown in words: title, flow, URLs to copy, scopes as tags', () => {
    const vm = buildAgentViewModel(restAgent(), openApiDef({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {},
        components: { securitySchemes: {
            oauth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://idp.example.com/token',
                scopes: { 'invoices:read': 'Read', 'invoices:write': 'Write' } } } },
            key: { type: 'apiKey', in: 'query', name: 'key' },
            basic: { type: 'http', scheme: 'basic' },
        } },
        security: [{ oauth: [] }, { key: [] }] }));
    const [oauth, key, basic] = vm.tabs[0].auth.schemes;
    assert.equal(oauth.typeLabel, 'OAuth 2.0');
    assert.deepEqual(oauth.details.map((d) => [d.label, d.kind]), [['Flow', 'text'], ['Token URL', 'url'], ['Scopes', 'tags']]);
    assert.equal(oauth.details[0].value, 'Client credentials');
    assert.deepEqual(oauth.details[2].tags, ['invoices:read', 'invoices:write']);
    assert.equal(key.typeLabel, 'API key');
    assert.deepEqual(key.details.map((d) => [d.label, d.value]), [['Sent in', 'Query parameter'], ['Name', 'key']]);
    assert.equal(basic.typeLabel, 'HTTP basic');
});

test('the Run it yourself tab renders the Markdown sanitized', () => {
    const md = '# Run it\n\n<script>alert(1)</script>\n\n```bash\nnpx tool\n```\n\n[x](javascript:alert(1))\n';
    const vm = buildAgentViewModel(agent({ types: ['LOCAL'] }),
        { AGENT_LOCAL_DEFINITION: { type: 'AGENT_LOCAL_DEFINITION', content: Buffer.from(md) } });
    const [tab] = vm.tabs;
    assert.equal(tab.isLocal, true);
    assert.ok(tab.localHtml.includes('<h1'));
    assert.ok(tab.localHtml.includes('npx tool'));
    assert.ok(!/<script|javascript:/i.test(tab.localHtml), tab.localHtml);
    assert.equal(vm.isLocalOnly, true);
});

test('EVENT tabs summarise AsyncAPI 3 from the developer side', () => {
    const vm = buildAgentViewModel(agent({ types: ['EVENT'], interfaces: [{ type: 'EVENT' }] }),
        { AGENT_EVENT_DEFINITION: { type: 'AGENT_EVENT_DEFINITION', content: ASYNCAPI_V3 } });
    const { summary } = vm.tabs[0].events;
    assert.equal(summary.servers[0].url, 'kafka.example.com:9092');
    assert.deepEqual(summary.channels.map((c) => [c.address, c.operations[0].direction]),
        [['invoices.received', 'You send'], ['invoices.triaged', 'You receive']]);
    assert.equal(vm.isEventOnly, true);
});

test('message payloads are listed as fields: enums joined, arrays marked', () => {
    const summary = asyncApiSummary({ asyncapi: '2.6.0', channels: { a: { subscribe: { message: { name: 'Triaged', payload: {
        type: 'object', properties: { invoiceId: { type: 'string' }, decision: { enum: ['APPROVE', 'HOLD'] },
            reasons: { type: 'array', items: { type: 'string' } } } } } } } } });
    assert.deepEqual(summary.channels[0].operations[0].messages[0].fields, [
        { name: 'invoiceId', type: 'string' }, { name: 'decision', type: 'APPROVE | HOLD' }, { name: 'reasons', type: 'string[]' },
    ]);
});

test('AsyncAPI 2 publish is "you send", subscribe is "you receive"', () => {
    const summary = asyncApiSummary({ asyncapi: '2.6.0', channels: { a: { publish: { message: { name: 'A' } } },
        b: { subscribe: { message: { name: 'B' } } } } });
    assert.deepEqual(summary.channels.map((c) => c.operations[0].direction), ['You send', 'You receive']);
});

test('badges and protocol labels for the listing', () => {
    const fields = { types: ['API', 'LOCAL'], interfaces: [
        { type: 'REST', protocol: 'openai_responses' }, { type: 'REST', protocol: 'MY_OWN' }] };
    assert.deepEqual(kindBadges(fields).map((b) => b.key), ['REST', 'LOCAL']);
    assert.deepEqual(protocolsOf(fields).map((p) => [p.label, p.recognized]), [['OpenAI Responses', true], ['MY_OWN', false]]);
});

test('details: provider link only for http(s); agent ID shown as given', () => {
    const vm = buildAgentViewModel(agent({ types: ['LOCAL'], agentId: 'abc-123',
        provider: { organization: 'Acme', url: 'javascript:alert(1)' }, models: [{ provider: 'Anthropic', name: 'claude' }] }));
    assert.deepEqual(vm.provider, { organization: 'Acme', url: null });
    assert.equal(vm.agentId, 'abc-123');
    assert.deepEqual(vm.models, [{ label: 'Anthropic · claude' }]);
});

test('with plans, callable tabs list the portal credentials and the example carries both headers', () => {
    const vm = buildAgentViewModel({ name: 'Agent', subscriptionPlans: [{ id: 'Gold' }], agent: {
        types: ['API', 'EVENT'],
        interfaces: [
            { type: 'REST', endpoints: { productionUrl: URL } },
            { type: 'EVENT' },
        ] } }, openApiDef(BEARER_OPENAPI));
    const [rest, events] = vm.tabs;
    assert.equal(vm.offersCredentials, true);
    assert.deepEqual(rest.portalCredentials.map((c) => c.header), ['api-key', 'Subscription-Key']);
    assert.equal(rest.auth, null);
    assert.ok(rest.snippet.includes('api-key: <your-api-key>'));
    assert.ok(rest.snippet.includes('Subscription-Key: <your-subscription-token>'));
    assert.ok(!rest.snippet.includes('Authorization'), rest.snippet);
    assert.equal(events.portalCredentials, undefined);
});

test('an API key goes where the scheme says: header, query parameter or cookie', () => {
    const a2aAgent = agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] });
    const snippet = (scheme) => buildAgentViewModel(a2aAgent, cardDef({
        ...CARD, securitySchemes: { key: { apiKeySecurityScheme: scheme } },
    })).tabs[0].snippet;
    assert.ok(snippet({ location: 'header', name: 'X-Key' }).includes('-H "X-Key: <your-key>"'));
    assert.ok(snippet({ location: 'query', name: 'key' }).includes('--url-query "key=<your-key>"'));
    assert.ok(snippet({ location: 'cookie', name: 'sid' }).includes('-b "sid=<your-key>"'));
    assert.ok(!snippet({ location: 'query', name: 'key' }).includes('-H "key:'));
    // A name that isn't a plain token never goes into the copyable command.
    assert.ok(!snippet({ location: 'header', name: 'x"; rm -rf ~; "' }).includes('rm -rf'));
});

test('only the extended card fields are hidden, not schemes whose names mention it', () => {
    const a2aAgent = agent({ types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: URL } }] });
    const [tab] = buildAgentViewModel(a2aAgent, cardDef({
        ...CARD,
        capabilities: { streaming: true, extendedAgentCard: true },
        securitySchemes: { protectedBearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
        securityRequirements: [{ schemes: { protectedBearer: { list: [] } } }],
    })).tabs;
    assert.ok(tab.snippet.includes('Authorization: Bearer'), tab.snippet);
    assert.ok(!tab.rawDefinition.text.includes('secret.example.com'));
    assert.ok(!tab.rawDefinition.text.includes('extendedAgentCard'));
});
