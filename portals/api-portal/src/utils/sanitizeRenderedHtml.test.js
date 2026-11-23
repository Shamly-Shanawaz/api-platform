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
const { marked } = require('marked');
const { sanitizeRenderedHtml } = require('./sanitizeRenderedHtml');

test('removes scripts, frames, styles, event handlers and dangerous URLs', () => {
    const out = sanitizeRenderedHtml(
        '<script>alert(1)</script><iframe src="https://x"></iframe><style>p{}</style>'
        + '<p onclick="alert(1)" style="color:red">hi</p>'
        + '<a href="javascript:alert(1)">a</a><a href="VBScript:x">b</a>'
        + '<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg"><img src="file:///etc/passwd">'
        + '<a href="//evil.example/x">c</a>');
    for (const bad of ['<script', 'alert(1)', '<iframe', '<style', 'onclick', 'style=', 'javascript:', 'VBScript:', 'svg+xml', 'file:', '//evil']) {
        assert.ok(!out.includes(bad), `kept ${bad}: ${out}`);
    }
    assert.ok(out.includes('<p>hi</p>'));
});

test('keeps ordinary markdown output', () => {
    const html = '<h2 id="intro">Intro</h2><p>Text <strong>bold</strong> <em>it</em></p><ul><li>one</li></ul>'
        + '<pre><code class="language-json">{"a":1}</code></pre><blockquote><p>q</p></blockquote>'
        + '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
        + '<p><img src="https://example.com/a.png" alt="A" title="t"></p>';
    const out = sanitizeRenderedHtml(html);
    for (const good of ['<h2 id="intro">', '<strong>bold</strong>', '<li>one</li>', 'class="language-json"', '<blockquote>', '<td>1</td>', 'src="https://example.com/a.png"']) {
        assert.ok(out.includes(good), `dropped ${good}: ${out}`);
    }
});

test('keeps http, https and mailto links, marked noopener', () => {
    const out = sanitizeRenderedHtml('<a href="https://example.com">x</a><a href="mailto:a@b.c">m</a>');
    assert.ok(out.includes('href="https://example.com"'));
    assert.ok(out.includes('href="mailto:a@b.c"'));
    assert.ok(out.includes('rel="noopener noreferrer"'));
});

test('keeps raster data: images', () => {
    assert.ok(sanitizeRenderedHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="p">').includes('data:image/png'));
});

test('cleans raw HTML that markdown passes through', () => {
    const md = '# Title\n\n<img src=x onerror="alert(1)">\n\n<svg><script>alert(1)</script></svg>\n\n'
        + '[click](javascript:alert(1))\n\n<form action="https://evil.example"><input name="p"></form>\n\n'
        + '<a href="https://ok.example" name="config">ok</a>\n';
    const out = sanitizeRenderedHtml(marked.parse(md));
    for (const bad of ['onerror', '<svg', '<script', 'javascript:', '<form', '<input', 'name="config"']) {
        assert.ok(!out.includes(bad), `kept ${bad}: ${out}`);
    }
    assert.ok(out.includes('<h1'));
    assert.ok(out.includes('href="https://ok.example"'));
});

test('returns an empty string for null and undefined', () => {
    assert.equal(sanitizeRenderedHtml(null), '');
    assert.equal(sanitizeRenderedHtml(undefined), '');
});
