package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestUserPortalHTTPSLoginAndUsageIsolation(t *testing.T) {
	root := t.TempDir()
	keys := filepath.Join(root, "client-keys")
	upstream := filepath.Join(root, "upstream-key")
	password := filepath.Join(root, "admin-password")
	archives := filepath.Join(root, "archive")
	if err := os.MkdirAll(archives, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keys, []byte("client-one\nclient-two\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(upstream, []byte("upstream\n"), 0600); err != nil {
		t.Fatal(err)
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte("administrator-password"), bcrypt.MinCost)
	if err := os.WriteFile(password, hash, 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadKeys(keys); err != nil {
		t.Fatal(err)
	}

	id, _ := requestID()
	dir := filepath.Join(archives, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	m := metadata{ID: id, ClientKeyID: keyID("client-one"), Model: "glm-5.3", ResponseStatus: 200, Usage: tokenUsage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15}}
	if err := writeJSON(filepath.Join(dir, "metadata.json"), m); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "request.body"), []byte(`{"messages":[{"role":"user","content":"secret prompt"}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "response.body"), []byte(`{"content":[{"type":"text","text":"secret response"}]}`), 0600); err != nil {
		t.Fatal(err)
	}

	a := newAdminServer(keys, upstream, archives, nil)
	a.passwordFile = password
	insecure := httptest.NewRequest(http.MethodGet, portalPrefix, nil)
	insecure.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	a.ServeHTTP(w, insecure)
	if w.Code != http.StatusUpgradeRequired {
		t.Fatalf("insecure status=%d", w.Code)
	}

	login := httptest.NewRequest(http.MethodPost, portalPrefix+"api/user-login", bytes.NewBufferString(`{"key":"client-one"}`))
	login.RemoteAddr = "127.0.0.1:1234"
	login.Header.Set("X-Forwarded-Proto", "https")
	login.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	a.ServeHTTP(w, login)
	if w.Code != http.StatusOK {
		t.Fatalf("login status=%d body=%s", w.Code, w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	usage := httptest.NewRequest(http.MethodGet, portalPrefix+"api/user-usage", nil)
	usage.RemoteAddr = "127.0.0.1:1234"
	usage.Header.Set("X-Forwarded-Proto", "https")
	usage.AddCookie(cookie)
	w = httptest.NewRecorder()
	a.ServeHTTP(w, usage)
	if w.Code != http.StatusOK {
		t.Fatalf("usage status=%d body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["total_tokens"].(float64) != 15 {
		t.Fatalf("unexpected usage: %v", body)
	}

	for _, kind := range []string{"request", "response"} {
		content := httptest.NewRequest(http.MethodGet, portalPrefix+"api/user-archives/"+id+"/"+kind, nil)
		content.RemoteAddr = "127.0.0.1:1234"
		content.Header.Set("X-Forwarded-Proto", "https")
		content.AddCookie(cookie)
		w = httptest.NewRecorder()
		a.ServeHTTP(w, content)
		if w.Code != http.StatusForbidden {
			t.Fatalf("user archive %s status=%d body=%s", kind, w.Code, w.Body.String())
		}
		if bytes.Contains(w.Body.Bytes(), []byte("secret")) {
			t.Fatalf("user archive %s leaked content", kind)
		}
	}
}
