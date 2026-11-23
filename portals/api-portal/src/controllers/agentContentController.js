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
 * Page controllers for the Agents section: the listing, the agent page and its
 * documents, the Markdown views for AI clients, the agent's public card, and the
 * view's ARD manifest. Kept apart from apiContentController so agent rendering never changes
 * what APIs and MCP servers render.
 *
 * Everything goes through escaped `{{ }}` templates; Markdown goes through
 * sanitizeRenderedHtml. The portal never fetches an agent URL.
 */

const { marked } = require('marked');
const constants = require('../utils/constants');
const util = require('../utils/util');
const logger = require('../config/logger');
const orgDao = require('../dao/organizationDao');
const viewDao = require('../dao/viewDao');
const orgContext = require('../utils/orgContext');
const apiDao = require('../dao/apiDao');
const apiFileDao = require('../dao/apiFileDao');
const subDao = require('../dao/subscriptionDao');
const planPresentation = require('../services/billing/planPresentation');
const apiMetadataService = require('../services/apiMetadataService');
const { buildAgentViewModel, kindBadges, protocolsOf } = require('./agentViewModel');
const { replaceEndpointParams, requestOrigin } = require('./apiContentController');
const { publicCard, ardEntry } = require('./agentCatalog');
const { config } = require('../config/configLoader');
const { sanitizeRenderedHtml } = require('../utils/sanitizeRenderedHtml');
const fs = require('fs');
const sampleAgentLoader = require('../utils/sampleAgentLoader');
const yaml = require('../utils/yaml');

const AGENT = constants.API_TYPE.AGENT;
// Listing quick filters: an interface type, or "Run it yourself" (LOCAL).
const KIND_FILTERS = new Set(['A2A', 'REST', 'EVENT', 'LOCAL']);
const TYPE_OPTIONS = [['A2A', 'A2A'], ['REST', 'REST'], ['EVENT', 'Events'], ['LOCAL', 'Run it yourself']];
// Definition types that are agent definitions, never documents.
const DEFINITION_DOC_TYPES = new Set([
    constants.DOC_TYPES.API_DEFINITION, constants.DOC_TYPES.AGENT_CARD,
    constants.DOC_TYPES.AGENT_EVENT_DEFINITION, constants.DOC_TYPES.AGENT_LOCAL_DEFINITION,
]);

const viewBaseUrl = (orgName, viewName) => `${constants.ROUTE.BASE_PATH}/${orgName}${constants.ROUTE.VIEWS_PATH}${viewName}`;

function profileOf(req) {
    if (!req.user) {
        return null;
    }
    return {
        imageURL: req.user.imageURL,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        email: req.user.email,
        isAdmin: req.user.isAdmin && !req.foreignOrgSession,
    };
}

function pageError(next, error) {
    if (Number(error?.statusCode) === 401) {
        return next(Object.assign(new Error(constants.ERROR_MESSAGE.COMMON_AUTH_ERROR_MESSAGE), { status: 401 }));
    }
    error.status = error.status || util.pageErrorStatus(error);
    return next(error);
}

const notFound = () => Object.assign(new Error('Agent not found'), { status: 404 });

// The listing card: the badge row, the REST protocol labels, and skill names for search notes.
function toCard(api) {
    const agent = api.agent || {};
    // YAML skills, or the Agent Card's (kept on the agent at intake): never both.
    const skills = [...(agent.skills || []), ...(agent.cardSkills || [])];
    return {
        ...api,
        badges: kindBadges(agent),
        kinds: kindBadges(agent).map((badge) => badge.key),
        protocols: protocolsOf(agent),
        skillNames: skills.map((skill) => skill?.name).filter(Boolean),
        skillTexts: skills.flatMap((skill) => [skill?.name, skill?.description, ...(skill?.tags || [])])
            .filter((text) => typeof text === 'string' && text),
    };
}

async function loadDefinitions(orgId, apiId) {
    const rows = await apiFileDao.listAgentDefinitions(orgId, apiId);
    return Object.fromEntries(rows.map((row) => [row.type, { type: row.type, content: row.file_content }]));
}

// The agent in this view, with its stored definition files; a 404 for anything else.
async function resolveAgent(orgId, handle, viewName) {
    const apiId = await apiDao.getIdInView(orgId, handle, viewName, { type: AGENT });
    if (!apiId) {
        throw notFound();
    }
    const metadata = JSON.parse(JSON.stringify(await apiMetadataService.getMetadataFromDB(orgId, apiId)));
    const definitions = await loadDefinitions(orgId, apiId);
    return { apiId, metadata, definitions, viewModel: buildAgentViewModel(metadata, definitions) };
}

async function listAgents(orgId, viewName, searchTerm, tags) {
    const list = await apiMetadataService.getMetadataListFromDB(orgId, searchTerm, tags, null, null, viewName,
        { include: AGENT });
    return JSON.parse(JSON.stringify(list));
}

// Whether the Details card has anything to show.
const hasDetails = (view) => Boolean(view.models?.length || view.agentId);

const isHidden = (agent) => agent.agentVisibility === constants.AGENT_VISIBILITY.HIDDEN;

// Whether AI clients may read this view: the view's AI switch, and the agent's visibility.
async function aiReadable(orgId, viewName) {
    return !(await util.isAiDisabledForPortal(orgId, viewName));
}

// A document's URL name, as the API docs pages link them: ".md" left off.
const docSlug = (name) => (typeof name === 'string' && name.endsWith('.md') ? name.slice(0, -3) : name);

// Documents as { type, name, url }, from { type, name } entries (stored or a sample's).
function docLinks(entries, linkBase) {
    return entries.map(({ type, name }) => ({
        type, name, url: `${linkBase}/docs/${encodeURIComponent(type)}/${encodeURIComponent(docSlug(name))}`,
    }));
}

// The docs page's left nav (pages/docs/partials/docs-nav.hbs): one group per type.
function docNav(docs) {
    const byType = new Map();
    for (const doc of docs) {
        if (!byType.has(doc.type)) byType.set(doc.type, []);
        byType.get(doc.type).push(doc.name);
    }
    return [...byType].map(([type, names]) => ({ type, names }));
}

/*
 * The agent's definitions, as the API docs page's SPECIFICATION group: one entry per stored
 * file (Agent Card, OpenAPI, AsyncAPI, the setup guide for running it yourself), each shown in the viewer
 * its kind uses on API pages. Labels say what each is for ("Events · AsyncAPI"); the badge
 * keeps the file name. Built from the view model, so the card is the one the page shows
 * (never the extended card) and the guide is the sanitized rendering the page shows.
 */
const SPEC_KINDS = [
    { key: 'agent-card', label: 'A2A · Agent Card', file: 'agent-card.json', docType: constants.DOC_TYPES.AGENT_CARD },
    { key: 'openapi', label: 'REST · OpenAPI', file: 'openapi.yaml', docType: constants.DOC_TYPES.API_DEFINITION },
    { key: 'asyncapi', label: 'Events · AsyncAPI', file: 'asyncapi.yaml', docType: constants.DOC_TYPES.AGENT_EVENT_DEFINITION },
    { key: 'run-it-yourself', label: 'Run it yourself · Setup guide', file: 'run-locally.md',
        docType: constants.DOC_TYPES.AGENT_LOCAL_DEFINITION },
];
const SPEC_PATH = 'specification';

function specSources(viewModel) {
    const sources = {};
    for (const tab of viewModel.tabs || []) {
        if (tab.isA2A && tab.rawDefinition) sources['agent-card'] = tab.rawDefinition.text;
        if (tab.isRest && tab.rawDefinition) sources.openapi = tab.rawDefinition.text;
        if (tab.isEvent && tab.events?.rawText) sources.asyncapi = tab.events.rawText;
        if (tab.isLocal && tab.localHtml) sources['run-it-yourself'] = tab.localHtml;
    }
    return sources;
}

// [{ key, label, file, url, downloadUrl }] for the definitions this agent has.
// An OpenAPI or AsyncAPI file written as JSON is named .json, as it downloads.
const fileNameOf = (kind, text) => (/\.yaml$/.test(kind.file) && /^\s*\{/.test(text)
    ? kind.file.replace(/\.yaml$/, '.json') : kind.file);

function specEntries(viewModel, agentUrl, downloadBase, { publicCard = false } = {}) {
    const sources = specSources(viewModel);
    return SPEC_KINDS.filter((kind) => sources[kind.key]).map((kind) => ({
        key: kind.key,
        label: kind.label,
        file: fileNameOf(kind, sources[kind.key]),
        url: `${agentUrl}/docs/${SPEC_PATH}/${kind.key}`,
        // The card is the portal's public copy where that is served (not HIDDEN, AI features
        // on in this view); otherwise, like the other files, the publisher's as stored.
        downloadUrl: !downloadBase ? null : kind.key === 'agent-card' && publicCard
            ? `${agentUrl}/agent-card.json`
            : `${downloadBase}?type=${kind.docType}`,
    }));
}

// What the viewer for one definition needs; null when the file can't be parsed.
function specContent(viewModel, key) {
    const text = specSources(viewModel)[key];
    if (!text) return null;
    if (key === 'agent-card') return { isCard: true, cardText: text };
    // Already rendered and sanitized by the view model (renderLocal), as on the overview.
    if (key === 'run-it-yourself') return { isGuide: true, guideHtml: text };
    let parsed;
    try {
        parsed = yaml.load(text);
    } catch (error) {
        parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return { isRaw: true, rawText: text };
    }
    if (key === 'openapi') {
        // As on an API's docs page: the viewer (and its Try it) shows the interface's
        // endpoints, not the servers the publisher's file names.
        const rest = (viewModel.tabs || []).find((tab) => tab.isRest);
        parsed = replaceEndpointParams(parsed, rest?.productionUrl || '', rest?.sandboxUrl || '');
    }
    // The API docs page's viewers (pages/partials/api-specification.hbs): Stoplight Elements
    // for OpenAPI, the AsyncAPI viewer for AsyncAPI.
    return key === 'openapi'
        ? { isOpenApi: true, viewerType: constants.API_TYPE.REST, swagger: JSON.stringify(parsed) }
        : { isAsyncApi: true, viewerType: constants.API_TYPE.WEBSUB, asyncapi: JSON.stringify(parsed) };
}

// The nav's SPECIFICATION entries (docs-nav.hbs `specItems`), marking the one shown.
const specItems = (specs, activeKey) => specs.map((spec) => ({
    label: spec.label, url: spec.url, active: spec.key === activeKey,
}));

// The docs nav groups: SPECIFICATION (its own entries) first, then the documents.
function navGroups(specs, docs) {
    return [...(specs.length ? [{ type: 'Specification' }] : []), ...docNav(docs)];
}

// The listed document a URL names (with or without ".md"); never a path from the URL.
const findDoc = (docs, docType, docName) =>
    docs.find((doc) => doc.type === docType && (doc.name === docName || docSlug(doc.name) === docName)) || null;

async function agentDocs(orgId, apiId, linkBase) {
    const entries = [];
    for (const docType of (await apiMetadataService.getAPIDocTypes(orgId, apiId)) || []) {
        if (!docType.type || DEFINITION_DOC_TYPES.has(docType.type)) {
            continue;
        }
        for (const name of docType.names || []) {
            entries.push({ type: docType.type, name });
        }
    }
    return docLinks(entries, linkBase);
}

// The agents this user subscribes to, by handle (listing ribbon and "View subscription").
async function subscribedHandles(req, orgId) {
    if (!req.user) {
        return new Set();
    }
    try {
        const subs = await subDao.list(orgId, { createdBy: util.resolveActor(req) });
        return new Set(subs.map((sub) => sub.api_metadata?.handle).filter(Boolean));
    } catch (error) {
        logger.warn('Failed to load subscriptions for the agent listing', { error: error.message, orgId });
        return new Set();
    }
}

// Agent icons are read through /agents/{handle}/assets (public for images, as for APIs).
function appendAgentImageUrls(list, orgId) {
    for (const agent of list) {
        for (const key of Object.keys(agent.apiImageMetadata || {})) {
            agent.apiImageMetadata[key] = `${constants.API_PORTAL_API.orgPath(orgId)}/agents/${encodeURIComponent(agent.id)}`
                + `${constants.API_TEMPLATE_FILE_NAME}${encodeURIComponent(agent.apiImageMetadata[key])}`
                + `${constants.ORG_ID_PARAM}${orgId}`;
        }
    }
}

// ---------------------------------------------------------------------------
// Listing: /views/:viewName/agents
// ---------------------------------------------------------------------------

// The listing's filters, shared by the database and design-mode listings.
function listingQuery(req) {
    return {
        searchTerm: typeof req.query.query === 'string' ? req.query.query : undefined,
        tags: typeof req.query.tags === 'string' ? req.query.tags : undefined,
        // Several ways of use can be picked (?type=A2A&type=REST); unknown values are dropped.
        typeFilter: [...new Set([].concat(req.query.type || []))].filter((t) => KIND_FILTERS.has(t)),
        protocolFilter: typeof req.query.protocol === 'string' ? req.query.protocol.trim() : '',
    };
}

// Search text of a card: name, description, tags, skills and REST protocol labels.
const searchTexts = (agent) => [agent.name, agent.description, ...(agent.tags || []), ...agent.skillTexts,
    ...agent.protocols.flatMap((p) => [p.raw, p.label])];

// Newest first, on the listing and in Settings. Agents without a creation time (design-mode
// samples) keep their order.
const createdTime = (agent) => {
    const value = agent.createdAt || agent.created_at;
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isNaN(time) ? null : time;
};
function newestFirst(agents) {
    return agents.map((agent, index) => ({ agent, index, time: createdTime(agent) }))
        .sort((a, b) => (a.time !== null && b.time !== null && a.time !== b.time ? b.time - a.time : a.index - b.index))
        .map(({ agent }) => agent);
}

function filterListing(all, { searchTerm, typeFilter, protocolFilter }) {
    let agents = newestFirst(all);
    if (searchTerm) {
        const needle = searchTerm.toLowerCase();
        agents = agents.filter((a) => searchTexts(a).some((text) => typeof text === 'string'
            && text.toLowerCase().includes(needle)));
    }
    // An agent stays when it offers every chosen way of use (A2A + REST: both).
    if (typeFilter.length) {
        agents = agents.filter((a) => typeFilter.every((t) => a.kinds.includes(t)));
    }
    if (protocolFilter) {
        const wanted = protocolFilter.toUpperCase();
        agents = agents.filter((a) => a.protocols.some((p) => p.raw.toUpperCase() === wanted));
    }
    // "Matches skill X" when a search hit only through a skill name. A ?protocol= link
    // (no dropdown any more) still narrows to that REST protocol label.
    if (searchTerm) {
        const needle = searchTerm.toLowerCase();
        for (const agent of agents) {
            const inHeader = [agent.name, agent.description, ...(agent.tags || [])]
                .some((text) => typeof text === 'string' && text.toLowerCase().includes(needle));
            if (!inHeader) {
                agent.matchedSkill = agent.skillNames.find((n) => n.toLowerCase().includes(needle)) || null;
            }
        }
    }

    return {
        apiMetadata: agents,
        totalCount: all.length,
        filters: {
            query: searchTerm || '',
            active: Boolean(typeFilter.length || protocolFilter || searchTerm),
        },
        // The way-of-use filter, a multi-select menu: applying it keeps the search; the search
        // box (search.js) keeps nothing else, as on API pages.
        typeOptions: TYPE_OPTIONS.map(([value, label]) => ({ value, label, selected: typeFilter.includes(value) })),
        typeSummary: typeFilter.length
            ? TYPE_OPTIONS.filter(([value]) => typeFilter.includes(value)).map(([, label]) => label).join(', ')
            : 'All ways of use',
    };
}

const loadAgents = async (req, res, next) => {
    if (config.designMode?.enabled) {
        return loadAgentsDesign(req, res, next);
    }
    const { orgName, viewName } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        const query = listingQuery(req);
        // Search runs in memory (filterListing) so it also finds skills and protocol labels.
        const all = (await listAgents(orgId, viewName, undefined, query.tags)).map(toCard);
        appendAgentImageUrls(all, orgId);
        const subscribed = await subscribedHandles(req, orgId);
        for (const agent of all) {
            agent.hasSubscription = Boolean(agent.subscriptionPlans?.length) && subscribed.has(agent.id);
        }
        const templateContent = {
            isAuthenticated: req.isAuthenticated(),
            baseUrl: viewBaseUrl(orgName, viewName),
            orgId,
            profile: req.isAuthenticated() ? profileOf(req) : null,
            ...filterListing(all, query),
        };
        res.send(await util.renderTemplateFromAPI(templateContent, orgId, orgName, 'pages/agents', viewName));
    } catch (error) {
        logger.error('Failed to load agent listing', { orgName, error: error.message });
        return pageError(next, error);
    }
};

// ---------------------------------------------------------------------------
// Agent page: /views/:viewName/agent/:apiHandle
// ---------------------------------------------------------------------------

const loadAgent = async (req, res, next) => {
    const { orgName, viewName, apiHandle } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        const { apiId, metadata, viewModel } = await resolveAgent(orgId, apiHandle, viewName);
        appendAgentImageUrls([metadata], orgId);
        const baseUrl = viewBaseUrl(orgName, viewName);
        const agentUrl = `${baseUrl}/agent/${encodeURIComponent(apiHandle)}`;
        const docs = await agentDocs(orgId, apiId, agentUrl);
        const specs = specEntries(viewModel, agentUrl, null);
        const landing = await apiFileDao.get(constants.FILE_NAME.API_MD_CONTENT_FILE_NAME, constants.DOC_TYPES.API_LANDING,
            orgId, apiId);

        // Plans, and the caller's own subscriptions to them, as on an MCP server page
        // (paid plans included; the plan block and checkout are shared).
        const subscriptionPlans = viewModel.offersCredentials
            ? await util.appendSubscriptionPlanDetails(orgId, metadata.subscriptionPlans, apiId)
            : [];
        await planPresentation.decoratePlans(orgId, subscriptionPlans);
        let subscriptions = [];
        if (req.user && subscriptionPlans.length) {
            try {
                const localSubs = await subDao.list(orgId, { apiId, createdBy: util.resolveActor(req) });
                subscriptions = (localSubs || []).map((sub) => ({
                    subscriptionId: sub.uuid,
                    policyName: sub.subscription_plan?.handle || '',
                    subscriptionPlanName: sub.subscription_plan?.display_name || '',
                    status: sub.status,
                    subscriptionToken: sub.token,
                    maskedToken: sub.token ? `${sub.token.slice(0, 4)}****${sub.token.slice(-4)}` : '',
                    customerName: null,
                }));
            } catch (error) {
                logger.warn('Failed to load agent subscriptions', { error: error.message, orgId });
            }
        }

        const templateContent = {
            isAuthenticated: req.isAuthenticated(),
            apiMetadata: metadata,
            agentView: viewModel,
            subscriptionPlans,
            subscriptions,
            hasPaidPlans: subscriptionPlans.some((plan) => plan.paid),
            showSubscriptionsNav: subscriptionPlans.length > 0,
            showApiKeysNav: viewModel.offersCredentials,
            // The Documentation button, as on API pages: always there; the docs home opens the
            // first definition, else the first document, else says there is none.
            documentationUrl: `${agentUrl}/docs/${SPEC_PATH}`,
            asyncApiUrl: specs.find((spec) => spec.key === 'asyncapi')?.url || null,
            // "Try with AI" points an assistant at the agent's Markdown view.
            tryWithAi: !isHidden(metadata) && await aiReadable(orgId, viewName),
            // The Details card: who offers the agent and what it runs on.
            showDetails: hasDetails(viewModel),
            docs,
            landingHtml: landing
                ? sanitizeRenderedHtml(marked.parse(landing.file_content.toString(constants.CHARSET_UTF8)))
                : '',
            baseUrl,
            orgId,
            profile: req.isAuthenticated() ? profileOf(req) : null,
        };
        res.send(await util.renderTemplateFromAPI(templateContent, orgId, orgName, 'pages/agent-landing', viewName));
    } catch (error) {
        logger.error('Failed to load agent page', { orgName, error: error.message });
        return pageError(next, error);
    }
};

// ---------------------------------------------------------------------------
// Documents: /views/:viewName/agent/:apiHandle/docs/:docType/:docName
// ---------------------------------------------------------------------------

const loadAgentDocument = async (req, res, next) => {
    const { orgName, viewName, apiHandle, docType, docName } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        if (DEFINITION_DOC_TYPES.has(docType)) {
            throw notFound();
        }
        const { apiId, metadata, viewModel } = await resolveAgent(orgId, apiHandle, viewName);
        const baseUrl = viewBaseUrl(orgName, viewName);
        const agentUrl = `${baseUrl}/agent/${encodeURIComponent(apiHandle)}`;
        const docs = await agentDocs(orgId, apiId, agentUrl);
        const specs = specEntries(viewModel, agentUrl,
            `${constants.API_PORTAL_API.orgPath(orgId)}/agents/${encodeURIComponent(apiHandle)}/assets`,
            { publicCard: !isHidden(metadata) && await aiReadable(orgId, viewName) });
        const shared = {
            isAuthenticated: req.isAuthenticated(),
            apiMetadata: metadata,
            agentView: viewModel,
            docs,
            docTypes: navGroups(specs, docs),
            baseDocUrl: agentUrl,
            baseUrl,
            orgId,
            profile: req.isAuthenticated() ? profileOf(req) : null,
        };
        if (docType === SPEC_PATH) {
            const spec = specs.find((entry) => entry.key === docName);
            const content = spec && specContent(viewModel, spec.key);
            if (!content) {
                throw notFound();
            }
            res.send(await util.renderTemplateFromAPI({
                ...shared, ...content, isSpec: true, spec, specItems: specItems(specs, spec.key),
            }, orgId, orgName, 'pages/agent-doc', viewName));
            return;
        }
        const listed = findDoc(docs, docType, docName);
        // Doc links carry the type without its stored DOC_ prefix (APIDocDTO strips it).
        const doc = listed
            && await apiFileDao.getDocByName(constants.DOC_TYPES.DOC_ID + docType, listed.name, orgId, apiId);
        if (!doc) {
            throw notFound();
        }
        const source = doc.file_content.toString(constants.CHARSET_UTF8);
        const isMarkdown = /\.md$/i.test(listed.name);
        const templateContent = {
            ...shared,
            specItems: specItems(specs, null),
            docName: listed.name,
            currentDocName: docSlug(listed.name),
            docHtml: isMarkdown ? sanitizeRenderedHtml(marked.parse(source)) : '',
            docText: isMarkdown ? '' : source,
        };
        res.send(await util.renderTemplateFromAPI(templateContent, orgId, orgName, 'pages/agent-doc', viewName));
    } catch (error) {
        logger.error('Failed to load agent document', { orgName, error: error.message });
        return pageError(next, error);
    }
};

// ---------------------------------------------------------------------------
// Docs home: /views/:viewName/agent/:apiHandle/docs/specification
// The fixed target of the nav's Documentation link and the page's Documentation button,
// as /mcp/{id}/docs/specification: the first definition, else the first document, else
// the docs page saying there is none.
// ---------------------------------------------------------------------------

const loadAgentDocsHome = async (req, res, next) => {
    const { orgName, viewName, apiHandle } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        const { apiId, metadata, viewModel } = await resolveAgent(orgId, apiHandle, viewName);
        const baseUrl = viewBaseUrl(orgName, viewName);
        const agentUrl = `${baseUrl}/agent/${encodeURIComponent(apiHandle)}`;
        const docs = await agentDocs(orgId, apiId, agentUrl);
        const first = specEntries(viewModel, agentUrl, null)[0]?.url || docs[0]?.url;
        if (first) {
            res.redirect(first);
            return;
        }
        res.send(await util.renderTemplateFromAPI({
            isAuthenticated: req.isAuthenticated(),
            apiMetadata: metadata,
            agentView: viewModel,
            docs,
            docTypes: [],
            baseDocUrl: agentUrl,
            baseUrl,
            orgId,
            isEmpty: true,
            profile: req.isAuthenticated() ? profileOf(req) : null,
        }, orgId, orgName, 'pages/agent-doc', viewName));
    } catch (error) {
        logger.error('Failed to load agent documentation', { orgName, error: error.message });
        return pageError(next, error);
    }
};

// ---------------------------------------------------------------------------
// Markdown for AI clients: /views/:viewName/agents.md and /agent/:apiHandle.md
// ---------------------------------------------------------------------------

function sendMarkdown(res, md) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    // Publisher text is passed through as Markdown; never let a browser sniff it as HTML.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(md);
}

function markdownError(res, error) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    if (Number(error?.status) === 404 || util.pageErrorStatus(error) === 404) {
        return res.status(404).send('# Not Found\n\nThe requested resource does not exist.');
    }
    return res.status(500).send('# Error\n\nFailed to load agent details.');
}

const loadAgentsMd = async (req, res) => {
    const { orgName, viewName } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        if (!(await aiReadable(orgId, viewName))) {
            throw notFound();
        }
        const all = (await listAgents(orgId, viewName)).map(toCard);
        const visible = all.filter((agent) => !isHidden(agent));
        const md = await util.renderMarkdownTemplateFromAPI({
            agents: visible.length ? visible.map((agent) => ({
                ...agent, kindLabel: agent.badges.map((badge) => badge.label).join(', '),
            })) : null,
            baseUrl: viewBaseUrl(orgName, viewName),
        }, orgId, 'pages/agents', viewName);
        sendMarkdown(res, md);
    } catch (error) {
        logger.error('Failed to generate agents markdown', { orgName, error: error.message });
        markdownError(res, error);
    }
};

const loadAgentMd = async (req, res) => {
    const { orgName, viewName, apiHandle } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        if (!(await aiReadable(orgId, viewName))) {
            throw notFound();
        }
        const { apiId, metadata, viewModel } = await resolveAgent(orgId, apiHandle, viewName);
        if (isHidden(metadata)) {
            throw notFound();
        }
        const baseUrl = viewBaseUrl(orgName, viewName);
        const agentUrl = `${baseUrl}/agent/${encodeURIComponent(apiHandle)}`;
        const md = await util.renderMarkdownTemplateFromAPI({
            apiMetadata: metadata,
            agentView: { ...viewModel, kindLabel: viewModel.badges.map((badge) => badge.label).join(', ') },
            subscriptionPlans: viewModel.offersCredentials
                ? await util.appendSubscriptionPlanDetails(orgId, metadata.subscriptionPlans, apiId)
                : [],
            // Each document as Markdown, as an API's .md links them (an AI client has no session).
            docs: (await agentDocs(orgId, apiId, agentUrl)).map((doc) => ({ ...doc, url: `${doc.url}.md` })),
            agentCardUrl: `${agentUrl}/agent-card.json`,
            baseUrl,
        }, orgId, 'pages/agent-landing', viewName);
        sendMarkdown(res, md);
    } catch (error) {
        logger.error('Failed to generate agent markdown', { orgName, error: error.message });
        markdownError(res, error);
    }
};

// One of the agent's documents as Markdown, for AI clients:
// /views/:viewName/agent/:apiHandle/docs/:docType/:docName.md. As an API's (loadDocumentMd):
// no session, but the view's AI switch, HIDDEN and the view itself apply, as on agent.md.
const loadAgentDocumentMd = async (req, res) => {
    const { orgName, viewName, apiHandle, docType, docName } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        if (!(await aiReadable(orgId, viewName)) || DEFINITION_DOC_TYPES.has(docType)) {
            throw notFound();
        }
        const { apiId, metadata } = await resolveAgent(orgId, apiHandle, viewName);
        if (isHidden(metadata)) {
            throw notFound();
        }
        const listed = findDoc(await agentDocs(orgId, apiId, ''), docType, docName);
        const doc = listed && /\.md$/i.test(listed.name)
            && await apiFileDao.getDocByName(constants.DOC_TYPES.DOC_ID + docType, listed.name, orgId, apiId);
        if (!doc) {
            throw notFound();
        }
        sendMarkdown(res, doc.file_content.toString(constants.CHARSET_UTF8));
    } catch (error) {
        logger.error('Failed to load agent document markdown', { orgName, error: error.message });
        markdownError(res, error);
    }
};

// ---------------------------------------------------------------------------
// The agent's public card: /views/:viewName/agent/:apiHandle/agent-card.json
// ---------------------------------------------------------------------------

// Absolute, behind a TLS-terminating proxy too (requestOrigin reads X-Forwarded-Proto).
const pageUrlOf = (req, orgName, viewName, handle) =>
    `${requestOrigin(req)}${viewBaseUrl(orgName, viewName)}/agent/${encodeURIComponent(handle)}`;

// The stored source card byte for byte. Never the extended card; never fetched.
const loadAgentCard = async (req, res, next) => {
    const { orgName, viewName, apiHandle } = req.params;
    try {
        const orgId = (await orgDao.get(orgName)).uuid;
        if (!(await aiReadable(orgId, viewName))) {
            throw notFound();
        }
        const { metadata, definitions } = await resolveAgent(orgId, apiHandle, viewName);
        const card = isHidden(metadata) ? null : publicCard(metadata, definitions);
        if (!card) {
            throw notFound();
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(card.bytes);
    } catch (error) {
        return pageError(next, error);
    }
};

// ---------------------------------------------------------------------------
// ARD manifest: /.well-known/ard.json at the domain root
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLoopback = (host) => LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
let warnedRequestHostPublisher = false;

/*
 * The publisher domain in identifiers. ARD identifiers should not change, so it is the
 * host of the portal's public address (`server.base_url`), which operators already set
 * for Stripe and API workflows. While that is still a loopback default (a local or test
 * setup), it falls back to the request's host and says so once in the log.
 */
function ardPublisher(req) {
    let configured;
    try {
        configured = new URL(config.server?.baseUrl || '').hostname.toLowerCase();
    } catch {
        configured = '';
    }
    if (configured && !isLoopback(configured) && /^[a-z0-9.-]+$/.test(configured)) {
        return configured;
    }
    if (!warnedRequestHostPublisher) {
        warnedRequestHostPublisher = true;
        logger.warn('ARD identifiers use the request host because server.base_url is not a public address; '
            + 'set server.base_url to the portal\'s public URL so identifiers stay the same');
    }
    return req.hostname;
}

/*
 * Every published, visible agent of this portal's organization, as one ARD v0.91
 * manifest (`{ entries }`) at the domain root, where ARD looks for it. Views are a
 * portal-internal grouping and don't split the manifest; each entry links through
 * the default view, or through the first other view that has the agent when the
 * default one doesn't. Views whose AI features are off are not used for links. An
 * agent with a card points at it; any other agent at its Markdown view. Built per
 * request; nothing is fetched. Served at the domain root and under the portal's base
 * path (for hosts whose root doesn't reach the portal; pages link it with rel="ard").
 */
const loadArdManifest = async (req, res, next) => {
    try {
        const orgId = await orgContext.getOrgUuid();
        const orgName = orgContext.getHandle();
        const fallback = await orgContext.getFallbackViewHandle(orgId);
        const viewNames = (await viewDao.list(orgId)).map((view) => view.handle)
            .sort((a, b) => (a === fallback ? -1 : b === fallback ? 1 : String(a).localeCompare(String(b))));
        const publisher = ardPublisher(req);
        const seen = new Set();
        const entries = [];
        for (const viewName of viewNames) {
            if (!(await aiReadable(orgId, viewName))) {
                continue;
            }
            for (const agent of (await listAgents(orgId, viewName)).filter((a) => !isHidden(a))) {
                if (seen.has(agent.id)) {
                    continue;
                }
                const apiId = await apiDao.getIdInView(orgId, agent.id, viewName, { type: AGENT });
                if (!apiId) {
                    continue;
                }
                seen.add(agent.id);
                const pageUrl = pageUrlOf(req, orgName, viewName, agent.id);
                const card = publicCard(agent, await loadDefinitions(orgId, apiId));
                entries.push(ardEntry(agent, { publisher, orgHandle: orgName, pageUrl, card }));
            }
        }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        // Public, read-only and credential-free, so any origin may read it (ARD's publishing guide).
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json({ entries });
    } catch (error) {
        logger.error('Failed to generate ARD manifest', { error: error.message });
        return next(error);
    }
};

// ---------------------------------------------------------------------------
// Design mode: the same pages from sample folders (utils/sampleAgentLoader.js)
// ---------------------------------------------------------------------------

const designBaseUrl = (viewName) => constants.ROUTE.BASE_PATH + constants.ROUTE.VIEWS_PATH + viewName;
const designPage = (page) => {
    const layoutPath = config.designMode.pathToLayout;
    return [`${layoutPath}pages/${page}/page.hbs`, `${layoutPath}layout/main.hbs`];
};

const loadAgentsDesign = (req, res, next) => {
    try {
        const query = listingQuery(req);
        const all = sampleAgentLoader.loadAll().map((sample) => toCard(sample.metadata));
        const [page, layout] = designPage('agents');
        res.send(util.renderTemplate(page, layout, {
            devMode: true, baseUrl: designBaseUrl(req.params.viewName), ...filterListing(all, query),
        }, false));
    } catch (error) {
        return pageError(next, error);
    }
};

const loadAgentDesign = (req, res, next) => {
    try {
        const sample = sampleAgentLoader.loadOne(req.params.apiHandle);
        if (!sample) throw notFound();
        const { metadata } = sample;
        const viewModel = buildAgentViewModel(metadata, sample.definitions);
        const baseUrl = designBaseUrl(req.params.viewName);
        const agentUrl = `${baseUrl}/agent/${encodeURIComponent(metadata.handle)}`;
        const subscriptionPlans = viewModel.offersCredentials ? metadata.subscriptionPlans : [];
        const docs = docLinks(sample.docs, agentUrl);
        const specs = specEntries(viewModel, agentUrl, null);
        const [page, layout] = designPage('agent-landing');
        res.send(util.renderTemplate(page, layout, {
            devMode: true,
            isAuthenticated: false,
            apiMetadata: metadata,
            agentView: viewModel,
            subscriptionPlans,
            subscriptions: [],
            showSubscriptionsNav: subscriptionPlans.length > 0,
            showApiKeysNav: viewModel.offersCredentials,
            documentationUrl: `${agentUrl}/docs/${SPEC_PATH}`,
            asyncApiUrl: specs.find((spec) => spec.key === 'asyncapi')?.url || null,
            tryWithAi: !isHidden(metadata),
            // The Details card: who offers the agent and what it runs on.
            showDetails: hasDetails(viewModel),
            docs,
            landingHtml: '',
            baseUrl,
        }, false));
    } catch (error) {
        return pageError(next, error);
    }
};

// The docs home for a sample (see loadAgentDocsHome).
const loadAgentDocsHomeDesign = (req, res, next) => {
    try {
        const { viewName, apiHandle } = req.params;
        const sample = sampleAgentLoader.loadOne(apiHandle);
        if (!sample) throw notFound();
        const baseUrl = designBaseUrl(viewName);
        const agentUrl = `${baseUrl}/agent/${encodeURIComponent(apiHandle)}`;
        const docs = docLinks(sample.docs, agentUrl);
        const viewModel = buildAgentViewModel(sample.metadata, sample.definitions);
        const first = specEntries(viewModel, agentUrl, null)[0]?.url || docs[0]?.url;
        if (first) {
            res.redirect(first);
            return;
        }
        const [page, layout] = designPage('agent-doc');
        res.send(util.renderTemplate(page, layout, {
            devMode: true, isAuthenticated: false, apiMetadata: sample.metadata, agentView: viewModel,
            docs, docTypes: [], baseDocUrl: agentUrl, baseUrl, isEmpty: true,
        }, false));
    } catch (error) {
        return pageError(next, error);
    }
};

// A sample's document, matched by name from its docs/ listing (never a path from the URL).
const loadAgentDocumentDesign = (req, res, next) => {
    try {
        const { viewName, apiHandle, docType, docName } = req.params;
        const sample = sampleAgentLoader.loadOne(apiHandle);
        if (!sample) throw notFound();
        const baseUrl = designBaseUrl(viewName);
        const agentUrl = `${baseUrl}/agent/${encodeURIComponent(apiHandle)}`;
        const docs = docLinks(sample.docs, agentUrl);
        const viewModel = buildAgentViewModel(sample.metadata, sample.definitions);
        const specs = specEntries(viewModel, agentUrl, null);
        const shared = {
            devMode: true,
            isAuthenticated: false,
            apiMetadata: sample.metadata,
            agentView: viewModel,
            docs,
            docTypes: navGroups(specs, docs),
            baseDocUrl: agentUrl,
            baseUrl,
        };
        const [page, layout] = designPage('agent-doc');
        if (docType === SPEC_PATH) {
            const spec = specs.find((entry) => entry.key === docName);
            const content = spec && specContent(viewModel, spec.key);
            if (!content) throw notFound();
            res.send(util.renderTemplate(page, layout, {
                ...shared, ...content, isSpec: true, spec, specItems: specItems(specs, spec.key),
            }, false));
            return;
        }
        const doc = findDoc(sample.docs, docType, docName);
        if (!doc) throw notFound();
        const source = fs.readFileSync(doc.file, constants.CHARSET_UTF8);
        const isMarkdown = /\.md$/i.test(doc.name);
        res.send(util.renderTemplate(page, layout, {
            ...shared,
            specItems: specItems(specs, null),
            docName: doc.name,
            currentDocName: docSlug(doc.name),
            docHtml: isMarkdown ? sanitizeRenderedHtml(marked.parse(source)) : '',
            docText: isMarkdown ? '' : source,
        }, false));
    } catch (error) {
        return pageError(next, error);
    }
};

module.exports = {
    loadAgents,
    loadAgent,
    loadAgentDocument,
    loadAgentDocsHome,
    loadAgentDesign,
    loadAgentDocumentDesign,
    loadAgentDocsHomeDesign,
    loadAgentsMd,
    loadAgentMd,
    loadAgentDocumentMd,
    loadAgentCard,
    loadArdManifest,
};
