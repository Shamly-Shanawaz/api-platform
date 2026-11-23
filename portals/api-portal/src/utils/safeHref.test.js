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

const test = require('node:test');
const assert = require('node:assert');
const { safeHref } = require('./safeHref');

test('safeHref keeps http, https and mailto links', () => {
    assert.equal(safeHref('https://github.com/acme/tool'), 'https://github.com/acme/tool');
    assert.equal(safeHref('http://example.com/a'), 'http://example.com/a');
    assert.equal(safeHref('mailto:team@example.com'), 'mailto:team@example.com');
    assert.equal(safeHref('  HTTPS://Example.com/x  '), 'https://example.com/x');
});

test('safeHref turns every other value into plain text', () => {
    for (const value of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>',
        'vbscript:msgbox(1)', '/relative/path', 'example.com/no-scheme', '', null, undefined, 42]) {
        assert.equal(safeHref(value), '', String(value));
    }
});
