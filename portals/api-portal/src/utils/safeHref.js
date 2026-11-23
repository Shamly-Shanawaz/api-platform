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
 * Link allowlist for publisher-supplied URLs rendered in pages (agent repository
 * links, card links). Only http, https and mailto pass; anything else (javascript:,
 * data:, vbscript:, relative or scheme-less values) returns '' so the template
 * renders it as plain text instead of a link. FR-016.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function safeHref(value) {
    if (typeof value !== 'string') {
        return '';
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return '';
    }
    return ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? parsed.href : '';
}

module.exports = { safeHref };
