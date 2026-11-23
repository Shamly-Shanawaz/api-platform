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

const { renderTemplateWithView, resolveActor, pageErrorStatus } = require('../utils/util');
const logger = require('../config/logger');
const constants = require('../utils/constants');
const orgDao = require('../dao/organizationDao');
const oauth2KeyDao = require('../dao/oauth2ConsumerKeyDao');
const keyAppMappingDao = require('../dao/oauth2KeyAppMappingDao');
const applicationDao = require('../dao/applicationDao');
const agentKeys = require('../services/agentKeys');
const kmRegistry = require('../services/keyManagerRegistry');

/**
 * Renders the "Agent keys" page: the signed-in user's AI agent keys, the OAuth2 keys
 * whose client belongs to an agent in the identity server. Built like the OAuth2
 * Keys page (server-rendered list, same degraded reads); which key managers can make
 * agent keys comes from their metadata, which the page script reads, as the OAuth2
 * Keys page does for its two entry points.
 */
const loadAgentKeys = async (req, res, next) => {
    const { orgName, viewName } = req.params;

    try {
        const orgDetails = await orgDao.get(orgName);
        const orgId = orgDetails.uuid;

        if (!req.user) {
            return res.redirect(`${constants.ROUTE.BASE_PATH}/${orgName}${constants.ROUTE.VIEWS_PATH}${viewName}/login`);
        }

        // Key manager names, disabled ones included: a key issued through one that was
        // later disabled still exists and still needs a name.
        const keyManagerNames = new Map();
        const keyManagerEnabled = new Map();
        try {
            for (const km of await kmRegistry.list(orgId, { includeDisabled: true })) {
                keyManagerNames.set(km.handle, km.display_name || km.handle);
                keyManagerEnabled.set(km.handle, Boolean(km.enabled));
            }
        } catch (kmError) {
            logger.warn('Failed to resolve key managers for the agent keys page', { error: kmError.message, orgId });
        }

        let keys = [];
        let keysLoadError = false;
        // The caller's own applications, for the associate picker, as the OAuth2 Keys
        // page loads them.
        let applications = [];
        try {
            const actor = resolveActor(req);
            const records = await oauth2KeyDao.listByCreator(orgId, actor);
            const agentByKey = await agentKeys.findByKeys((records || []).map((k) => k.keyId));
            // Associations, as on the OAuth2 Keys page: an agent key can be associated
            // with an application like any OAuth2 key (one key per key type per
            // application, whichever kind of key holds the slot).
            const appByKey = await keyAppMappingDao.getByKeys((records || []).map((k) => k.keyId));
            const appNames = new Map();
            for (const appUuid of new Set(appByKey.values())) {
                const app = await applicationDao.get(orgId, appUuid, actor);
                if (app) appNames.set(appUuid, { id: app.handle, displayName: app.display_name });
            }
            const linking = await agentKeys.linkKeyManagerIds(orgId,
                (records || []).filter((k) => agentByKey.has(k.keyId)).map((k) => k.keyManagerId));
            keys = (records || []).filter((k) => agentByKey.has(k.keyId)).map((k) => {
                const agent = agentByKey.get(k.keyId);
                const app = appNames.get(appByKey.get(k.keyId));
                return {
                    keyId: k.keyId,
                    name: k.name || '',
                    keyType: k.keyType || 'PRODUCTION',
                    keyManagerId: k.keyManagerId,
                    keyManagerName: keyManagerNames.get(k.keyManagerId) || k.keyManagerId,
                    // Rotation goes through the key manager, so a disabled one can't.
                    keyManagerEnabled: keyManagerEnabled.has(k.keyManagerId)
                        ? keyManagerEnabled.get(k.keyManagerId)
                        : true,
                    consumerKey: k.consumerKey,
                    agentId: agent.agentId,
                    actsForUsers: agent.actsForUsers,
                    // Linked (on a key manager that records existing clients): someone
                    // else's agent; deleting the key only unlinks it.
                    linked: linking.has(k.keyManagerId),
                    createdAt: k.createdAt,
                    applicationId: app ? app.id : '',
                    applicationName: app ? app.displayName : '',
                };
            });

            // Which key types each application already holds (any key, app or agent),
            // so the picker greys out what the server would refuse with a 409.
            const takenByApp = new Map();
            for (const k of records || []) {
                const handle = (appNames.get(appByKey.get(k.keyId)) || {}).id;
                if (!handle) continue;
                if (!takenByApp.has(handle)) takenByApp.set(handle, []);
                takenByApp.get(handle).push(k.keyType || 'PRODUCTION');
            }
            applications = (await applicationDao.list(orgId, actor) || []).map((a) => ({
                id: a.handle,
                displayName: a.display_name,
                takenTypes: takenByApp.get(a.handle) || [],
            }));
        } catch (dbError) {
            keysLoadError = true;
            logger.warn('Failed to load agent keys', { error: dbError.message, orgId });
        }

        const templateContent = {
            baseUrl: constants.ROUTE.BASE_PATH + '/' + orgName + constants.ROUTE.VIEWS_PATH + viewName,
            profile: {
                firstName: req.user.firstName,
                lastName: req.user.lastName,
                email: req.user.email,
                imageURL: req.user.picture || req.user.imageURL || constants.DEFAULT_PROFILE_IMAGE_URL,
                isAdmin: req.user.isAdmin,
            },
            orgId,
            agentKeys: keys,
            applications,
            keysLoadError,
        };

        const html = await renderTemplateWithView('../pages/agent-keys/page.hbs',
            './src/defaultContent/layout/main.hbs', templateContent, true, orgId, viewName);
        return res.send(html);
    } catch (error) {
        logger.error('Error loading the agent keys page', { error: error.message, stack: error.stack, orgName });
        error.status = pageErrorStatus(error);
        return next(error);
    }
};

module.exports = { loadAgentKeys };
