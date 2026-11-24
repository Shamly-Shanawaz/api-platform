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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/url"
	"reflect"
	"strings"

	"github.com/cucumber/godog"
	"gopkg.in/yaml.v3"

	"github.com/wso2/api-platform/tests/framework/core/cleanup"
	"github.com/wso2/api-platform/tests/framework/core/util/httpx"
	"github.com/wso2/api-platform/tests/framework/core/util/tcontext"
	stepscommon "github.com/wso2/api-platform/tests/framework/suites/it/steps/common"
)

// portalAgentKind is the clean-up kind of an agent (kind: Agent) created through /agents. It
// shares the order of APIs, so an agent's keys and subscriptions are removed before it.
var portalAgentKind = cleanup.Kind{Name: "api-portal-agent", Order: 40}

// portalMockAgentKind is the clean-up kind of an agent a scenario registers straight in the
// testbench's ThunderID agent API.
var portalMockAgentKind = cleanup.Kind{Name: "api-portal-mock-agent", Order: 70}

// agentCardEndpoint is the URL the agent card fixtures sit under.
const agentCardEndpoint = "https://agents.example.invalid/invoice"

// agentScript is publisher content that must reach no page as markup.
const agentScript = `<script>alert("agent-xss")</script>`

// agentFiles are the definition fixtures an agent upload names, each with its content.
var agentFiles = map[string]string{
	"card": `{
  "name": "Invoice Triage Agent",
  "description": "Reads invoices and flags anything wrong.",
  "version": "1.2.0",
  "provider": {
    "organization": "Acme Finance",
    "url": "https://acme.example.invalid"
  },
  "supportedInterfaces": [
    {
      "url": "` + agentCardEndpoint + `",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "extract",
      "name": "Extract invoice fields",
      "description": "Reads an invoice into JSON",
      "examples": [
        "Pull the total from this invoice"
      ]
    }
  ]
}`,
	"card 0.3": `{
  "name": "Flight Search Agent",
  "description": "Finds flights.",
  "version": "0.3.1",
  "protocolVersion": "0.3.0",
  "url": "` + agentCardEndpoint + `/rpc",
  "preferredTransport": "JSONRPC",
  "capabilities": {},
  "securitySchemes": {
    "key": {
      "type": "apiKey",
      "in": "header",
      "name": "X-API-Key"
    }
  },
  "security": [
    {
      "key": []
    }
  ],
  "skills": [
    {
      "id": "search",
      "name": "Search flights",
      "description": "Finds flights"
    }
  ]
}`,
	"openapi":           "openapi: 3.1.0\ninfo:\n  title: Claims\n  version: \"1\"\npaths:\n  /threads:\n    post:\n      summary: Create a thread\n",
	"openapi v2":        "openapi: 3.1.0\ninfo:\n  title: Claims\n  version: \"1\"\npaths:\n  /threads:\n    post:\n      summary: Create a thread\n# v2\n",
	"openapi responses": "openapi: 3.1.0\ninfo:\n  title: Responses\n  version: \"1\"\npaths:\n  /v1/responses:\n    post:\n      summary: Create a response\ncomponents:\n  securitySchemes:\n    bearer:\n      type: http\n      scheme: bearer\nsecurity:\n  - bearer: []\n",
	"asyncapi": "asyncapi: 3.0.0\ninfo:\n  title: Invoices\n  version: \"1\"\nchannels:\n  invoices:\n    address: invoices.received\n" +
		"  audit:\n    address: invoices.audit\noperations:\n  takeInvoice:\n    action: receive\n    channel:\n      $ref: \"#/channels/invoices\"\n",
	"run locally":             "# Run it yourself\n\n```bash\nnpx @acme/tool run\n```\n",
	"run locally with script": "# Run it yourself\n\n```bash\nnpx @acme/tool run\n```\n\n" + agentScript + "\n[x](javascript:alert(1))\n",
}

// agentFileNames are the names definition files carry, in a multipart upload and at the root of
// an agent ZIP.
var agentFileNames = map[string]string{
	"a2aDefinition":   "agent-card.json",
	"restDefinition":  "openapi.yaml",
	"eventDefinition": "asyncapi.yaml",
	"localDefinition": "run-locally.md",
}

// agentFile is one definition file of an agent upload.
type agentFile struct {
	field, name, content string
}

// registerAgentSteps binds the steps that create and update agents and check what the portal
// stores and serves for them, and the steps that read the testbench's ThunderID agent API.
func (s *Steps) registerAgentSteps(sc *godog.ScenarioContext) {
	sc.Step(`^I create an API Portal agent from "([^"]*)" as "([^"]*)" in (JSON|YAML|ZIP) form(?: with files "([^"]*)")? with values:$`,
		s.createAgentFromTemplate)
	sc.Step(`^I update the API Portal agent "([^"]*)" from "([^"]*)" as "([^"]*)" in (JSON|YAML|ZIP) form(?: with files "([^"]*)")? with values:$`,
		s.updateAgentFromTemplate)
	sc.Step(`^I send the API Portal agent "([^"]*)" document back as "([^"]*)"(?: with form field "([^"]*)" set to '([^']*)')?$`,
		s.resendAgentDocument)
	sc.Step(`^the response body should equal the API Portal agent file "([^"]*)"$`, s.responseBodyIsAgentFile)
	sc.Step(`^I store the API Portal JSON response field "([^"]*)" as "([^"]*)"$`, s.storeJSONValue)
	sc.Step(`^the API Portal JSON response field "([^"]*)" should equal stored "([^"]*)"$`, s.jsonValueEqualsStored)
	sc.Step(`^the API Portal key manager mock should (hold|not hold) the agent "([^"]*)"$`, s.mockHoldsAgent)
	sc.Step(`^the API Portal key manager mock should have received (\d+) agent registrations?$`, s.mockAgentRegistrations)
	sc.Step(`^the API Portal key manager mock agent "([^"]*)" should have "([^"]*)" equal to '([^']*)'$`, s.mockAgentField)
	sc.Step(`^an agent named "([^"]*)" is registered directly in the API Portal key manager mock and stored as "([^"]*)"$`,
		s.registerMockAgent)
}

// createAgentFromTemplate POSTs the rendered agent to /agents in the named form, with the named
// definition files, and registers an agent the portal accepted for scenario cleanup.
func (s *Steps) createAgentFromTemplate(ctx context.Context, template, role, form, files string, table *godog.Table) error {
	document, name, err := s.renderAgent(ctx, template, table)
	if err != nil {
		return err
	}
	if err := s.sendAgent(ctx, http.MethodPost, "/agents", role, form, files, document, nil); err != nil {
		return err
	}
	response, err := publishedResponse(ctx)
	if err != nil {
		return err
	}
	if !response.Succeeded() {
		// A refused create stores nothing; the steps that follow assert the refusal.
		return nil
	}
	if name == "" {
		return fmt.Errorf("the API Portal accepted an agent without metadata.name")
	}
	return s.registerPortalResource(ctx, portalAgentKind, name, cleanup.ScenarioScope,
		portalCleanupRequest{method: http.MethodDelete, path: "/agents"})
}

// updateAgentFromTemplate PUTs the rendered agent over the named agent.
func (s *Steps) updateAgentFromTemplate(ctx context.Context, agentID, template, role, form, files string, table *godog.Table) error {
	agentID, err := stepscommon.Expand(ctx, agentID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(agentID) == "" {
		return fmt.Errorf("API Portal agent id is required")
	}
	document, _, err := s.renderAgent(ctx, template, table)
	if err != nil {
		return err
	}
	return s.sendAgent(ctx, http.MethodPut, "/agents/"+url.PathEscape(agentID), role, form, files, document, nil)
}

// resendAgentDocument reads an agent's stored document and PUTs it back unchanged as JSON
// metadata, with no definition files and an optional extra form field.
func (s *Steps) resendAgentDocument(ctx context.Context, agentID, role, field, value string) error {
	agentID, err := stepscommon.Expand(ctx, agentID)
	if err != nil {
		return err
	}
	base, token, err := s.authedAs(ctx, role)
	if err != nil {
		return err
	}
	current, err := s.getJSON(ctx, base, token, "/agents/"+url.PathEscape(agentID))
	if err != nil {
		return err
	}
	if !current.Succeeded() {
		return fmt.Errorf("reading API Portal agent %q: %s", agentID, current.Describe())
	}
	var agent struct {
		Document map[string]any `json:"document"`
	}
	if err := json.Unmarshal(current.Body, &agent); err != nil || agent.Document == nil {
		return fmt.Errorf("API Portal agent %q has no document: %s", agentID, current.Describe())
	}
	var extra map[string]string
	if strings.TrimSpace(field) != "" {
		value, err = stepscommon.Expand(ctx, value)
		if err != nil {
			return err
		}
		extra = map[string]string{field: value}
	}
	return s.sendAgent(ctx, http.MethodPut, "/agents/"+url.PathEscape(agentID), role, "JSON", "", agent.Document, extra)
}

// renderAgent renders the agent template, drops the fields a null value left out, and returns
// the document with its metadata.name.
func (s *Steps) renderAgent(ctx context.Context, template string, table *godog.Table) (map[string]any, string, error) {
	rendered, err := stepscommon.RenderResourceTemplateJSON(ctx, s.featureRoot, template, table)
	if err != nil {
		return nil, "", err
	}
	cleaned, err := withoutNullFields(rendered)
	if err != nil {
		return nil, "", err
	}
	var document map[string]any
	if err := json.Unmarshal(cleaned, &document); err != nil {
		return nil, "", fmt.Errorf("decoding the rendered agent: %w", err)
	}
	name := ""
	if metadata, ok := document["metadata"].(map[string]any); ok {
		name, _ = metadata["name"].(string)
	}
	return document, name, nil
}

// sendAgent sends an agent document in the named form through the portal funnel: JSON as the
// metadata field, YAML as an agent.yaml file, or ZIP as an archive holding agent.yaml, a document
// and the definition files under their fixed names.
func (s *Steps) sendAgent(ctx context.Context, method, path, role, form, files string, document map[string]any, extra map[string]string) error {
	definitions, err := agentDefinitions(ctx, files)
	if err != nil {
		return err
	}
	body, contentType, err := agentMultipart(form, document, definitions, extra)
	if err != nil {
		return err
	}
	base, token, err := s.authedAs(ctx, role)
	if err != nil {
		return err
	}
	_, err = s.portalFunnel().Send(ctx, httpx.Request{
		Method: method, URL: s.portalRequestURL(base, path),
		Headers: map[string]string{"Authorization": "Bearer " + token},
		Body:    body, ContentType: contentType,
	})
	if err != nil {
		return fmt.Errorf("API Portal %s %s: %w", method, path, err)
	}
	return nil
}

// agentDefinitions resolves a "field=fixture, field=fixture" list into definition files. An
// empty list or "none" sends no file.
func agentDefinitions(ctx context.Context, files string) ([]agentFile, error) {
	files, err := stepscommon.Expand(ctx, files)
	if err != nil {
		return nil, err
	}
	files = strings.TrimSpace(files)
	if files == "" || strings.EqualFold(files, noDefinition) {
		return nil, nil
	}
	var definitions []agentFile
	for _, entry := range strings.Split(files, ",") {
		field, fixture, ok := strings.Cut(strings.TrimSpace(entry), "=")
		field, fixture = strings.TrimSpace(field), strings.TrimSpace(fixture)
		if !ok || field == "" || fixture == "" {
			return nil, fmt.Errorf("agent file %q must be written field=fixture", entry)
		}
		content, known := agentFiles[fixture]
		if !known {
			return nil, fmt.Errorf("unknown API Portal agent file fixture %q", fixture)
		}
		name := agentFileNames[field]
		if name == "" {
			name = field + ".txt"
		}
		definitions = append(definitions, agentFile{field: field, name: name, content: content})
	}
	return definitions, nil
}

// agentMultipart builds the multipart body of an agent upload in the named form.
func agentMultipart(form string, document map[string]any, definitions []agentFile, extra map[string]string) ([]byte, string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	switch strings.ToUpper(form) {
	case "JSON":
		encoded, err := json.Marshal(document)
		if err != nil {
			return nil, "", fmt.Errorf("encoding the agent document: %w", err)
		}
		if err := writer.WriteField("metadata", string(encoded)); err != nil {
			return nil, "", err
		}
	case "YAML":
		encoded, err := yaml.Marshal(document)
		if err != nil {
			return nil, "", fmt.Errorf("encoding the agent document as YAML: %w", err)
		}
		if err := addPart(writer, "metadata", "agent.yaml", "application/yaml", string(encoded)); err != nil {
			return nil, "", err
		}
	case "ZIP":
		encoded, err := yaml.Marshal(document)
		if err != nil {
			return nil, "", fmt.Errorf("encoding the agent document as YAML: %w", err)
		}
		entries := []zipEntry{
			{name: "agent.yaml", content: encoded},
			{name: "docs/overview.md", content: []byte("# Agent overview\n\nRead me. " + agentScript + "\n")},
		}
		for _, definition := range definitions {
			entries = append(entries, zipEntry{name: definition.name, content: []byte(definition.content)})
		}
		archive, err := buildZip(entries)
		if err != nil {
			return nil, "", err
		}
		part, err := writer.CreateFormFile("artifact", "agent.zip")
		if err != nil {
			return nil, "", err
		}
		if _, err := part.Write(archive); err != nil {
			return nil, "", err
		}
		definitions = nil
	default:
		return nil, "", fmt.Errorf("unknown API Portal agent form %q", form)
	}
	for _, definition := range definitions {
		if err := addPart(writer, definition.field, definition.name, "application/octet-stream", definition.content); err != nil {
			return nil, "", err
		}
	}
	for name, value := range extra {
		if err := writer.WriteField(name, value); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return body.Bytes(), writer.FormDataContentType(), nil
}

// responseBodyIsAgentFile asserts the published body is the named definition fixture, byte for
// byte.
func (s *Steps) responseBodyIsAgentFile(ctx context.Context, fixture string) error {
	want, ok := agentFiles[fixture]
	if !ok {
		return fmt.Errorf("unknown API Portal agent file fixture %q", fixture)
	}
	response, err := publishedResponse(ctx)
	if err != nil {
		return err
	}
	if string(response.Body) != want {
		return fmt.Errorf("the response body is not the agent file %q byte for byte: %s", fixture, response.Describe())
	}
	return nil
}

// storeJSONValue stores a field of the published JSON response, of any type, as canonical JSON.
func (s *Steps) storeJSONValue(ctx context.Context, field, key string) error {
	value, err := publishedJSONValue(ctx, field)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encoding JSON field %q: %w", field, err)
	}
	return tcontext.Set(ctx, key, string(encoded))
}

// jsonValueEqualsStored asserts a field of the published JSON response equals a stored value,
// compared as JSON rather than as text.
func (s *Steps) jsonValueEqualsStored(ctx context.Context, field, key string) error {
	got, err := publishedJSONValue(ctx, field)
	if err != nil {
		return err
	}
	stored, err := tcontext.ResolveString(ctx, key)
	if err != nil {
		return err
	}
	var want any
	if err := json.Unmarshal([]byte(stored), &want); err != nil {
		return fmt.Errorf("stored value %q is not JSON: %w", key, err)
	}
	if !reflect.DeepEqual(got, want) {
		encoded, _ := json.Marshal(got)
		return fmt.Errorf("JSON field %q is %s, want the stored %s", field, encoded, stored)
	}
	return nil
}

// publishedJSONValue reads a dotted field of the published JSON response; an empty field is the
// whole document.
func publishedJSONValue(ctx context.Context, field string) (any, error) {
	response, err := publishedResponse(ctx)
	if err != nil {
		return nil, err
	}
	var document map[string]any
	if err := json.Unmarshal(response.Body, &document); err != nil {
		return nil, fmt.Errorf("the response is not a JSON object: %s", response.Describe())
	}
	if strings.TrimSpace(field) == "" {
		return document, nil
	}
	value, ok := traverseWebhookJSON(document, field)
	if !ok {
		return nil, fmt.Errorf("JSON field %q is absent from %s", field, response.Describe())
	}
	return value, nil
}

// mockAgents is the testbench's listing of the agents in this scenario's partition and the agent
// API calls it received.
type mockAgents struct {
	Agents   []map[string]any `json:"agents"`
	Requests []struct {
		Method string `json:"method"`
		Path   string `json:"path"`
		Status int    `json:"status"`
	} `json:"requests"`
}

// mockBase returns the scenario's partition of the testbench OAuth2 service.
func (s *Steps) mockBase(ctx context.Context) (string, error) {
	base, err := s.topo.URL("testbench", "oauth2")
	if err != nil {
		return "", err
	}
	partition, err := s.webhookPartition(ctx)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(base, "/") + "/" + partition, nil
}

// readMockAgents reads the partition's agents from the testbench.
func (s *Steps) readMockAgents(ctx context.Context) (mockAgents, error) {
	var listing mockAgents
	base, err := s.mockBase(ctx)
	if err != nil {
		return listing, err
	}
	response, err := s.client.Do(ctx, httpx.Request{Method: http.MethodGet, URL: base + "/debug/agents"}, 0, 0)
	if err != nil {
		return listing, fmt.Errorf("reading the key manager mock's agents: %w", err)
	}
	if !response.Succeeded() {
		return listing, fmt.Errorf("reading the key manager mock's agents: %s", response.Describe())
	}
	if err := json.Unmarshal(response.Body, &listing); err != nil {
		return listing, fmt.Errorf("decoding the key manager mock's agents: %w", err)
	}
	return listing, nil
}

// mockAgent returns the held agent with the id, or nil.
func (m mockAgents) mockAgent(id string) map[string]any {
	for _, held := range m.Agents {
		if held["id"] == id {
			return held
		}
	}
	return nil
}

// mockHoldsAgent asserts whether the key manager mock holds the agent.
func (s *Steps) mockHoldsAgent(ctx context.Context, mode, agentID string) error {
	agentID, err := stepscommon.Expand(ctx, agentID)
	if err != nil {
		return err
	}
	listing, err := s.readMockAgents(ctx)
	if err != nil {
		return err
	}
	held := listing.mockAgent(agentID) != nil
	if held != (mode == "hold") {
		return fmt.Errorf("the key manager mock holds agent %q: %t, want %t", agentID, held, mode == "hold")
	}
	return nil
}

// mockAgentRegistrations asserts how many agents the portal registered (successful POST /agents).
func (s *Steps) mockAgentRegistrations(ctx context.Context, want int) error {
	listing, err := s.readMockAgents(ctx)
	if err != nil {
		return err
	}
	got := 0
	for _, request := range listing.Requests {
		if request.Method == http.MethodPost && strings.HasSuffix(request.Path, "/agents") && request.Status == http.StatusCreated {
			got++
		}
	}
	if got != want {
		return fmt.Errorf("the key manager mock registered %d agents, want %d", got, want)
	}
	return nil
}

// mockAgentField asserts a dotted field of a held agent equals a JSON value.
func (s *Steps) mockAgentField(ctx context.Context, agentID, field, want string) error {
	agentID, err := stepscommon.Expand(ctx, agentID)
	if err != nil {
		return err
	}
	want, err = stepscommon.Expand(ctx, want)
	if err != nil {
		return err
	}
	var wantValue any
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		return fmt.Errorf("expected value %q is not JSON: %w", want, err)
	}
	listing, err := s.readMockAgents(ctx)
	if err != nil {
		return err
	}
	held := listing.mockAgent(agentID)
	if held == nil {
		return fmt.Errorf("the key manager mock does not hold agent %q", agentID)
	}
	var got any = held
	for _, part := range strings.Split(field, ".") {
		name, index, indexed := strings.Cut(part, "[")
		object, ok := got.(map[string]any)
		if !ok {
			return fmt.Errorf("agent field %q is absent", field)
		}
		if got, ok = object[name]; !ok {
			return fmt.Errorf("agent field %q is absent", field)
		}
		if indexed {
			list, ok := got.([]any)
			var i int
			if _, err := fmt.Sscanf(strings.TrimSuffix(index, "]"), "%d", &i); err != nil || !ok || i < 0 || i >= len(list) {
				return fmt.Errorf("agent field %q is absent", field)
			}
			got = list[i]
		}
	}
	if !reflect.DeepEqual(got, wantValue) {
		encoded, _ := json.Marshal(got)
		return fmt.Errorf("agent %q field %q is %s, want %s", agentID, field, encoded, want)
	}
	return nil
}

// registerMockAgent registers an agent straight in the testbench's agent API, as a tool outside
// the portal would, and stores its id, client id and secret as <key>AgentId, <key>ClientId and
// <key>ClientSecret. It is registered for clean-up in the mock.
func (s *Steps) registerMockAgent(ctx context.Context, name, key string) error {
	name, err := stepscommon.Expand(ctx, name)
	if err != nil {
		return err
	}
	base, err := s.mockBase(ctx)
	if err != nil {
		return err
	}
	token, err := s.mockToken(ctx, base)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{
		"type": "default", "attributes": map[string]string{"name": name},
		"inboundAuthConfig": []map[string]any{{"type": "oauth2", "config": map[string]any{"grantTypes": []string{"client_credentials"}}}},
	})
	if err != nil {
		return err
	}
	response, err := s.client.Do(ctx, httpx.Request{
		Method: http.MethodPost, URL: base + "/agents", Body: body, ContentType: "application/json",
		Headers: map[string]string{"Authorization": "Bearer " + token},
	}, 0, 0)
	if err != nil {
		return fmt.Errorf("registering agent %q in the key manager mock: %w", name, err)
	}
	if response.StatusCode != http.StatusCreated {
		return fmt.Errorf("registering agent %q in the key manager mock: %s", name, response.Describe())
	}
	var created struct {
		ID                string `json:"id"`
		InboundAuthConfig []struct {
			Config struct {
				ClientID     string `json:"clientId"`
				ClientSecret string `json:"clientSecret"`
			} `json:"config"`
		} `json:"inboundAuthConfig"`
	}
	if err := json.Unmarshal(response.Body, &created); err != nil || created.ID == "" || len(created.InboundAuthConfig) == 0 {
		return fmt.Errorf("the key manager mock answered an agent registration without credentials: %s", response.Describe())
	}
	if err := s.registerMockAgentCleanup(ctx, created.ID); err != nil {
		return err
	}
	config := created.InboundAuthConfig[0].Config
	return errors.Join(
		tcontext.Set(ctx, key+"AgentId", created.ID),
		tcontext.Set(ctx, key+"ClientId", config.ClientID),
		tcontext.Set(ctx, key+"ClientSecret", config.ClientSecret))
}

// mockToken gets a provisioning token from the testbench OAuth2 service for its fixed client.
func (s *Steps) mockToken(ctx context.Context, base string) (string, error) {
	response, err := s.client.Do(ctx, httpx.Request{
		Method: http.MethodPost, URL: base + "/oauth2/token",
		Body:        []byte("grant_type=client_credentials&client_id=test-client&client_secret=test-secret"),
		ContentType: "application/x-www-form-urlencoded",
	}, 0, 0)
	if err != nil {
		return "", fmt.Errorf("getting a key manager mock token: %w", err)
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(response.Body, &token); err != nil || token.AccessToken == "" {
		return "", fmt.Errorf("getting a key manager mock token: %s", response.Describe())
	}
	return token.AccessToken, nil
}

// registerMockAgentCleanup removes the mock agent when the scenario ends; one already gone is
// fine.
func (s *Steps) registerMockAgentCleanup(ctx context.Context, agentID string) error {
	registry, err := cleanup.Of(ctx)
	if err != nil {
		return err
	}
	base, err := s.mockBase(ctx)
	if err != nil {
		return err
	}
	deleter := func(ctx context.Context, resource cleanup.Resource) error {
		token, err := s.mockToken(ctx, base)
		if err != nil {
			return err
		}
		response, err := s.client.Do(ctx, httpx.Request{
			Method: http.MethodDelete, URL: base + "/agents/" + url.PathEscape(resource.ID),
			Headers: map[string]string{"Authorization": "Bearer " + token},
		}, 0, 0)
		if err != nil {
			return err
		}
		if response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusNotFound {
			return fmt.Errorf("deleting mock agent %q: %s", resource.ID, response.Describe())
		}
		return nil
	}
	kind := cleanup.Kind{Name: portalMockAgentKind.Name + ":" + base, Order: portalMockAgentKind.Order}
	if err := registry.RegisterDeleter(kind, deleter); err != nil {
		return errors.Join(err, deleter(ctx, cleanup.Resource{Kind: kind, ID: agentID}))
	}
	resource := cleanup.Resource{Kind: kind, ID: agentID, Actor: "admin", Description: "registered in the key manager mock"}
	if err := registry.RegisterScoped(cleanup.ScenarioScope, resource); err != nil {
		return errors.Join(err, deleter(ctx, resource))
	}
	return nil
}
