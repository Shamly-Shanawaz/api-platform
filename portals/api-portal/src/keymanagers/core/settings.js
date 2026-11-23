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
 * A key manager's own settings: the admin's choices that its driver cannot know
 * about itself. One closed set of keys, checked by one function, whichever way the
 * key manager was declared:
 *
 *   - the REST API's `provisioning` block (Settings → Key Managers), stored in
 *     key_manager_configurations.settings;
 *   - a config file entry's optional `[api_portal.key_manager.settings]` table.
 *
 *   supportedGrantTypes        which of the driver's grant types a developer may pick
 *                              (empty: all of them)
 *   agentRegistrationEndpoint  where AI agents are registered (ThunderID: its
 *                              `/agents` URL). Set: developers also get agent keys
 *                              here (Keys → Agent Keys). Only on a driver that
 *                              declares agent keys.
 *
 * Free of logger and configLoader, like registry.js: config/keyManagerConfig.js
 * calls it during configLoader's own bootstrap. Whether the agent endpoint may be
 * dialled is checked where the other endpoints are (configLoader at boot,
 * keyManagerService on save), under the key manager's own client policy.
 */

const { getDriver, declaresAgentKeys } = require('./registry');

// The keys, as the REST API spells them (and as configLoader camelCases the TOML).
const SETTINGS_KEYS = Object.freeze(['supportedGrantTypes', 'agentRegistrationEndpoint']);

const MAX_ENDPOINT_LENGTH = 255;

/**
 * The grant types a driver declares, straight from its own metadata, read from a
 * bare instance (a static fact about the driver). [] when the driver declares no
 * grant_types property, or can't be introspected: no restriction is expressible.
 */
function declaredGrantTypes(type) {
    try {
        const create = getDriver(type);
        if (!create) return [];
        const instance = create({});
        const meta = typeof instance.metadata === 'function' ? instance.metadata() : null;
        const grantProp = ((meta && meta.properties) || []).find((p) => p.name === 'grant_types');
        if (!grantProp || !Array.isArray(grantProp.options)) return [];
        return grantProp.options.map((o) => o.value).filter(Boolean);
    } catch (_error) {
        // Unvalidated here, rather than blocking the key manager; key creation still
        // compares against live metadata.
        return [];
    }
}

/**
 * Check a settings bag for one driver type.
 *
 * @param {string} type        the driver type
 * @param {object} raw         the submitted settings (camelCase keys)
 * @param {object} [opts]
 * @param {boolean} [opts.closed]  reject keys outside the set (the config file;
 *        the REST block is a larger object whose other members are not settings)
 * @param {(key: string) => string} [opts.name]  how to name a key in a message
 * @returns {{settings: {supportedGrantTypes: string[], agentRegistrationEndpoint: string}} | {error: string}}
 */
function validateSettings(type, raw, { closed = false, name = (key) => key } = {}) {
    const bag = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (closed) {
        const unknown = Object.keys(bag).filter((k) => !SETTINGS_KEYS.includes(k));
        if (unknown.length) {
            return { error: `unknown setting(s) ${unknown.map(name).join(', ')}; allowed: ${SETTINGS_KEYS.map(name).join(', ')}` };
        }
    }

    /*
     * The admin's restriction on which grants a portal user may pick. Checked against
     * what the driver declares, so it can't name a grant the key manager never offers
     * (an empty dropdown, and a key manager nobody can create a key on).
     */
    let supportedGrantTypes = [];
    const grants = bag.supportedGrantTypes;
    if (grants !== undefined && grants !== null) {
        if (!Array.isArray(grants)) {
            return { error: `${name('supportedGrantTypes')} must be an array of grant type names.` };
        }
        supportedGrantTypes = grants.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim());
        const declared = declaredGrantTypes(type);
        if (declared.length) {
            const unknown = supportedGrantTypes.filter((g) => !declared.includes(g));
            if (unknown.length) {
                return {
                    error: `${name('supportedGrantTypes')} contains grant type(s) this key manager `
                        + `does not offer: ${unknown.join(', ')}. It offers: ${declared.join(', ')}.`,
                };
            }
        }
    }

    // Accepted only on a driver that can make agent keys, so the setting can never
    // promise something the driver cannot do. Empty means "no agent keys here".
    let agentRegistrationEndpoint = '';
    const agentEndpoint = bag.agentRegistrationEndpoint;
    if (agentEndpoint !== undefined && agentEndpoint !== null && agentEndpoint !== '') {
        if (typeof agentEndpoint !== 'string') {
            return { error: `${name('agentRegistrationEndpoint')} must be a URL.` };
        }
        agentRegistrationEndpoint = agentEndpoint.trim();
        if (agentRegistrationEndpoint && !declaresAgentKeys(type)) {
            return { error: `${name('agentRegistrationEndpoint')} is not available for this key manager type: it can't make agent keys.` };
        }
        if (agentRegistrationEndpoint.length > MAX_ENDPOINT_LENGTH) {
            return { error: `${name('agentRegistrationEndpoint')} is longer than ${MAX_ENDPOINT_LENGTH} characters.` };
        }
    }

    return { settings: { supportedGrantTypes, agentRegistrationEndpoint } };
}

module.exports = { SETTINGS_KEYS, declaredGrantTypes, validateSettings };
