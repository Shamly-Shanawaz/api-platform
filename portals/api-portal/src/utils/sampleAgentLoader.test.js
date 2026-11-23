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
 * Design mode reads agents from samples/agents/ through the same intake as POST /agents.
 * Every bundled sample must load (a sample the API would refuse is silently left out of
 * design mode, so this is where a drifted sample shows up). Runs in a child process with
 * a design-mode config, since the loader reads the loaded configuration.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

test('every bundled agent sample loads in design mode, shaped for the agent pages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sal-'));
    try {
        const cfg = path.join(dir, 'config.toml');
        fs.writeFileSync(cfg, '[api_portal.artifacts]\nenabled_types = ["apis", "agents"]\n\n'
            + '[api_portal.design_mode]\nenabled = true\n');
        const probe = path.join(dir, 'probe.js');
        fs.writeFileSync(probe, `
            const loader = require(${JSON.stringify(path.join(ROOT, 'src/utils/sampleAgentLoader'))});
            const all = loader.loadAll();
            const one = loader.loadOne('invoice-triage-agent');
            process.stdout.write('PROBE_JSON:' + JSON.stringify({
                handles: all.map((s) => s.metadata.handle).sort(),
                folders: require('fs').readdirSync(${JSON.stringify(path.join(ROOT, 'samples/agents'))}).length,
                one: one && { type: one.metadata.type, kinds: one.metadata.agent.types,
                    definitions: Object.keys(one.definitions), docs: one.docs.map((d) => d.name) },
                traversal: loader.loadOne('../apis'),
                missing: loader.loadOne('no-such-agent'),
            }) + '\\n');
            process.exit(0);
        `);
        const run = spawnSync(process.execPath, [probe, '--config', cfg], {
            cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
        });
        assert.equal(run.status, 0, run.stderr);
        const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE_JSON:'));
        assert.ok(line, run.stdout + run.stderr);
        const out = JSON.parse(line.slice('PROBE_JSON:'.length));

        assert.equal(out.handles.length, out.folders, `a sample was left out: loaded ${out.handles.join(', ')}`);
        assert.equal(out.one.type, 'Agent');
        assert.deepEqual(out.one.kinds, ['API']);
        assert.deepEqual(out.one.definitions, ['AGENT_CARD']);
        assert.ok(out.one.docs.length > 0);
        assert.equal(out.traversal, null);
        assert.equal(out.missing, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
