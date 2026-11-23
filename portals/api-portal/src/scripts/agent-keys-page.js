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

// "Agent Keys" page. The list is rendered server-side; this script drives the
// Generate, view, Get token, Rotate secret and Delete flows, the copy buttons and the
// row menus. It follows the OAuth2 Keys page (oauth2-keys-page.js) step for step.
//
// The key managers that make agent keys (an agent registration endpoint is set in
// Settings → Key Managers; `agentKeys`, with the grants each offers) and those that
// record existing clients (keyCreation `provide`, where existing agents are linked,
// as existing applications are imported) come from
// GET /key-managers/metadata?subjectType=AGENT; POST /oauth2-keys checks the same. Every string from the server is put
// on the page with textContent, never as markup.

(function () {
    var root = document.getElementById('agent-keys-root');
    if (!root) return;

    var KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
    var TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
    var _metadata = null;
    var _submitting = false;
    var _copyTimer = null;

    /* ── helpers ──────────────────────────────────────────────── */

    function mutationHeaders() {
        return { 'Content-Type': 'application/json', 'X-CSRF-Token': window.apiPortalApi.csrfToken() };
    }
    function byId(id) { return document.getElementById(id); }
    function show(id) { var el = byId(id); if (el) el.style.display = 'flex'; }
    function hide(id) { var el = byId(id); if (el) el.style.display = 'none'; }
    async function alertMsg(message, type) {
        if (typeof showAlert === 'function') { try { await showAlert(message, type); } catch (e) { /* noop */ } }
    }
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }
    function on(id, event, fn) { var node = byId(id); if (node) node.addEventListener(event, fn); }
    async function readJson(resp) { try { return await resp.json(); } catch (e) { return null; } }
    function keyUrl(keyId, suffix) {
        return window.apiPortalApi.root('/oauth2-keys/' + encodeURIComponent(keyId) + (suffix || ''));
    }

    /* ── key managers ─────────────────────────────────────────── */

    async function loadMetadata() {
        if (_metadata) return _metadata;
        try {
            var resp = await fetch(window.apiPortalApi.root('/key-managers/metadata?subjectType=AGENT'), { headers: mutationHeaders() });
            if (!resp.ok) return null;
            var data = await resp.json();
            _metadata = (data && data.list) || [];
        } catch (e) {
            return null;
        }
        return _metadata;
    }
    // Generate: the key managers that make agent keys. Link: those that record existing
    // clients, as Import does for applications on the OAuth2 Keys page.
    function agentKeyManagers(forLink) {
        return (_metadata || []).filter(function (km) {
            return forLink ? km.keyCreation === 'provide' : Boolean(km.agentKeys);
        });
    }
    function keyManagerById(id) {
        return (_metadata || []).filter(function (km) { return km.id === id; })[0] || null;
    }
    function selectedKeyManager() {
        var sel = byId('ak-km-select');
        return sel ? keyManagerById(sel.value) : null;
    }

    /* ── generate ─────────────────────────────────────────────── */

    function grantBox(grant, fixed) {
        var wrap = el('label', 'ok-check' + (fixed ? ' ak-check--fixed' : ''));
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.value = grant.value;
        box.className = 'ak-grant';
        if (fixed) { box.checked = true; box.disabled = true; }
        wrap.appendChild(box);
        wrap.appendChild(el('span', null, grant.label || grant.value));
        return wrap;
    }

    // The grants the chosen key manager offers agent keys, in two groups. Client
    // credentials is always held, so it is shown ticked and fixed.
    function renderGrants() {
        var km = selectedKeyManager();
        var self = byId('ak-grants-self');
        var users = byId('ak-grants-users');
        self.textContent = '';
        users.textContent = '';
        var grants = (km && km.agentKeys && km.agentKeys.grantTypes) || [];
        var forUsers = 0;
        grants.forEach(function (g) {
            if (g.forUsers) {
                users.appendChild(grantBox(g, false));
                forUsers += 1;
            } else {
                self.appendChild(grantBox(g, g.value === 'client_credentials'));
            }
        });
        byId('ak-users-group').hidden = forUsers === 0;
        var hint = byId('ak-km-hint');
        hint.textContent = km && km.description ? km.description : '';
        syncCallbacks();
    }

    function chosenGrants() {
        var picked = [];
        document.querySelectorAll('#ak-add-modal .ak-grant:checked').forEach(function (b) { picked.push(b.value); });
        return picked;
    }

    function addCallbackRow(value) {
        var rows = byId('ak-callbacks');
        var row = el('div', 'ok-list-row');
        var box = document.createElement('input');
        box.type = 'url';
        box.className = 'ok-form-input ok-list-input';
        box.placeholder = 'https://agent.example.com/callback';
        box.value = value || '';
        var del = el('button', 'ok-list-del');
        del.type = 'button';
        del.title = 'Remove';
        del.setAttribute('aria-label', 'Remove this callback URL');
        var icon = el('i', 'bi bi-x-lg');
        icon.setAttribute('aria-hidden', 'true');
        del.appendChild(icon);
        del.addEventListener('click', function () {
            row.parentNode.removeChild(row);
            if (!rows.querySelector('.ok-list-row')) addCallbackRow('');
        });
        row.appendChild(box);
        row.appendChild(del);
        rows.appendChild(row);
        return box;
    }

    // Callback URLs are asked for only with the authorization code grant.
    function syncCallbacks() {
        var needed = chosenGrants().indexOf('authorization_code') !== -1;
        byId('ak-callbacks-group').hidden = !needed;
        if (needed && !byId('ak-callbacks').querySelector('.ok-list-row')) addCallbackRow('');
    }

    function chosenCallbacks() {
        var values = [];
        document.querySelectorAll('#ak-callbacks .ok-list-input').forEach(function (box) {
            var v = (box.value || '').trim();
            if (v && values.indexOf(v) === -1) values.push(v);
        });
        return values;
    }

    /*
     * One dialog for Generate and for viewing a key, as the OAuth2 Keys page uses its
     * add form, frozen, to show a key. In view mode every control is disabled, the
     * submit button is hidden and Cancel reads Close.
     */
    function setAddMode(viewing, title) {
        byId('ak-add-title').textContent = viewing ? (title || 'Agent key') : 'Generate agent key';
        byId('ak-add-submit').hidden = viewing;
        byId('ak-add-cancel').textContent = viewing ? 'Close' : 'Cancel';
        byId('ak-callback-add').hidden = viewing;
        byId('ak-km-select').disabled = viewing;
        byId('ak-name').disabled = viewing;
    }
    function freezeAddForm() {
        document.querySelectorAll('#ak-add-modal .ok-modal-body input, #ak-add-modal .ok-modal-body button')
            .forEach(function (c) { c.disabled = true; });
    }

    async function openAdd() {
        setAddMode(false);
        if (!(await loadMetadata())) {
            await alertMsg('Could not load the key managers. Try again later.', 'error');
            return;
        }
        var choices = agentKeyManagers(false);
        var sel = byId('ak-km-select');
        sel.textContent = '';
        choices.forEach(function (km) {
            var opt = el('option', null, km.displayName || km.id);
            opt.value = km.id;
            sel.appendChild(opt);
        });
        byId('ak-name').value = '';
        byId('ak-callbacks').textContent = '';
        renderGrants();
        show('ak-add-modal');
        byId('ak-name').focus();
    }

    async function submitAdd() {
        if (_submitting) return;
        var km = selectedKeyManager();
        if (!km) return;
        var name = (byId('ak-name').value || '').trim();
        if (!KEY_NAME.test(name)) {
            await alertMsg('Give the key a name: letters, digits, dots, underscores or dashes, starting with a letter or digit.', 'error');
            return;
        }
        var grants = chosenGrants();
        var properties = { client_name: name, grant_types: grants };
        if (grants.indexOf('authorization_code') !== -1) {
            var callbacks = chosenCallbacks();
            if (!callbacks.length) {
                await alertMsg('Add at least one callback URL for the authorization code grant.', 'error');
                return;
            }
            properties.redirect_uris = callbacks;
        }

        _submitting = true;
        var btn = byId('ak-add-submit');
        btn.disabled = true;
        try {
            var resp = await fetch(window.apiPortalApi.root('/oauth2-keys'), {
                method: 'POST',
                headers: mutationHeaders(),
                body: JSON.stringify({ keyManagerId: km.id, subjectType: 'AGENT', properties: properties }),
            });
            var data = await readJson(resp);
            if (!resp.ok) {
                await alertMsg((data && data.message) || 'Could not generate the agent key.', 'error');
                return;
            }
            hide('ak-add-modal');
            showCredentials(km, data || {}, false);
        } catch (e) {
            await alertMsg('Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            _submitting = false;
            btn.disabled = false;
        }
    }

    /* ── link an existing agent ────────────────────────────────── */

    async function openLink() {
        if (!(await loadMetadata())) {
            await alertMsg('Could not load the key managers. Try again later.', 'error');
            return;
        }
        var sel = byId('ak-link-km-select');
        sel.textContent = '';
        agentKeyManagers(true).forEach(function (km) {
            var opt = el('option', null, km.displayName || km.id);
            opt.value = km.id;
            sel.appendChild(opt);
        });
        ['ak-link-name', 'ak-link-client-id'].forEach(function (id) { byId(id).value = ''; });
        show('ak-link-modal');
        byId('ak-link-name').focus();
    }

    async function submitLink() {
        if (_submitting) return;
        var kmId = byId('ak-link-km-select').value;
        var name = (byId('ak-link-name').value || '').trim();
        // As Import for an application: the client ID only, nothing checked upstream.
        var link = { clientId: (byId('ak-link-client-id').value || '').trim() };
        if (!KEY_NAME.test(name)) {
            await alertMsg('Give the key a name: letters, digits, dots, underscores or dashes, starting with a letter or digit.', 'error');
            return;
        }
        if (!link.clientId) {
            await alertMsg('Enter the consumer key of the agent\'s OAuth client.', 'error');
            return;
        }
        _submitting = true;
        var btn = byId('ak-link-submit');
        btn.disabled = true;
        try {
            var resp = await fetch(window.apiPortalApi.root('/oauth2-keys'), {
                method: 'POST',
                headers: mutationHeaders(),
                body: JSON.stringify({ keyManagerId: kmId, subjectType: 'AGENT', properties: { client_name: name }, link: link }),
            });
            var data = await readJson(resp);
            if (!resp.ok) {
                await alertMsg((data && data.message) || 'Could not link the agent.', 'error');
                return;
            }
            hide('ak-link-modal');
            window.location.reload();
        } catch (e) {
            await alertMsg('Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            _submitting = false;
            btn.disabled = false;
        }
    }

    /* ── credentials (shown once) ─────────────────────────────── */

    function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

    function sampleSelf(km, clientId) {
        return [
            'curl -s -X POST ' + shellQuote(km.tokenEndpoint || '<token endpoint>') + ' \\',
            '  -u ' + shellQuote(clientId + ':<client secret>') + ' \\',
            '  -d grant_type=client_credentials',
        ].join('\n');
    }

    function sampleExchange(km, clientId) {
        return [
            'curl -s -X POST ' + shellQuote(km.tokenEndpoint || '<token endpoint>') + ' \\',
            '  -u ' + shellQuote(clientId + ':<client secret>') + ' \\',
            '  --data-urlencode grant_type=' + TOKEN_EXCHANGE + ' \\',
            "  --data-urlencode subject_token='<the user's access token>' \\",
            '  --data-urlencode subject_token_type=urn:ietf:params:oauth:token-type:access_token \\',
            "  --data-urlencode resource='<the API the token is for>'",
        ].join('\n');
    }

    function sampleCode(km, clientId, callbacks) {
        var url;
        try {
            url = new URL(km.authorizeEndpoint);
        } catch (e) {
            return 'The key manager has no authorization endpoint configured.';
        }
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', (callbacks && callbacks[0]) || '<callback URL>');
        url.searchParams.set('scope', 'openid');
        url.searchParams.set('code_challenge', '<PKCE challenge>');
        url.searchParams.set('code_challenge_method', 'S256');
        return url.toString();
    }

    // Step 3 of the authorization code flow: the code for the user's token.
    function sampleCodeExchange(km, clientId, callbacks) {
        return [
            'curl -s -X POST ' + shellQuote(km.tokenEndpoint || '<token endpoint>') + ' \\',
            '  -u ' + shellQuote(clientId + ':<client secret>') + ' \\',
            '  -d grant_type=authorization_code \\',
            "  --data-urlencode code='<the code from the callback>' \\",
            '  --data-urlencode redirect_uri=' + shellQuote((callbacks && callbacks[0]) || '<callback URL>') + ' \\',
            "  --data-urlencode code_verifier='<the PKCE verifier>'",
        ].join('\n');
    }

    function showCredentials(km, key, rotated) {
        var props = key.properties || {};
        var grants = props.grant_types || [];
        var clientId = key.consumerKey || '';
        byId('ak-secret-title').textContent = rotated ? 'Secret rotated' : 'Agent key created';
        byId('ak-secret-km').textContent = (km && (km.displayName || km.id)) || key.keyManagerName || '';
        byId('ak-secret-agent-id').textContent = key.agentId || '';
        byId('ak-secret-client-id').textContent = clientId;
        byId('ak-secret-value').textContent = key.consumerSecret || '';
        var meta = km || keyManagerById(key.keyManagerId) || {};
        byId('ak-sample-self').textContent = sampleSelf(meta, clientId);
        var exchange = grants.indexOf(TOKEN_EXCHANGE) !== -1;
        byId('ak-sample-exchange-block').hidden = !exchange;
        byId('ak-sample-exchange').textContent = exchange ? sampleExchange(meta, clientId) : '';
        var code = grants.indexOf('authorization_code') !== -1;
        byId('ak-sample-code-block').hidden = !code;
        byId('ak-sample-code').textContent = code ? sampleCode(meta, clientId, props.redirect_uris) : '';
        show('ak-secret-modal');
    }

    /* ── view ─────────────────────────────────────────────────── */

    /** Open one key read-only: the Generate dialog, filled in and frozen. Selecting a row lands here. */
    async function openView(row) {
        var keyId = row.getAttribute('data-key-id');
        try {
            var resp = await fetch(keyUrl(keyId), { headers: mutationHeaders() });
            var key = await readJson(resp);
            if (!resp.ok || !key) {
                await alertMsg((key && key.message) || 'Could not load the agent key.', 'error');
                return;
            }
            await loadMetadata();
            var props = key.properties || {};
            var granted = props.grant_types || [];

            setAddMode(true, key.name || 'Agent key');
            var sel = byId('ak-km-select');
            sel.textContent = '';
            var opt = el('option', null, key.keyManagerName || key.keyManagerId);
            opt.value = key.keyManagerId;
            sel.appendChild(opt);
            byId('ak-name').value = key.name || '';
            byId('ak-callbacks').textContent = '';

            // The grants the key manager offers agent keys, ticked as this key holds
            // them. A key manager that no longer lists them (disabled, or one where
            // agents are linked) shows the key's own grants instead.
            var km = keyManagerById(key.keyManagerId);
            if (km && km.agentKeys) {
                renderGrants();
            } else {
                var self = byId('ak-grants-self');
                self.textContent = '';
                byId('ak-grants-users').textContent = '';
                granted.forEach(function (g) { self.appendChild(grantBox({ value: g, label: g }, false)); });
                byId('ak-users-group').hidden = true;
            }
            document.querySelectorAll('#ak-add-modal .ak-grant').forEach(function (b) {
                b.checked = granted.indexOf(b.value) !== -1;
            });
            byId('ak-callbacks').textContent = '';
            (props.redirect_uris || []).forEach(function (u) { addCallbackRow(u); });
            byId('ak-callbacks-group').hidden = !(props.redirect_uris && props.redirect_uris.length);
            byId('ak-km-hint').textContent = key.linked
                ? 'Linked: an agent managed elsewhere. Deleting the key only unlinks it.'
                : (key.agentId ? 'Agent ID: ' + key.agentId : '');
            freezeAddForm();
            show('ak-add-modal');
        } catch (e) {
            await alertMsg('Could not reach the server. Check your connection and try again.', 'error');
        }
    }

    /* ── get token (the agent's own, client credentials) ─────── */

    var _tokenKeyId = null;

    function openToken(row) {
        _tokenKeyId = row.getAttribute('data-key-id');
        byId('ak-token-client-id').textContent = row.getAttribute('data-consumer-key') || '';
        // Cleared on every open: a secret typed for one key must never carry over.
        ['ak-token-secret', 'ak-token-scopes', 'ak-token-resources'].forEach(function (id) { byId(id).value = ''; });
        byId('ak-token-obo').hidden = true;
        byId('ak-token-obo-pointer').hidden = true;
        var forUsers = row.getAttribute('data-acts-for-users') === 'true';
        byId('ak-token-note').hidden = !forUsers;
        show('ak-token-modal');
        byId('ak-token-secret').focus();
        if (forUsers) showOboSteps(_tokenKeyId);
    }

    // The steps for a user's token, for the grants this key holds (read from the key
    // manager). Left hidden if the key can't be read: the note above still says
    // that only the agent's own token is taken here.
    async function showOboSteps(keyId) {
        try {
            var resp = await fetch(keyUrl(keyId), { headers: mutationHeaders() });
            var key = await readJson(resp);
            if (!resp.ok || !key || keyId !== _tokenKeyId) return;
            await loadMetadata();
            var km = keyManagerById(key.keyManagerId) || {};
            var props = key.properties || {};
            var grants = props.grant_types || [];
            var clientId = key.consumerKey || '';
            var exchange = grants.indexOf(TOKEN_EXCHANGE) !== -1;
            var code = grants.indexOf('authorization_code') !== -1;
            // The key acts for users (stored when it was made), but its grants couldn't
            // be read back (its key manager is gone or disabled): show both flows.
            var unknown = !exchange && !code;
            if (unknown) { exchange = true; code = true; }
            byId('ak-token-obo-unknown').hidden = !unknown;
            byId('ak-token-obo-exchange').hidden = !exchange;
            byId('ak-token-obo-code').hidden = !code;
            if (exchange) byId('ak-token-sample-exchange').textContent = sampleExchange(km, clientId);
            if (code) {
                byId('ak-token-sample-code').textContent = sampleCode(km, clientId, props.redirect_uris);
                byId('ak-token-sample-code-exchange').textContent = sampleCodeExchange(km, clientId, props.redirect_uris);
            }
            byId('ak-token-obo').hidden = !(exchange || code);
            byId('ak-token-obo-pointer').hidden = !(exchange || code);
        } catch (e) {
            // The note already says what this dialog does; the steps are extra.
        }
    }

    async function submitToken() {
        if (_submitting || !_tokenKeyId) return;
        var secret = byId('ak-token-secret').value;
        if (!secret) {
            await alertMsg('Enter the client secret for this key.', 'error');
            return;
        }
        var scopes = byId('ak-token-scopes').value.split(/\s+/).filter(Boolean);
        var resources = byId('ak-token-resources').value.split(/\s+/).filter(Boolean);
        _submitting = true;
        var btn = byId('ak-token-submit');
        btn.disabled = true;
        try {
            var body = { consumerSecret: secret };
            if (scopes.length) body.scopes = scopes;
            if (resources.length) body.resources = resources;
            var resp = await fetch(keyUrl(_tokenKeyId, '/generate-token'),
                { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body) });
            var data = await readJson(resp);
            if (!resp.ok) {
                await alertMsg((data && data.message) || 'Could not get a token.', 'error');
                return;
            }
            byId('ak-token-secret').value = '';
            hide('ak-token-modal');
            var token = data || {};
            byId('ak-token-value').textContent = token.accessToken || '';
            var parts = [];
            if (token.tokenType) parts.push(token.tokenType);
            if (token.validityTime) parts.push('valid for ' + token.validityTime + 's');
            parts.push(token.tokenScopes && token.tokenScopes.length ? 'scopes: ' + token.tokenScopes.join(' ') : 'no scopes granted');
            byId('ak-token-summary').textContent = parts.join(' · ');
            show('ak-token-result-modal');
        } catch (e) {
            await alertMsg('Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            _submitting = false;
            btn.disabled = false;
        }
    }

    /* ── rotate and delete ────────────────────────────────────── */

    var _rotateRow = null;
    var _deleteKeyId = null;

    function openRotate(row) {
        _rotateRow = row;
        byId('ak-rotate-name').textContent = row.getAttribute('data-name') || '';
        show('ak-rotate-modal');
    }

    async function confirmRotate() {
        if (!_rotateRow || _submitting) return;
        _submitting = true;
        var btn = byId('ak-rotate-confirm');
        btn.disabled = true;
        try {
            var resp = await fetch(keyUrl(_rotateRow.getAttribute('data-key-id'), '/rotate-secret'),
                { method: 'POST', headers: mutationHeaders(), body: '{}' });
            var data = await readJson(resp);
            if (!resp.ok) {
                await alertMsg((data && data.message) || 'Could not rotate the secret.', 'error');
                return;
            }
            hide('ak-rotate-modal');
            await loadMetadata();
            showCredentials(keyManagerById((data || {}).keyManagerId), data || {}, true);
        } catch (e) {
            await alertMsg('Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            _submitting = false;
            btn.disabled = false;
        }
    }

    function openDelete(row) {
        _deleteKeyId = row.getAttribute('data-key-id');
        var linked = row.getAttribute('data-linked') === 'true';
        document.querySelectorAll('.ak-delete-name').forEach(function (n) { n.textContent = row.getAttribute('data-name') || ''; });
        byId('ak-delete-created').hidden = linked;
        byId('ak-delete-linked').hidden = !linked;
        byId('ak-delete-title').textContent = linked ? 'Unlink agent key' : 'Delete agent key';
        byId('ak-delete-confirm').textContent = linked ? 'Unlink' : 'Delete key';
        show('ak-delete-modal');
    }

    async function confirmDelete() {
        if (!_deleteKeyId || _submitting) return;
        _submitting = true;
        var btn = byId('ak-delete-confirm');
        btn.disabled = true;
        try {
            var resp = await fetch(keyUrl(_deleteKeyId), { method: 'DELETE', headers: mutationHeaders() });
            if (!resp.ok) {
                var body = await readJson(resp);
                await alertMsg((body && body.message) || 'Could not delete the key.', 'error');
                return;
            }
            hide('ak-delete-modal');
            window.location.reload();
        } catch (e) {
            await alertMsg('Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            _submitting = false;
            btn.disabled = false;
        }
    }

    /* ── copy ─────────────────────────────────────────────────── */

    document.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.ok-copy') : null;
        if (!btn) return;
        var targetId = btn.getAttribute('data-copy-target');
        var text = targetId ? ((byId(targetId) || {}).textContent || '') : (btn.getAttribute('data-copy') || '');
        if (!text) return;
        if (!navigator.clipboard) { alertMsg('Copying needs a secure (https) connection.', 'error'); return; }
        navigator.clipboard.writeText(text).then(function () {
            btn.classList.add('is-copied');
            clearTimeout(_copyTimer);
            _copyTimer = setTimeout(function () { btn.classList.remove('is-copied'); }, 1400);
        }, function () { alertMsg('Could not copy to the clipboard.', 'error'); });
    });

    /* ── relative timestamps (as on the OAuth2 Keys page) ──────── */

    var RELATIVE_UNITS = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
    function relativeTime(date) {
        var seconds = Math.round((date.getTime() - Date.now()) / 1000);
        if (Math.abs(seconds) < 60) return 'just now';
        for (var i = 0; i < RELATIVE_UNITS.length; i++) {
            var size = RELATIVE_UNITS[i][1];
            if (Math.abs(seconds) >= size) {
                var value = Math.round(seconds / size);
                try {
                    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, RELATIVE_UNITS[i][0]);
                } catch (e) {
                    return Math.abs(value) + ' ' + RELATIVE_UNITS[i][0] + (Math.abs(value) === 1 ? '' : 's') + (value < 0 ? ' ago' : ' from now');
                }
            }
        }
        return 'just now';
    }
    function refreshTimestamps() {
        document.querySelectorAll('.ok-created-at[datetime]').forEach(function (node) {
            var when = new Date(node.getAttribute('datetime'));
            if (!isNaN(when.getTime())) node.textContent = relativeTime(when);
        });
    }
    refreshTimestamps();
    setInterval(function () { if (!document.hidden) refreshTimestamps(); }, 60000);

    /* ── row menus (fixed-position, as on the OAuth2 Keys page) ── */

    function closeRowMenus() {
        document.querySelectorAll('.ok-dropdown').forEach(function (d) { d.style.display = 'none'; });
        document.querySelectorAll('.ok-menu-trigger[aria-expanded="true"]').forEach(function (t) {
            t.setAttribute('aria-expanded', 'false');
        });
    }
    function openRowMenu(trigger) {
        var dd = trigger.parentElement.querySelector('.ok-dropdown');
        if (!dd) return;
        var wasOpen = dd.style.display === 'flex';
        closeRowMenus();
        if (wasOpen) return;
        dd.style.display = 'flex';
        dd.style.visibility = 'hidden';
        var r = trigger.getBoundingClientRect();
        var h = dd.offsetHeight;
        var w = dd.offsetWidth;
        dd.style.top = (window.innerHeight - r.bottom < h + 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
        dd.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        dd.style.visibility = '';
        trigger.setAttribute('aria-expanded', 'true');
    }
    window.addEventListener('scroll', closeRowMenus, true);
    window.addEventListener('resize', closeRowMenus);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeRowMenus(); });

    /* ── application association (as on the OAuth2 Keys page) ──── */

    var _appRow = null;   // the row whose association is being edited

    function applications() {
        var node = byId('ak-applications-data');
        if (!node) return [];
        try { return JSON.parse(node.textContent || '[]'); } catch (e) { return []; }
    }

    function openAppModal(row) {
        _appRow = row;
        var apps = applications();
        var sel = byId('ak-app-select');
        var current = row.getAttribute('data-application-id') || '';
        var keyType = row.getAttribute('data-key-type') || 'PRODUCTION';
        sel.textContent = '';
        // "None" is a real choice: picking it dissociates.
        var none = el('option', null, '— None —');
        none.value = '';
        sel.appendChild(none);
        var available = 0;
        apps.forEach(function (app) {
            // One key per key type per application: one that already holds a key of
            // this type is listed but can't be picked (unless it is this key's).
            var taken = app.id !== current && (app.takenTypes || []).indexOf(keyType) !== -1;
            var label = app.displayName || app.id;
            var opt = el('option', null, taken ? label + '  (already has a ' + keyType.toLowerCase() + ' key)' : label);
            opt.value = app.id;
            opt.disabled = taken;
            if (!taken) available += 1;
            sel.appendChild(opt);
        });
        sel.value = current;
        if (!apps.length) {
            alertMsg('You have no applications yet. Create one first, then associate this key with it.', 'error');
            return;
        }
        if (!available && !current) {
            alertMsg('Every application already has a key of this type associated with it. '
                + 'Remove one of those associations, or create another application, to associate this key.', 'error');
            return;
        }
        show('ak-app-modal');
    }

    async function saveAssociation() {
        if (!_appRow || _submitting) return;
        var keyId = _appRow.getAttribute('data-key-id');
        var current = _appRow.getAttribute('data-application-id') || '';
        var chosen = byId('ak-app-select').value;
        if (chosen === current) { hide('ak-app-modal'); return; }
        _submitting = true;
        var btn = byId('ak-app-save');
        btn.disabled = true;
        try {
            // One control, two endpoints: an application associates, "None" dissociates.
            var resp = await fetch(keyUrl(keyId, chosen ? '/associate' : '/dissociate'), {
                method: 'POST',
                headers: mutationHeaders(),
                body: chosen ? JSON.stringify({ applicationId: chosen }) : undefined,
            });
            if (!resp.ok) {
                var data = await readJson(resp);
                await alertMsg((data && data.message) || 'Could not update the association.', 'error');
                return;
            }
            hide('ak-app-modal');
            window.location.reload();
        } catch (e) {
            await alertMsg('Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            _submitting = false;
            btn.disabled = false;
        }
    }

    document.addEventListener('click', function (e) {
        if (!e.target.closest) return;
        var menuBtn = e.target.closest('.ak-row-menu');
        if (menuBtn) { openRowMenu(menuBtn); return; }
        if (!e.target.closest('.ok-dropdown')) closeRowMenus();

        var row = e.target.closest('tr.ok-row');
        if (!row) return;
        if (e.target.closest('.ak-row-token')) { openToken(row); return; }
        if (e.target.closest('.ak-row-rotate')) { closeRowMenus(); openRotate(row); return; }
        if (e.target.closest('.ak-row-delete')) { closeRowMenus(); openDelete(row); return; }
        if (e.target.closest('.ak-row-app')) { openAppModal(row); return; }
        // Selecting the row opens the key read-only, unless the click was on an action.
        if (e.target.closest('.ok-actions') || e.target.closest('.ok-copy')) return;
        openView(row);
    });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (!e.target.classList || !e.target.classList.contains('ok-row')) return;
        e.preventDefault();
        openView(e.target);
    });

    /* ── wiring ───────────────────────────────────────────────── */

    ['ak-add-btn', 'ak-add-btn-empty'].forEach(function (id) { on(id, 'click', openAdd); });
    ['ak-link-btn', 'ak-link-btn-empty'].forEach(function (id) { on(id, 'click', openLink); });
    on('ak-link-submit', 'click', submitLink);
    ['ak-link-close', 'ak-link-cancel'].forEach(function (id) { on(id, 'click', function () { hide('ak-link-modal'); }); });
    on('ak-km-select', 'change', renderGrants);
    on('ak-add-modal', 'change', function (e) { if (e.target.classList.contains('ak-grant')) syncCallbacks(); });
    on('ak-callback-add', 'click', function () { addCallbackRow('').focus(); });
    on('ak-add-submit', 'click', submitAdd);
    ['ak-add-close', 'ak-add-cancel'].forEach(function (id) { on(id, 'click', function () { hide('ak-add-modal'); }); });
    ['ak-token-close', 'ak-token-cancel'].forEach(function (id) { on(id, 'click', function () { hide('ak-token-modal'); }); });
    on('ak-token-submit', 'click', submitToken);
    ['ak-token-result-close', 'ak-token-done'].forEach(function (id) {
        on(id, 'click', function () { byId('ak-token-value').textContent = ''; hide('ak-token-result-modal'); });
    });
    on('ak-rotate-cancel', 'click', function () { hide('ak-rotate-modal'); });
    on('ak-rotate-confirm', 'click', confirmRotate);
    on('ak-delete-cancel', 'click', function () { hide('ak-delete-modal'); });
    on('ak-delete-confirm', 'click', confirmDelete);
    on('ak-app-save', 'click', saveAssociation);
    ['ak-app-close', 'ak-app-cancel'].forEach(function (id) { on(id, 'click', function () { hide('ak-app-modal'); }); });
    // The list is server-rendered: reload so a new key appears. Also the only exit
    // from the panel, so a shown secret is never skipped past.
    ['ak-secret-close', 'ak-secret-done'].forEach(function (id) { on(id, 'click', function () { window.location.reload(); }); });

    // Show each entry point, and the right empty-state text, only where a key
    // manager can serve it. Left as rendered if the metadata can't be read.
    (async function syncEntryPoints() {
        var list = await loadMetadata();
        if (!list) return;
        var canGenerate = agentKeyManagers(false).length > 0;
        var canLink = agentKeyManagers(true).length > 0;
        ['ak-add-btn', 'ak-add-btn-empty'].forEach(function (id) { var b = byId(id); if (b) b.hidden = !canGenerate; });
        ['ak-link-btn', 'ak-link-btn-empty'].forEach(function (id) { var b = byId(id); if (b) b.hidden = !canLink; });
        var available = canGenerate || canLink;
        var yes = byId('ak-empty-available');
        var no = byId('ak-empty-unavailable');
        if (yes) yes.hidden = !available;
        if (no) no.hidden = available;
    }());
})();
