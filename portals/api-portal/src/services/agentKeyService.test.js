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
 * AI agent keys (subjectType AGENT) through the real OAuth2 key handlers, DAOs and
 * sqlite schema, in a child process as oauth2KeyService.handlers.test.js does. The
 * one stand-in is the key manager: resolveDriver returns an in-process ThunderID-like
 * driver that records agent calls, so nothing is dialled. The driver's own requests
 * are covered by drivers/thunderid.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SCHEMA = path.join(PROJECT_ROOT, 'database', 'schema.sqlite.sql');
const ORG = 'org-uuid-1';
const TX = 'urn:ietf:params:oauth:grant-type:token-exchange';

let tmpDir;
test.after(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

const CONFIG = (dbFile) => `
[api_portal.security]
encryption_key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
session_secret = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

[api_portal.organization]
handle = "default"
portal_id = "test-portal"

[api_portal.database]
type = "sqlite"
path = ${JSON.stringify(dbFile)}

[[api_portal.key_manager]]
id   = "offline-km"
name = "Offline KM"
type = "provision"
token_endpoint        = "https://idp.example.com/oauth2/token"
registration_endpoint = "https://idp.example.com/oauth2/register"

  [api_portal.key_manager.auth]
  method        = "client_credentials"
  client_id     = "inert-client"
  client_secret = "inert-secret"
`;

const PROBE = (root) => `
const path = require('path');
const root = ${JSON.stringify(root)};
const registry = require(path.join(root, 'src/services/keyManagerRegistry'));
const { KeyManagerCallError } = require(path.join(root, 'src/keymanagers/core/keyManager'));
const agentDao = require(path.join(root, 'src/dao/oauth2KeyAgentMappingDao'));
const db = require(path.join(root, 'src/db/driver'));

// ThunderID-like drivers: 'thunder-km' supports agents, 'plain-km' doesn't.
const calls = [];
let nextCreate = null;
let nextDelete = null;
let n = 0;
const TX = 'urn:ietf:params:oauth:grant-type:token-exchange';
const GRANTS = [
    { value: 'client_credentials', label: 'Client credentials', forUsers: false },
    { value: 'authorization_code', label: 'Authorization code', forUsers: true },
    { value: TX, label: 'Token exchange', forUsers: true },
];
const thunder = {
    id: 'thunder-km', displayName: 'Thunder', keyType: 'PRODUCTION',
    agentKeys: { grantTypes: GRANTS }, agentKeysEnabled() { return true; },
    tokenEndpoint: 'https://thunder/oauth2/token',
    metadata() {
        return { id: this.id, displayName: this.displayName, type: 'thunderid', agentKeys: { ...this.agentKeys },
            properties: [{ name: 'grant_types', type: 'multiselect', options: [
                { value: 'authorization_code' }, { value: 'refresh_token' }, { value: 'client_credentials' }] }] };
    },
    async getAgent(agentId) {
        calls.push(['getAgent', agentId]);
        // An agent made outside the portal, for linking; any other agent is one the portal made.
        if (agentId === 'ext-agent') {
            return { clientId: 'ext-client', properties: { client_name: 'ext', grant_types: ['client_credentials', TX] } };
        }
        if (agentId === 'missing-agent') throw new KeyManagerCallError('client_not_found', 'gone', 404);
        return { clientId: 'cid-' + agentId.replace('agent-', ''),
            properties: { client_name: 'read-from-thunder', grant_types: ['client_credentials'] } };
    },
    async createAgent(args) {
        calls.push(['createAgent', args]);
        if (nextCreate) { const e = nextCreate; nextCreate = null; throw e; }
        n += 1;
        return { agentId: 'agent-' + n, consumerKey: 'cid-' + n, consumerSecret: 'secret-' + n };
    },
    async rotateAgentSecret(agentId) { calls.push(['rotateAgentSecret', agentId]); return { consumerSecret: 'rotated' }; },
    async deleteAgent(agentId) {
        calls.push(['deleteAgent', agentId]);
        if (nextDelete) { const e = nextDelete; nextDelete = null; throw e; }
    },
    async getKey() { calls.push(['getKey']); throw new Error('DCR must not be used for an agent key'); },
    async requestToken(consumerKey, secret, opts = {}) {
        calls.push(['requestToken', consumerKey, secret, opts.authMethod]);
        if (secret === 'wrong') throw new KeyManagerCallError('token_request_rejected', 'bad secret', 401);
        return { accessToken: 'cc-token', tokenType: 'Bearer', expiresIn: 600, scope: '' };
    },
};
// A key manager whose agent keys can only use client credentials.
const noObo = Object.assign({}, thunder, { id: 'noobo-km', displayName: 'No OBO',
    agentKeys: { grantTypes: GRANTS.slice(0, 1) } });
const plain = { id: 'plain-km', displayName: 'Plain', keyType: 'PRODUCTION', agentKeys: null,
    agentKeysEnabled() { return false; } };
/*
 * A key manager that records existing clients (keyCreation provide), as a Provision
 * one does: where existing agents are linked. Nothing on it goes upstream.
 */
const linker = {
    id: 'link-km', displayName: 'Linker', keyType: 'PRODUCTION', keyCreation: 'provide', agentKeys: null,
    tokenEndpoint: 'https://thunder/oauth2/token',
    agentKeysEnabled() { return false; },
    async requestToken(consumerKey) { calls.push(['requestToken', consumerKey]); return { accessToken: 't' }; },
    async getAgent() { throw new KeyManagerCallError('unsupported_operation', 'provision', null); },
    async rotateAgentSecret() { calls.push(['rotateAgentSecret']); throw new Error('must not rotate'); },
    async deleteAgent() { calls.push(['deleteAgent']); throw new Error('must not delete upstream'); },
};
const realResolve = registry.resolveDriver;
registry.resolveDriver = async (orgId, handle, opts) => (handle === 'thunder-km' ? thunder
    : handle === 'noobo-km' ? noObo
    : handle === 'link-km' ? linker
    : handle === 'plain-km' ? plain : realResolve(orgId, handle, opts));

const svc = require(path.join(root, 'src/services/oauth2KeyService'));
const agentSvc = require(path.join(root, 'src/services/agentKeyService'));
// What the OAuth2 keys handler does: subjectType AGENT goes to the agent key service.
const create = (req, res) => (req.body && req.body.subjectType === 'AGENT'
    ? agentSvc.createAgentKey(req, res) : svc.createOAuth2Key(req, res));
const out = {};
function call(fn, req) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200, headers: {},
            status(c) { this.statusCode = c; return this; },
            setHeader(k, v) { this.headers[k] = v; },
            json(b) { resolve({ status: this.statusCode, body: b }); return this; },
            send(b) { resolve({ status: this.statusCode, body: b === undefined ? null : b }); return this; },
        };
        Promise.resolve(fn(req, res)).catch((e) => resolve({ status: 'THREW', body: String(e && e.message) }));
    });
}
const as = (extra) => Object.assign({ orgId: ${JSON.stringify(ORG)}, user: { sub: 'dev-1', email: 'Ana.Silva@example.com' },
    baseUrl: '/api', path: '/oauth2-keys', query: {}, params: {}, body: {} }, extra || {});
const agentBody = (name, extra) => ({ body: Object.assign({ keyManagerId: 'thunder-km', subjectType: 'AGENT',
    properties: { client_name: name } }, extra || {}) });

(async () => {
    out.created = await call(create, as(agentBody('invoice-bot')));
    const keyId = out.created.body && out.created.body.keyId;
    out.createCall = calls.find((c) => c[0] === 'createAgent');
    out.badName = await call(create, as(agentBody('bad name!')));
    out.extraProps = await call(create, as({ body: { keyManagerId: 'thunder-km', subjectType: 'AGENT',
        properties: { client_name: 'x', scope: ['openid'] } } }));
    out.notSupported = await call(create, as({ body: { keyManagerId: 'plain-km', subjectType: 'AGENT',
        properties: { client_name: 'x' } } }));
    nextCreate = new KeyManagerCallError('conflict', 'name taken', 409);
    out.nameTaken = await call(create, as(agentBody('dupe')));

    out.list = await call(svc.listOAuth2Keys, as());
    out.get = await call(svc.getOAuth2Key, as({ params: { keyId } }));
    out.update = await call(svc.updateOAuth2Key, as({ params: { keyId }, body: { properties: { client_name: 'y' } } }));
    out.rotate = await call(agentSvc.rotateOAuth2KeySecret, as({ params: { keyId } }));
    out.otherUserRotate = await call(agentSvc.rotateOAuth2KeySecret, as({ user: { sub: 'dev-2' }, params: { keyId } }));

    // An application key can't be rotated here.
    const app = await call(create, as({ body: { keyManagerId: 'offline-km', properties: { client_name: 'app', consumerKey: 'ck-app' } } }));
    out.appKeyType = app.body.subjectType;
    out.rotateAppKey = await call(agentSvc.rotateOAuth2KeySecret, as({ params: { keyId: app.body.keyId } }));

    // A Thunder agent's token: client credentials with the agent's own client.
    out.thunderToken = await call(svc.generateOAuth2KeyToken, as({ params: { keyId }, body: { consumerSecret: 'rotated' } }));
    out.thunderTokenCall = calls.filter((c) => c[0] === 'requestToken').pop();

    out.delete = await call(svc.deleteOAuth2Key, as({ params: { keyId } }));
    out.deleteCall = calls.filter((c) => c[0] === 'deleteAgent').pop();
    out.mappingAfterDelete = await agentDao.getByKey(keyId);

    // The identity server already lost the agent: still removed here.
    const gone = await call(create, as(agentBody('gone-bot')));
    nextDelete = new KeyManagerCallError('client_not_found', '404', 404);
    out.deleteGone = await call(svc.deleteOAuth2Key, as({ params: { keyId: gone.body.keyId } }));
    // Any other failure keeps the key: nothing is left live that the portal can't see.
    const kept = await call(create, as(agentBody('kept-bot')));
    nextDelete = new KeyManagerCallError('unreachable', 'down', null);
    out.deleteFails = await call(svc.deleteOAuth2Key, as({ params: { keyId: kept.body.keyId } }));
    out.keptAfterFailedDelete = (await call(svc.getOAuth2Key, as({ params: { keyId: kept.body.keyId } }))).status;

    // A portal write that fails after the agent exists deletes the agent again.
    const realCreate = agentDao.create;
    agentDao.create = async () => { throw new Error('db down'); };
    calls.length = 0;
    out.dbFails = await call(create, as(agentBody('half-bot')));
    out.dbFailsCalls = calls.map((c) => c[0]);
    // ...and when the clean-up fails too, the key still isn't recorded.
    calls.length = 0;
    nextDelete = new KeyManagerCallError('unreachable', 'down', null);
    out.orphan = await call(create, as(agentBody('orphan-bot')));
    out.orphanCalls = calls.map((c) => c[0]);
    out.rowsAfterOrphan = (await db.query("SELECT COUNT(*) AS n FROM oauth2_consumer_keys WHERE name = 'orphan-bot'", []))[0].n;
    agentDao.create = realCreate;
    out.rowsAfterDbFail = (await db.query("SELECT COUNT(*) AS n FROM oauth2_consumer_keys WHERE name = 'half-bot'", []))[0].n;
    out.getKeyCalls = calls.filter((c) => c[0] === 'getKey').length;

    // On behalf of users: created with token exchange, remembered, refused where unsupported.
    calls.length = 0;
    out.obo = await call(create, as(agentBody('obo-bot', { properties: { client_name: 'obo-bot', grant_types: [TX] } })));
    out.oboCreateCall = calls.find((c) => c[0] === 'createAgent');
    out.oboList = await call(svc.listOAuth2Keys, as());
    out.oboGet = await call(svc.getOAuth2Key, as({ params: { keyId: out.obo.body.keyId } }));
    out.oboRotate = await call(agentSvc.rotateOAuth2KeySecret, as({ params: { keyId: out.obo.body.keyId } }));
    out.oboToken = await call(svc.generateOAuth2KeyToken, as({ params: { keyId: out.obo.body.keyId }, body: { consumerSecret: 'rotated' } }));
    out.oboRefused = await call(create, as({ body: { keyManagerId: 'noobo-km', subjectType: 'AGENT',
        properties: { client_name: 'noobo-bot', grant_types: [TX] } } }));
    const withProps = (name, props) => agentBody(name, { properties: Object.assign({ client_name: name }, props) });
    out.codeNoCallback = await call(create, as(withProps('code-a', { grant_types: ['authorization_code'] })));
    out.codeBadCallback = await call(create, as(withProps('code-b', { grant_types: ['authorization_code'],
        redirect_uris: ['javascript:alert(1)'] })));
    out.callbackNoCode = await call(create, as(withProps('code-c', { redirect_uris: ['https://bot.example.com/cb'] })));
    out.grantsNotList = await call(create, as(withProps('code-d', { grant_types: 'authorization_code' })));
    calls.length = 0;
    out.code = await call(create, as(withProps('code-bot', { grant_types: ['authorization_code'],
        redirect_uris: ['https://bot.example.com/cb'] })));
    out.codeCreateCall = calls.find((c) => c[0] === 'createAgent');

    // Linking an agent that exists elsewhere.
    const linkBody = (name, link, km) => ({ body: { keyManagerId: km || 'link-km', subjectType: 'AGENT',
        properties: { client_name: name }, link } });
    const ext = { clientId: 'ext-client' };
    calls.length = 0;
    out.linked = await call(create, as(linkBody('ext-bot', ext)));
    out.linkCalls = calls.map((c) => c[0]);
    out.linkedTwice = await call(create, as(linkBody('ext-bot-2', ext)));
    out.linkNoClient = await call(create, as(linkBody('x1', {})));
    out.linkOldShape = await call(create, as(linkBody('x2', { agentId: 'a', clientSecret: 's' })));
    // The client of an agent the portal created.
    out.linkPortalAgent = await call(create, as(linkBody('x4', { clientId: out.obo.body.consumerKey })));
    // Linking is on a key manager that records existing clients, not one that creates agents.
    out.linkNoLinking = await call(create, as(linkBody('x5', ext, 'thunder-km')));
    out.linkExtraProps = await call(create, as({ body: { keyManagerId: 'link-km', subjectType: 'AGENT',
        properties: { client_name: 'x6', grant_types: [TX] }, link: ext } }));
    out.linkedRotate = await call(agentSvc.rotateOAuth2KeySecret, as({ params: { keyId: out.linked.body.keyId } }));
    out.linkedRotateCalls = calls.map((c) => c[0]);
    out.linkedList = await call(svc.listOAuth2Keys, as({ query: { subjectType: 'AGENT' } }));
    calls.length = 0;
    out.linkedDelete = await call(svc.deleteOAuth2Key, as({ params: { keyId: out.linked.body.keyId } }));
    out.linkedDeleteCalls = calls.map((c) => c[0]);

    process.stdout.write('\\nPROBE_JSON:' + JSON.stringify(out) + '\\n');
    process.exit(0);
})();
`;

let _results;
function results() {
    if (_results) return _results;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-oka-'));
    const dbFile = path.join(tmpDir, 'portal.db');
    const seed = path.join(tmpDir, 'seed.js');
    fs.writeFileSync(seed, `
        const fs = require('fs');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(${JSON.stringify(dbFile)});
        db.exec(fs.readFileSync(${JSON.stringify(SCHEMA)}, 'utf8'));
        db.prepare(\`INSERT INTO organizations (uuid, portal_id, display_name, handle, idp_ref_id, configuration, created_by, updated_by)
            VALUES (?,?,?,?,?,?,?,?)\`).run(${JSON.stringify(ORG)}, 'test-portal', 'Default', 'default', 'idp-1', '{}', 'test', 'test');
        db.close();
    `);
    const seeded = spawnSync(process.execPath, [seed], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
    const cfg = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(cfg, CONFIG(dbFile));
    const runner = path.join(tmpDir, 'probe.js');
    fs.writeFileSync(runner, PROBE(PROJECT_ROOT));
    const run = spawnSync(process.execPath, [runner, '--config', cfg], {
        cwd: PROJECT_ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE_JSON:'));
    assert.ok(line, `no PROBE_JSON: ${run.stdout}\n${run.stderr}`);
    _results = JSON.parse(line.slice('PROBE_JSON:'.length));
    return _results;
}

test('an agent key creates an agent named with the key name, as DCR names a client, and returns the secret once', () => {
    const r = results();
    assert.equal(r.created.status, 201);
    assert.equal(r.created.body.subjectType, 'AGENT');
    assert.equal(r.created.body.agentId, 'agent-1');
    assert.equal(r.created.body.consumerKey, 'cid-1');
    assert.equal(r.created.body.consumerSecret, 'secret-1');
    assert.equal(r.created.body.name, 'invoice-bot');
    assert.deepEqual(r.created.body.properties, { client_name: 'invoice-bot', grant_types: ['client_credentials'] });
    assert.equal(r.createCall[1].name, 'invoice-bot');
});

test('an agent key takes only a valid name, and only where the admin allowed agents', () => {
    const r = results();
    assert.equal(r.badName.status, 400);
    assert.equal(r.extraProps.status, 400);
    assert.equal(r.notSupported.status, 400);
    assert.match(JSON.stringify(r.notSupported.body), /does not issue keys for AI agents/);
});

test('a taken agent name is the same 409 conflict a DCR key gets', () => {
    const r = results();
    assert.equal(r.nameTaken.status, 409);
    assert.match(JSON.stringify(r.nameTaken.body), /conflict with an existing client/);
});

test('list and read mark agent keys and never use DCR for them', () => {
    const r = results();
    const item = r.list.body.list.find((k) => k.keyId === r.created.body.keyId);
    assert.equal(item.subjectType, 'AGENT');
    assert.equal(item.agentId, 'agent-1');
    assert.equal(item.consumerSecret, '');
    assert.equal(r.get.status, 200);
    assert.equal(r.get.body.agentId, 'agent-1');
    assert.equal(r.get.body.consumerSecret, '');
    // Read back from the identity server's agent, never through DCR.
    assert.equal(r.get.body.properties.client_name, 'read-from-thunder');
    assert.equal(r.getKeyCalls, 0);
});

test('an agent key cannot be edited; its secret is rotated instead, by its owner only', () => {
    const r = results();
    assert.equal(r.update.status, 409);
    assert.equal(r.rotate.status, 200);
    assert.equal(r.rotate.body.consumerSecret, 'rotated');
    assert.equal(r.otherUserRotate.status, 404);
    assert.equal(r.appKeyType, 'APPLICATION');
    assert.equal(r.rotateAppKey.status, 409);
});

test('delete removes the agent upstream first; already gone is fine; any other failure keeps the key', () => {
    const r = results();
    assert.equal(r.delete.status, 204);
    assert.deepEqual(r.deleteCall, ['deleteAgent', 'agent-1']);
    assert.equal(r.mappingAfterDelete, null);
    assert.equal(r.deleteGone.status, 204);
    assert.equal(r.deleteFails.status, 500);
    assert.equal(r.keptAfterFailedDelete, 200);
});

test('a failed portal write deletes the new agent and leaves no key row', () => {
    const r = results();
    assert.equal(r.dbFails.status, 500);
    assert.deepEqual(r.dbFailsCalls, ['createAgent', 'deleteAgent']);
    assert.equal(r.rowsAfterDbFail, 0);
    // Key row and mapping are one transaction: the failed mapping takes the key row with it.
    assert.equal(r.orphan.status, 500);
    assert.deepEqual(r.orphanCalls, ['createAgent', 'deleteAgent']);
    assert.equal(r.rowsAfterOrphan, 0);
});

test('a Thunder agent key gets its token with client credentials on its own client', () => {
    const r = results();
    assert.strictEqual(r.thunderToken.status, 200);
    assert.strictEqual(r.thunderToken.body.accessToken, 'cc-token');
    assert.deepStrictEqual(r.thunderTokenCall, ['requestToken', 'cid-1', 'rotated', 'client_secret_basic']);
});

test('an agent key acts on behalf of users when it holds a grant for that, and it is remembered', () => {
    const r = results();
    assert.strictEqual(r.obo.status, 201);
    assert.deepStrictEqual(r.oboCreateCall[1].grantTypes, ['client_credentials', TX]);
    assert.strictEqual(r.obo.body.actsForUsers, true);
    assert.deepStrictEqual(r.obo.body.properties.grant_types, ['client_credentials', TX]);
    const item = r.oboList.body.list.find((k) => k.keyId === r.obo.body.keyId);
    assert.strictEqual(item.actsForUsers, true);
    assert.strictEqual(r.oboGet.body.actsForUsers, true);
    assert.strictEqual(r.oboRotate.body.actsForUsers, true);
    // Its own token still comes from client credentials.
    assert.strictEqual(r.oboToken.status, 200);
    // A plain agent key says nothing about it.
    assert.strictEqual(r.created.body.actsForUsers, undefined);
    assert.deepStrictEqual(r.createCall[1].grantTypes, ['client_credentials']);
});

test('a grant the key manager does not offer agent keys is refused', () => {
    const r = results();
    assert.strictEqual(r.oboRefused.status, 400);
    assert.match(JSON.stringify(r.oboRefused.body), /does not accept/);
    assert.strictEqual(r.grantsNotList.status, 400);
});

test('authorization code needs valid callback URLs, and callback URLs need authorization code', () => {
    const r = results();
    assert.strictEqual(r.codeNoCallback.status, 400);
    assert.strictEqual(r.codeBadCallback.status, 400);
    assert.strictEqual(r.callbackNoCode.status, 400);
    assert.strictEqual(r.code.status, 201);
    assert.deepStrictEqual(r.codeCreateCall[1].grantTypes, ['client_credentials', 'authorization_code']);
    assert.deepStrictEqual(r.codeCreateCall[1].redirectUris, ['https://bot.example.com/cb']);
    assert.strictEqual(r.code.body.actsForUsers, true);
    assert.deepStrictEqual(r.code.body.properties.redirect_uris, ['https://bot.example.com/cb']);
});

test('an existing agent is linked as an application is imported: its client ID recorded, nothing upstream', () => {
    const r = results();
    assert.strictEqual(r.linked.status, 201);
    assert.strictEqual(r.linked.body.linked, true);
    // No agent ID: nothing uses one for a linked agent.
    assert.strictEqual(r.linked.body.agentId, undefined);
    assert.strictEqual(r.linked.body.consumerKey, 'ext-client');
    assert.strictEqual(r.linked.body.consumerSecret, '');
    // Not read from the identity server, so not claimed.
    assert.strictEqual(r.linked.body.actsForUsers, undefined);
    // Nothing is called upstream: no token, no read.
    assert.deepStrictEqual(r.linkCalls, []);
    // Lists mark it linked too, from its key manager.
    const listed = r.linkedList.body.list.find((k) => k.keyId === r.linked.body.keyId);
    assert.strictEqual(listed.linked, true);
});

test('a link needs a client ID, on a key manager that records existing clients', () => {
    const r = results();
    for (const failed of [r.linkNoClient, r.linkOldShape]) {
        assert.strictEqual(failed.status, 400);
        assert.match(JSON.stringify(failed.body), /client ID/);
    }
    assert.strictEqual(r.linkExtraProps.status, 400);
    assert.strictEqual(r.linkNoLinking.status, 400);
});

test('an agent the portal created, or one already linked, is not linked again', () => {
    const r = results();
    assert.strictEqual(r.linkPortalAgent.status, 409);
    assert.match(JSON.stringify(r.linkPortalAgent.body), /portal created this agent/);
    assert.strictEqual(r.linkedTwice.status, 409);
});

test('a linked key is only unlinked: no rotate, and delete leaves the agent alone', () => {
    const r = results();
    assert.strictEqual(r.linkedRotate.status, 409);
    assert.ok(!r.linkedRotateCalls.includes('rotateAgentSecret'));
    assert.strictEqual(r.linkedDelete.status, 204);
    assert.ok(!r.linkedDeleteCalls.includes('deleteAgent'));
});
