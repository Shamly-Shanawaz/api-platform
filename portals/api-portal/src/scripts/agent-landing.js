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

// Agent pages: the listing filter, the "How to use" tabs, skill fold-outs and copy buttons. Copies read
// textContent and the script never builds HTML from agent data, so publisher content
// stays inert.
document.addEventListener('DOMContentLoaded', () => {
    // Listing: the way-of-use multi-select. Ticking keeps the menu open; closing it (click
    // outside, Escape, or the summary) applies a changed choice, as does Apply.
    document.querySelectorAll('[data-agent-filter]').forEach((form) => {
        const menu = form.querySelector('.agent-filter-menu');
        if (!menu) return;
        const boxes = [...form.querySelectorAll('input[name="type"]')];
        const chosen = () => boxes.filter((b) => b.checked).map((b) => b.value).join(',');
        let applied = chosen();
        const apply = () => {
            applied = chosen();
            form.submit();
        };
        menu.addEventListener('toggle', () => {
            if (!menu.open && chosen() !== applied) apply();
        });
        document.addEventListener('click', (event) => {
            if (menu.open && !menu.contains(event.target)) menu.open = false;
        });
        menu.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && menu.open) {
                menu.open = false;
                menu.querySelector('summary').focus();
            }
        });
        form.addEventListener('submit', () => { applied = chosen(); });
        const clear = form.querySelector('[data-agent-filter-clear]');
        if (clear) {
            clear.addEventListener('click', () => {
                boxes.forEach((b) => { b.checked = false; });
                apply();
            });
        }
        // Back/forward can restore the page with stale boxes: match the URL again.
        window.addEventListener('pageshow', () => {
            const wanted = new URLSearchParams(window.location.search).getAll('type');
            boxes.forEach((b) => { b.checked = wanted.includes(b.value); });
            applied = chosen();
            menu.open = false;
        });
        // The shared search box (search.js) loads ?query= alone; on the agent listing a search
        // keeps the chosen ways of use. Runs first (capture) and stops search.js's handler.
        const query = document.getElementById('query');
        if (query) {
            document.addEventListener('keypress', (event) => {
                if (event.target !== query || event.key !== 'Enter') return;
                event.stopPropagation();
                event.preventDefault();
                const params = new URLSearchParams();
                if (query.value) params.set('query', query.value);
                new URLSearchParams(window.location.search).getAll('type')
                    .forEach((type) => params.append('type', type));
                const search = params.toString();
                window.location.href = `${window.location.pathname}${search ? `?${search}` : ''}`;
            }, true);
        }
    });

    // Tabs: click, or arrow keys / Home / End on the tab list (WAI-ARIA tabs pattern).
    document.querySelectorAll('[data-agent-tabs]').forEach((tabs) => {
        const own = () => [...tabs.querySelectorAll('[data-tab-target]')]
            .filter((tab) => tab.closest('[data-agent-tabs]') === tabs);
        const select = (tab, focus) => {
            own().forEach((other) => {
                const active = other === tab;
                other.classList.toggle('agent-tab--active', active);
                other.setAttribute('aria-selected', String(active));
                other.setAttribute('tabindex', active ? '0' : '-1');
                const panel = document.getElementById(other.dataset.tabTarget);
                if (panel) panel.classList.toggle('d-none', !active);
            });
            if (focus) tab.focus();
        };
        own().forEach((tab) => {
            tab.addEventListener('click', () => select(tab, false));
            tab.addEventListener('keydown', (event) => {
                const list = own();
                const i = list.indexOf(tab);
                const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[event.key];
                if (next === undefined) return;
                event.preventDefault();
                select(list[(next + list.length) % list.length], true);
            });
        });
    });

    // A link to a tab panel (e.g. #agent-run from the Install button) opens that tab.
    const openTabFromHash = () => {
        let id;
        try {
            id = decodeURIComponent(window.location.hash.slice(1));
        } catch (error) {
            return; // A badly encoded link (e.g. #100%) opens the page as it is.
        }
        if (!id) return;
        const panel = document.getElementById(id);
        if (!panel || panel.getAttribute('role') !== 'tabpanel') return;
        const tab = [...document.querySelectorAll('[data-tab-target]')].find((t) => t.dataset.tabTarget === id);
        if (tab) tab.click();
        panel.closest('section')?.scrollIntoView({ block: 'start' });
    };
    openTabFromHash();
    window.addEventListener('hashchange', openTabFromHash);

    // The portal's Copy button (.copy-btn): "Copied" for a moment, as on API and MCP pages.
    const copy = async (button, text) => {
        try {
            await navigator.clipboard.writeText(text);
            button.classList.add('copy-btn--copied');
            clearTimeout(button.copyTimer);
            button.copyTimer = setTimeout(() => button.classList.remove('copy-btn--copied'), 1600);
        } catch (e) {
            console.warn('Copy failed', e);
        }
    };
    const copyButton = () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy-btn agent-code-copy';
        button.title = 'Copy';
        button.setAttribute('aria-label', 'Copy');
        const icon = document.createElement('span');
        icon.className = 'copy-btn-icon';
        icon.appendChild(Object.assign(document.createElement('i'), { className: 'bi bi-copy' }));
        const done = document.createElement('span');
        done.className = 'copy-btn-check';
        done.appendChild(Object.assign(document.createElement('i'), { className: 'bi bi-check' }));
        done.appendChild(document.createTextNode(' Copied'));
        button.append(icon, done);
        return button;
    };

    // A Copy button on every code block of the publisher's Markdown (Run it yourself setup guide). The block
    // keeps the portal's Markdown code style (as in API documents); only the button is added.
    document.querySelectorAll('[data-agent-copy-blocks] pre').forEach((pre) => {
        const wrap = document.createElement('div');
        wrap.className = 'agent-code agent-code--md';
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        const button = copyButton();
        button.addEventListener('click', () => copy(button, pre.textContent));
        wrap.insertBefore(button, pre);
    });

    // Skill fold-outs, as the MCP page's tools (no inline handlers here).
    document.querySelectorAll('[data-agent-accordion]').forEach((head) => {
        const toggle = () => {
            head.classList.toggle('open');
            head.setAttribute('aria-expanded', String(head.classList.contains('open')));
        };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
    });

    // Syntax colouring for the light code blocks, as on MCP pages (highlight.js is optional).
    if (window.hljs) {
        document.querySelectorAll('.mc-json-block pre code').forEach((code) => window.hljs.highlightElement(code));
    }

    document.querySelectorAll('[data-copy-target]').forEach((button) => {
        button.addEventListener('click', () => {
            const source = document.getElementById(button.dataset.copyTarget);
            if (source) copy(button, source.textContent);
        });
    });
});
