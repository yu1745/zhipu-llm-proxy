package main

import (
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/metacubex/tailscale/tsnet"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/term"
)

const (
	adminPrefix       = "/zhipu-proxy/admin/"
	portalPrefix      = "/zhipu-proxy/portal/"
	adminCookie       = "zhipu_proxy_admin"
	userCookie        = "zhipu_proxy_user"
	adminSessionTTL   = 12 * time.Hour
	archivePreviewMax = 4 << 20
)

//go:embed web/dist
var adminAssets embed.FS

type adminSession struct {
	CSRF        string
	Role        string
	ClientKeyID string
	LoginIP     string
	LastIP      string
	UserAgent   string
	CreatedAt   time.Time
	LastSeenAt  time.Time
	ExpiresAt   time.Time
}

type loginWindow struct {
	Failures []time.Time
}

type adminServer struct {
	keysFile       string
	upstreamFile   string
	passwordFile   string
	archiveRoot    string
	startedAt      time.Time
	tailscale      *tsnet.Server
	static         http.Handler
	mu             sync.Mutex
	sessions       map[string]adminSession
	loginByAddress map[string]loginWindow
	configMu       sync.Mutex
}

func newAdminServer(keysFile, upstreamFile, archiveRoot string, tailscale *tsnet.Server) *adminServer {
	dist, err := fs.Sub(adminAssets, "web/dist")
	if err != nil {
		panic(err)
	}
	a := &adminServer{
		keysFile: keysFile, upstreamFile: upstreamFile,
		passwordFile: getenv("ADMIN_PASSWORD_FILE", "/opt/zhipu-llm-proxy/config/admin-password"),
		archiveRoot:  archiveRoot, tailscale: tailscale, startedAt: time.Now(),
		sessions: map[string]adminSession{}, loginByAddress: map[string]loginWindow{},
	}
	a.static = spaFileServer(dist)
	return a
}

func spaFileServer(dist fs.FS) http.Handler {
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(dist, path); err != nil {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			files.ServeHTTP(w, r2)
			return
		}
		files.ServeHTTP(w, r)
	})
}

func adminSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]), "https")
}

func (a *adminServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	if !adminSecureRequest(r) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUpgradeRequired)
		_, _ = io.WriteString(w, `{"error":"admin requires HTTPS through a trusted reverse proxy"}`)
		return
	}
	base, role := "", ""
	if strings.HasPrefix(r.URL.Path, adminPrefix) {
		base, role = adminPrefix, "admin"
	}
	if strings.HasPrefix(r.URL.Path, portalPrefix) {
		base, role = portalPrefix, "user"
	}
	if base == "" {
		http.NotFound(w, r)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, base)
	if strings.HasPrefix(rel, "api/") {
		apiPath := strings.TrimPrefix(rel, "api/")
		if role == "admin" {
			a.serveAPI(w, r, apiPath)
		} else {
			a.serveUserAPI(w, r, apiPath)
		}
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/" + rel
	a.static.ServeHTTP(w, r2)
}

func writeAdminJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func randomToken(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func requestAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
		if net.ParseIP(forwarded) != nil {
			return forwarded
		}
	}
	return host
}

func (a *adminServer) loginAllowed(address string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	window := a.loginByAddress[address]
	kept := window.Failures[:0]
	for _, t := range window.Failures {
		if now.Sub(t) < 10*time.Minute {
			kept = append(kept, t)
		}
	}
	window.Failures = kept
	a.loginByAddress[address] = window
	return len(kept) < 5
}

func (a *adminServer) loginFailed(address string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	window := a.loginByAddress[address]
	window.Failures = append(window.Failures, time.Now())
	a.loginByAddress[address] = window
}

func (a *adminServer) loginSucceeded(address string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.loginByAddress, address)
}

func (a *adminServer) createSession(w http.ResponseWriter, r *http.Request, role, clientKeyID string) (adminSession, error) {
	token, err := randomToken(32)
	if err != nil {
		return adminSession{}, err
	}
	csrf, err := randomToken(24)
	if err != nil {
		return adminSession{}, err
	}
	now := time.Now()
	address := requestAddress(r)
	session := adminSession{CSRF: csrf, Role: role, ClientKeyID: clientKeyID, LoginIP: address, LastIP: address, UserAgent: r.UserAgent(), CreatedAt: now, LastSeenAt: now, ExpiresAt: now.Add(adminSessionTTL)}
	a.mu.Lock()
	a.sessions[token] = session
	a.mu.Unlock()
	name, path := adminCookie, adminPrefix
	if role == "user" {
		name, path = userCookie, portalPrefix
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: token, Path: path, Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: int(adminSessionTTL.Seconds())})
	return session, nil
}

func (a *adminServer) session(r *http.Request, role string) (string, adminSession, bool) {
	name := adminCookie
	if role == "user" {
		name = userCookie
	}
	cookie, err := r.Cookie(name)
	if err != nil {
		return "", adminSession{}, false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[cookie.Value]
	if !ok || time.Now().After(s.ExpiresAt) || s.Role != role {
		delete(a.sessions, cookie.Value)
		return "", adminSession{}, false
	}
	s.LastIP = requestAddress(r)
	s.LastSeenAt = time.Now()
	a.sessions[cookie.Value] = s
	return cookie.Value, s, true
}

func (a *adminServer) requireSession(w http.ResponseWriter, r *http.Request, role string, mutation bool) (string, adminSession, bool) {
	token, session, ok := a.session(r, role)
	if !ok {
		writeAdminJSON(w, http.StatusUnauthorized, map[string]any{"error": "authentication required"})
		return "", adminSession{}, false
	}
	if mutation && r.Header.Get("X-CSRF-Token") != session.CSRF {
		writeAdminJSON(w, http.StatusForbidden, map[string]any{"error": "invalid CSRF token"})
		return "", adminSession{}, false
	}
	return token, session, true
}

func (a *adminServer) serveAPI(w http.ResponseWriter, r *http.Request, path string) {
	if path == "login" && r.Method == http.MethodPost {
		a.handleLogin(w, r)
		return
	}
	mutation := r.Method != http.MethodGet && r.Method != http.MethodHead
	token, session, ok := a.requireSession(w, r, "admin", mutation)
	if !ok {
		return
	}
	switch {
	case path == "session" && r.Method == http.MethodGet:
		writeAdminJSON(w, http.StatusOK, map[string]any{"authenticated": true, "csrf_token": session.CSRF})
	case path == "logout" && r.Method == http.MethodPost:
		a.mu.Lock()
		delete(a.sessions, token)
		a.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: adminCookie, Value: "", Path: adminPrefix, Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		writeAdminJSON(w, http.StatusOK, map[string]any{"ok": true})
	case path == "status" && r.Method == http.MethodGet:
		a.handleStatus(w, r)
	case path == "client-keys":
		a.handleClientKeys(w, r)
	case path == "upstream-key":
		a.handleUpstreamKey(w, r)
	case path == "archives" && r.Method == http.MethodGet:
		a.handleArchiveList(w, r)
	case strings.HasPrefix(path, "archives/") && r.Method == http.MethodGet:
		a.handleArchive(w, r, strings.TrimPrefix(path, "archives/"))
	default:
		http.NotFound(w, r)
	}
}

func (a *adminServer) serveUserAPI(w http.ResponseWriter, r *http.Request, path string) {
	if path == "user-login" && r.Method == http.MethodPost {
		a.handleUserLogin(w, r)
		return
	}
	mutation := r.Method != http.MethodGet && r.Method != http.MethodHead
	token, session, ok := a.requireSession(w, r, "user", mutation)
	if !ok {
		return
	}
	switch {
	case path == "user-session" && r.Method == http.MethodGet:
		writeAdminJSON(w, 200, map[string]any{"authenticated": true, "csrf_token": session.CSRF, "client_key_id": session.ClientKeyID})
	case path == "user-logout" && r.Method == http.MethodPost:
		a.mu.Lock()
		delete(a.sessions, token)
		a.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: userCookie, Value: "", Path: portalPrefix, Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		writeAdminJSON(w, 200, map[string]any{"ok": true})
	case path == "user-usage" && r.Method == http.MethodGet:
		a.handleUserUsage(w, r, session.ClientKeyID)
	case path == "user-archives" && r.Method == http.MethodGet:
		a.handleUserArchiveList(w, r, session.ClientKeyID)
	case strings.HasPrefix(path, "user-archives/") && r.Method == http.MethodGet:
		a.handleUserArchive(w, r, strings.TrimPrefix(path, "user-archives/"), session.ClientKeyID)
	default:
		http.NotFound(w, r)
	}
}

func (a *adminServer) handleUserLogin(w http.ResponseWriter, r *http.Request) {
	address := requestAddress(r)
	if !a.loginAllowed(address) {
		writeAdminJSON(w, 429, map[string]any{"error": "too many login attempts"})
		return
	}
	var input struct {
		Key string `json:"key"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input) != nil {
		writeAdminJSON(w, 400, map[string]any{"error": "invalid request"})
		return
	}
	id, ok := authenticateClientKey("Bearer " + strings.TrimSpace(input.Key))
	if !ok {
		a.loginFailed(address)
		writeAdminJSON(w, 401, map[string]any{"error": "invalid credentials"})
		return
	}
	a.loginSucceeded(address)
	s, err := a.createSession(w, r, "user", id)
	if err != nil {
		writeAdminJSON(w, 500, map[string]any{"error": "session unavailable"})
		return
	}
	writeAdminJSON(w, 200, map[string]any{"authenticated": true, "csrf_token": s.CSRF, "client_key_id": id})
}

func archiveMetadata(path string) (metadata, error) {
	var m metadata
	data, err := os.ReadFile(filepath.Join(path, "metadata.json"))
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(data, &m)
	return m, err
}

func (a *adminServer) userArchiveMetadata(clientKeyID string) ([]metadata, error) {
	entries, err := os.ReadDir(a.archiveRoot)
	if err != nil {
		return nil, err
	}
	var result []metadata
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		m, err := archiveMetadata(filepath.Join(a.archiveRoot, e.Name()))
		if err == nil && m.ClientKeyID == clientKeyID {
			result = append(result, m)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].StartedAt > result[j].StartedAt })
	return result, nil
}

func (a *adminServer) handleUserUsage(w http.ResponseWriter, r *http.Request, clientKeyID string) {
	items, err := a.userArchiveMetadata(clientKeyID)
	if err != nil {
		writeAdminJSON(w, 500, map[string]any{"error": "cannot read usage"})
		return
	}
	usage := tokenUsage{}
	models := map[string]int{}
	success := 0
	for _, m := range items {
		usage.PromptTokens += m.Usage.PromptTokens
		usage.CompletionTokens += m.Usage.CompletionTokens
		usage.TotalTokens += m.Usage.TotalTokens
		if m.Model != "" {
			models[m.Model]++
		}
		if m.ResponseStatus >= 200 && m.ResponseStatus < 300 {
			success++
		}
	}
	recent := items
	if len(recent) > 6 {
		recent = recent[:6]
	}
	writeAdminJSON(w, 200, map[string]any{"request_count": len(items), "successful_requests": success, "prompt_tokens": usage.PromptTokens, "completion_tokens": usage.CompletionTokens, "total_tokens": usage.TotalTokens, "usage": usage, "models": models, "recent_requests": recent})
}

func (a *adminServer) handleUserArchiveList(w http.ResponseWriter, r *http.Request, clientKeyID string) {
	all, err := a.userArchiveMetadata(clientKeyID)
	if err != nil {
		writeAdminJSON(w, 500, map[string]any{"error": "cannot list archives"})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	if offset < 0 {
		offset = 0
	}
	if offset > len(all) {
		offset = len(all)
	}
	end := offset + limit
	if end > len(all) {
		end = len(all)
	}
	items := make([]archiveListItem, 0, end-offset)
	for _, m := range all[offset:end] {
		items = append(items, archiveListItem{ID: m.ID, StartedAt: m.StartedAt, CompletedAt: m.CompletedAt, Method: m.Method, RequestURI: m.RequestURI, ResponseStatus: m.ResponseStatus, Complete: m.Complete, Model: m.Model, Usage: m.Usage})
	}
	next := ""
	if end < len(all) {
		next = strconv.Itoa(end)
	}
	writeAdminJSON(w, 200, map[string]any{"items": items, "next_cursor": next})
}

func (a *adminServer) handleUserArchive(w http.ResponseWriter, r *http.Request, rest, clientKeyID string) {
	parts := strings.Split(rest, "/")
	if len(parts) == 0 {
		return
	}
	path, err := safeArchivePath(a.archiveRoot, parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	m, err := archiveMetadata(path)
	if err != nil || m.ClientKeyID != clientKeyID {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 1 {
		writeAdminJSON(w, 200, m)
		return
	}
	if len(parts) != 2 || (parts[1] != "request" && parts[1] != "response") {
		http.NotFound(w, r)
		return
	}
	serveArchiveBody(w, r, path, parts[1])
}

func (a *adminServer) handleLogin(w http.ResponseWriter, r *http.Request) {
	address := requestAddress(r)
	if !a.loginAllowed(address) {
		writeAdminJSON(w, http.StatusTooManyRequests, map[string]any{"error": "too many login attempts"})
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		writeAdminJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
		return
	}
	hash, err := os.ReadFile(a.passwordFile)
	if err != nil || len(strings.TrimSpace(string(hash))) == 0 {
		writeAdminJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "admin password is not configured"})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(strings.TrimSpace(string(hash))), []byte(input.Password)) != nil {
		a.loginFailed(address)
		writeAdminJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid credentials"})
		return
	}
	a.loginSucceeded(address)
	s, err := a.createSession(w, r, "admin", "")
	if err != nil {
		writeAdminJSON(w, http.StatusInternalServerError, map[string]any{"error": "session unavailable"})
		return
	}
	writeAdminJSON(w, http.StatusOK, map[string]any{"authenticated": true, "csrf_token": s.CSRF})
}

func maskSecret(value string) string {
	value = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "Bearer "))
	if len(value) <= 8 {
		return strings.Repeat("•", len(value))
	}
	return value[:4] + strings.Repeat("•", 8) + value[len(value)-4:]
}

func keyID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

func readPlainKeys(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var result []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			result = append(result, strings.TrimSpace(strings.TrimPrefix(line, "Bearer ")))
		}
	}
	return result, nil
}

func atomicSecretFile(path string, content []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".secret-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func (a *adminServer) handleClientKeys(w http.ResponseWriter, r *http.Request) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	keys, err := readPlainKeys(a.keysFile)
	if err != nil {
		writeAdminJSON(w, 500, map[string]any{"error": "cannot read client keys"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		items := make([]map[string]string, 0, len(keys))
		for _, key := range keys {
			items = append(items, map[string]string{"id": keyID(key), "masked": maskSecret(key)})
		}
		writeAdminJSON(w, 200, map[string]any{"items": items})
	case http.MethodPost:
		var input struct {
			Key string `json:"key"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input)
		key := strings.TrimSpace(input.Key)
		if key == "" {
			token, e := randomToken(32)
			if e != nil {
				writeAdminJSON(w, 500, map[string]any{"error": "key generation failed"})
				return
			}
			key = "sk-proxy-" + token
		}
		if strings.ContainsAny(key, "\r\n") {
			writeAdminJSON(w, 400, map[string]any{"error": "invalid key"})
			return
		}
		for _, existing := range keys {
			if subtleEqual(existing, key) {
				writeAdminJSON(w, 409, map[string]any{"error": "key already exists"})
				return
			}
		}
		keys = append(keys, key)
		if err := atomicSecretFile(a.keysFile, []byte(strings.Join(keys, "\n")+"\n")); err != nil || loadKeys(a.keysFile) != nil {
			writeAdminJSON(w, 500, map[string]any{"error": "cannot save client key"})
			return
		}
		writeAdminJSON(w, 201, map[string]any{"id": keyID(key), "key": key, "masked": maskSecret(key)})
	case http.MethodDelete:
		id := r.URL.Query().Get("id")
		var kept []string
		found := false
		for _, key := range keys {
			if keyID(key) == id {
				found = true
			} else {
				kept = append(kept, key)
			}
		}
		if !found {
			writeAdminJSON(w, 404, map[string]any{"error": "key not found"})
			return
		}
		content := ""
		if len(kept) > 0 {
			content = strings.Join(kept, "\n") + "\n"
		}
		if err := atomicSecretFile(a.keysFile, []byte(content)); err != nil || loadKeys(a.keysFile) != nil {
			writeAdminJSON(w, 500, map[string]any{"error": "cannot save client keys"})
			return
		}
		writeAdminJSON(w, 200, map[string]any{"ok": true})
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		http.Error(w, "method not allowed", 405)
	}
}

func subtleEqual(a, b string) bool { return keyID(a) == keyID(b) && len(a) == len(b) }

func (a *adminServer) handleUpstreamKey(w http.ResponseWriter, r *http.Request) {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	switch r.Method {
	case http.MethodGet:
		data, err := os.ReadFile(a.upstreamFile)
		if err != nil {
			writeAdminJSON(w, 500, map[string]any{"error": "cannot read upstream key"})
			return
		}
		writeAdminJSON(w, 200, map[string]any{"configured": len(strings.TrimSpace(string(data))) > 0, "masked": maskSecret(string(data))})
	case http.MethodPut:
		var input struct {
			Key string `json:"key"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input) != nil {
			writeAdminJSON(w, 400, map[string]any{"error": "invalid request"})
			return
		}
		key := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(input.Key), "Bearer "))
		if key == "" || strings.ContainsAny(key, "\r\n") {
			writeAdminJSON(w, 400, map[string]any{"error": "invalid key"})
			return
		}
		if err := atomicSecretFile(a.upstreamFile, []byte(key+"\n")); err != nil || loadUpstreamKey(a.upstreamFile) != nil {
			writeAdminJSON(w, 500, map[string]any{"error": "cannot save upstream key"})
			return
		}
		writeAdminJSON(w, 200, map[string]any{"ok": true, "masked": maskSecret(key)})
	default:
		w.Header().Set("Allow", "GET, PUT")
		http.Error(w, "method not allowed", 405)
	}
}

func directorySize(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, e := d.Info(); e == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

func (a *adminServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	entries, _ := os.ReadDir(a.archiveRoot)
	count := 0
	globalUsage := tokenUsage{}
	models := map[string]int{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		count++
		if m, err := archiveMetadata(filepath.Join(a.archiveRoot, e.Name())); err == nil {
			globalUsage.PromptTokens += m.Usage.PromptTokens
			globalUsage.CompletionTokens += m.Usage.CompletionTokens
			globalUsage.TotalTokens += m.Usage.TotalTokens
			if m.Model != "" {
				models[m.Model]++
			}
		}
	}
	var stat syscall.Statfs_t
	_ = syscall.Statfs(a.archiveRoot, &stat)
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	tsState := "unknown"
	ips := []string{}
	if lc, err := a.tailscale.LocalClient(); err == nil {
		if status, e := lc.Status(r.Context()); e == nil {
			tsState = status.BackendState
		}
	}
	v4, v6 := a.tailscale.TailscaleIPs()
	if v4.IsValid() {
		ips = append(ips, v4.String())
	}
	if v6.IsValid() {
		ips = append(ips, v6.String())
	}
	uptime := int64(time.Since(a.startedAt).Seconds())
	used := total - free
	archiveBytes := directorySize(a.archiveRoot)
	usedPercent := float64(0)
	if total > 0 {
		usedPercent = float64(used) * 100 / float64(total)
	}
	writeAdminJSON(w, 200, map[string]any{
		"version": appVersion, "uptime_seconds": uptime, "uptime": uptime,
		"service":   map[string]any{"status": "online", "uptime": uptime, "version": appVersion},
		"tailscale": map[string]any{"state": tsState, "status": tsState, "ips": ips, "ip": strings.Join(ips, ", "), "exit_node": os.Getenv("TAILSCALE_EXIT_NODE")},
		"archives":  map[string]any{"count": count, "bytes": archiveBytes, "size": archiveBytes},
		"usage":     map[string]any{"prompt_tokens": globalUsage.PromptTokens, "completion_tokens": globalUsage.CompletionTokens, "total_tokens": globalUsage.TotalTokens, "models": models},
		"disk":      map[string]any{"total_bytes": total, "free_bytes": free, "used_bytes": used, "available": free, "used_percent": usedPercent},
	})
}

type archiveListItem struct {
	ID             string     `json:"id"`
	StartedAt      string     `json:"started_at"`
	CompletedAt    string     `json:"completed_at"`
	Method         string     `json:"method"`
	RequestURI     string     `json:"request_uri"`
	Model          string     `json:"model,omitempty"`
	ResponseStatus int        `json:"response_status"`
	Complete       bool       `json:"complete"`
	Bytes          int64      `json:"bytes,omitempty"`
	Usage          tokenUsage `json:"usage"`
}

func (a *adminServer) handleArchiveList(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(a.archiveRoot)
	if err != nil {
		writeAdminJSON(w, 500, map[string]any{"error": "cannot list archives"})
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	if offset < 0 {
		offset = 0
	}
	end := offset + limit
	if end > len(names) {
		end = len(names)
	}
	items := make([]archiveListItem, 0, end-offset)
	for _, id := range names[offset:end] {
		var m metadata
		data, e := os.ReadFile(filepath.Join(a.archiveRoot, id, "metadata.json"))
		if e != nil || json.Unmarshal(data, &m) != nil {
			continue
		}
		items = append(items, archiveListItem{ID: m.ID, StartedAt: m.StartedAt, CompletedAt: m.CompletedAt, Method: m.Method, RequestURI: m.RequestURI, ResponseStatus: m.ResponseStatus, Complete: m.Complete, Bytes: directorySize(filepath.Join(a.archiveRoot, id))})
	}
	next := ""
	if end < len(names) {
		next = strconv.Itoa(end)
	}
	writeAdminJSON(w, 200, map[string]any{"items": items, "next_cursor": next})
}

func safeArchivePath(root, id string) (string, error) {
	if id == "" || filepath.Base(id) != id || strings.Contains(id, "..") {
		return "", errors.New("invalid archive id")
	}
	path := filepath.Join(root, id)
	if st, err := os.Stat(path); err != nil || !st.IsDir() {
		return "", os.ErrNotExist
	}
	return path, nil
}

func serveArchiveBody(w http.ResponseWriter, r *http.Request, path, kind string) {
	name := kind + ".body"
	f, e := os.Open(filepath.Join(path, name))
	if e != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, _ := f.Stat()
	if info != nil && info.Size() > archivePreviewMax {
		w.Header().Set("X-Content-Truncated", "true")
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.CopyN(w, f, archivePreviewMax)
}

func (a *adminServer) handleArchive(w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(rest, "/")
	path, err := safeArchivePath(a.archiveRoot, parts[0])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 1 {
		var value any
		data, e := os.ReadFile(filepath.Join(path, "metadata.json"))
		if e != nil || json.Unmarshal(data, &value) != nil {
			writeAdminJSON(w, 500, map[string]any{"error": "invalid metadata"})
			return
		}
		writeAdminJSON(w, 200, value)
		return
	}
	if len(parts) != 2 || (parts[1] != "request" && parts[1] != "response") {
		http.NotFound(w, r)
		return
	}
	serveArchiveBody(w, r, path, parts[1])
}

func setAdminPassword() error {
	if os.Geteuid() != 0 {
		return errors.New("must run as root")
	}
	path := getenv("ADMIN_PASSWORD_FILE", "/opt/zhipu-llm-proxy/config/admin-password")
	var password []byte
	var err error
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprint(os.Stderr, "New admin password: ")
		password, err = term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
	} else {
		password, err = io.ReadAll(io.LimitReader(os.Stdin, 4096))
		password = []byte(strings.TrimSpace(string(password)))
	}
	if err != nil {
		return err
	}
	if len(password) < 12 {
		return errors.New("admin password must contain at least 12 characters")
	}
	hash, err := bcrypt.GenerateFromPassword(password, 12)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return atomicSecretFile(path, append(hash, '\n'))
}
