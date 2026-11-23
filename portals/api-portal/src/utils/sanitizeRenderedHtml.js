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
 * Allowlist sanitizer for rendered rich content: markdown documents (marked output)
 * and uploaded landing-page fragments, for every artifact kind (FR-025, R14).
 * Markdown converters pass raw inline HTML straight through, so the output is
 * sanitized after conversion, never trusted.
 *
 * Kept: headings, paragraphs, lists, code/pre, tables, blockquotes, emphasis, links
 * (http, https, mailto) and images (http, https, data:image). Removed: script,
 * iframe, style, event handlers, javascript:/vbscript: URLs and anything else not listed.
 */

const sanitizeHtml = require('sanitize-html');

const OPTIONS = {
    allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
        'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sup', 'sub', 'mark', 'small', 'kbd',
        'code', 'pre', 'blockquote',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
        'a', 'img', 'details', 'summary',
    ],
    allowedAttributes: {
        a: ['href', 'title', 'target', 'rel'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        code: ['class'],
        pre: ['class'],
        span: ['class'],
        div: ['class'],
        th: ['align', 'colspan', 'rowspan'],
        td: ['align', 'colspan', 'rowspan'],
        ol: ['start'],
        h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    // data: images only — never data:text/html or data:image/svg+xml (SVG can script).
    exclusiveFilter: (frame) => frame.tag === 'img'
        && /^data:/i.test(frame.attribs.src || '')
        && !/^data:image\/(png|jpe?g|gif|webp);/i.test(frame.attribs.src || ''),
    transformTags: {
        a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
};

function sanitizeRenderedHtml(html) {
    if (html === null || html === undefined) {
        return '';
    }
    return sanitizeHtml(String(html), OPTIONS);
}

module.exports = { sanitizeRenderedHtml };
