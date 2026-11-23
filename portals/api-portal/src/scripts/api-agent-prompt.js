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

let _agentMdUrl = '';

// Agent pages carry the agent's name and ways of use on #agentPromptData (data-*
// attributes, so the values arrive escaped); the prompt is worded for an agent.
function readAgentPromptData() {
    const el = document.getElementById('agentPromptData');
    return el ? { name: el.dataset.name || '', kinds: el.dataset.kinds || '' } : null;
}

function buildAgentPrompt(mdUrl) {
    const agent = readAgentPromptData();
    if (agent) {
        const kinds = agent.kinds ? ` It can be used this way: ${agent.kinds}.` : '';
        return `Please fetch the details of the "${agent.name}" agent from the following URL:\n\n${mdUrl}\n\n`
            + `It is an AI agent published in this portal.${kinds} Once you've read it, provide a structured summary covering:\n`
            + '- What the agent does, and the skills it offers\n'
            + '- Each way to use it (A2A, REST, events, or running it yourself), with its address\n'
            + '- How to authenticate, and how to get credentials from this portal\n'
            + '- An example request for one of its skills\n\n'
            + "Then ask me what I'd like the agent to do, with a few sample requests based on its skills.";
    }
    return `Please fetch the API details from the following URL:\n\n${mdUrl}\n\nOnce you've read it, provide a structured summary covering:\n- What this API does\n- Authentication mechanisms and how to obtain credentials\n- Available endpoints\n- Main resources and key fields in their responses\n\nThen ask me what I'd like to do with it, with a few sample options to choose from.`;
}

function copyAgentPrompt() {
    const text = document.getElementById('apiAgentPromptText').textContent;
    const btn = document.getElementById('apiBtnCopyPrompt');
    navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copy-btn--copied');
        if (btn._copyTimer) clearTimeout(btn._copyTimer);
        btn._copyTimer = setTimeout(() => { btn.classList.remove('copy-btn--copied'); }, 1600);
    });
}

function downloadAgentPrompt(apiName) {
    const text = document.getElementById('apiAgentPromptText').textContent;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = apiName + '.txt';
    a.click();
    URL.revokeObjectURL(url);
}

function toggleApiRunDropdown(event) {
    event.stopPropagation();
    document.getElementById('apiRunDropdownMenu').classList.toggle('show');
}

function runApiPromptInClaude() {
    const text = _agentMdUrl
        ? buildAgentPrompt(_agentMdUrl + '?request-id=' + Math.floor(Math.random() * 1e10))
        : document.getElementById('apiAgentPromptText').textContent;
    window.open('https://claude.ai/new?q=' + encodeURIComponent(text), '_blank');
}

function runApiPromptInChatGPT() {
    const text = document.getElementById('apiAgentPromptText').textContent;
    window.open('https://chatgpt.com/?prompt=' + encodeURIComponent(text), '_blank');
    document.getElementById('apiRunDropdownMenu').classList.remove('show');
}

function addRipple(btn, e) {
    const existing = btn.querySelector('.btn-ripple');
    if (existing) existing.remove();
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    Object.assign(ripple.style, {
        position: 'absolute', borderRadius: '50%',
        width: size + 'px', height: size + 'px',
        left: x + 'px', top: y + 'px',
        background: 'rgba(255,255,255,0.35)',
        transform: 'scale(0)', pointerEvents: 'none',
        animation: 'btn-ripple-anim 0.55s ease-out forwards',
    });
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
}

document.addEventListener('DOMContentLoaded', () => {
    let apiName = '';

    const aiBtn = document.querySelector('.btn-icon-ai');
    if (aiBtn) aiBtn.addEventListener('click', (e) => addRipple(aiBtn, e));

    const dataEl = document.getElementById('apiAgentData');
    if (dataEl) {
        try {
            const data = JSON.parse(dataEl.textContent);
            // MCP servers are served from /mcp/{handle}.md rather than /api/{handle}.md,
            // so the segment comes from the page. Defaults to 'api' for the API pages.
            const resourcePath = data.resourcePath || 'api';
            const mdUrl = window.location.origin + data.baseUrl + '/' + resourcePath + '/' + data.id + '.md';
            _agentMdUrl = mdUrl;
            apiName = data.id;

            const modalEl = document.getElementById('apiAgentPromptModal');
            if (modalEl) {
                modalEl.addEventListener('show.bs.modal', function () {
                    document.getElementById('apiAgentPromptText').textContent = buildAgentPrompt(mdUrl);
                });
            }
        } catch (e) {
            console.error('Failed to parse apiAgentData:', e);
        }
    }

    const apiBtnCopyPrompt = document.getElementById('apiBtnCopyPrompt');
    if (apiBtnCopyPrompt) apiBtnCopyPrompt.addEventListener('click', copyAgentPrompt);

    const apiBtnDownloadPrompt = document.getElementById('apiBtnDownloadPrompt');
    if (apiBtnDownloadPrompt) apiBtnDownloadPrompt.addEventListener('click', () => downloadAgentPrompt(apiName));

    const apiBtnRunPrompt = document.getElementById('apiBtnRunPrompt');
    if (apiBtnRunPrompt) apiBtnRunPrompt.addEventListener('click', toggleApiRunDropdown);

    const apiBtnRunClaude = document.getElementById('apiBtnRunClaude');
    if (apiBtnRunClaude) apiBtnRunClaude.addEventListener('click', runApiPromptInClaude);

    const apiBtnRunChatGPT = document.getElementById('apiBtnRunChatGPT');
    if (apiBtnRunChatGPT) apiBtnRunChatGPT.addEventListener('click', runApiPromptInChatGPT);

    document.addEventListener('click', () => {
        const menu = document.getElementById('apiRunDropdownMenu');
        if (menu) menu.classList.remove('show');
    });
});
