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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package oauth2

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// maxAgents bounds the agents one partition holds.
const maxAgents = 256

// agent is one AI agent registered through the ThunderID agent API mock. It owns an OAuth
// client whose credentials the token endpoint accepts for the client_credentials grant.
type agent struct {
	ID           string
	OUID         string
	Type         string
	Name         string
	Description  string
	Delegated    bool
	ClientID     string
	ClientSecret string
	GrantTypes   []string
	RedirectURIs []string
	ScopeClaims  map[string]any
}

// agentRequest records one call to the agent API, without its body.
type agentRequest struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Status int    `json:"status"`
}

// agentBody is the part of a ThunderID agent document the mock reads.
type agentBody struct {
	OUID        string `json:"ouId"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Delegated   bool   `json:"delegated"`
	Attributes  struct {
		Name string `json:"name"`
	} `json:"attributes"`
	InboundAuthConfig []struct {
		Type   string `json:"type"`
		Config struct {
			ClientID     string         `json:"clientId"`
			ClientSecret string         `json:"clientSecret"`
			GrantTypes   []string       `json:"grantTypes"`
			RedirectURIs []string       `json:"redirectUris"`
			ScopeClaims  map[string]any `json:"scopeClaims"`
		} `json:"config"`
	} `json:"inboundAuthConfig"`
}

// registerAgentRoutes adds ThunderID's agent API (/agents) and its diagnostic listing. The API
// answers as ThunderID does: the name is attributes.name and unique (409 when taken), create
// returns the client secret once, GET never returns it, PUT is a full replace in which a new
// clientSecret replaces the old one at once, and DELETE is 204 and then 404. Every call needs a
// bearer token this service issued.
func (s *Service) registerAgentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /agents", s.createAgent)
	mux.HandleFunc("GET /agents/{id}", s.getAgent)
	mux.HandleFunc("PUT /agents/{id}", s.replaceAgent)
	mux.HandleFunc("DELETE /agents/{id}", s.deleteAgent)
	mux.HandleFunc("GET /debug/agents", s.listAgents)
}

func (s *Service) createAgent(w http.ResponseWriter, r *http.Request) {
	p, ok := s.agentCall(w, r)
	if !ok {
		return
	}
	body, ok := readAgentBody(w, r, p)
	if !ok {
		return
	}
	name := strings.TrimSpace(body.Attributes.Name)
	switch {
	case body.Type != "default":
		p.finishAgentCall(w, r, http.StatusBadRequest, map[string]string{"code": "AGT-1001"})
		return
	case name == "":
		p.finishAgentCall(w, r, http.StatusBadRequest, map[string]string{"code": "AGT-1015"})
		return
	}
	secret, err := randomSecret()
	if err != nil {
		p.finishAgentCall(w, r, http.StatusInternalServerError, map[string]string{"code": "AGT-5000"})
		return
	}
	p.mu.Lock()
	if p.agents == nil {
		p.agents = map[string]*agent{}
	}
	for _, existing := range p.agents {
		if existing.Name == name {
			p.mu.Unlock()
			p.finishAgentCall(w, r, http.StatusConflict, map[string]string{"code": "AGT-1014"})
			return
		}
	}
	if len(p.agents) >= maxAgents {
		p.mu.Unlock()
		p.finishAgentCall(w, r, http.StatusInsufficientStorage, map[string]string{"code": "AGT-5070"})
		return
	}
	p.agentSequence++
	n := p.agentSequence
	created := &agent{
		ID: fmt.Sprintf("agent-%d", n), OUID: body.OUID, Type: body.Type, Name: name,
		Description: body.Description, Delegated: body.Delegated,
		ClientID: fmt.Sprintf("agent-client-%d", n), ClientSecret: fmt.Sprintf("agent-secret-%d-%s", n, secret),
		ScopeClaims: map[string]any{"roles": []string{"roles"}},
	}
	if created.OUID == "" {
		created.OUID = "ou-system"
	}
	if len(body.InboundAuthConfig) > 0 {
		created.GrantTypes = body.InboundAuthConfig[0].Config.GrantTypes
		created.RedirectURIs = body.InboundAuthConfig[0].Config.RedirectURIs
	}
	p.agents[created.ID] = created
	view := created.view()
	p.mu.Unlock()
	// The secret is returned once, on create, and the client id sits in the OAuth configuration.
	config := view["inboundAuthConfig"].([]map[string]any)[0]["config"].(map[string]any)
	config["clientSecret"] = created.ClientSecret
	delete(view, "clientId")
	p.finishAgentCall(w, r, http.StatusCreated, view)
}

func (s *Service) getAgent(w http.ResponseWriter, r *http.Request) {
	p, ok := s.agentCall(w, r)
	if !ok {
		return
	}
	p.mu.Lock()
	found := p.agents[r.PathValue("id")]
	var view map[string]any
	if found != nil {
		view = found.view()
	}
	p.mu.Unlock()
	if found == nil {
		p.finishAgentCall(w, r, http.StatusNotFound, map[string]string{"code": "AGT-1004"})
		return
	}
	p.finishAgentCall(w, r, http.StatusOK, view)
}

func (s *Service) replaceAgent(w http.ResponseWriter, r *http.Request) {
	p, ok := s.agentCall(w, r)
	if !ok {
		return
	}
	body, ok := readAgentBody(w, r, p)
	if !ok {
		return
	}
	p.mu.Lock()
	found := p.agents[r.PathValue("id")]
	if found == nil {
		p.mu.Unlock()
		p.finishAgentCall(w, r, http.StatusNotFound, map[string]string{"code": "AGT-1004"})
		return
	}
	if strings.TrimSpace(body.Attributes.Name) == "" || len(body.InboundAuthConfig) == 0 ||
		body.InboundAuthConfig[0].Config.ClientID != found.ClientID {
		p.mu.Unlock()
		p.finishAgentCall(w, r, http.StatusBadRequest, map[string]string{"code": "AGT-1001"})
		return
	}
	config := body.InboundAuthConfig[0].Config
	if config.ClientSecret != "" {
		found.ClientSecret = config.ClientSecret
	}
	// A full replace: what the body leaves out is gone.
	found.Name = strings.TrimSpace(body.Attributes.Name)
	found.Description = body.Description
	found.Delegated = body.Delegated
	found.GrantTypes = config.GrantTypes
	found.RedirectURIs = config.RedirectURIs
	found.ScopeClaims = config.ScopeClaims
	view := found.view()
	p.mu.Unlock()
	p.finishAgentCall(w, r, http.StatusOK, view)
}

func (s *Service) deleteAgent(w http.ResponseWriter, r *http.Request) {
	p, ok := s.agentCall(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	p.mu.Lock()
	_, found := p.agents[id]
	delete(p.agents, id)
	p.mu.Unlock()
	if !found {
		p.finishAgentCall(w, r, http.StatusNotFound, map[string]string{"code": "AGT-1004"})
		return
	}
	p.finishAgentCall(w, r, http.StatusNoContent, nil)
}

// listAgents serves the partition's agents, without their secrets, and the agent API calls it
// received, so a scenario can check what the portal sent.
func (s *Service) listAgents(w http.ResponseWriter, r *http.Request) {
	p, ok := s.scoped(r)
	if !ok {
		http.Error(w, "oauth2: missing partition", http.StatusInternalServerError)
		return
	}
	p.mu.Lock()
	agents := make([]map[string]any, 0, len(p.agents))
	for _, held := range p.agents {
		view := held.view()
		view["delegated"] = held.Delegated
		agents = append(agents, view)
	}
	requests := append([]agentRequest(nil), p.agentRequests...)
	p.mu.Unlock()
	sort.Slice(agents, func(i, j int) bool { return agents[i]["id"].(string) < agents[j]["id"].(string) })
	writeJSON(w, map[string]any{"agents": agents, "requests": requests})
}

// agentCall resolves the partition and requires a bearer token this service issued.
func (s *Service) agentCall(w http.ResponseWriter, r *http.Request) (*partition, bool) {
	p, ok := s.scoped(r)
	if !ok {
		http.Error(w, "oauth2: missing partition", http.StatusInternalServerError)
		return nil, false
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer mock-token-") {
		p.finishAgentCall(w, r, http.StatusUnauthorized, map[string]string{"code": "AUTH-401"})
		return nil, false
	}
	return p, true
}

// readAgentBody decodes a bounded agent document, answering 400 or 413 itself on failure.
func readAgentBody(w http.ResponseWriter, r *http.Request, p *partition) (agentBody, bool) {
	var body agentBody
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			p.finishAgentCall(w, r, http.StatusRequestEntityTooLarge, map[string]string{"code": "AGT-1413"})
			return body, false
		}
		p.finishAgentCall(w, r, http.StatusBadRequest, map[string]string{"code": "AGT-1001"})
		return body, false
	}
	if err := json.Unmarshal(data, &body); err != nil {
		p.finishAgentCall(w, r, http.StatusBadRequest, map[string]string{"code": "AGT-1001"})
		return body, false
	}
	return body, true
}

// finishAgentCall records the call and writes its answer.
func (p *partition) finishAgentCall(w http.ResponseWriter, r *http.Request, status int, body any) {
	p.mu.Lock()
	p.agentRequests = append(p.agentRequests, agentRequest{Method: r.Method, Path: r.URL.Path, Status: status})
	if len(p.agentRequests) > maxHistory {
		p.agentRequests = p.agentRequests[len(p.agentRequests)-maxHistory:]
	}
	p.mu.Unlock()
	if body == nil {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// agentClient reports whether the credentials are an agent's own client in the partition.
func (p *partition) agentClient(id, secret string) bool {
	if !strings.HasPrefix(id, "agent-client-") {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, held := range p.agents {
		if held.ClientID == id {
			return secret != "" && held.ClientSecret == secret
		}
	}
	return false
}

// view is the agent as GET returns it: read-only fields included, the secret never.
func (a *agent) view() map[string]any {
	config := map[string]any{
		"clientId": a.ClientID, "grantTypes": a.GrantTypes,
		"tokenEndpointAuthMethod": "client_secret_basic", "scopeClaims": a.ScopeClaims,
	}
	if len(a.RedirectURIs) > 0 {
		config["redirectUris"] = a.RedirectURIs
	}
	return map[string]any{
		"id": a.ID, "ouId": a.OUID, "ouHandle": "default", "type": a.Type, "display": a.Name,
		"description": a.Description, "clientId": a.ClientID, "attributes": map[string]any{"name": a.Name},
		"status": map[string]any{"status": "ACTIVE"}, "isReadOnly": false, "isOwnedByOU": true,
		"inboundAuthConfig": []map[string]any{{"type": "oauth2", "config": config}},
	}
}

// randomSecret returns a random suffix for an agent's client secret.
func randomSecret() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
