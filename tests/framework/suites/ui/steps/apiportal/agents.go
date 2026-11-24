/*
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
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
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package apiportal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"

	"github.com/cucumber/godog"
	playwright "github.com/mxschmitt/playwright-go"

	"github.com/wso2/api-platform/tests/framework/core/cleanup"
	"github.com/wso2/api-platform/tests/framework/core/util/retry"
	"github.com/wso2/api-platform/tests/framework/core/util/tcontext"
	"github.com/wso2/api-platform/tests/framework/core/util/unique"
)

// KindAPIPortalAgent identifies an agent (kind: Agent) owned by the API Portal test plane.
var KindAPIPortalAgent = cleanup.Kind{Name: "api-portal-agent", Order: 52}

const (
	keyAgentListingREST  = "uiAPIPortalAgentListingREST"
	keyAgentListingLocal = "uiAPIPortalAgentListingLocal"
	keyAgentPageMulti    = "uiAPIPortalAgentPageMulti"
	keyAgentWizardA2A    = "uiAPIPortalAgentWizardA2A"
	keyAgentWizardREST   = "uiAPIPortalAgentWizardREST"
	keyAgentKeysKM       = "uiAPIPortalAgentKeysKM"
	keyAgentKeysPlainKM  = "uiAPIPortalAgentKeysPlainKM"

	agentAPIVersion  = "api-portal.api-platform.wso2.com/v1alpha1"
	agentEndpoint    = "https://agents.example.invalid/wizard"
	agentRunMarkdown = "# Run it\n\n<script>window.__agentXss = 1</script>\n\n```bash\nnpx @acme/tool run\n```\n\n[click](javascript:alert(1))\n"
	agentOpenAPI     = "openapi: 3.1.0\ninfo:\n  title: Fields\n  version: \"1\"\npaths:\n  /run:\n    post:\n      summary: Run\n"
	agentAsyncAPI    = `{"asyncapi":"3.0.0","info":{"title":"Invoices","version":"1"},` +
		`"channels":{"received":{"address":"invoices.received","messages":{"InvoiceReceived":{"payload":{"type":"object",` +
		`"properties":{"invoiceId":{"type":"string"},"decision":{"enum":["APPROVE","HOLD"]}}}}}}},` +
		`"operations":{"send":{"action":"receive","channel":{"$ref":"#/channels/received"}}}}`
)

// agentSettingsRow locates an agent's row in Settings → Agents.
func agentSettingsRow(page playwright.Page, id string) playwright.Locator {
	return page.Locator(`[id="cfg-agent-row-` + id + `"]`)
}

// agentCard returns an Agent Card naming the agent, with one skill.
func agentCard(name string) string {
	card, _ := json.Marshal(map[string]any{
		"name": name, "version": "2.0.0", "description": "From the card.",
		"supportedInterfaces": []map[string]string{{"url": agentEndpoint, "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}},
		"skills":              []map[string]any{{"id": "summarize", "name": "Summarize notes", "description": "Turns notes into a summary.", "tags": []string{"notes"}}},
	})
	return string(card)
}

// registerAgentSteps wires the agent catalogue, Settings → Agents and Agent Keys journeys.
func (u *Steps) registerAgentSteps(sc *godog.ScenarioContext) {
	sc.Step(`^the API Portal has agent catalogue fixtures$`, u.seedAgentCatalogue)
	sc.Step(`^the agent listing shows each agent with its ways of use, and no Subscribe without plans$`, u.agentListingShowsAgents)
	sc.Step(`^the user filters the agent listing by Run it yourself, then also by REST$`, u.filterAgentListing)
	sc.Step(`^the agent listing search finds the REST agent by one of its skills$`, u.searchAgentBySkill)
	sc.Step(`^the API listing does not list the agents$`, u.apiListingOmitsAgents)
	sc.Step(`^the multi-way agent page shows one tab per way of use, and the tabs follow the keyboard$`, u.agentPageTabs)
	sc.Step(`^Install opens Run it yourself, with the setup guide's HTML cleaned$`, u.agentInstallOpensRun)
	sc.Step(`^the agent's Documentation opens its first definition, and the AsyncAPI offers Download$`, u.agentDocumentation)
	sc.Step(`^the Try with AI dialog speaks of the agent, not an API$`, u.agentTryWithAI)
	sc.Step(`^the administrator adds an A2A agent in the wizard, and its Agent Card fills the details$`, u.addA2AAgentInWizard)
	sc.Step(`^the administrator edits that agent with the same steps, keeping what the form does not show$`, u.editAgentInWizard)
	sc.Step(`^the administrator deprecates that agent from its row menu$`, u.deprecateAgent)
	sc.Step(`^the administrator adds a REST agent in the wizard, correcting what the form and the server refuse$`, u.addRESTAgentInWizard)
	sc.Step(`^Settings → Agents offers no import or download actions, and a dialog closes when its background is clicked$`, u.agentSettingsActions)
	sc.Step(`^the administrator deletes two agents together from the bulk bar, and one from its row menu$`, u.deleteAgentsInSettings)
	sc.Step(`^the API Portal has a key manager that makes agent keys and one that does not$`, u.seedAgentKeyManagers)
	sc.Step(`^the key manager form offers an agent registration endpoint only for a type that makes agent keys$`, u.keyManagerFormAgentEndpoint)
	sc.Step(`^the developer's Agent Keys page offers only the key manager that makes agent keys, with the grants to choose$`, u.agentKeysPage)
	sc.Step(`^the developer's OAuth2 Keys page offers both key managers for application keys$`, u.oauth2KeysPageOffersBoth)
}

// agentFile is a definition file sent with an agent.
type agentFile struct {
	field, name, content string
}

// seedAgent creates an agent through the signed-in session, registering it for cleanup first so
// a create that succeeds but fails to answer is still removed.
func (u *Steps) seedAgent(ctx context.Context, page playwright.Page, id string, spec map[string]any, files ...agentFile) error {
	if err := cleanup.Register(ctx, cleanup.Resource{Kind: KindAPIPortalAgent, ID: id, Actor: u.topo.Admin.Username}); err != nil {
		return fmt.Errorf("registering agent %s for cleanup: %w", id, err)
	}
	document := map[string]any{"apiVersion": agentAPIVersion, "kind": "Agent", "metadata": map[string]string{"name": id}, "spec": spec}
	metadata, err := json.Marshal(document)
	if err != nil {
		return err
	}
	// The page serializes only []any and map[string]any arguments.
	parts := make([]any, 0, len(files))
	for _, file := range files {
		parts = append(parts, map[string]any{"field": file.field, "name": file.name, "content": file.content})
	}
	result, err := page.Evaluate(`async ({metadata, files}) => {
        const token = document.cookie.split('; ').find(v => v.startsWith('XSRF-TOKEN='));
        const form = new FormData();
        form.append('metadata', metadata);
        for (const file of files) form.append(file.field, new Blob([file.content]), file.name);
        const response = await fetch('/api-portal/api/v0.9/agents', {
            method: 'POST',
            headers: { organization: 'default', 'X-CSRF-Token': token ? decodeURIComponent(token.split('=').slice(1).join('=')) : '' },
            body: form,
        });
        return { status: response.status, body: await response.text() };
    }`, map[string]any{"metadata": string(metadata), "files": parts})
	if err != nil {
		return fmt.Errorf("creating agent %s: %w", id, err)
	}
	fields, _ := result.(map[string]any)
	status := 0
	if number, ok := fields["status"].(float64); ok {
		status = int(number)
	} else if number, ok := fields["status"].(int); ok {
		status = number
	}
	if status != http.StatusCreated {
		return fmt.Errorf("creating agent %s answered %d: %v", id, status, fields["body"])
	}
	return nil
}

// agentSpec returns a published agent's spec with the given ways of use.
func agentSpec(name string, types []string, extra map[string]any) map[string]any {
	spec := map[string]any{"displayName": name, "version": "v1.0", "description": "An agent for the UI journeys.",
		"status": "PUBLISHED", "types": types}
	for key, value := range extra {
		spec[key] = value
	}
	return spec
}

// uniqueAgent returns a unique agent handle and its display name.
func uniqueAgent(ctx context.Context, prefix, label string) (string, string, error) {
	generated, err := unique.Unique(ctx, prefix)
	if err != nil {
		return "", "", err
	}
	id := wizardHandle(generated)
	return id, label + " " + id, nil
}

// agentFixture reads a stored agent handle.
func agentFixture(ctx context.Context, key string) (string, error) {
	value, ok := tcontext.Get(ctx, key)
	id, _ := value.(string)
	if !ok || id == "" {
		return "", fmt.Errorf("agent fixture %q is not set", key)
	}
	return id, nil
}

// seedAgentCatalogue adds a REST agent with a skill, a run-it-yourself agent, and a multi-way
// agent whose setup guide holds a script.
func (u *Steps) seedAgentCatalogue(ctx context.Context) error {
	page, err := u.page(ctx)
	if err != nil {
		return err
	}
	restID, restName, err := uniqueAgent(ctx, "agent-listing-rest", "IT Listing Agent REST")
	if err != nil {
		return err
	}
	if err := u.seedAgent(ctx, page, restID, agentSpec(restName, []string{"API"}, map[string]any{
		"skills":     []map[string]string{{"id": "reconcile", "name": "Reconcile ledgers", "description": "Matches entries"}},
		"interfaces": []map[string]any{{"type": "REST", "endpoints": map[string]string{"productionUrl": "https://agents.example.invalid/rest"}}},
	}), agentFile{"restDefinition", "openapi.yaml", agentOpenAPI}); err != nil {
		return err
	}
	localID, localName, err := uniqueAgent(ctx, "agent-listing-local", "IT Listing Agent Local")
	if err != nil {
		return err
	}
	if err := u.seedAgent(ctx, page, localID, agentSpec(localName, []string{"LOCAL"}, nil),
		agentFile{"localDefinition", "run-locally.md", "# Run it\n\n```bash\nnpx @acme/tool run\n```\n"}); err != nil {
		return err
	}
	multiID, multiName, err := uniqueAgent(ctx, "agent-page-multi", "IT Page Agent Multi")
	if err != nil {
		return err
	}
	if err := u.seedAgent(ctx, page, multiID, agentSpec(multiName, []string{"API", "EVENT", "LOCAL"}, map[string]any{
		"interfaces": []map[string]any{
			{"type": "REST", "endpoints": map[string]string{"productionUrl": "https://agents.example.invalid/rest"}},
			{"type": "EVENT"},
		},
	}), agentFile{"restDefinition", "openapi.yaml", agentOpenAPI}, agentFile{"eventDefinition", "asyncapi.json", agentAsyncAPI},
		agentFile{"localDefinition", "run-locally.md", agentRunMarkdown}); err != nil {
		return err
	}
	return wizardAll(
		func() error { return tcontext.Set(ctx, keyAgentListingREST, restID) },
		func() error { return tcontext.Set(ctx, keyAgentListingLocal, localID) },
		func() error { return tcontext.Set(ctx, keyAgentPageMulti, multiID) },
	)
}

// openAgentListing opens the agent listing at path and waits for the cards of the ids.
func (u *Steps) openAgentListing(ctx context.Context, path string, ids ...string) (playwright.Page, error) {
	page, err := u.page(ctx)
	if err != nil {
		return nil, err
	}
	if err := u.openAPIPortalPath(ctx, path); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if err := u.expect.Locator(page.Locator("#agentCard-" + id)).ToHaveCount(1); err != nil {
			return nil, fmt.Errorf("the agent listing %s does not show %s: %w", path, id, err)
		}
	}
	return page, nil
}

// agentListingShowsAgents checks the listing's cards, kind chips, search box and way-of-use menu,
// newest first, and that the card opens the agent.
func (u *Steps) agentListingShowsAgents(ctx context.Context) error {
	restID, err := agentFixture(ctx, keyAgentListingREST)
	if err != nil {
		return err
	}
	localID, err := agentFixture(ctx, keyAgentListingLocal)
	if err != nil {
		return err
	}
	page, err := u.openAgentListing(ctx, "/agents", restID, localID)
	if err != nil {
		return err
	}
	rest := page.Locator("#agentCard-" + restID)
	local := page.Locator("#agentCard-" + localID)
	if err := wizardAll(
		u.wizardContains(page, ".apilist-results-heading", "Agents"),
		func() error {
			return u.expect.Locator(rest.Locator(".agent-card-kinds .agent-kind-chip--REST")).ToContainText("REST")
		},
		func() error { return u.expect.Locator(rest.Locator(".api-card-footer")).ToHaveCount(0) },
		func() error { return u.expect.Locator(rest).Not().ToContainText("No plans needed") },
		func() error {
			return u.expect.Locator(local.Locator(".agent-card-kinds .agent-kind-chip--LOCAL")).ToContainText("Run it yourself")
		},
		func() error { return u.expect.Locator(page.Locator(".search-container #query")).ToHaveCount(1) },
		u.wizardContains(page, "#agent-type-filter", "All ways of use"),
		func() error {
			return u.expect.Locator(page.Locator(".agent-filter-option")).ToHaveText([]string{"A2A", "REST", "Events", "Run it yourself"})
		},
		func() error { return u.expect.Locator(page.Locator(".api-card .dp-badge--protocol")).ToHaveCount(0) },
	); err != nil {
		return err
	}
	// Newest first: the run-it-yourself agent was added after the REST agent.
	ids, err := page.Locator(".api-card[id^='agentCard-']").EvaluateAll(`cards => cards.map(card => card.id)`)
	if err != nil {
		return err
	}
	order := fmt.Sprint(ids)
	if strings.Index(order, "agentCard-"+localID) > strings.Index(order, "agentCard-"+restID) {
		return fmt.Errorf("the agent listing does not show the newest agent first: %s", order)
	}
	if err := rest.Locator(".api-card-top").Click(); err != nil {
		return fmt.Errorf("opening the REST agent from its card: %w", err)
	}
	return u.expect.Page(page).ToHaveURL(regexp.MustCompile("/agent/" + regexp.QuoteMeta(restID) + "$"))
}

// filterAgentListing narrows the listing with the way-of-use menu: one way, then two, then clears
// it.
func (u *Steps) filterAgentListing(ctx context.Context) error {
	restID, err := agentFixture(ctx, keyAgentListingREST)
	if err != nil {
		return err
	}
	multiID, err := agentFixture(ctx, keyAgentPageMulti)
	if err != nil {
		return err
	}
	localID, err := agentFixture(ctx, keyAgentListingLocal)
	if err != nil {
		return err
	}
	page, err := u.openAgentListing(ctx, "/agents", restID, localID)
	if err != nil {
		return err
	}
	option := func(text string) playwright.Locator {
		return page.Locator(".agent-filter-option").Filter(playwright.LocatorFilterOptions{HasText: regexp.MustCompile(`^\s*` + text + `\s*$`)}).Locator("input")
	}
	return wizardAll(
		wizardClick(page, "#agent-type-filter"),
		func() error { return option("Run it yourself").Check() },
		wizardClick(page, ".agent-filter-apply"),
		func() error { return u.expect.Page(page).ToHaveURL(regexp.MustCompile(`type=LOCAL`)) },
		u.wizardContains(page, "#agent-type-filter", "Run it yourself"),
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + localID)).ToHaveCount(1) },
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + restID)).ToHaveCount(0) },
		// A second way: closing the menu applies it, and only agents offering both are listed.
		wizardClick(page, "#agent-type-filter"),
		func() error { return option("REST").Check() },
		wizardClick(page, ".apilist-results-heading"),
		func() error {
			return u.expect.Page(page).ToHaveURL(regexp.MustCompile(`type=LOCAL.*type=REST|type=REST.*type=LOCAL`))
		},
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + localID)).ToHaveCount(0) },
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + restID)).ToHaveCount(0) },
		// The multi-way agent offers both, so it is the one listed.
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + multiID)).ToHaveCount(1) },
		wizardClick(page, "#agent-type-filter"),
		wizardClick(page, "[data-agent-filter-clear]"),
		func() error { return u.expect.Page(page).Not().ToHaveURL(regexp.MustCompile(`type=`)) },
		u.wizardContains(page, "#agent-type-filter", "All ways of use"),
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + restID)).ToHaveCount(1) },
	)
}

// searchAgentBySkill searches the listing for a skill name and checks the match note.
func (u *Steps) searchAgentBySkill(ctx context.Context) error {
	restID, err := agentFixture(ctx, keyAgentListingREST)
	if err != nil {
		return err
	}
	localID, err := agentFixture(ctx, keyAgentListingLocal)
	if err != nil {
		return err
	}
	page, err := u.openAgentListing(ctx, "/agents", restID, localID)
	if err != nil {
		return err
	}
	return wizardAll(
		wizardFill(page, "#query", "Reconcile"),
		func() error { return page.Locator("#query").Press("Enter") },
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + restID)).ToHaveCount(1) },
		func() error {
			return u.expect.Locator(page.Locator("#agentCard-" + restID + " .agent-match-note")).ToContainText("Reconcile ledgers")
		},
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + localID)).ToHaveCount(0) },
	)
}

// apiListingOmitsAgents checks the API listing has no card for the REST agent, which the agent
// listing shows.
func (u *Steps) apiListingOmitsAgents(ctx context.Context) error {
	restID, err := agentFixture(ctx, keyAgentListingREST)
	if err != nil {
		return err
	}
	page, err := u.openAgentListing(ctx, "/agents", restID)
	if err != nil {
		return err
	}
	if err := u.openAPIPortalPath(ctx, "/apis"); err != nil {
		return err
	}
	if err := u.expect.Page(page).ToHaveURL(regexp.MustCompile(`/views/default/apis$`)); err != nil {
		return err
	}
	return wizardAll(
		func() error { return u.expect.Locator(page.Locator("#agentCard-" + restID)).ToHaveCount(0) },
		func() error { return u.expect.Locator(page.Locator("#apiCard-" + restID)).ToHaveCount(0) },
		func() error {
			return u.expect.Locator(page.Locator("body")).Not().ToContainText("IT Listing Agent REST " + restID)
		},
	)
}

// openAgentPage opens an agent's page and waits for its tabs or body.
func (u *Steps) openAgentPage(ctx context.Context, id string) (playwright.Page, error) {
	if err := u.openPortalPage(ctx, "/agent/"+id); err != nil {
		return nil, err
	}
	page, err := u.page(ctx)
	if err != nil {
		return nil, err
	}
	if err := u.expect.Locator(page.Locator("[data-agent-docs-link]")).ToBeVisible(); err != nil {
		return nil, err
	}
	return page, nil
}

// agentPageTabs checks one tab per way of use, in order, with the REST tab's endpoint, operation
// and skills, and that the arrow and End keys move between tabs.
func (u *Steps) agentPageTabs(ctx context.Context) error {
	id, err := agentFixture(ctx, keyAgentPageMulti)
	if err != nil {
		return err
	}
	page, err := u.openAgentPage(ctx, id)
	if err != nil {
		return err
	}
	return wizardAll(
		func() error {
			return u.expect.Locator(page.Locator(`[role="tablist"] [role="tab"]`)).ToHaveText([]string{"REST", "Events", "Run it yourself"})
		},
		func() error {
			return u.expect.Locator(page.Locator("#agent-use-REST")).Not().ToHaveClass(regexp.MustCompile(`\bd-none\b`))
		},
		u.wizardContains(page, "#agent-use-REST .aov-endpoint-card", "Production"),
		u.wizardVisible(page, "#agent-use-REST .aov-endpoint-card .copy-btn"),
		u.wizardContains(page, "#agent-use-REST .aov-method-badge--POST", "POST"),
		func() error { return page.Locator("#agent-use-REST-tab").Focus() },
		wizardPress(page, "ArrowRight"),
		u.wizardHasAttribute(page, "#agent-use-EVENT-tab", "aria-selected", "true"),
		u.wizardFocused(page, "#agent-use-EVENT-tab"),
		u.wizardContains(page, "#agent-use-EVENT", "invoices.received"),
		u.wizardContains(page, "#agent-use-EVENT .aov-channel-badge--pub", "SEND"),
		func() error {
			return u.expect.Locator(page.Locator("#agent-use-EVENT")).Not().ToContainText("APPROVE | HOLD")
		},
		func() error {
			return u.expect.Locator(page.Locator("#agent-use-REST")).ToHaveClass(regexp.MustCompile(`\bd-none\b`))
		},
		wizardPress(page, "End"),
		func() error {
			return u.expect.Locator(page.Locator("#agent-run")).Not().ToHaveClass(regexp.MustCompile(`\bd-none\b`))
		},
	)
}

// agentInstallOpensRun clicks Install and checks the setup guide is rendered without its script
// or javascript: link, and that the script never ran.
func (u *Steps) agentInstallOpensRun(ctx context.Context) error {
	id, err := agentFixture(ctx, keyAgentPageMulti)
	if err != nil {
		return err
	}
	page, err := u.openAgentPage(ctx, id)
	if err != nil {
		return err
	}
	if err := page.Locator("a").Filter(playwright.LocatorFilterOptions{HasText: regexp.MustCompile(`^\s*Install\s*$`)}).First().Click(); err != nil {
		return fmt.Errorf("clicking Install: %w", err)
	}
	if err := wizardAll(
		func() error {
			return u.expect.Locator(page.Locator("#agent-run")).Not().ToHaveClass(regexp.MustCompile(`\bd-none\b`))
		},
		u.wizardContains(page, "#agent-run", "npx @acme/tool run"),
		func() error { return u.expect.Locator(page.Locator("#agent-run script")).ToHaveCount(0) },
		func() error {
			return u.expect.Locator(page.Locator(`#agent-run a[href^="javascript:"]`)).ToHaveCount(0)
		},
		func() error {
			return u.expect.Locator(page.Locator("#agent-run .agent-code-copy").First()).ToBeAttached()
		},
	); err != nil {
		return err
	}
	ran, err := page.Evaluate(`() => window.__agentXss === undefined`)
	if err != nil {
		return err
	}
	if ran != true {
		return fmt.Errorf("the setup guide's script ran on the agent page")
	}
	return nil
}

// agentDocumentation follows the Documentation button to the first definition and checks the
// AsyncAPI viewer's Download link.
func (u *Steps) agentDocumentation(ctx context.Context) error {
	id, err := agentFixture(ctx, keyAgentPageMulti)
	if err != nil {
		return err
	}
	page, err := u.openAgentPage(ctx, id)
	if err != nil {
		return err
	}
	if err := wizardAll(
		u.wizardHasAttribute(page, "[data-agent-docs-link]", "href", regexp.MustCompile(`/docs/specification$`)),
		func() error {
			return u.expect.Locator(page.Locator("#agent-docs-nav")).Not().ToHaveAttribute("hidden", "")
		},
		u.wizardHasAttribute(page, "#agent-docs-nav", "href", regexp.MustCompile(`/docs/specification$`)),
		wizardClick(page, "[data-agent-docs-link]"),
		func() error { return u.expect.Page(page).ToHaveURL(regexp.MustCompile(`/docs/specification/openapi$`)) },
		u.wizardContains(page, ".adoc-nav", "SPECIFICATION"),
		u.wizardContains(page, ".adoc-nav", "AsyncAPI"),
	); err != nil {
		return err
	}
	if err := u.openPortalPage(ctx, "/agent/"+id+"/docs/specification/asyncapi"); err != nil {
		return err
	}
	return u.wizardHasAttribute(page, ".agent-spec-bar a[download]", "href",
		regexp.MustCompile(`/agents/`+regexp.QuoteMeta(id)+`/assets\?type=AGENT_EVENT_DEFINITION`))()
}

// agentTryWithAI checks the Try with AI dialog speaks of the agent.
func (u *Steps) agentTryWithAI(ctx context.Context) error {
	id, err := agentFixture(ctx, keyAgentPageMulti)
	if err != nil {
		return err
	}
	page, err := u.openAgentPage(ctx, id)
	if err != nil {
		return err
	}
	info := page.Locator("#apiAgentPromptModal .hero-modal-info-text")
	return wizardAll(
		func() error { return u.expect.Locator(info).ToContainText("discover and call this agent") },
		func() error { return u.expect.Locator(info).Not().ToContainText("this API") },
	)
}

// openAgentsPanel opens Settings → Agents.
func (u *Steps) openAgentsPanel(ctx context.Context) (playwright.Page, error) {
	return u.openSettingsPanel(ctx, "cfg-agents")
}

// storedAgent reads an agent through the signed-in session.
func (u *Steps) storedAgent(page playwright.Page, id string) (int, map[string]any, error) {
	status, body, err := u.portalCall(page, http.MethodGet, "/agents/"+url.PathEscape(id), nil)
	if err != nil || status != http.StatusOK {
		return status, nil, err
	}
	var agent map[string]any
	if err := json.Unmarshal([]byte(body), &agent); err != nil {
		return status, nil, fmt.Errorf("decoding agent %s: %w", id, err)
	}
	return status, agent, nil
}

// agentDocumentSpec reads an agent's stored document spec.
func (u *Steps) agentDocumentSpec(page playwright.Page, id string) (map[string]any, error) {
	status, agent, err := u.storedAgent(page, id)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("GET /agents/%s answered %d", id, status)
	}
	document, _ := agent["document"].(map[string]any)
	spec, _ := document["spec"].(map[string]any)
	if spec == nil {
		return nil, fmt.Errorf("agent %s has no document spec", id)
	}
	return spec, nil
}

// jsonEqual compares a decoded JSON value with a JSON text.
func jsonEqual(got any, want string) bool {
	var expected any
	if err := json.Unmarshal([]byte(want), &expected); err != nil {
		return false
	}
	return reflect.DeepEqual(got, expected)
}

// formGroupError locates the error under the form group holding the selector.
func formGroupError(page playwright.Page, selector string) playwright.Locator {
	return page.Locator(".cfg-form-group").Filter(playwright.LocatorFilterOptions{Has: page.Locator(selector)}).Locator(".ag-field-error")
}

// addA2AAgentInWizard adds an A2A agent: Interfaces first, then the card fills the details, which
// stay out of the document unless the administrator changes them.
func (u *Steps) addA2AAgentInWizard(ctx context.Context) error {
	id, name, err := uniqueAgent(ctx, "agent-wizard", "IT Wizard Agent")
	if err != nil {
		return err
	}
	if err := cleanup.Register(ctx, cleanup.Resource{Kind: KindAPIPortalAgent, ID: id, Actor: u.topo.Admin.Username}); err != nil {
		return err
	}
	if err := tcontext.Set(ctx, keyAgentWizardA2A, id); err != nil {
		return err
	}
	page, err := u.openAgentsPanel(ctx)
	if err != nil {
		return err
	}
	card := wizardFile("agent-card.json", "application/json", []byte(agentCard(name)))
	if err := wizardAll(
		wizardClick(page, "#ag-add-btn"),
		u.wizardVisible(page, "#cfg-agents-wizard"),
		func() error {
			return u.expect.Locator(page.Locator("#cfg-agents-wizard .cfg-step-label")).ToHaveText(
				[]string{"Interfaces", "Details", "Skills and identity", "Assets"})
		},
		u.wizardVisible(page, "#ag-wstep-0"),
		// Client-side checks show under their fields.
		wizardClick(page, "#ag-wz-next"),
		u.wizardContains(page, "#ag-wstep-0 .ag-field-error", "Pick at least one way to use the agent."),
		u.wizardHidden(page, "#ag-wz-errors"),
		func() error { return page.Locator("#ag-use-a2a").Check() },
		func() error {
			return u.expect.Locator(page.Locator(`.ag-iface[data-ag-kind="A2A"]`)).ToHaveClass(regexp.MustCompile(`\bis-on\b`))
		},
		func() error {
			return u.expect.Locator(page.Locator(`.ag-iface[data-ag-kind="REST"]`)).Not().ToHaveClass(regexp.MustCompile(`\bis-on\b`))
		},
		wizardFill(page, "#ag-a2a-prod", agentEndpoint),
		func() error { return u.expect.Locator(page.Locator("#ag-a2a-binding")).ToHaveCount(0) },
		wizardClick(page, "#ag-wz-next"),
		func() error {
			return u.expect.Locator(formGroupError(page, `[data-ag-file="a2a"]`)).ToContainText("Agent Card")
		},
		wizardChoose(page, "#ag-a2a-file", card),
		u.wizardContains(page, "#ag-a2a-chip", "agent-card.json"),
		wizardClick(page, `[data-ag-file="a2a"] .ag-file-remove`),
		u.wizardHidden(page, "#ag-a2a-chip"),
		wizardChoose(page, "#ag-a2a-file", card),
		wizardClick(page, "#ag-wz-next"),
		// Details are filled from the card and tagged so.
		u.wizardVisible(page, "#ag-wstep-1"),
		u.wizardHasValue(page, "#ag-name", name),
		u.wizardHasValue(page, "#ag-version", "2.0.0"),
		u.wizardVisible(page, `[data-ag-from-card="displayName"]`),
		u.wizardHidden(page, ".ag-listing-required >> nth=0"),
		wizardFill(page, "#ag-handle", id),
		// A changed value is the administrator's own: no tag.
		wizardFill(page, "#ag-version", "v2"),
		u.wizardHidden(page, `[data-ag-from-card="version"]`),
		wizardClick(page, "#ag-wz-next"),
		// Skills come from the card, then the model.
		u.wizardVisible(page, "#ag-wstep-2"),
		u.wizardHidden(page, "#ag-sec-skills"),
		u.wizardVisible(page, "#ag-sec-card-skills"),
		u.wizardContains(page, "#ag-card-skills-list", "Summarize notes"),
		u.wizardHasText(page, "#ag-card-skills-count", "1"),
		func() error { return u.expect.Locator(page.Locator("#ag-models .ag-model")).ToHaveCount(1) },
		wizardClick(page, "#ag-wz-next"),
		u.wizardVisible(page, "#ag-wstep-3"),
		u.wizardContains(page, "#ag-wz-next", "Save agent"),
		wizardClick(page, "#ag-wz-next"),
	); err != nil {
		return err
	}
	if err := u.expect.Locator(agentSettingsRow(page, id)).ToContainText(name,
		playwright.LocatorAssertionsToContainTextOptions{Timeout: playwright.Float(wizardSaveTimeout)}); err != nil {
		return err
	}
	if err := u.expect.Locator(agentSettingsRow(page, id)).ToContainText("A2A"); err != nil {
		return err
	}
	spec, err := u.agentDocumentSpec(page, id)
	if err != nil {
		return err
	}
	labels, _ := spec["labels"].([]any)
	switch {
	case !jsonEqual(spec["interfaces"], `[{"type":"A2A","endpoints":{"productionUrl":"`+agentEndpoint+`"}}]`):
		return fmt.Errorf("the wizard stored interfaces %v", spec["interfaces"])
	case spec["displayName"] != nil, spec["skills"] != nil:
		return fmt.Errorf("the wizard stored the card's own values in the document: %v", spec)
	case spec["version"] != "v2":
		return fmt.Errorf("the wizard stored version %v, want v2", spec["version"])
	case !strings.Contains(fmt.Sprint(labels), "default"):
		return fmt.Errorf("a new agent is not in the default view: labels %v", labels)
	}
	return nil
}

// openAgentRowMenu opens the row menu of an agent in Settings → Agents.
func (u *Steps) openAgentRowMenu(page playwright.Page, id string) (playwright.Locator, error) {
	row := agentSettingsRow(page, id)
	if err := u.revealOnPage(page, row); err != nil {
		return row, err
	}
	if err := row.Locator(".cfg-menu-trigger").Click(); err != nil {
		return row, fmt.Errorf("opening the row menu of %s: %w", id, err)
	}
	return row, nil
}

// editAgentInWizard edits the wizard agent through the same steps: a live card URL, a new
// description, a model and a content ZIP the wizard asks to confirm, keeping the version.
func (u *Steps) editAgentInWizard(ctx context.Context) error {
	id, err := agentFixture(ctx, keyAgentWizardA2A)
	if err != nil {
		return err
	}
	page, err := u.openAgentsPanel(ctx)
	if err != nil {
		return err
	}
	row, err := u.openAgentRowMenu(page, id)
	if err != nil {
		return err
	}
	content, err := wizardZip(map[string]string{"bundle/docs/Guide.md": "# Guide\n"})
	if err != nil {
		return err
	}
	cardURL := "https://gw.example.invalid/wizard/card.json"
	if err := wizardAll(
		func() error { return row.Locator(".ag-edit").Click() },
		u.wizardHasText(page, "#ag-wz-title", "Edit Agent"),
		func() error {
			return u.expect.Locator(page.Locator("#cfg-agents-wizard .cfg-step:visible")).ToHaveCount(4)
		},
		u.wizardVisible(page, "#ag-a2a-onfile"),
		u.wizardHasValue(page, "#ag-a2a-card-url", ""),
		wizardFill(page, "#ag-a2a-card-url", cardURL),
		wizardClick(page, "#ag-wz-next"),
		func() error { return u.expect.Locator(page.Locator("#ag-handle")).ToBeDisabled() },
		u.wizardHasValue(page, "#ag-handle", id),
		u.wizardVisible(page, `[data-ag-from-card="displayName"]`),
		wizardFill(page, "#ag-desc", "Edited by the UI test."),
		wizardClick(page, "#ag-wz-next"),
		u.wizardVisible(page, "#ag-wstep-2"),
		wizardFill(page, ".ag-model-provider", "Anthropic"),
		wizardFill(page, ".ag-model-name", "claude-sonnet-4-5"),
		wizardClick(page, "#ag-wz-next"),
		wizardClick(page, "#ag-assets-to-import"),
		u.wizardVisible(page, "#ag-assets-panel-import"),
		wizardChoose(page, "#ag-content-input", content),
		u.wizardContains(page, "#ag-content-chip", "content.zip"),
		u.wizardContains(page, "#ag-wz-next", "Save changes"),
		wizardClick(page, "#ag-wz-next"),
		// A ZIP replaces all content, so the wizard asks first.
		u.wizardVisible(page, "#cfg-replace-content-modal"),
		u.wizardContains(page, "#cfg-replace-content-modal", "content.zip"),
	); err != nil {
		return err
	}
	if _, err := awaitCreate(page, http.MethodPut, regexp.MustCompile(`/agents/`+regexp.QuoteMeta(id)+`/assets$`),
		wizardClick(page, "#cfg-replace-content-confirm")); err != nil {
		return err
	}
	if err := u.expect.Locator(agentSettingsRow(page, id)).ToHaveCount(1,
		playwright.LocatorAssertionsToHaveCountOptions{Timeout: playwright.Float(wizardSaveTimeout)}); err != nil {
		return err
	}
	return retry.Await(ctx, retry.Options{}, func(context.Context) (map[string]any, error) {
		spec, err := u.agentDocumentSpec(page, id)
		if err != nil {
			return nil, retry.Transient(err)
		}
		return spec, nil
	}, func(spec map[string]any) bool {
		interfaces, _ := spec["interfaces"].([]any)
		first, _ := func() (map[string]any, bool) {
			if len(interfaces) == 0 {
				return nil, false
			}
			item, ok := interfaces[0].(map[string]any)
			return item, ok
		}()
		return spec["description"] == "Edited by the UI test." && first != nil && first["cardUrl"] == cardURL &&
			jsonEqual(spec["models"], `[{"provider":"Anthropic","name":"claude-sonnet-4-5"}]`) && spec["version"] == "v2"
	}, "waiting for the edited agent's document")
}

// deprecateAgent deprecates the wizard agent from its row menu.
func (u *Steps) deprecateAgent(ctx context.Context) error {
	id, err := agentFixture(ctx, keyAgentWizardA2A)
	if err != nil {
		return err
	}
	page, err := u.openAgentsPanel(ctx)
	if err != nil {
		return err
	}
	row, err := u.openAgentRowMenu(page, id)
	if err != nil {
		return err
	}
	return wizardAll(
		func() error { return row.Locator(`.ag-status[data-status="DEPRECATED"]`).Click() },
		u.wizardVisible(page, "#ag-deprecate-modal"),
		u.wizardContains(page, "#ag-deprecate-modal", "Deprecate Agent"),
		wizardClick(page, "#ag-deprecate-confirm"),
		func() error {
			return u.expect.Locator(agentSettingsRow(page, id)).ToContainText("Deprecated",
				playwright.LocatorAssertionsToContainTextOptions{Timeout: playwright.Float(wizardSaveTimeout)})
		},
	)
}

// addRESTAgentInWizard adds a REST agent: the OpenAPI and the details are required, labels,
// tags, owners, a plan and a typed skill are set, and the URL the server refuses opens its field.
func (u *Steps) addRESTAgentInWizard(ctx context.Context) error {
	id, name, err := uniqueAgent(ctx, "agent-fields", "IT Fields Agent")
	if err != nil {
		return err
	}
	if err := cleanup.Register(ctx, cleanup.Resource{Kind: KindAPIPortalAgent, ID: id, Actor: u.topo.Admin.Username}); err != nil {
		return err
	}
	if err := tcontext.Set(ctx, keyAgentWizardREST, id); err != nil {
		return err
	}
	page, err := u.openAgentsPanel(ctx)
	if err != nil {
		return err
	}
	defaultLabel := `#ag-labels .cfg-label-toggle[data-value="default"]`
	if err := wizardAll(
		wizardClick(page, "#ag-add-btn"),
		func() error { return page.Locator("#ag-use-rest").Check() },
		wizardFill(page, "#ag-rest-prod", "not a url"),
		wizardClick(page, "#ag-wz-next"),
		func() error {
			return u.expect.Locator(formGroupError(page, `[data-ag-file="rest"]`)).ToContainText("OpenAPI")
		},
		wizardChoose(page, "#ag-rest-file", wizardFile("openapi.yaml", "application/yaml", []byte(agentOpenAPI))),
		wizardClick(page, "#ag-wz-next"),
		// Without A2A the listing details are required.
		u.wizardVisible(page, ".ag-listing-required >> nth=0"),
		wizardClick(page, "#ag-wz-next"),
		func() error {
			return u.expect.Locator(page.Locator("#ag-version")).ToHaveClass(regexp.MustCompile(`\bcfg-form-input--error\b`))
		},
		wizardFill(page, "#ag-name", name),
		wizardFill(page, "#ag-handle", id),
		wizardFill(page, "#ag-version", "v1.0"),
		wizardFill(page, "#ag-desc", "Checks the form fields."),
		wizardClick(page, "#ag-fold-labels summary"),
		u.wizardHasAttribute(page, defaultLabel, "aria-pressed", "true"),
		wizardClick(page, defaultLabel),
		u.wizardHasAttribute(page, defaultLabel, "aria-pressed", "false"),
		wizardClick(page, defaultLabel),
		u.wizardHasAttribute(page, defaultLabel, "aria-pressed", "true"),
		func() error {
			return u.expect.Locator(page.Locator(defaultLabel)).ToHaveClass(regexp.MustCompile(`\bselected\b`))
		},
		func() error { return page.Locator("#ag-tags-input").PressSequentially("finance") },
		wizardPress(page, "Enter"),
		func() error { return page.Locator("#ag-tags-input").PressSequentially("invoices,") },
		func() error { return u.expect.Locator(page.Locator("#ag-tags-chips .cfg-chip")).ToHaveCount(2) },
		wizardClick(page, "#ag-fold-owners summary"),
		wizardFill(page, "#ag-tech-owner", "Tess"),
		wizardFill(page, "#ag-tech-email", "tess@example.com"),
		wizardClick(page, "#ag-fold-plans summary"),
		wizardClick(page, "#ag-plans-search"),
		func() error {
			return page.Locator("#ag-plans-dropdown .cfg-chip-dd-item").First().DispatchEvent("mousedown", nil)
		},
		func() error { return u.expect.Locator(page.Locator("#ag-plans-chips .cfg-chip")).ToHaveCount(1) },
		wizardClick(page, "#ag-wz-next"),
		// Without A2A, skills are typed here.
		u.wizardVisible(page, "#ag-sec-skills"),
		u.wizardVisible(page, "#ag-skills-empty"),
		wizardClick(page, "#ag-add-skill"),
		u.wizardHidden(page, "#ag-skills-empty"),
		wizardFill(page, ".ag-skill-name", "Triage an invoice"),
		u.wizardHasValue(page, ".ag-skill-id", "triage-an-invoice"),
		wizardFill(page, ".ag-skill-desc", "Checks it."),
		wizardClick(page, "#ag-wz-next"),
		u.wizardContains(page, "#ag-wz-next", "Save agent"),
		wizardClick(page, "#ag-wz-next"),
		// The server refuses the URL, and its message opens the field.
		u.wizardVisible(page, "#ag-wstep-0"),
		func() error {
			return u.expect.Locator(page.Locator("#ag-rest-prod")).ToHaveClass(regexp.MustCompile(`\bcfg-form-input--error\b`))
		},
		func() error {
			return u.expect.Locator(formGroupError(page, "#ag-rest-prod")).ToContainText("productionUrl")
		},
		wizardFill(page, "#ag-rest-prod", "https://agents.example.invalid/fields"),
		wizardClick(page, "#ag-wz-next"),
		u.wizardVisible(page, "#ag-wstep-1"),
		wizardClick(page, "#ag-wz-next"),
		u.wizardVisible(page, "#ag-wstep-2"),
		wizardClick(page, "#ag-wz-next"),
		u.wizardVisible(page, "#ag-wstep-3"),
		wizardClick(page, "#ag-wz-next"),
	); err != nil {
		return err
	}
	if err := u.expect.Locator(agentSettingsRow(page, id).Locator(".ag-type-badge")).ToContainText("REST",
		playwright.LocatorAssertionsToContainTextOptions{Timeout: playwright.Float(wizardSaveTimeout)}); err != nil {
		return err
	}
	spec, err := u.agentDocumentSpec(page, id)
	if err != nil {
		return err
	}
	plans, _ := spec["subscriptionPlans"].([]any)
	skills, _ := spec["skills"].([]any)
	firstSkill, _ := func() (map[string]any, bool) {
		if len(skills) == 0 {
			return nil, false
		}
		item, ok := skills[0].(map[string]any)
		return item, ok
	}()
	switch {
	case !jsonEqual(spec["tags"], `["finance","invoices"]`):
		return fmt.Errorf("the wizard stored tags %v", spec["tags"])
	case len(plans) != 1:
		return fmt.Errorf("the wizard stored plans %v, want one", plans)
	case !jsonEqual(spec["businessInformation"], `{"technicalOwner":"Tess","technicalOwnerEmail":"tess@example.com"}`):
		return fmt.Errorf("the wizard stored owners %v", spec["businessInformation"])
	case spec["status"] != "PUBLISHED":
		return fmt.Errorf("the wizard stored status %v", spec["status"])
	case firstSkill == nil || firstSkill["id"] != "triage-an-invoice":
		return fmt.Errorf("the wizard stored skills %v", skills)
	}
	return nil
}

// agentSettingsActions checks Settings → Agents has no import or download actions, and that a
// dialog closes on a click on its background, leaving the agent.
func (u *Steps) agentSettingsActions(ctx context.Context) error {
	id, err := agentFixture(ctx, keyAgentWizardA2A)
	if err != nil {
		return err
	}
	page, err := u.openAgentsPanel(ctx)
	if err != nil {
		return err
	}
	row, err := u.openAgentRowMenu(page, id)
	if err != nil {
		return err
	}
	if err := wizardAll(
		func() error {
			return u.expect.Locator(page.Locator("#cfg-agents")).Not().ToContainText("Import from file")
		},
		func() error { return u.expect.Locator(row.Locator(".cfg-dropdown")).Not().ToContainText("Download") },
		func() error {
			return u.expect.Locator(row.Locator(".cfg-dropdown")).Not().ToContainText("Update from file")
		},
		func() error { return row.Locator(".ag-delete").Click() },
		u.wizardVisible(page, "#ag-delete-modal"),
	); err != nil {
		return err
	}
	modal := page.Locator("#ag-delete-modal")
	box, err := modal.BoundingBox()
	if err != nil || box == nil {
		return fmt.Errorf("measuring the delete dialog: %v", err)
	}
	// The top edge sits under the fixed navbar, so click the bottom of the dimmed area.
	if err := modal.Click(playwright.LocatorClickOptions{Position: &playwright.Position{X: box.Width / 2, Y: box.Height - 5}}); err != nil {
		return fmt.Errorf("clicking the dialog background: %w", err)
	}
	return wizardAll(
		u.wizardHidden(page, "#ag-delete-modal"),
		func() error { return u.expect.Locator(agentSettingsRow(page, id)).ToHaveCount(1) },
	)
}

// deleteAgentsInSettings deletes two seeded agents with the bulk bar, then the REST wizard agent
// from its row menu.
func (u *Steps) deleteAgentsInSettings(ctx context.Context) error {
	page, err := u.page(ctx)
	if err != nil {
		return err
	}
	var bulk []string
	for _, prefix := range []string{"agent-bulk-a", "agent-bulk-b"} {
		id, name, err := uniqueAgent(ctx, prefix, "IT Bulk Agent")
		if err != nil {
			return err
		}
		if err := u.seedAgent(ctx, page, id, agentSpec(name, []string{"LOCAL"}, nil),
			agentFile{"localDefinition", "run-locally.md", "# Run it\n"}); err != nil {
			return err
		}
		bulk = append(bulk, id)
	}
	if page, err = u.openAgentsPanel(ctx); err != nil {
		return err
	}
	for _, id := range bulk {
		row := agentSettingsRow(page, id)
		if err := u.revealOnPage(page, row); err != nil {
			return err
		}
		if err := row.Locator(".ag-row-check").Check(); err != nil {
			return fmt.Errorf("selecting %s: %w", id, err)
		}
	}
	if err := wizardAll(
		func() error { return page.Locator("#ag-bulk-bar").ScrollIntoViewIfNeeded() },
		u.wizardContains(page, "#ag-bulk-bar", "2 agents selected"),
		wizardClick(page, "#ag-bulk-delete-btn"),
		u.wizardVisible(page, "#ag-delete-modal"),
		u.wizardContains(page, "#ag-delete-modal", "2 selected agents"),
		wizardClick(page, "#ag-delete-confirm"),
		func() error {
			return u.expect.Locator(agentSettingsRow(page, bulk[0])).ToHaveCount(0,
				playwright.LocatorAssertionsToHaveCountOptions{Timeout: playwright.Float(wizardSaveTimeout)})
		},
		func() error { return u.expect.Locator(agentSettingsRow(page, bulk[1])).ToHaveCount(0) },
	); err != nil {
		return err
	}
	for _, id := range bulk {
		if status, _, err := u.storedAgent(page, id); err != nil || status != http.StatusNotFound {
			return fmt.Errorf("GET /agents/%s after the bulk delete answered %d (%v), want 404", id, status, err)
		}
	}
	id, err := agentFixture(ctx, keyAgentWizardREST)
	if err != nil {
		return err
	}
	// The positive control for the 404 below: the agent is found before the delete.
	if status, _, err := u.storedAgent(page, id); err != nil || status != http.StatusOK {
		return fmt.Errorf("GET /agents/%s before the delete answered %d (%v), want 200", id, status, err)
	}
	row, err := u.openAgentRowMenu(page, id)
	if err != nil {
		return err
	}
	if err := wizardAll(
		func() error { return row.Locator(".ag-delete").Click() },
		u.wizardVisible(page, "#ag-delete-modal"),
		wizardClick(page, "#ag-delete-confirm"),
		func() error {
			return u.expect.Locator(agentSettingsRow(page, id)).ToHaveCount(0,
				playwright.LocatorAssertionsToHaveCountOptions{Timeout: playwright.Float(wizardSaveTimeout)})
		},
	); err != nil {
		return err
	}
	if status, _, err := u.storedAgent(page, id); err != nil || status != http.StatusNotFound {
		return fmt.Errorf("GET /agents/%s after the delete answered %d (%v), want 404", id, status, err)
	}
	return nil
}

// thunderKeyManager returns a ThunderID key manager, with an agent registration endpoint when
// agents is set. Its endpoints are never called: the journey only reads the forms.
func thunderKeyManager(id, name string, agents bool) map[string]any {
	provisioning := map[string]any{
		"type":                 "thunderid",
		"registrationEndpoint": "https://thunder.example.invalid/oauth2/dcr/register",
		"auth":                 map[string]any{"method": "client_credentials", "clientId": "portal", "clientSecret": "portal-secret", "scopes": []string{"system"}},
	}
	if agents {
		provisioning["agentRegistrationEndpoint"] = "https://thunder.example.invalid/agents"
	}
	return map[string]any{"id": id, "displayName": name, "tokenEndpoint": "https://thunder.example.invalid/oauth2/token", "provisioning": provisioning}
}

// seedAgentKeyManagers adds a ThunderID key manager that makes agent keys and one that does not.
func (u *Steps) seedAgentKeyManagers(ctx context.Context) error {
	page, err := u.page(ctx)
	if err != nil {
		return err
	}
	for _, km := range []struct {
		key, prefix string
		agents      bool
	}{{keyAgentKeysKM, "agent-km", true}, {keyAgentKeysPlainKM, "plain-km", false}} {
		id, name, err := uniqueAgent(ctx, km.prefix, "IT Thunder")
		if err != nil {
			return err
		}
		if err := cleanup.Register(ctx, cleanup.Resource{Kind: KindAPIPortalKeyManager, ID: id, Actor: u.topo.Admin.Username}); err != nil {
			return err
		}
		status, body, err := u.portalCall(page, http.MethodPost, "/key-managers", thunderKeyManager(id, name, km.agents))
		if err != nil {
			return err
		}
		if status != http.StatusCreated {
			return fmt.Errorf("creating key manager %s answered %d: %s", id, status, body)
		}
		if err := tcontext.Set(ctx, km.key, id); err != nil {
			return err
		}
	}
	return nil
}

// keyManagerFormAgentEndpoint checks the key manager form shows the agent endpoint field for
// ThunderID only, and offers no separate agent key manager.
func (u *Steps) keyManagerFormAgentEndpoint(ctx context.Context) error {
	page, err := u.openSettingsPanel(ctx, "cfg-keymanagers")
	if err != nil {
		return err
	}
	return wizardAll(
		func() error { return u.expect.Locator(page.Locator("#cfg-add-agent-km-btn")).ToHaveCount(0) },
		wizardClick(page, "#cfg-add-km-btn"),
		wizardSelect(page, "#km-type", "thunderid"),
		u.wizardVisible(page, "#km-agent-endpoint-field"),
		wizardSelect(page, "#km-type", "wso2is"),
		u.wizardHidden(page, "#km-agent-endpoint-field"),
		wizardClick(page, "#cfg-km-modal-cancel"),
	)
}

// keyManagerOptions reads the values of a key manager select.
func keyManagerOptions(page playwright.Page, selector string) (string, error) {
	values, err := page.Locator(selector + " option").EvaluateAll(`options => options.map(o => o.value)`)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", selector, err)
	}
	return fmt.Sprint(values), nil
}

// agentKeysPage signs the developer in and checks the Agent Keys page offers only the key manager
// that makes agent keys, client credentials always and the user grants as a choice.
func (u *Steps) agentKeysPage(ctx context.Context) error {
	agentKM, err := agentFixture(ctx, keyAgentKeysKM)
	if err != nil {
		return err
	}
	plainKM, err := agentFixture(ctx, keyAgentKeysPlainKM)
	if err != nil {
		return err
	}
	if err := u.loginAsDeveloper(ctx); err != nil {
		return err
	}
	if err := u.openAPIPortalPath(ctx, "/agent-keys"); err != nil {
		return err
	}
	page, err := u.page(ctx)
	if err != nil {
		return err
	}
	add := page.Locator("#ak-add-btn:visible, #ak-add-btn-empty:visible").First()
	if err := wizardAll(
		func() error {
			return u.expect.Locator(page.Locator("#keys-submenu #agent-keys-nav")).ToHaveClass(regexp.MustCompile(`\bactive\b`))
		},
		func() error { return u.expect.Locator(add).ToBeVisible() },
		func() error { return add.Click() },
		u.wizardVisible(page, "#ak-add-modal"),
	); err != nil {
		return err
	}
	options, err := keyManagerOptions(page, "#ak-km-select")
	if err != nil {
		return err
	}
	if !strings.Contains(options, agentKM) || strings.Contains(options, plainKM) {
		return fmt.Errorf("the Agent Keys form offers %s; want %s and not %s", options, agentKM, plainKM)
	}
	authCode := `#ak-grants-users input[value="authorization_code"]`
	return wizardAll(
		wizardSelect(page, "#ak-km-select", agentKM),
		func() error {
			return u.expect.Locator(page.Locator(`#ak-grants-self input[value="client_credentials"]`)).ToBeChecked()
		},
		func() error {
			return u.expect.Locator(page.Locator(`#ak-grants-self input[value="client_credentials"]`)).ToBeDisabled()
		},
		u.wizardVisible(page, "#ak-users-group"),
		u.wizardHidden(page, "#ak-callbacks-group"),
		func() error { return page.Locator(authCode).Check() },
		u.wizardVisible(page, "#ak-callbacks-group"),
		func() error { return page.Locator(authCode).Uncheck() },
		u.wizardHidden(page, "#ak-callbacks-group"),
	)
}

// oauth2KeysPageOffersBoth checks the OAuth2 Keys form, for application keys, offers both key
// managers and no subject choice.
func (u *Steps) oauth2KeysPageOffersBoth(ctx context.Context) error {
	agentKM, err := agentFixture(ctx, keyAgentKeysKM)
	if err != nil {
		return err
	}
	plainKM, err := agentFixture(ctx, keyAgentKeysPlainKM)
	if err != nil {
		return err
	}
	if err := u.openAPIPortalPath(ctx, "/oauth2-keys"); err != nil {
		return err
	}
	page, err := u.page(ctx)
	if err != nil {
		return err
	}
	add := page.Locator("#ok-add-btn:visible, #ok-add-btn-empty:visible").First()
	if err := wizardAll(
		func() error { return u.expect.Locator(add).ToBeVisible() },
		func() error { return add.Click() },
		u.wizardVisible(page, "#ok-add-modal"),
		func() error { return u.expect.Locator(page.Locator("#ok-subject-group")).ToHaveCount(0) },
	); err != nil {
		return err
	}
	options, err := keyManagerOptions(page, "#ok-km-select")
	if err != nil {
		return err
	}
	if !strings.Contains(options, agentKM) || !strings.Contains(options, plainKM) {
		return fmt.Errorf("the OAuth2 Keys form offers %s; want both %s and %s", options, agentKM, plainKM)
	}
	return nil
}
