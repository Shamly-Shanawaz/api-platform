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
 * Settings → Agents (cfg-agents-panel.hbs). Agents are added and edited in a wizard
 * (Interfaces, Details, Skills and identity, Assets; the same steps both ways), as APIs and MCP servers are.
 * Interfaces come first so an Agent Card can fill the details; importing
 * agent.yaml or a ZIP is done through the /agents REST API. The browser sends a
 * kind: Agent document to /agents and the server holds every rule; agent-document.js shapes the document from the form.
 * Errors are listed as the server words them (field and fix, never a value).
 */
(function () {
  var panel = document.getElementById('cfg-agents');
  var Doc = window.cfgAgentDocument;
  if (!panel || !Doc) return;

  function el(id) { return document.getElementById(id); }
  function val(id) { var e = el(id); return e ? e.value.trim() : ''; }
  function setVal(id, value) { var e = el(id); if (e) e.value = value || ''; }
  function show(id, on) { var e = el(id); if (e) e.style.display = on ? '' : 'none'; }
  // Dialog overlays centre their dialog as a flex box.
  function showModal(id, on) { var e = el(id); if (e) e.style.display = on ? 'flex' : 'none'; }
  function checked(id) { var e = el(id); return Boolean(e && e.checked); }
  function fileOf(id) { var e = el(id); return e && e.files && e.files[0] ? e.files[0] : null; }
  function clearFile(id) { var e = el(id); if (e) e.value = ''; }
  function url(path) { return window.apiPortalApi.root(path); }
  function csrf() { return { 'X-CSRF-Token': window.apiPortalApi.csrfToken() }; }
  function agentPath(id) { return '/agents/' + encodeURIComponent(id); }
  function alertMsg(message, type) { return typeof showAlert === 'function' ? showAlert(message, type) : Promise.resolve(); }

  var rows = [];
  try { rows = JSON.parse((el('cfg-agents-data') || {}).textContent || '[]'); } catch (e) { rows = []; }
  function rowOf(id) { return rows.filter(function (r) { return r.apiId === id; })[0] || null; }

  async function getAgent(id) {
    var res = await fetch(url(agentPath(id)), { headers: csrf() });
    if (!res.ok) throw new Error(Doc.errorMessages(await res.json().catch(function () { return {}; }), res.statusText)[0]);
    return res.json();
  }

  function showErrors(boxId, messages) {
    var box = el(boxId);
    if (!box) return;
    box.innerHTML = '';
    if (!messages || !messages.length) { box.style.display = 'none'; return; }
    var title = document.createElement('p');
    title.className = 'ag-errors-title';
    title.textContent = messages.length === 1 ? 'Fix this and try again:' : 'Fix these ' + messages.length + ' problems and try again:';
    var ul = document.createElement('ul');
    messages.forEach(function (m) { var li = document.createElement('li'); li.textContent = m; ul.appendChild(li); });
    box.appendChild(title);
    box.appendChild(ul);
    box.style.display = '';
  }

  // ── Errors under their fields ────────────────────────────────────────────
  // A server message that names a form field is shown under that field, as the API
  // wizard does; the rest stay in the summary box at the bottom.
  var FIELD_TARGETS = {
    handle: 'ag-handle', name: 'ag-name', version: 'ag-version', description: 'ag-desc',
    models: 'ag-models', agentId: 'ag-agent-id',
    labels: 'ag-labels', tags: 'ag-tags-wrap', plans: 'ag-plans-wrap', skills: 'ag-skills',
    'a2a.productionUrl': 'ag-a2a-prod', 'a2a.sandboxUrl': 'ag-a2a-sandbox', 'a2a.cardUrl': 'ag-a2a-card-url',
    'rest.productionUrl': 'ag-rest-prod', 'rest.sandboxUrl': 'ag-rest-sandbox',
    'owners.technicalOwner': 'ag-tech-owner', 'owners.technicalOwnerEmail': 'ag-tech-email',
    'owners.businessOwner': 'ag-biz-owner', 'owners.businessOwnerEmail': 'ag-biz-email',
  };
  function targetOf(key) {
    if (!key) return null;
    var file = /^file\.(a2a|rest|event|local)$/.exec(key);
    if (file) return panel.querySelector('[data-ag-file="' + file[1] + '"]');
    return FIELD_TARGETS[key] ? el(FIELD_TARGETS[key]) : null;
  }
  function clearFieldErrors() {
    panel.querySelectorAll('.ag-field-error').forEach(function (n) { n.remove(); });
    panel.querySelectorAll('.cfg-form-input--error').forEach(function (n) { n.classList.remove('cfg-form-input--error'); });
  }
  // `after`: put the note straight after the target (a step's description, a button)
  // rather than at the end of its form group.
  function fieldError(target, message, after) {
    var note = document.createElement('p');
    note.className = 'cfg-field-error ag-field-error';
    note.setAttribute('role', 'alert');
    note.textContent = message;
    if (after) {
      target.insertAdjacentElement('afterend', note);
    } else {
      (target.closest('.cfg-form-group') || target.parentNode).appendChild(note);
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) target.classList.add('cfg-form-input--error');
    // A field in a folded section: open it, so the message is seen.
    for (var fold = target.closest('details'); fold; fold = fold.parentElement && fold.parentElement.closest('details')) {
      fold.open = true;
    }
  }
  // Shows each message under its field, opens the first step that has one, and returns
  // the messages no field claims.
  function placeErrors(messages, doc) {
    clearFieldErrors();
    var rest = [];
    var firstStep = null;
    messages.forEach(function (message) {
      var target = targetOf(Doc.fieldFor(message, doc));
      if (!target) { rest.push(message); return; }
      var step = target.closest('.cfg-wizard-step');
      var index = step ? Number(step.id.replace('ag-wstep-', '')) : null;
      if (index !== null && (firstStep === null || index < firstStep)) firstStep = index;
      fieldError(target, message);
    });
    if (firstStep !== null && firstStep !== state.step) goTo(firstStep);
    return rest;
  }

  // ── Labels (toggle picker) ───────────────────────────────────────────────
  function pickerValues(id) {
    var root = el(id);
    if (!root) return [];
    return Array.prototype.slice.call(root.querySelectorAll('.cfg-label-toggle[aria-pressed="true"]'))
      .map(function (b) { return b.dataset.value; });
  }
  function setPicker(id, values) {
    var root = el(id);
    if (!root) return;
    root.querySelectorAll('.cfg-label-toggle').forEach(function (b) {
      var on = values.indexOf(b.dataset.value) !== -1;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('selected', on);
    });
  }
  (function () {
    var root = el('ag-labels');
    if (!root) return;
    root.addEventListener('click', function (e) {
      var chip = e.target.closest('.cfg-label-toggle');
      if (!chip) return;
      // As the API wizard: aria-pressed for the value, .selected for the look.
      var on = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', on ? 'false' : 'true');
      chip.classList.toggle('selected', !on);
    });
  }());

  // ── Tags (the API wizard's chip input) ───────────────────────────────────
  var tagChips = window.cfgChipInput ? window.cfgChipInput.create({
    wrapId: 'ag-tags-wrap', chipsId: 'ag-tags-chips', inputId: 'ag-tags-input',
  }) : null;

  // ── Subscription plans (the API wizard's searchable picker) ──────────────
  var allPlans = [];
  try { allPlans = JSON.parse((el('cfg-plans-data') || {}).textContent || '[]') || []; } catch (e) { allPlans = []; }
  var planChips = []; // plan handles, in the order picked
  function planOf(handle) {
    return allPlans.filter(function (p) { return p.planName === handle; })[0] || { planName: handle, displayName: handle };
  }
  function renderPlanChips() {
    var box = el('ag-plans-chips');
    if (!box) return;
    box.innerHTML = '';
    planChips.forEach(function (handle) {
      var chip = document.createElement('span');
      chip.className = 'cfg-chip';
      chip.appendChild(document.createTextNode(planOf(handle).displayName || handle));
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cfg-chip-remove';
      remove.title = 'Remove';
      remove.innerHTML = '<i class="bi bi-x"></i>';
      remove.addEventListener('click', function (e) {
        e.stopPropagation();
        planChips = planChips.filter(function (h) { return h !== handle; });
        renderPlanChips();
      });
      chip.appendChild(remove);
      box.appendChild(chip);
    });
  }
  function showPlanDropdown(query) {
    var dd = el('ag-plans-dropdown');
    if (!dd) return;
    var q = String(query || '').toLowerCase().trim();
    var matches = allPlans.filter(function (p) {
      if (planChips.indexOf(p.planName) !== -1) return false;
      return !q || [p.displayName, p.planName, p.description].some(function (t) {
        return String(t || '').toLowerCase().indexOf(q) !== -1;
      });
    });
    dd.innerHTML = '';
    if (!matches.length) {
      var none = document.createElement('div');
      none.className = 'cfg-chip-dd-empty';
      none.textContent = 'No matching plans';
      dd.appendChild(none);
    }
    matches.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'cfg-chip-dd-item';
      var name = document.createElement('div');
      name.className = 'cfg-chip-dd-name';
      name.textContent = p.displayName || p.planName;
      item.appendChild(name);
      if (p.description) {
        var desc = document.createElement('div');
        desc.className = 'cfg-chip-dd-desc';
        desc.textContent = p.description;
        item.appendChild(desc);
      }
      item.addEventListener('mousedown', function (e) {
        e.preventDefault();
        if (planChips.indexOf(p.planName) === -1) planChips.push(p.planName);
        renderPlanChips();
        el('ag-plans-search').value = '';
        dd.style.display = 'none';
      });
      dd.appendChild(item);
    });
    dd.style.display = 'block';
  }
  (function () {
    var search = el('ag-plans-search');
    if (!search) return;
    el('ag-plans-wrap').addEventListener('click', function () { search.focus(); });
    search.addEventListener('focus', function () { showPlanDropdown(search.value); });
    search.addEventListener('input', function () { showPlanDropdown(search.value); });
    search.addEventListener('blur', function () { setTimeout(function () { el('ag-plans-dropdown').style.display = 'none'; }, 160); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { el('ag-plans-dropdown').style.display = 'none'; search.blur(); }
    });
  }());

  // ── Wizard state ─────────────────────────────────────────────────────────
  var STEPS = 4;
  // Interfaces, Details, Skills and identity, Assets: the same steps when adding and editing.
  function lastStep() { return STEPS - 1; }
  var state = null;

  function freshState(agent) {
    return {
      step: 0,
      editId: agent ? agent.id : null,
      agent: agent,
      form: Doc.formFromAgent(agent),
      docs: [],
      docsToRemove: [],
      existingDocs: agent ? ((rowOf(agent.id) || {}).existingDocs || []) : [],
      handleTouched: Boolean(agent),
      // The listing values the Agent Card gives (to fill and tag the fields): from the card
      // chosen now, else what the stored card supplied.
      cardValues: agent ? Doc.formFromAgent(agent).fromCard : null,
      assetsMode: 'docs',
      contentZip: null,
    };
  }

  // The card is in force when one is uploaded now or stored and the A2A interface stays.
  function cardInForce() {
    return checked('ag-use-a2a') && (Boolean(fileOf('ag-a2a-file')) || state.form.hasFile.A2A);
  }

  function openWizard(agent) {
    state = freshState(agent);
    var f = state.form;
    el('ag-wz-title').textContent = agent ? 'Edit Agent' : 'Add Agent';
    setVal('ag-name', f.displayName);
    setVal('ag-version', f.version);
    setVal('ag-desc', f.description);
    setVal('ag-handle', f.handle);
    el('ag-handle').disabled = Boolean(agent);
    setVal('ag-agent-id', f.agentId);
    resetContentUpload();
    setAssetsMode('docs');
    if (tagChips) tagChips.set(f.tags);
    // A new agent lands in the default view, as a new API does.
    setPicker('ag-labels', agent ? f.labels : ['default']);
    renderModels(f.models);
    planChips = f.subscriptionPlans.slice();
    renderPlanChips();
    setVal('ag-tech-owner', f.owners.technicalOwner);
    setVal('ag-tech-email', f.owners.technicalOwnerEmail);
    setVal('ag-biz-owner', f.owners.businessOwner);
    setVal('ag-biz-email', f.owners.businessOwnerEmail);
    setVisibility(f.agentVisibility);

    el('ag-use-a2a').checked = Boolean(f.a2a);
    setVal('ag-a2a-prod', f.a2a && f.a2a.productionUrl);
    setVal('ag-a2a-sandbox', f.a2a && f.a2a.sandboxUrl);
    setVal('ag-a2a-card-url', f.a2a && f.a2a.cardUrl);
    el('ag-use-rest').checked = Boolean(f.rest);
    setVal('ag-rest-prod', f.rest && f.rest.productionUrl);
    setVal('ag-rest-sandbox', f.rest && f.rest.sandboxUrl);
    setVal('ag-rest-protocol', f.rest && f.rest.protocol);
    el('ag-use-event').checked = f.event;
    el('ag-use-local').checked = f.local;
    clearFile('ag-docs-input');
    FILE_KINDS.forEach(function (kind) { setFile(kind, null); });

    renderSkills(f.skills);
    renderDocs();
    syncInterfaces();
    // Optional sections start folded; when editing, those that hold something start open.
    openFold('ag-fold-labels', agent && (f.labels.length || f.tags.length));
    openFold('ag-fold-owners', agent && Object.keys(f.owners).some(function (k) { return f.owners[k]; }));
    openFold('ag-fold-plans', f.subscriptionPlans.length);
    showErrors('ag-wz-errors', []);
    clearFieldErrors();
    show('cfg-agents-list', false);
    show('cfg-agents-wizard', true);
    goTo(0);
  }

  function closeWizard() {
    state = null;
    show('cfg-agents-wizard', false);
    show('cfg-agents-list', true);
  }

  function setVisibility(value) {
    el('ag-vis-visible').classList.toggle('active', value !== 'HIDDEN');
    el('ag-vis-hidden').classList.toggle('active', value === 'HIDDEN');
  }
  el('ag-vis-visible').addEventListener('click', function () { setVisibility('VISIBLE'); });
  el('ag-vis-hidden').addEventListener('click', function () { setVisibility('HIDDEN'); });

  // Handle follows the name until edited by hand (create only).
  el('ag-name').addEventListener('input', function () {
    if (state && !state.handleTouched) setVal('ag-handle', Doc.skillId(val('ag-name')));
  });
  el('ag-handle').addEventListener('input', function () { if (state) state.handleTouched = true; });

  function openFold(id, on) { var e = el(id); if (e) e.open = Boolean(on); }

  // Interfaces: each section opens when ticked. Plans only for a called agent; skills
  // typed in only without A2A (with it, the card's are listed); the listing is required
  // only without A2A, since the card supplies it.
  function syncInterfaces() {
    panel.querySelectorAll('.ag-iface').forEach(function (section) {
      var box = section.querySelector('input[type="checkbox"]');
      section.querySelector('.ag-iface-body').style.display = box.checked ? '' : 'none';
      section.classList.toggle('is-on', box.checked);
    });
    var card = cardInForce();
    var a2a = checked('ag-use-a2a');
    show('ag-fold-plans', a2a || checked('ag-use-rest'));
    panel.querySelectorAll('.ag-listing-required').forEach(function (n) { n.style.display = a2a ? 'none' : ''; });
    show('ag-sec-skills', !a2a);
    show('ag-sec-card-skills', card);
    if (card) renderCardSkills();
    updateCardTags();
  }

  // "From the Agent Card" beside a listing field that still holds the card's value.
  var LISTING_FIELDS = { displayName: 'ag-name', version: 'ag-version', description: 'ag-desc' };
  function updateCardTags() {
    var values = cardInForce() && state.cardValues ? state.cardValues : {};
    var any = false;
    Object.keys(LISTING_FIELDS).forEach(function (key) {
      var on = Boolean(values[key]) && val(LISTING_FIELDS[key]) === String(values[key]).trim();
      any = any || on;
      var tag = panel.querySelector('[data-ag-from-card="' + key + '"]');
      if (tag) tag.style.display = on ? '' : 'none';
    });
    show('ag-card-note', any);
  }
  Object.keys(LISTING_FIELDS).forEach(function (key) { el(LISTING_FIELDS[key]).addEventListener('input', updateCardTags); });

  /*
   * A card chosen now fills the name, version and description, read in the browser: an
   * empty field, or one still holding the last card's value, takes the card's. The values
   * become `fromCard`, so those left unchanged stay out of the document and keep following
   * the card. A card that isn't JSON fills nothing; the server says why on save.
   */
  async function readCardValues() {
    var file = fileOf('ag-a2a-file');
    if (!file) return;
    var card;
    try { card = JSON.parse(await file.text()); } catch (e) { card = null; }
    if (!card || typeof card !== 'object') return;
    var before = state.cardValues || {};
    var next = {
      displayName: typeof card.name === 'string' ? card.name.trim() : null,
      version: typeof card.version === 'string' ? card.version.trim() : null,
      description: typeof card.description === 'string' ? card.description.trim() : null,
    };
    Object.keys(LISTING_FIELDS).forEach(function (key) {
      var id = LISTING_FIELDS[key];
      var current = val(id);
      if (next[key] && (!current || current === before[key])) setVal(id, next[key]);
      // The new card lacks a value the last one gave: empty the field rather than keep the
      // old card's value as if the admin had typed it.
      else if (!next[key] && before[key] && current === String(before[key]).trim()) setVal(id, '');
    });
    if (!state.handleTouched && !state.editId && val('ag-name')) setVal('ag-handle', Doc.skillId(val('ag-name')));
    state.cardValues = next;
    state.form.fromCard = next;
    updateCardTags();
  }

  /*
   * The chosen card was removed: fields still holding its values go back to what they
   * were when the wizard opened, and the stored card (if any) is the one in force again.
   */
  function forgetChosenCard() {
    var opened = Doc.formFromAgent(state.agent);
    var before = state.cardValues || {};
    Object.keys(LISTING_FIELDS).forEach(function (key) {
      var id = LISTING_FIELDS[key];
      if (before[key] && val(id) === String(before[key]).trim()) setVal(id, opened[key] || '');
    });
    state.cardValues = state.agent ? opened.fromCard : null;
    state.form.fromCard = state.cardValues;
    updateCardTags();
  }

  ['ag-use-a2a', 'ag-use-rest', 'ag-use-event', 'ag-use-local'].forEach(function (id) {
    el(id).addEventListener('change', syncInterfaces);
  });

  // ── Definition files ─────────────────────────────────────────────────────
  // Each kind has a drop zone, a chip for a newly chosen file (with Remove), and an
  // "on file" note for a stored one, as the API wizard's spec upload. A stored file
  // is replaced by attaching a new one; it is removed with its interface.
  var FILE_KINDS = ['a2a', 'rest', 'event', 'local'];
  var FILE_TYPE = { a2a: 'A2A', rest: 'REST', event: 'EVENT', local: 'LOCAL' };
  var FILE_EXT = { a2a: /\.json$/i, rest: /\.(ya?ml|json)$/i, event: /\.(ya?ml|json)$/i, local: /\.(md|markdown)$/i };

  // Show a kind's file: the chip when one is chosen now, else the note when one is stored.
  function setFile(kind, file) {
    var input = el('ag-' + kind + '-file');
    if (!file) input.value = '';
    el('ag-' + kind + '-name').textContent = file ? file.name : '';
    el('ag-' + kind + '-chip').classList.toggle('visible', Boolean(file));
    show('ag-' + kind + '-onfile', !file && Boolean(state && state.form.hasFile[FILE_TYPE[kind]]));
  }
  function acceptFile(kind, file) {
    if (!file) return false;
    if (!FILE_EXT[kind].test(file.name)) {
      alertMsg('"' + file.name + '" is not a file this field takes. Use ' + el('ag-' + kind + '-file').accept + '.', 'error');
      return false;
    }
    return true;
  }
  FILE_KINDS.forEach(function (kind) {
    var input = el('ag-' + kind + '-file');
    var wrap = panel.querySelector('[data-ag-file="' + kind + '"]');
    var zone = wrap.querySelector('.ag-file-zone');
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      setFile(kind, acceptFile(kind, file) ? file : null);
      syncInterfaces();
      if (kind === 'a2a') readCardValues();
    });
    wrap.querySelector('.ag-file-remove').addEventListener('click', function () {
      setFile(kind, null);
      syncInterfaces();
      if (kind === 'a2a') forgetChosenCard();
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('cfg-upload-compact--active');
    });
    zone.addEventListener('dragleave', function (e) {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('cfg-upload-compact--active');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('cfg-upload-compact--active');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length || !acceptFile(kind, files[0])) return;
      var one = new DataTransfer();
      one.items.add(files[0]);
      input.files = one.files;
      setFile(kind, files[0]);
      syncInterfaces();
      if (kind === 'a2a') readCardValues();
    });
  });

  // ── Skills from the Agent Card (read-only) ───────────────────────────────
  // From the card chosen now (read in the browser), else from the stored agent.
  async function cardSkills() {
    var file = fileOf('ag-a2a-file');
    if (file) {
      try {
        var card = JSON.parse(await file.text());
        return Array.isArray(card && card.skills) ? card.skills : [];
      } catch (e) {
        return null;
      }
    }
    if (!state || !state.agent || !state.form.hasFile.A2A) return [];
    // The stored card, read once per wizard run: the agent's own skills are YAML skills only.
    if (!state.storedCardSkills) {
      state.storedCardSkills = fetch(url(agentPath(state.agent.id) + '/assets?type=AGENT_CARD'))
        .then(function (res) {
          if (!res.ok) throw new Error(res.statusText);
          return res.json();
        })
        .then(function (card) { return Array.isArray(card && card.skills) ? card.skills : []; })
        // Not read (session expired, network): say so, not "no skills".
        .catch(function () { return UNREAD; });
    }
    return state.storedCardSkills;
  }
  var UNREAD = 'unread';
  async function renderCardSkills() {
    var skills = await cardSkills();
    var list = el('ag-card-skills-list');
    list.innerHTML = '';
    if (skills === UNREAD) {
      el('ag-card-skills-count').textContent = '';
      var unread = document.createElement('li');
      unread.className = 'ag-card-skills-empty';
      unread.textContent = 'The stored Agent Card could not be read. Reload the page to see its skills.';
      list.appendChild(unread);
      return;
    }
    el('ag-card-skills-count').textContent = skills && skills.length ? String(skills.length) : '';
    if (!skills || !skills.length) {
      var empty = document.createElement('li');
      empty.className = 'ag-card-skills-empty';
      empty.textContent = skills ? 'The Agent Card lists no skills.' : 'The Agent Card could not be read as JSON. The portal checks it when you save.';
      list.appendChild(empty);
      return;
    }
    // Values go in as text, never as markup.
    skills.forEach(function (skill) {
      var li = document.createElement('li');
      li.className = 'ag-card-skill';
      var name = document.createElement('p');
      name.className = 'ag-card-skill-name';
      name.textContent = (skill && (skill.name || skill.id)) || 'Unnamed skill';
      li.appendChild(name);
      if (skill && skill.description) {
        var desc = document.createElement('p');
        desc.className = 'ag-card-skill-desc';
        desc.textContent = skill.description;
        li.appendChild(desc);
      }
      var tags = Array.isArray(skill && skill.tags) ? skill.tags.filter(Boolean) : [];
      if (tags.length) {
        var row = document.createElement('div');
        row.className = 'ag-card-skill-tags';
        tags.forEach(function (t) {
          var chip = document.createElement('span');
          chip.className = 'ag-card-skill-tag';
          chip.textContent = String(t);
          row.appendChild(chip);
        });
        li.appendChild(row);
      }
      list.appendChild(li);
    });
  }

  // ── Skills editor ────────────────────────────────────────────────────────
  function skillRow(skill, index) {
    var wrap = document.createElement('div');
    wrap.className = 'cfg-form-section ag-skill';
    wrap.innerHTML =
      '<div class="ag-skill-head"><p class="cfg-form-section-title">Skill ' + (index + 1) + '</p>'
      + '<button type="button" class="cfg-btn-ghost cfg-btn-sm ag-skill-remove">Remove</button></div>'
      + '<div class="cfg-form-grid">'
      + '<div class="cfg-form-group"><label>Name <span class="required">*</span></label><input type="text" class="cfg-form-input ag-skill-name"></div>'
      + '<div class="cfg-form-group"><label>ID <span class="required">*</span></label><input type="text" class="cfg-form-input cfg-form-input--mono ag-skill-id"></div>'
      + '<div class="cfg-form-group cfg-form-group-full"><label>Description <span class="required">*</span></label><textarea rows="2" class="cfg-form-input ag-skill-desc"></textarea></div>'
      + '<div class="cfg-form-group cfg-form-group-full"><label>Example prompts</label><textarea rows="2" class="cfg-form-input ag-skill-examples"></textarea>'
      + '<p class="cfg-field-hint">One per line. Shown on the agent page and used by AI tools.</p></div>'
      + '</div>';
    // Values go in through .value, never as markup.
    wrap.querySelector('.ag-skill-name').value = skill.name || '';
    wrap.querySelector('.ag-skill-id').value = skill.id || '';
    wrap.querySelector('.ag-skill-desc').value = skill.description || '';
    wrap.querySelector('.ag-skill-examples').value = (skill.examples || []).join('\n');
    wrap.dataset.idTouched = skill.id ? 'true' : 'false';
    wrap.querySelector('.ag-skill-name').addEventListener('input', function (e) {
      if (wrap.dataset.idTouched !== 'true') wrap.querySelector('.ag-skill-id').value = Doc.skillId(e.target.value);
    });
    wrap.querySelector('.ag-skill-id').addEventListener('input', function () { wrap.dataset.idTouched = 'true'; });
    wrap.querySelector('.ag-skill-remove').addEventListener('click', function () {
      renderSkills(readSkills().filter(function (_, i) { return i !== index; }));
    });
    return wrap;
  }
  function renderSkills(skills) {
    var root = el('ag-skills');
    root.innerHTML = '';
    skills.forEach(function (s, i) { root.appendChild(skillRow(s, i)); });
    show('ag-skills-empty', !skills.length);
  }
  function readSkills() {
    return Array.prototype.slice.call(el('ag-skills').querySelectorAll('.ag-skill')).map(function (row) {
      return {
        name: row.querySelector('.ag-skill-name').value,
        id: row.querySelector('.ag-skill-id').value,
        description: row.querySelector('.ag-skill-desc').value,
        examples: row.querySelector('.ag-skill-examples').value.split('\n'),
      };
    });
  }
  el('ag-add-skill').addEventListener('click', function () {
    renderSkills(readSkills().concat([{ name: '', id: '', description: '', examples: [] }]));
  });

  // ── Models (spec.models: provider and name) ───────────────────────────────
  function modelRow(model, index) {
    var row = document.createElement('div');
    row.className = 'ag-model';
    row.innerHTML =
      '<input type="text" class="cfg-form-input ag-model-provider" placeholder="Provider, e.g. Anthropic" aria-label="Model provider">'
      + '<input type="text" class="cfg-form-input cfg-form-input--mono ag-model-name" placeholder="Model, e.g. claude-sonnet-4-5" aria-label="Model name">'
      + '<button type="button" class="cfg-action-btn ag-model-remove" aria-label="Remove model"><i class="bi bi-x-lg"></i></button>';
    // Values go in through .value, never as markup.
    row.querySelector('.ag-model-provider').value = model.provider || '';
    row.querySelector('.ag-model-name').value = model.name || '';
    row.querySelector('.ag-model-remove').addEventListener('click', function () {
      renderModels(readModels().filter(function (_, i) { return i !== index; }));
    });
    return row;
  }
  function renderModels(models) {
    var root = el('ag-models');
    root.innerHTML = '';
    // Always one row to type into; an empty row is dropped on save (agent-document.js).
    (models.length ? models : [{ provider: '', name: '' }]).forEach(function (m, i) { root.appendChild(modelRow(m, i)); });
  }
  function readModels() {
    return Array.prototype.slice.call(el('ag-models').querySelectorAll('.ag-model')).map(function (row) {
      return { provider: row.querySelector('.ag-model-provider').value, name: row.querySelector('.ag-model-name').value };
    });
  }
  el('ag-add-model').addEventListener('click', function () {
    renderModels(readModels().concat([{ provider: '', name: '' }]));
    var rows = el('ag-models').querySelectorAll('.ag-model-provider');
    if (rows.length) rows[rows.length - 1].focus();
  });

  // ── Documentation ────────────────────────────────────────────────────────
  function docItem(name, onRemove) {
    var item = document.createElement('div');
    item.className = 'cfg-docs-item';
    var label = document.createElement('span');
    label.textContent = name;
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'cfg-action-btn';
    remove.setAttribute('aria-label', 'Remove ' + name);
    remove.innerHTML = '<i class="bi bi-x-lg"></i>';
    remove.addEventListener('click', onRemove);
    item.appendChild(label);
    item.appendChild(remove);
    return item;
  }
  // Stored documents are { name, type }, as for the API wizard; a removal names both, so only
  // that category's copy goes.
  function isRemoved(doc) {
    return state.docsToRemove.some(function (r) { return r.fileName === doc.name && r.type === doc.type; });
  }
  function renderDocs() {
    var keptExisting = state.existingDocs.filter(function (doc) { return !isRemoved(doc); });
    show('ag-docs-empty', !keptExisting.length && !state.docs.length);
    var existing = el('ag-existing-docs');
    existing.innerHTML = '';
    keptExisting.forEach(function (doc) {
      existing.appendChild(docItem(doc.name, function () {
        state.docsToRemove.push({ fileName: doc.name, type: doc.type });
        renderDocs();
      }));
    });
    var added = el('ag-docs-list');
    added.innerHTML = '';
    state.docs.forEach(function (file, i) {
      added.appendChild(docItem(file.name, function () { state.docs.splice(i, 1); renderDocs(); }));
    });
  }
  // Markdown only, as the API wizard's docs step; others are skipped with a message.
  function addDocs(files) {
    var rejected = [];
    Array.prototype.slice.call(files || []).forEach(function (f) {
      if (/\.(md|markdown)$/i.test(f.name)) state.docs.push(f); else rejected.push(f.name);
    });
    renderDocs();
    if (rejected.length) alertMsg('Only .md files are accepted. Skipped: ' + rejected.join(', '), 'error');
  }
  el('ag-docs-input').addEventListener('change', function (e) {
    addDocs(e.target.files);
    e.target.value = '';
  });
  (function () {
    var zone = el('ag-docs-zone');
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('cfg-upload-compact--active'); });
    zone.addEventListener('dragleave', function (e) {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('cfg-upload-compact--active');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('cfg-upload-compact--active');
      addDocs(e.dataTransfer && e.dataTransfer.files);
    });
  }());

  // ── Steps ────────────────────────────────────────────────────────────────
  function goTo(step) {
    state.step = step;
    // A new step starts at its top, not wherever the last one was scrolled to.
    var wizard = el('cfg-agents-wizard');
    if (wizard && wizard.scrollIntoView) wizard.scrollIntoView({ block: 'start' });
    for (var i = 0; i < STEPS; i += 1) {
      show('ag-wstep-' + i, i === step);
      var marker = panel.querySelector('[data-ag-step="' + i + '"]');
      marker.classList.remove('cfg-step--active', 'cfg-step--done');
      var circle = marker.querySelector('.cfg-step-circle');
      if (i < step) { marker.classList.add('cfg-step--done'); circle.innerHTML = '<i class="bi bi-check" style="font-size:.75rem;line-height:1;"></i>'; }
      else { if (i === step) marker.classList.add('cfg-step--active'); circle.textContent = String(i + 1); }
    }
    show('ag-wz-prev', step > 0);
    el('ag-wz-next').textContent = step === lastStep() ? (state.editId ? 'Save changes' : 'Save agent') : 'Next';
    showErrors('ag-wz-errors', []);
  }

  // The checks the form can make before sending; the server checks everything else.
  // Each is { target, message, after }: shown under its field, as the API wizard does.
  function stepProblems(step) {
    var problems = [];
    var file = function (kind) { return panel.querySelector('[data-ag-file="' + kind + '"]'); };
    if (step === 0) {
      var any = ['ag-use-a2a', 'ag-use-rest', 'ag-use-event', 'ag-use-local'].some(checked);
      if (!any) {
        problems.push({ target: el('ag-wstep-0').querySelector('.cfg-wstep-desc'), after: true,
          message: 'Pick at least one way to use the agent.' });
      }
      if (checked('ag-use-a2a') && !val('ag-a2a-prod')) {
        problems.push({ target: el('ag-a2a-prod'), message: 'Give the A2A interface a production URL.' });
      }
      if (checked('ag-use-a2a') && !fileOf('ag-a2a-file') && !state.form.hasFile.A2A) {
        problems.push({ target: file('a2a'), message: 'Upload the Agent Card for A2A.' });
      }
      if (checked('ag-use-rest') && !val('ag-rest-prod')) {
        problems.push({ target: el('ag-rest-prod'), message: 'Give the REST interface a production URL.' });
      }
      if (checked('ag-use-rest') && !fileOf('ag-rest-file') && !state.form.hasFile.REST) {
        problems.push({ target: file('rest'), message: 'Upload the OpenAPI document for REST.' });
      }
      if (checked('ag-use-event') && !fileOf('ag-event-file') && !state.form.hasFile.EVENT) {
        problems.push({ target: file('event'), message: 'Upload the AsyncAPI document for Events.' });
      }
      if (checked('ag-use-local') && !fileOf('ag-local-file') && !state.form.hasFile.LOCAL) {
        problems.push({ target: file('local'), message: 'Upload the setup guide for running it yourself (Markdown).' });
      }
      // Plans are only for an agent that is called: say so rather than drop them silently.
      if (any && !checked('ag-use-a2a') && !checked('ag-use-rest') && planChips.length) {
        problems.push({ target: el('ag-wstep-0').querySelector('.cfg-wstep-desc'), after: true,
          message: 'This agent has subscription plans, which need an A2A or REST interface. To drop them, keep A2A or REST '
            + 'ticked, remove the plans in Details → Subscription plans, then untick it.' });
      }
    }
    if (step === 1) {
      if (!val('ag-handle')) problems.push({ target: el('ag-handle'), message: 'Give the agent a handle.' });
      // With A2A the Agent Card supplies these; without it they are needed.
      if (!checked('ag-use-a2a')) {
        [['ag-name', 'Give the agent a name.'], ['ag-version', 'Give the agent a version.'],
          ['ag-desc', 'Give the agent a description.']].forEach(function (entry) {
          if (!val(entry[0])) problems.push({ target: el(entry[0]), message: entry[1] });
        });
      }
    }
    return problems;
  }

  // Client-side problems under their fields; the summary box stays for server messages.
  function showProblems(problems) {
    clearFieldErrors();
    showErrors('ag-wz-errors', []);
    problems.forEach(function (p) { fieldError(p.target, p.message, p.after); });
    var first = problems[0] && problems[0].target;
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
  }

  function readForm() {
    var f = state.form;
    return {
      handle: val('ag-handle'),
      displayName: val('ag-name'), version: val('ag-version'), description: val('ag-desc'),
      models: readModels(), agentId: val('ag-agent-id'),
      status: f.status,
      agentVisibility: el('ag-vis-hidden').classList.contains('active') ? 'HIDDEN' : 'VISIBLE',
      tags: tagChips ? tagChips.get() : [],
      labels: pickerValues('ag-labels'),
      subscriptionPlans: planChips.slice(),
      owners: { technicalOwner: val('ag-tech-owner'), technicalOwnerEmail: val('ag-tech-email'),
        businessOwner: val('ag-biz-owner'), businessOwnerEmail: val('ag-biz-email') },
      a2a: checked('ag-use-a2a') ? { productionUrl: val('ag-a2a-prod'), sandboxUrl: val('ag-a2a-sandbox'),
        cardUrl: val('ag-a2a-card-url') } : null,
      rest: checked('ag-use-rest') ? { productionUrl: val('ag-rest-prod'), sandboxUrl: val('ag-rest-sandbox'),
        protocol: val('ag-rest-protocol') } : null,
      event: checked('ag-use-event'),
      local: checked('ag-use-local'),
      skills: readSkills(),
      fromCard: f.fromCard,
    };
  }

  async function save() {
    var form = readForm();
    var inForce = {
      A2A: Boolean(form.a2a) && (Boolean(fileOf('ag-a2a-file')) || state.form.hasFile.A2A),
      REST: Boolean(form.rest) && (Boolean(fileOf('ag-rest-file')) || state.form.hasFile.REST),
    };
    var doc = Doc.applyForm(state.agent ? state.agent.document : null, form, inForce);
    var fd = new FormData();
    fd.append('metadata', JSON.stringify(doc));
    // A file goes only with its part; a part left unticked loses its stored file.
    [['ag-a2a-file', form.a2a, 'A2A'], ['ag-rest-file', form.rest, 'REST'], ['ag-event-file', form.event, 'EVENT'],
      ['ag-local-file', form.local, 'LOCAL']].forEach(function (entry) {
      var file = fileOf(entry[0]);
      if (file && entry[1]) fd.append(Doc.FILE_FIELDS[entry[2]], file);
    });
    // Documents, or a content ZIP uploaded after the save: one or the other, as in Add API.
    var importing = state.assetsMode === 'import' && Boolean(state.contentZip);
    // Editing: a ZIP replaces all content, so ask first, as the API wizard does.
    if (importing && state.editId && !(await confirmReplaceContent())) return;
    if (state.assetsMode === 'docs') {
      state.docs.forEach(function (file) { fd.append('docs', file); });
      if (state.editId && state.docsToRemove.length) fd.append('docsToRemove', JSON.stringify(state.docsToRemove));
    }

    var next = el('ag-wz-next');
    next.disabled = true;
    clearFieldErrors();
    var editId = state.editId;
    var contentZip = state.contentZip;
    // The page stays locked until the save ends, so the wizard can't change (or close) under
    // it, as in the API wizard.
    var page = document.querySelector('.cfg-layout');
    if (page) page.inert = true;
    try {
      var res = await fetch(url(editId ? agentPath(editId) : '/agents'), {
        method: editId ? 'PUT' : 'POST', headers: csrf(), body: fd,
      });
      if (res.ok) {
        var saved = editId ? 'Agent updated' : 'Agent created';
        if (importing) {
          var contentError = await importContent(editId || doc.metadata.name, contentZip);
          if (contentError) {
            // As the API wizard: the agent is saved, the wizard stays open (now editing it)
            // with the rejected ZIP marked, so another can be chosen.
            await reopenAfterContentError(editId || doc.metadata.name, saved, contentError);
            return;
          }
        }
        await alertMsg(saved + ' successfully.', 'success');
        window.location.reload();
        return;
      }
      var messages = Doc.errorMessages(await res.json().catch(function () { return {}; }), res.statusText);
      var unplaced = placeErrors(messages, doc);
      showErrors('ag-wz-errors', unplaced);
      alertMsg('Failed: ' + (messages.length === 1 ? messages[0] : messages.length + ' problems. See the form.'), 'error');
    } catch (e) {
      showErrors('ag-wz-errors', [e.message]);
      alertMsg('Error: ' + e.message, 'error');
    } finally {
      if (page) page.inert = false;
      next.disabled = false;
    }
  }

  async function reopenAfterContentError(handle, saved, contentError) {
    var step = state.step;
    try {
      openWizard(await getAgent(handle));
    } catch (e) {
      await alertMsg(saved + ', but the content was not uploaded: ' + contentError, 'error');
      window.location.reload();
      return;
    }
    goTo(step);
    setAssetsMode('import');
    el('ag-content-error').textContent = 'Not uploaded: ' + contentError;
    show('ag-content-error', true);
    alertMsg(saved + ', but the content was not uploaded. Choose another ZIP and save again.', 'error');
  }

  // "Replace all content?" (the API wizard's dialog in cfg-modals.hbs): resolves true to go on.
  function confirmReplaceContent() {
    var modal = el('cfg-replace-content-modal');
    if (!modal) return Promise.resolve(true);
    var confirmBtn = el('cfg-replace-content-confirm');
    var cancelBtn = el('cfg-replace-content-cancel');
    var opener = document.activeElement;
    el('cfg-replace-content-api').textContent = val('ag-name') || state.editId;
    el('cfg-replace-content-zip').textContent = state.contentZip.name;
    return new Promise(function (resolve) {
      function done(ok) {
        modal.style.display = 'none';
        confirmBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onOverlay);
        if (opener) opener.focus();
        resolve(ok);
      }
      function onOk() { done(true); }
      function onCancel() { done(false); }
      function onOverlay(e) { if (e.target === modal) done(false); }
      confirmBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      modal.addEventListener('click', onOverlay);
      modal.style.display = 'flex';
      confirmBtn.focus();
    });
  }

  el('ag-wz-next').addEventListener('click', function () {
    var problems = stepProblems(state.step);
    if (problems.length) { showProblems(problems); return; }
    clearFieldErrors();
    if (state.step < lastStep()) goTo(state.step + 1); else save();
  });
  el('ag-wz-prev').addEventListener('click', function () { if (state.step > 0) goTo(state.step - 1); });
  el('ag-wz-cancel').addEventListener('click', closeWizard);
  el('ag-wz-back-link').addEventListener('click', function (e) { e.preventDefault(); closeWizard(); });
  el('ag-add-btn').addEventListener('click', function () { openWizard(null); });

  // ── Assets: documents, or a content ZIP instead (as Add API) ─────────────
  // The ZIP goes to PUT /agents/{id}/assets after the agent is saved.
  function setAssetsMode(mode) {
    if (state) state.assetsMode = mode;
    el('ag-assets-panel-docs').hidden = mode !== 'docs';
    el('ag-assets-panel-import').hidden = mode !== 'import';
  }
  el('ag-assets-to-import').addEventListener('click', function () {
    state.docs = [];
    state.docsToRemove = [];
    renderDocs();
    setAssetsMode('import');
  });
  el('ag-assets-to-docs').addEventListener('click', function () {
    resetContentUpload();
    setAssetsMode('docs');
  });
  function resetContentUpload() {
    if (state) state.contentZip = null;
    clearFile('ag-content-input');
    el('ag-content-chip').classList.remove('visible');
    show('ag-content-error', false);
  }
  function pickContentZip(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      el('ag-content-error').textContent = 'Unsupported file type. Accepted: .zip';
      show('ag-content-error', true);
      return;
    }
    state.contentZip = file;
    el('ag-content-name').textContent = file.name;
    el('ag-content-chip').classList.add('visible');
    show('ag-content-error', false);
  }
  el('ag-content-input').addEventListener('change', function (e) { pickContentZip(e.target.files && e.target.files[0]); });
  el('ag-content-remove').addEventListener('click', resetContentUpload);
  (function () {
    var zone = el('ag-content-zone');
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('cfg-upload-zone--active'); });
    zone.addEventListener('dragleave', function (e) {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('cfg-upload-zone--active');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('cfg-upload-zone--active');
      pickContentZip(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }());
  // '' when the content was taken, else every reason the portal gave.
  async function importContent(handle, file) {
    try {
      var fd = new FormData();
      fd.append('content', file);
      var res = await fetch(url(agentPath(handle) + '/assets'), { method: 'PUT', headers: csrf(), body: fd });
      if (res.ok) return '';
      return Doc.errorMessages(await res.json().catch(function () { return {}; }), res.statusText).join(' ');
    } catch (e) {
      return e.message;
    }
  }

  // ── Row actions ──────────────────────────────────────────────────────────
  async function setStatus(id, name, status) {
    try {
      var doc = Doc.withStatus(await getAgent(id), status);
      var fd = new FormData();
      fd.append('metadata', JSON.stringify(doc));
      var res = await fetch(url(agentPath(id)), { method: 'PUT', headers: csrf(), body: fd });
      if (!res.ok) {
        await alertMsg('Failed: ' + Doc.errorMessages(await res.json().catch(function () { return {}; }), res.statusText).join(' '), 'error');
        return;
      }
      await alertMsg(name + (status === 'PUBLISHED' ? ' published.' : ' deprecated.'), 'success');
      window.location.reload();
    } catch (e) {
      await alertMsg('Error: ' + e.message, 'error');
    }
  }

  var pendingDeprecate = null;
  el('ag-deprecate-cancel').addEventListener('click', function () { showModal('ag-deprecate-modal', false); });
  // Clicking the dimmed background closes a dialog, as it does for APIs.
  ['ag-deprecate-modal', 'ag-delete-modal'].forEach(function (id) {
    el(id).addEventListener('click', function (e) {
      if (e.target === this) { showModal(id, false); pendingDeprecate = null; pendingDelete = null; }
    });
  });
  el('ag-deprecate-confirm').addEventListener('click', function () {
    if (!pendingDeprecate) return;
    showModal('ag-deprecate-modal', false);
    setStatus(pendingDeprecate.id, pendingDeprecate.name, 'DEPRECATED');
    pendingDeprecate = null;
  });

  // One agent ({id, name}) or several (the bulk selection).
  var pendingDelete = null;
  el('ag-delete-cancel').addEventListener('click', function () { showModal('ag-delete-modal', false); });

  async function deleteOne(item) {
    try {
      var res = await fetch(url(agentPath(item.id)), { method: 'DELETE', headers: csrf() });
      if (res.ok) return null;
      return Doc.errorMessages(await res.json().catch(function () { return {}; }), res.statusText).join(' ');
    } catch (e) {
      return e.message;
    }
  }
  el('ag-delete-confirm').addEventListener('click', async function () {
    if (!pendingDelete) return;
    var items = Array.isArray(pendingDelete) ? pendingDelete : [pendingDelete];
    var bulk = Array.isArray(pendingDelete);
    pendingDelete = null;
    showModal('ag-delete-modal', false);
    var failures = [];
    await Promise.all(items.map(async function (item) {
      var reason = await deleteOne(item);
      if (reason) failures.push({ name: item.name, reason: reason });
    }));
    if (!failures.length) {
      await alertMsg(bulk ? 'Deleted.' : 'Agent deleted.', 'success');
    } else if (!bulk) {
      await alertMsg('Delete failed: ' + failures[0].reason, 'error');
      return;
    } else {
      // An agent with subscriptions or active keys can't be deleted: say which, and why.
      await alertMsg(failures.length + ' of ' + items.length + ' agents could not be deleted: '
        + failures.map(function (f) { return f.name + ' (' + f.reason + ')'; }).join('; '), 'error');
    }
    window.location.reload();
  });

  // ── Bulk selection (as the APIs and MCP tables) ──────────────────────────
  (function () {
    var tbody = el('cfg-agents-tbody');
    var selectAll = el('ag-select-all');
    if (!tbody || !selectAll) return;
    function selected() { return Array.prototype.slice.call(tbody.querySelectorAll('.ag-row-check:checked')); }
    function sync() {
      var checks = selected();
      var all = tbody.querySelectorAll('.ag-row-check');
      el('ag-bulk-bar').style.display = checks.length ? 'flex' : 'none';
      el('ag-bulk-bar-count').textContent = checks.length + ' agent' + (checks.length === 1 ? '' : 's') + ' selected';
      selectAll.checked = all.length > 0 && checks.length === all.length;
      selectAll.indeterminate = checks.length > 0 && checks.length < all.length;
    }
    selectAll.addEventListener('change', function () {
      var on = selectAll.checked;
      tbody.querySelectorAll('.ag-row-check').forEach(function (c) { c.checked = on; });
      sync();
    });
    tbody.addEventListener('change', function (e) { if (e.target.classList.contains('ag-row-check')) sync(); });
    el('ag-bulk-delete-btn').addEventListener('click', function () {
      var checks = selected();
      if (!checks.length) return;
      pendingDelete = checks.map(function (c) { return { id: c.dataset.id, name: c.dataset.name }; });
      el('ag-delete-name').textContent = checks.length + ' selected agent' + (checks.length === 1 ? '' : 's');
      showModal('ag-delete-modal', true);
    });
  }());

  // ── Type badges: one per kind, as APIs show their type ───────────────────
  var KIND_CLASS = { 'A2A': 'a2a', 'REST': 'rest', 'Events': 'event', 'Run it yourself': 'local' };
  panel.querySelectorAll('td.ag-kinds').forEach(function (cell) {
    var kinds = String(cell.dataset.kinds || '').split(' + ').filter(Boolean);
    cell.textContent = '';
    var row = document.createElement('div');
    row.className = 'ag-kind-badges';
    kinds.forEach(function (kind) {
      var badge = document.createElement('span');
      badge.className = 'cfg-type-badge ag-type-badge ag-type-badge--' + (KIND_CLASS[kind] || 'other');
      badge.textContent = kind;
      row.appendChild(badge);
    });
    cell.appendChild(row);
  });

  panel.addEventListener('click', async function (e) {
    var button = e.target.closest('.ag-edit, .ag-status, .ag-delete');
    if (!button) return;
    document.querySelectorAll('.cfg-dropdown').forEach(function (d) { d.style.display = 'none'; });
    var id = button.dataset.id;
    if (button.classList.contains('ag-edit')) {
      try { openWizard(await getAgent(id)); } catch (err) { await alertMsg('Error: ' + err.message, 'error'); }
    } else if (button.classList.contains('ag-status')) {
      // Deprecating is confirmed, as it is for APIs; publishing again is not.
      if (button.dataset.status === 'DEPRECATED') {
        pendingDeprecate = { id: id, name: button.dataset.name };
        el('ag-deprecate-name').textContent = button.dataset.name;
        showModal('ag-deprecate-modal', true);
      } else {
        setStatus(id, button.dataset.name, button.dataset.status);
      }
    } else if (button.classList.contains('ag-delete')) {
      pendingDelete = { id: id, name: button.dataset.name };
      el('ag-delete-name').textContent = button.dataset.name;
      showModal('ag-delete-modal', true);
    }
  });
})();
