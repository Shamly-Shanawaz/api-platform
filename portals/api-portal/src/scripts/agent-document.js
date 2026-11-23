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

/*
 * The kind: Agent document that Settings → Agents sends, built from the Add/Edit form.
 * Pure: no DOM, no network. The server holds every rule (agentArtifactValidation.js);
 * this only shapes the document so it passes them:
 *   - the form owns the fields it shows; everything else (provider, annotations,
 *     referenceId, ...) is kept from the stored document;
 *   - an interface carries only its URLs (and REST its protocol label): transports, auth
 *     and operations come from its definition file, and skills from the Agent Card when
 *     there is an A2A interface;
 *   - at most one interface per type; spec.types follows the interfaces and LOCAL.
 * Definition files are not named in the document: they go in the upload fields below.
 *
 * Loaded in the browser as window.cfgAgentDocument, and by the unit tests via require.
 */
(function (root) {
  var API_VERSION = 'api-portal.api-platform.wso2.com/v1alpha1';

  // Upload field for each kind of definition file.
  var FILE_FIELDS = { A2A: 'a2aDefinition', REST: 'restDefinition', EVENT: 'eventDefinition', LOCAL: 'localDefinition' };

  // Spec fields the form owns: cleared from the stored document first, so a field
  // emptied in the form is removed rather than kept.
  var FORM_SPEC_FIELDS = ['types', 'displayName', 'version', 'description', 'models', 'agentId', 'status',
    'agentVisibility', 'labels', 'tags', 'subscriptionPlans', 'skills', 'interfaces', 'businessInformation'];
  // spec.businessInformation, as the API wizard's Ownership section.
  var OWNER_FIELDS = ['technicalOwner', 'technicalOwnerEmail', 'businessOwner', 'businessOwnerEmail'];

  function present(value) {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function str(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function list(values) {
    return (Array.isArray(values) ? values : []).map(str).filter(Boolean);
  }

  /*
   * The form's starting values for an agent from GET /agents/{id} (or empty for a new
   * one). `hasFile` says which definition files are stored, so the form can show them
   * as on file and leave the covered fields out.
   */
  function formFromAgent(agent) {
    var doc = (agent && agent.document) || { spec: {} };
    var spec = doc.spec || {};
    var ifaces = Array.isArray(spec.interfaces) ? spec.interfaces : [];
    var byType = {};
    ifaces.forEach(function (i) { if (i && i.type) byType[i.type] = i; });
    var flags = {};
    (agent && Array.isArray(agent.interfaces) ? agent.interfaces : []).forEach(function (i) {
      if (i && i.type) flags[i.type] = Boolean(i.hasDefinition);
    });
    var types = Array.isArray(spec.types) ? spec.types : [];
    var endpoint = function (i, key) { return (i && i.endpoints && i.endpoints[key]) || ''; };
    return {
      handle: (doc.metadata && doc.metadata.name) || '',
      // Shown as the portal has them (the card fills what the YAML leaves out).
      displayName: (agent && agent.displayName) || spec.displayName || '',
      version: (agent && agent.version) || spec.version || '',
      description: (agent && agent.description) || spec.description || '',
      // What the agent runs on: the About box's Models row on the agent page.
      models: (Array.isArray(spec.models) ? spec.models : []).filter(function (m) { return m && typeof m === 'object'; })
        .map(function (m) { return { provider: str(m.provider), name: str(m.name) }; }),
      agentId: spec.agentId || '',
      owners: OWNER_FIELDS.reduce(function (out, key) {
        out[key] = (spec.businessInformation && spec.businessInformation[key]) || '';
        return out;
      }, {}),
      status: spec.status || 'PUBLISHED',
      agentVisibility: spec.agentVisibility || 'VISIBLE',
      tags: list(spec.tags),
      labels: list(spec.labels),
      subscriptionPlans: list(spec.subscriptionPlans),
      a2a: byType.A2A ? {
        productionUrl: endpoint(byType.A2A, 'productionUrl'), sandboxUrl: endpoint(byType.A2A, 'sandboxUrl'),
        cardUrl: byType.A2A.cardUrl || '',
      } : null,
      rest: byType.REST ? {
        productionUrl: endpoint(byType.REST, 'productionUrl'), sandboxUrl: endpoint(byType.REST, 'sandboxUrl'),
        protocol: byType.REST.protocol || '',
      } : null,
      event: Boolean(byType.EVENT),
      local: types.indexOf('LOCAL') !== -1,
      skills: (Array.isArray(spec.skills) ? spec.skills : []).map(function (s) {
        return { id: s.id || '', name: s.name || '', description: s.description || '',
          examples: list(s.examples) };
      }),
      // Which files are stored: the card and OpenAPI as the server reports them; the
      // AsyncAPI and LOCAL files are required, so stored whenever their part exists.
      hasFile: { A2A: Boolean(flags.A2A), REST: Boolean(flags.REST), EVENT: Boolean(byType.EVENT),
        LOCAL: types.indexOf('LOCAL') !== -1 },
      // What the card supplied, so an unchanged value stays out of the document.
      fromCard: {
        displayName: !present(spec.displayName) && (agent && agent.displayName) || null,
        version: !present(spec.version) && (agent && agent.version) || null,
        description: !present(spec.description) && (agent && agent.description) || null,
      },
    };
  }

  // A skill id from its name: lowercase words joined by dashes.
  function skillId(name) {
    return str(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  }

  /*
   * The document to send. `base` is the stored document on edit (GET /agents/{id}
   * `document`), or null. `files` says which definition files will be in force after
   * the save: { A2A, REST } true when uploaded now or stored and kept.
   */
  function applyForm(base, form, files) {
    var doc = clone(base) || { apiVersion: API_VERSION, kind: 'Agent', metadata: {}, spec: {} };
    doc.apiVersion = API_VERSION;
    doc.kind = 'Agent';
    doc.metadata = doc.metadata || {};
    doc.metadata.name = str(form.handle) || doc.metadata.name;
    var stored = doc.spec || {};
    var spec = {};
    Object.keys(stored).forEach(function (key) {
      if (FORM_SPEC_FIELDS.indexOf(key) === -1) spec[key] = clone(stored[key]);
    });
    var inForce = files || {};
    var fromCard = form.fromCard || {};

    var interfaces = [];
    function iface(type, fields) {
      var out = { type: type };
      Object.keys(fields).forEach(function (key) { if (present(fields[key])) out[key] = fields[key]; });
      interfaces.push(out);
    }
    function endpoints(part) {
      var e = {};
      if (present(part.productionUrl)) e.productionUrl = str(part.productionUrl);
      if (present(part.sandboxUrl)) e.sandboxUrl = str(part.sandboxUrl);
      return e;
    }
    if (form.a2a) {
      iface('A2A', {
        endpoints: endpoints(form.a2a),
        // Where A2A clients read the live card; only when given (the portal never guesses one).
        cardUrl: str(form.a2a.cardUrl),
      });
    }
    if (form.rest) {
      iface('REST', { endpoints: endpoints(form.rest), protocol: str(form.rest.protocol) });
    }
    if (form.event) {
      iface('EVENT', {});
    }

    var types = [];
    if (form.a2a || form.rest) types.push('API');
    if (form.event) types.push('EVENT');
    if (form.local) types.push('LOCAL');
    spec.types = types;

    // A listing value the card supplied and the admin left unchanged stays out, so the
    // card keeps supplying it.
    ['displayName', 'version', 'description'].forEach(function (key) {
      var value = str(form[key]);
      if (value && !(inForce.A2A && fromCard[key] && value === fromCard[key])) spec[key] = value;
    });
    var models = (form.models || []).map(function (m) {
      var out = {};
      if (present(m && m.provider)) out.provider = str(m.provider);
      if (present(m && m.name)) out.name = str(m.name);
      return out;
    }).filter(function (m) { return Object.keys(m).length; });
    if (models.length) spec.models = models;
    if (present(form.agentId)) spec.agentId = str(form.agentId);
    var owners = {};
    OWNER_FIELDS.forEach(function (key) { if (present(form.owners && form.owners[key])) owners[key] = str(form.owners[key]); });
    if (Object.keys(owners).length) spec.businessInformation = owners;
    spec.status = form.status === 'DEPRECATED' ? 'DEPRECATED' : 'PUBLISHED';
    spec.agentVisibility = form.agentVisibility === 'HIDDEN' ? 'HIDDEN' : 'VISIBLE';
    // Labels: none ticked on an agent that had some removes them, as unticking does for an API.
    if (list(form.labels).length) spec.labels = list(form.labels);
    else if (list(stored.labels).length) spec.labels = [];
    if (list(form.tags).length) spec.tags = list(form.tags);
    // Plans only for an agent that is called.
    if (types.indexOf('API') !== -1 && list(form.subscriptionPlans).length) {
      spec.subscriptionPlans = list(form.subscriptionPlans);
    }
    // Skills come from the Agent Card when there is an A2A interface.
    if (!form.a2a) {
      var skills = (form.skills || []).filter(function (s) { return present(s.name) || present(s.description); })
        .map(function (s) {
          var out = { id: str(s.id) || skillId(s.name), name: str(s.name), description: str(s.description) };
          var examples = list(s.examples);
          if (examples.length) out.examples = examples;
          // Tags and modes the form doesn't show are kept from the stored skill.
          var before = (Array.isArray(stored.skills) ? stored.skills : []).filter(function (x) { return x && x.id === out.id; })[0];
          ['tags', 'inputModes', 'outputModes'].forEach(function (key) {
            if (before && present(before[key])) out[key] = clone(before[key]);
          });
          return out;
        });
      if (skills.length) spec.skills = skills;
    }
    if (interfaces.length) spec.interfaces = interfaces;
    doc.spec = spec;
    return doc;
  }

  // The stored document with only its status changed (Publish / Deprecate).
  function withStatus(agent, status) {
    var doc = clone(agent && agent.document);
    if (!doc || !doc.spec) return null;
    doc.spec.status = status;
    return doc;
  }

  // The messages of an error response (every problem the server found).
  function errorMessages(body, fallback) {
    var errors = body && Array.isArray(body.errors) ? body.errors : [];
    var messages = errors.map(function (e) { return e && e.message; }).filter(present);
    if (messages.length) return messages;
    var single = body && (body.description || body.message || body.error);
    return [present(single) ? String(single) : fallback || 'Something went wrong.'];
  }

  /*
   * The form field a server message is about, so the form can show it under that field.
   * Server messages start "Field '<path>' ..."; interfaces are addressed by index, so
   * the sent document says which kind each index is. Returns a key the form knows
   * ('handle', 'name', 'a2a.productionUrl', 'file.a2a', 'skills', ...) or null.
   */
  var PATH_KEYS = {
    'metadata.name': 'handle',
    'spec.displayName': 'name',
    'spec.version': 'version',
    'spec.description': 'description',
    'spec.agentId': 'agentId',
    'spec.labels': 'labels',
    'spec.tags': 'tags',
    'spec.subscriptionPlans': 'plans',
    'spec.skills': 'skills',
    a2aDefinition: 'file.a2a',
    restDefinition: 'file.rest',
    eventDefinition: 'file.event',
    localDefinition: 'file.local',
  };
  OWNER_FIELDS.forEach(function (key) { PATH_KEYS['spec.businessInformation.' + key] = 'owners.' + key; });
  function fieldFor(message, doc) {
    var match = /^Field '([^']+)'/.exec(str(message));
    if (!match) return null;
    var path = match[1];
    var iface = /^spec\.interfaces\[(\d+)\]\.endpoints\.(productionUrl|sandboxUrl)$/.exec(path);
    if (iface) {
      var entry = doc && doc.spec && Array.isArray(doc.spec.interfaces) ? doc.spec.interfaces[Number(iface[1])] : null;
      var kind = entry && { A2A: 'a2a', REST: 'rest' }[entry.type];
      return kind ? kind + '.' + iface[2] : null;
    }
    if (/^spec\.interfaces\[\d+\]\.cardUrl$/.test(path)) return 'a2a.cardUrl';
    if (/^spec\.skills(\[|\.|$)/.test(path)) return 'skills';
    if (/^spec\.models(\[|$)/.test(path)) return 'models';
    if (/^spec\.tags(\[|$)/.test(path)) return 'tags';
    if (/^spec\.labels(\[|$)/.test(path)) return 'labels';
    return PATH_KEYS[path] || null;
  }

  var api = {
    API_VERSION: API_VERSION, FILE_FIELDS: FILE_FIELDS, OWNER_FIELDS: OWNER_FIELDS,
    formFromAgent: formFromAgent, applyForm: applyForm, withStatus: withStatus, skillId: skillId,
    errorMessages: errorMessages, fieldFor: fieldFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.cfgAgentDocument = api;
})(typeof window !== 'undefined' ? window : null);
