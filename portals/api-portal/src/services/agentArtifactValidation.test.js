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
 * The kind: Agent v1alpha1 rules, one case per rule. Messages are asserted exactly:
 * they name a field, never a value or a limit. Every problem is collected, so cases
 * also check that problems are reported together.
 */

const test = require('node:test');
const assert = require('node:assert');
const yaml = require('js-yaml');
const {
    validateAgentArtifact, pruneEmpty, assertDocumentSize,
} = require('./agentArtifactValidation');

const MAX = 4096;
const URL = 'https://agents.example.com/a';
const META = { name: 'agent-a' };
const LISTING = { displayName: 'Agent A', version: 'v1', description: 'Does things.' };
const file = (fileName, content) => ({ fileName, buffer: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)) });
const CARD_JSON = {
    name: 'Card name', version: '1.0.0', description: 'From the card',
    supportedInterfaces: [{ url: `${URL}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    skills: [{ id: 'triage', name: 'Triage', description: 'Sorts invoices', tags: ['finance'] }],
};
const CARD = file('agent-card.json', CARD_JSON);
const OPENAPI = file('openapi.yaml', 'openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\n');
const ASYNCAPI = file('asyncapi.yaml', 'asyncapi: 3.0.0\ninfo: {title: t, version: "1"}\n');
const RUN_MD = file('run-locally.md', '# Run it\n\n```bash\nnpx @acme/tool run\n```\n');

const SKILLS = [{ id: 'triage', name: 'Triage', description: 'Sorts invoices' }];
const a2a = (extra = {}) => ({ type: 'A2A', endpoints: { productionUrl: URL }, ...extra });
const rest = (extra = {}) => ({ type: 'REST', endpoints: { productionUrl: URL }, ...extra });
const event = (extra = {}) => ({ type: 'EVENT', ...extra });

const api = (iface, extra = {}) => ({ types: ['API'], ...LISTING, interfaces: [iface], ...extra });
// An A2A agent with its Agent Card (C), the usual valid agent in these cases.
const a2aApi = (iface = a2a(), extra = {}) => api(iface, extra);
const C = { a2aDefinition: CARD };
const local = (extra = {}) => ({ types: ['LOCAL'], ...LISTING, ...extra });

function ok(spec, uploads = {}, options = {}, metadata = META) {
    return validateAgentArtifact(metadata, spec, uploads, { maxDefinitionBytes: MAX, ...options });
}

// Asserts the listed messages are exactly the problems reported.
function rejects(spec, uploads, messages, options = {}, metadata = META) {
    const expected = Array.isArray(messages) ? messages : [messages];
    assert.throws(() => ok(spec, uploads, options, metadata), (err) => {
        assert.deepEqual(err.details || [err.description || err.message], expected);
        return true;
    });
}

test('the supported shapes are accepted', () => {
    assert.deepEqual(ok(a2aApi(), C).types, ['API']);
    const carded = ok(api(a2a()), { a2aDefinition: CARD });
    assert.equal(carded.definitions[0].docType, 'AGENT_CARD');
    assert.equal(carded.card.name, 'Card name');
    assert.equal(ok(api(rest()), { restDefinition: OPENAPI }).definitions[0].docType, 'API_DEFINITION');
    assert.equal(ok({ types: ['EVENT'], ...LISTING, interfaces: [event()] }, { eventDefinition: ASYNCAPI })
        .definitions[0].docType, 'AGENT_EVENT_DEFINITION');
    assert.deepEqual(ok(local(), { localDefinition: RUN_MD }).definitions.map((d) => d.docType), ['AGENT_LOCAL_DEFINITION']);
    assert.deepEqual(ok({ ...a2aApi(), types: ['API', 'LOCAL'] }, { ...C, localDefinition: RUN_MD }).types, ['API', 'LOCAL']);
    // Without A2A, skills may be written in the YAML.
    assert.equal(ok(api(rest(), { skills: SKILLS }), { restDefinition: OPENAPI }).skills[0].id, 'triage');
});

test('one interface of each type, each with its own definition file', () => {
    const spec = { types: ['API', 'EVENT', 'LOCAL'], ...LISTING, interfaces: [a2a(), rest(), event()] };
    const result = ok(spec, { a2aDefinition: CARD, restDefinition: OPENAPI, eventDefinition: ASYNCAPI, localDefinition: RUN_MD });
    assert.deepEqual(result.definitions.map((d) => d.docType),
        ['AGENT_CARD', 'API_DEFINITION', 'AGENT_EVENT_DEFINITION', 'AGENT_LOCAL_DEFINITION']);
});

test('at most one interface per type; types are closed; interface id is not a field', () => {
    rejects({ ...LISTING, types: ['API'], interfaces: [rest(), rest()] }, { restDefinition: OPENAPI },
        "Field 'spec.interfaces[1].type' must be unique: an agent has at most one REST interface.");
    rejects(a2aApi(a2a({ type: 'GRPC' })), {}, [
        "Field 'spec.interfaces[0].type' must be one of A2A, REST, EVENT.",
        "Field 'spec.types' includes API, so an A2A or REST interface is required. Add one to spec.interfaces, or remove API.",
    ]);
    rejects(a2aApi(a2a({ id: 'a2a' })), C, "Field 'spec.interfaces[0].id' is not allowed. Remove it.");
    rejects(a2aApi(a2a({ definition: 'agent-card.json' })), C, "Field 'spec.interfaces[0].definition' is not allowed. Remove it.");
    rejects(local({ local: { definition: 'run-locally.md' } }), { localDefinition: RUN_MD }, "Field 'spec.local' is not allowed. Remove it.");
});

test('spec.types is required, closed and unique', () => {
    rejects({ ...LISTING }, { localDefinition: RUN_MD }, [
        "Field 'spec.types' is required.",
        "Field 'localDefinition' was uploaded, but spec.types does not include LOCAL. Add LOCAL, or don't upload the file.",
    ]);
    rejects(local({ types: ['LOCAL', 'OTHER'] }), { localDefinition: RUN_MD }, "Field 'spec.types' must list one or more of API, EVENT, LOCAL.");
    rejects(local({ types: ['LOCAL', 'LOCAL'] }), { localDefinition: RUN_MD }, "Field 'spec.types' must be unique.");
});

test('each type needs its part and each part needs its type', () => {
    rejects({ types: ['API'], ...LISTING }, {},
        "Field 'spec.types' includes API, so an A2A or REST interface is required. Add one to spec.interfaces, or remove API.");
    rejects({ ...a2aApi(), types: ['LOCAL'] }, { ...C, localDefinition: RUN_MD },
        "Field 'spec.types' must include API when an A2A or REST interface is given. Add API to spec.types.");
    rejects({ types: ['EVENT'], ...LISTING }, {},
        "Field 'spec.types' includes EVENT, so an EVENT interface is required. Add one to spec.interfaces, or remove EVENT.");
    rejects(local(), {},
        "Field 'localDefinition' is required when spec.types includes LOCAL. Upload a Markdown file that says how to run the agent.");
});

test('unknown fields are rejected everywhere', () => {
    rejects(a2aApi(a2a(), { colour: 'blue' }), C, "Field 'spec.colour' is not allowed. Remove it.");
    rejects(a2aApi(a2a({ tenant: 't1' })), C, "Field 'spec.interfaces[0].tenant' is not allowed. Remove it.");
    rejects(a2aApi(a2a({ bindings: [{ protocolBinding: 'JSONRPC' }] })), C, "Field 'spec.interfaces[0].bindings' is not allowed. Remove it.");
    rejects(a2aApi(), C, "Field 'metadata.owner' is not allowed. Remove it.", {}, { name: 'agent-a', owner: 'x' });
    rejects(a2aApi(), { ...C, cardDefinition: CARD }, "Field 'cardDefinition' is not allowed. Remove it.");
    rejects(a2aApi(), { ...C, definition: CARD },
        "Field 'definition' is not allowed. Send the Agent Card as 'a2aDefinition', the OpenAPI as 'restDefinition', the AsyncAPI as 'eventDefinition' and the run-it-yourself Markdown as 'localDefinition'.");
});

test('an empty value counts as absent', () => {
    const result = ok(a2aApi(a2a(), { tags: [], description: 'Does things.', provider: {}, agentId: '  ' }), C);
    assert.equal(result.spec.tags, undefined);
    assert.equal(result.spec.provider, undefined);
    assert.equal(result.spec.agentId, undefined);
    assert.deepEqual(pruneEmpty({ a: '', b: [], c: {}, d: { e: null }, security: [{ bearer: [] }] }), { security: [{ bearer: [] }] });
});

test('a __proto__ key stays a visible key and is rejected', () => {
    const spec = JSON.parse(JSON.stringify(local()).replace('"types"', '"__proto__":{"skills":[{"id":"x"}]},"types"'));
    rejects(spec, { localDefinition: RUN_MD }, "Field 'spec.__proto__' is not allowed. Remove it.");
});

test('agentId is optional, a string, at most 255 characters', () => {
    assert.equal(ok(a2aApi(a2a(), { agentId: '5f0c-agent' }), C).spec.agentId, '5f0c-agent');
    rejects(a2aApi(a2a(), { agentId: 42 }), C, "Field 'spec.agentId' is invalid.");
    rejects(a2aApi(a2a(), { agentId: 'x'.repeat(256) }), C, "Field 'spec.agentId' is too long.");
});

test('the listing is required without A2A and defaults from the card', () => {
    rejects({ types: ['API'], interfaces: [rest()] }, { restDefinition: OPENAPI }, [
        "Field 'spec.displayName' is required.",
        "Field 'spec.version' is required.",
        "Field 'spec.description' is required.",
    ]);
    const result = ok({ types: ['API'], interfaces: [a2a()] }, C);
    assert.equal(result.spec.displayName, undefined);
    assert.equal(result.card.version, '1.0.0');
});

test('every A2A and REST interface needs its definition file', () => {
    rejects(api(a2a()), {}, "Field 'a2aDefinition' is required with an A2A interface. Upload its Agent Card.");
    rejects(api(rest()), {}, "Field 'restDefinition' is required with a REST interface. Upload its OpenAPI document.");
    rejects({ types: ['API'], ...LISTING, interfaces: [a2a(), rest()] }, {}, [
        "Field 'a2aDefinition' is required with an A2A interface. Upload its Agent Card.",
        "Field 'restDefinition' is required with a REST interface. Upload its OpenAPI document.",
    ]);
});

test('an interface gives only its URLs: transports, auth and operations come from its file', () => {
    rejects(api(a2a({ protocolBinding: 'GRPC', securitySchemes: { k: { type: 'apiKey', name: 'k', in: 'header' } } }),
        { skills: SKILLS }), C, [
        "Field 'spec.interfaces[0].protocolBinding' is not allowed. Remove it.",
        "Field 'spec.interfaces[0].securitySchemes' is not allowed. Remove it.",
        "Field 'spec.skills' cannot be used when an agent card is provided. Remove it; the card supplies it.",
    ]);
    rejects(api(rest({ resources: [{ method: 'GET', path: '/x' }], security: [{ bearer: [] }] })), { restDefinition: OPENAPI }, [
        "Field 'spec.interfaces[0].resources' is not allowed. Remove it.",
        "Field 'spec.interfaces[0].security' is not allowed. Remove it.",
    ]);
    assert.equal(ok(api(rest({ protocol: 'OPENAI_RESPONSES' })), { restDefinition: OPENAPI }).interfaces[0].protocol, 'OPENAI_RESPONSES');
});

test('endpoints: productionUrl required, http(s) only, no credentials, at most 255 characters', () => {
    rejects(a2aApi(a2a({ endpoints: {} })), C, "Field 'spec.interfaces[0].endpoints.productionUrl' is required.");
    for (const bad of ['ftp://x.example', 'javascript:alert(1)', 'https://user:pw@x.example/a', 'not a url']) {
        rejects(a2aApi(a2a({ endpoints: { productionUrl: bad } })), C, "Field 'spec.interfaces[0].endpoints.productionUrl' is invalid.");
    }
    rejects(a2aApi(a2a({ endpoints: { productionUrl: `https://x.example/${'a'.repeat(255)}` } })), C,
        "Field 'spec.interfaces[0].endpoints.productionUrl' is too long.");
});

test('an EVENT interface needs its AsyncAPI file and nothing else', () => {
    rejects({ types: ['EVENT'], ...LISTING, interfaces: [event({ endpoints: { productionUrl: URL } })] }, {}, [
        "Field 'eventDefinition' is required with an EVENT interface. Upload its AsyncAPI document.",
        "Field 'spec.interfaces[0].endpoints' is not allowed. Remove it.",
    ]);
    rejects({ types: ['EVENT'], ...LISTING, interfaces: [event()] }, { eventDefinition: file('asyncapi.yaml', 'openapi: 3.0.0') },
        "Field 'eventDefinition' must be an AsyncAPI 2 or 3 document.");
});

test('a definition file needs its interface', () => {
    rejects(a2aApi(), { ...C, restDefinition: OPENAPI },
        "Field 'restDefinition' was uploaded, but spec.interfaces has no REST interface. Add one, or don't upload the file.");
});

test('the file content must fit its kind', () => {
    rejects(api(a2a()), { a2aDefinition: file('agent-card.json', 'not json') },
        "Field 'a2aDefinition' must be an agent card (a JSON object).");
    rejects(api(rest()), { restDefinition: file('openapi.yaml', 'title: x') },
        "Field 'restDefinition' must be an OpenAPI document.");
    rejects(local(), { localDefinition: file('run-locally.md', '   ') }, "Field 'localDefinition' must be a Markdown text file.");
    rejects(local(), { localDefinition: file('run-locally.md', Buffer.from([0x23, 0x00, 0x41]).toString('latin1')) },
        "Field 'localDefinition' must be a Markdown text file.");
});

test('an oversized definition is refused with a generic 413', () => {
    assert.throws(() => ok(api(rest()), { restDefinition: file('openapi.yaml', `openapi: 3.0.0\n#${'x'.repeat(MAX)}`) }),
        (err) => err.statusCode === 413 && !/\d/.test(err.description));
});

test('on update no file keeps the stored one; a removed interface loses it', () => {
    const existing = { definitions: {
        AGENT_CARD: { card: CARD_JSON }, API_DEFINITION: {}, AGENT_LOCAL_DEFINITION: {},
    } };
    const kept = ok({ types: ['API', 'LOCAL'], interfaces: [a2a(), rest()] }, {}, { existing });
    assert.deepEqual(kept.keep, ['AGENT_CARD', 'API_DEFINITION', 'AGENT_LOCAL_DEFINITION']);
    assert.equal(kept.card.name, 'Card name');
    assert.deepEqual(kept.definitions, []);
    // REST and LOCAL removed: their files are not kept.
    const fewer = ok({ types: ['API'], interfaces: [a2a()] }, {}, { existing });
    assert.deepEqual(fewer.keep, ['AGENT_CARD']);
    // An uploaded file replaces the stored one.
    const replaced = ok({ types: ['API'], interfaces: [a2a()] }, { a2aDefinition: file('x.json', { ...CARD_JSON, name: 'New' }) }, { existing });
    assert.deepEqual(replaced.keep, []);
    assert.equal(replaced.card.name, 'New');
});

test('plans only when types includes API', () => {
    rejects(local({ subscriptionPlans: ['Gold'] }), { localDefinition: RUN_MD },
        "Field 'spec.subscriptionPlans' is allowed only when spec.types includes API. Remove the plans, or add API and an interface.");
    assert.deepEqual(ok(a2aApi(a2a(), { subscriptionPlans: ['Gold'] }), C).spec.subscriptionPlans, ['Gold']);
});

test('skills: id, name and description required, ids unique', () => {
    rejects(api(rest(), { skills: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B', description: 'b' }] }), { restDefinition: OPENAPI }, [
        "Field 'spec.skills[0].description' is required.",
        "Field 'spec.skills[1].id' must be unique.",
    ]);
});

test('metadata.name is a handle', () => {
    rejects(local(), { localDefinition: RUN_MD }, "Field 'metadata.name' is invalid.", {}, { name: 'Agent A' });
    rejects(local(), { localDefinition: RUN_MD }, "Field 'metadata.name' is required.", {}, {});
});

test('a YAML document whose aliases expand past the node budget is refused', () => {
    const lines = ['a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i <= 6; i += 1) {
        lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]`);
    }
    lines.push('types: [LOCAL]');
    const bomb = yaml.load(lines.join('\n'));
    assert.throws(() => assertDocumentSize(bomb), (err) => err.statusCode === 413);
    assert.throws(() => ok(bomb), (err) => err.statusCode === 413);
});


test('a definition saved with a UTF-8 byte order mark is accepted and stored without it', () => {
    const json = JSON.stringify(CARD_JSON);
    const withBom = { fileName: 'agent-card.json', buffer: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(json)]) };
    const result = ok(a2aApi(), { a2aDefinition: withBom });
    assert.equal(result.card.name, CARD_JSON.name);
    assert.equal(result.definitions[0].buffer.toString('utf8'), json);
});
