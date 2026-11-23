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
 * The document Settings → Agents builds from its form. Every built document is run
 * through the server's validator, so the form can't drift from the rules.
 */

const test = require('node:test');
const assert = require('node:assert');
const { formFromAgent, applyForm, withStatus, errorMessages, skillId, fieldFor } = require('./agent-document');
const { validateAgentArtifact } = require('../services/agentArtifactValidation');

const CARD = { name: 'Card name', version: '1.0.0', description: 'From the card', skills: [{ id: 's', name: 'S', description: 'd' }] };
const file = (content) => ({ fileName: 'x', buffer: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)) });
const ASYNCAPI = 'asyncapi: 3.0.0\ninfo: {title: t, version: "1"}\n';
const OPENAPI = 'openapi: 3.1.0\ninfo: {title: t, version: "1"}\npaths: {}\n';

function valid(doc, uploads = {}, existing) {
    return validateAgentArtifact(doc.metadata, doc.spec, uploads, { maxDefinitionBytes: 1 << 20, existing });
}

const blank = () => ({ ...formFromAgent(null), handle: 'triage', displayName: 'Triage', version: 'v1', description: 'Triages.' });

test('a new A2A agent sends only its URLs; the card supplies transports, auth and skills', () => {
    const form = { ...blank(), a2a: { productionUrl: 'https://a.example.com' },
        skills: [{ name: 'X', description: 'y' }], subscriptionPlans: ['Gold'] };
    const doc = applyForm(null, form, { A2A: true });
    assert.deepEqual(doc.spec.types, ['API']);
    assert.deepEqual(doc.spec.interfaces, [{ type: 'A2A', endpoints: { productionUrl: 'https://a.example.com' } }]);
    assert.equal(doc.spec.skills, undefined);
    assert.deepEqual(doc.spec.subscriptionPlans, ['Gold']);
    assert.ok(valid(doc, { a2aDefinition: file(CARD) }));
});

test('without A2A, skills are written in the document', () => {
    const form = { ...blank(), rest: { productionUrl: 'https://r.example.com' },
        skills: [{ name: 'Triage an invoice', description: 'Checks it.', examples: ['INV-9', ' '] }] };
    const doc = applyForm(null, form, { REST: true });
    assert.deepEqual(doc.spec.skills, [{ id: 'triage-an-invoice', name: 'Triage an invoice', description: 'Checks it.', examples: ['INV-9'] }]);
    assert.ok(valid(doc, { restDefinition: file(OPENAPI) }));
});

test('every way at once, with the required files', () => {
    const form = { ...blank(), a2a: { productionUrl: 'https://a.example.com' }, rest: { productionUrl: 'https://r.example.com', protocol: 'OPENAI_CHAT' },
        event: true, local: true, skills: [{ name: 'S', description: 'd' }] };
    const doc = applyForm(null, form, { A2A: true, REST: true });
    assert.deepEqual(doc.spec.types, ['API', 'EVENT', 'LOCAL']);
    assert.deepEqual(doc.spec.interfaces.map((i) => i.type), ['A2A', 'REST', 'EVENT']);
    assert.ok(valid(doc, { a2aDefinition: file(CARD), restDefinition: file(OPENAPI), eventDefinition: file(ASYNCAPI),
        localDefinition: file('# Run it\n') }));
});

test('the Agent Card URL is sent only when given, kept on edit and removed when emptied', () => {
    const url = 'https://gw.example.com/triage/.well-known/agent-card.json';
    const form = { ...blank(), a2a: { productionUrl: 'https://a.example.com', cardUrl: url } };
    const doc = applyForm(null, form, { A2A: true });
    assert.equal(doc.spec.interfaces[0].cardUrl, url);
    assert.ok(valid(doc, { a2aDefinition: file(CARD) }));
    const agent = { document: doc, interfaces: [{ type: 'A2A', hasDefinition: true }] };
    const edited = formFromAgent(agent);
    assert.equal(edited.a2a.cardUrl, url);
    assert.deepEqual(applyForm(doc, edited, { A2A: true }).spec.interfaces[0].cardUrl, url);
    const emptied = applyForm(doc, { ...edited, a2a: { ...edited.a2a, cardUrl: '' } }, { A2A: true });
    assert.equal(emptied.spec.interfaces[0].cardUrl, undefined);
    // Nothing is guessed when it is left empty.
    assert.equal(applyForm(null, { ...blank(), a2a: { productionUrl: 'https://a.example.com' } }, { A2A: true })
        .spec.interfaces[0].cardUrl, undefined);
    assert.equal(fieldFor("Field 'spec.interfaces[0].cardUrl' must be an http or https URL."), 'a2a.cardUrl');
});

test('the Status field round-trips, and anything but DEPRECATED saves as PUBLISHED', () => {
    const form = { ...blank(), rest: { productionUrl: 'https://r.example.com' }, status: 'DEPRECATED' };
    const doc = applyForm(null, form, {});
    assert.equal(doc.spec.status, 'DEPRECATED');
    assert.equal(formFromAgent({ document: doc }).status, 'DEPRECATED');
    assert.equal(applyForm(doc, { ...formFromAgent({ document: doc }), status: 'PUBLISHED' }, {}).spec.status, 'PUBLISHED');
    assert.equal(applyForm(null, { ...form, status: 'BOGUS' }, {}).spec.status, 'PUBLISHED');
});

test('plans are dropped for an agent that is not called', () => {
    const doc = applyForm(null, { ...blank(), local: true, subscriptionPlans: ['Gold'] }, {});
    assert.equal(doc.spec.subscriptionPlans, undefined);
    assert.ok(valid(doc, { localDefinition: file('# Run\n') }));
});

test('edit keeps what the form does not show, and round-trips unchanged', () => {
    const document = { apiVersion: 'api-portal.api-platform.wso2.com/v1alpha1', kind: 'Agent', metadata: { name: 'triage', annotations: { a: 'b' } },
        spec: { types: ['API'], displayName: 'Triage', version: 'v1', description: 'Triages.', status: 'PUBLISHED', agentVisibility: 'VISIBLE',
            models: [{ provider: 'Anthropic', name: 'claude' }], referenceId: 'ref-1',
            skills: [{ id: 'draft', name: 'Draft', description: 'Drafts', tags: ['writing'] }],
            interfaces: [{ type: 'REST', protocol: 'CUSTOM', endpoints: { productionUrl: 'https://r.example.com' } }] } };
    const agent = { document, displayName: 'Triage', version: 'v1', description: 'Triages.', interfaces: [{ type: 'REST', hasDefinition: true }] };
    const form = formFromAgent(agent);
    const doc = applyForm(document, form, { REST: true });
    assert.deepEqual(doc, document);
    assert.ok(valid(doc, {}, { definitions: { API_DEFINITION: {} } }));
});

test('a listing value the card supplied stays out while the card is in force', () => {
    const document = { metadata: { name: 'carded' }, spec: { types: ['API'], interfaces: [{ type: 'A2A', endpoints: { productionUrl: 'https://a.example.com' } }] } };
    const agent = { document, displayName: 'Card name', version: '1.0.0', description: 'From the card', interfaces: [{ type: 'A2A', hasDefinition: true }] };
    const form = formFromAgent(agent);
    assert.equal(form.hasFile.A2A, true);
    const unchanged = applyForm(document, form, { A2A: true });
    assert.equal(unchanged.spec.displayName, undefined);
    const renamed = applyForm(document, { ...form, displayName: 'Own name' }, { A2A: true });
    assert.equal(renamed.spec.displayName, 'Own name');
    assert.ok(valid(unchanged, {}, { definitions: { AGENT_CARD: { card: CARD } } }));
});

test('removing an interface removes it from the document', () => {
    const document = { metadata: { name: 'x' }, spec: { types: ['API', 'EVENT'], displayName: 'X', version: 'v1', description: 'd',
        interfaces: [{ type: 'REST', endpoints: { productionUrl: 'https://r.example.com' } }, { type: 'EVENT' }] } };
    const form = { ...formFromAgent({ document }), event: false };
    const doc = applyForm(document, form, {});
    assert.deepEqual(doc.spec.types, ['API']);
    assert.deepEqual(doc.spec.interfaces.map((i) => i.type), ['REST']);
});

test('status changes keep the rest of the document', () => {
    const document = { metadata: { name: 'x' }, spec: { status: 'PUBLISHED', tags: ['a'] } };
    assert.deepEqual(withStatus({ document }, 'DEPRECATED').spec, { status: 'DEPRECATED', tags: ['a'] });
    assert.equal(document.spec.status, 'PUBLISHED');
    assert.equal(withStatus({}, 'DEPRECATED'), null);
});

test('ownership goes in spec.businessInformation, and an emptied field is removed', () => {
    const owners = { technicalOwner: 'Tess', technicalOwnerEmail: 'tess@example.com', businessOwner: '', businessOwnerEmail: ' ' };
    const doc = applyForm(null, { ...blank(), rest: { productionUrl: 'https://r.example.com' }, owners }, { REST: true });
    assert.deepEqual(doc.spec.businessInformation, { technicalOwner: 'Tess', technicalOwnerEmail: 'tess@example.com' });
    assert.ok(valid(doc, { restDefinition: file(OPENAPI) }));
    const agent = { document: doc };
    assert.equal(formFromAgent(agent).owners.technicalOwnerEmail, 'tess@example.com');
    assert.equal(formFromAgent(agent).owners.businessOwner, '');
    const cleared = applyForm(doc, { ...formFromAgent(agent), owners: {} }, {});
    assert.equal(cleared.spec.businessInformation, undefined);
});

test('a server message is placed under the form field it names', () => {
    const doc = { spec: { interfaces: [{ type: 'REST' }, { type: 'A2A' }] } };
    assert.equal(fieldFor("Field 'spec.version' is required.", doc), 'version');
    assert.equal(fieldFor("Field 'metadata.name' is invalid.", doc), 'handle');
    assert.equal(fieldFor("Field 'spec.interfaces[1].endpoints.productionUrl' is invalid.", doc), 'a2a.productionUrl');
    assert.equal(fieldFor("Field 'spec.interfaces[0].endpoints.sandboxUrl' is invalid.", doc), 'rest.sandboxUrl');
    assert.equal(fieldFor("Field 'spec.businessInformation.technicalOwnerEmail' is invalid.", doc), 'owners.technicalOwnerEmail');
    assert.equal(fieldFor("Field 'spec.skills[0].name' is required.", doc), 'skills');
    assert.equal(fieldFor("Field 'eventDefinition' is required with an EVENT interface.", doc), 'file.event');
    assert.equal(fieldFor("Field 'spec.colour' is not allowed. Remove it.", doc), null);
    assert.equal(fieldFor('Something else went wrong.', doc), null);
});

test('error messages list every problem', () => {
    assert.deepEqual(errorMessages({ errors: [{ message: 'A' }, { message: 'B' }] }), ['A', 'B']);
    assert.deepEqual(errorMessages({ description: 'Not found' }), ['Not found']);
    assert.deepEqual(errorMessages(null, 'Failed'), ['Failed']);
    assert.equal(skillId('  Route for approval! '), 'route-for-approval');
});

test('models come from the form, an emptied row is dropped; the provider the form does not show is kept', () => {
    const document = { metadata: { name: 'x' }, spec: { types: ['API'], displayName: 'X', version: 'v1', description: 'd',
        provider: { organization: 'Acme', url: 'https://acme.example.com' }, models: [{ provider: 'Anthropic', name: 'claude' }],
        interfaces: [{ type: 'REST', endpoints: { productionUrl: 'https://r.example.com' } }] } };
    const form = formFromAgent({ document, interfaces: [{ type: 'REST', hasDefinition: true }] });
    assert.deepEqual(form.models, [{ provider: 'Anthropic', name: 'claude' }]);
    const doc = applyForm(document, { ...form, models: [{ provider: ' OpenAI ', name: '' }, { provider: '', name: ' ' }] }, { REST: true });
    assert.deepEqual(doc.spec.models, [{ provider: 'OpenAI' }]);
    assert.deepEqual(doc.spec.provider, { organization: 'Acme', url: 'https://acme.example.com' });
    assert.equal(applyForm(document, { ...form, models: [] }, { REST: true }).spec.models, undefined);
    assert.ok(valid(doc, {}, { definitions: { API_DEFINITION: {} } }));
    assert.equal(fieldFor("Field 'spec.models[0]' needs a provider or a name. Add at least one of them."), 'models');
});

test('unticking every label on an agent that had some sends an empty list', () => {
    const base = { apiVersion: 'api-portal.api-platform.wso2.com/v1alpha1', kind: 'Agent', metadata: { name: 'triage' },
        spec: { types: ['LOCAL'], displayName: 'Triage', version: 'v1', description: 'Triages.', labels: ['partners'] } };
    const form = { ...formFromAgent({ document: base }), local: true, labels: [] };
    assert.deepEqual(applyForm(base, form, {}).spec.labels, []);
    // A new agent with no label ticked sends none.
    assert.equal(applyForm(null, { ...blank(), local: true, labels: [] }, {}).spec.labels, undefined);
});
