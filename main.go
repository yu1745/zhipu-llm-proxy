package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/metacubex/tailscale/ipn"
	"github.com/metacubex/tailscale/tsnet"
)

const upstreamHost = "open.bigmodel.cn"

type keySet struct{ values [][]byte }
type secretValue struct{ value string }

var allowed atomic.Pointer[keySet]
var upstreamCredential atomic.Pointer[secretValue]

type tokenUsage struct {
	PromptTokens             int64 `json:"prompt_tokens"`
	CompletionTokens         int64 `json:"completion_tokens"`
	TotalTokens              int64 `json:"total_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CachedTokens             int64 `json:"cached_tokens"`
}

type metadata struct {
	ID              string      `json:"id"`
	StartedAt       string      `json:"started_at"`
	CompletedAt     string      `json:"completed_at,omitempty"`
	RemoteAddr      string      `json:"remote_addr"`
	Method          string      `json:"method"`
	RequestURI      string      `json:"request_uri"`
	ClientKeyID     string      `json:"client_key_id,omitempty"`
	Model           string      `json:"model,omitempty"`
	Usage           tokenUsage  `json:"usage"`
	RequestHeaders  http.Header `json:"request_headers"`
	UpstreamURL     string      `json:"upstream_url"`
	ResponseStatus  int         `json:"response_status,omitempty"`
	ResponseHeaders http.Header `json:"response_headers,omitempty"`
	Complete        bool        `json:"complete"`
	Error           string      `json:"error,omitempty"`
}

func loadKeys(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var keys [][]byte
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "Bearer "))
		if line != "" {
			keys = append(keys, []byte(line))
		}
	}
	if err := s.Err(); err != nil {
		return err
	}
	allowed.Store(&keySet{values: keys})
	log.Printf("loaded %d allowed keys", len(keys))
	return nil
}

func loadUpstreamKey(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	key := strings.TrimSpace(string(b))
	key = strings.TrimSpace(strings.TrimPrefix(key, "Bearer "))
	if key == "" {
		return fmt.Errorf("upstream key is empty")
	}
	upstreamCredential.Store(&secretValue{value: key})
	return nil
}

func authenticateClientKey(header string) (string, bool) {
	candidateText := strings.TrimSpace(header)
	if strings.HasPrefix(candidateText, "Bearer ") {
		candidateText = strings.TrimSpace(strings.TrimPrefix(candidateText, "Bearer "))
	}
	candidate := []byte(candidateText)
	set := allowed.Load()
	if set == nil {
		return "", false
	}
	matched := ""
	for _, key := range set.values {
		if len(candidate) == len(key) && subtle.ConstantTimeCompare(candidate, key) == 1 {
			matched = keyID(string(key))
		}
	}
	return matched, matched != ""
}

var hopByHopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true,
	"Proxy-Authorization": true, "Proxy-Connection": true, "Te": true,
	"Trailer": true, "Transfer-Encoding": true, "Upgrade": true,
}

func copyHeader(dst, src http.Header) {
	connectionTokens := map[string]bool{}
	for _, value := range src.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			connectionTokens[http.CanonicalHeaderKey(strings.TrimSpace(token))] = true
		}
	}
	for k, values := range src {
		canonical := http.CanonicalHeaderKey(k)
		if hopByHopHeaders[canonical] || connectionTokens[canonical] {
			continue
		}
		for _, v := range values {
			dst.Add(k, v)
		}
	}
}
func clonedRedactedHeaders(src http.Header) http.Header {
	h := src.Clone()
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie", "Set-Cookie", "X-Api-Key", "Api-Key"} {
		if h.Get(name) != "" {
			h.Set(name, "[REDACTED]")
		}
	}
	return h
}
func requestID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return time.Now().UTC().Format("20060102T150405.000000000Z") + "-" + hex.EncodeToString(b), nil
}
func writeJSON(path string, v any) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	e := json.NewEncoder(f)
	e.SetIndent("", "  ")
	if err = e.Encode(v); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
func clientIP(remote string, headers http.Header) string {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return remote
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		forwarded := strings.TrimSpace(strings.Split(headers.Get("X-Forwarded-For"), ",")[0])
		if net.ParseIP(forwarded) != nil {
			return forwarded
		}
	}
	return host
}

type wireUsage struct {
	PromptTokens             int64 `json:"prompt_tokens"`
	CompletionTokens         int64 `json:"completion_tokens"`
	TotalTokens              int64 `json:"total_tokens"`
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	PromptTokensDetails      struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
}

func normalizedUsage(u wireUsage) tokenUsage {
	prompt, completion, total := u.PromptTokens, u.CompletionTokens, u.TotalTokens
	if prompt == 0 {
		prompt = u.InputTokens
	}
	if completion == 0 {
		completion = u.OutputTokens
	}
	if total == 0 {
		total = prompt + completion
	}
	cached := u.PromptTokensDetails.CachedTokens
	if cached == 0 {
		cached = u.CacheReadInputTokens + u.CacheCreationInputTokens
	}
	return tokenUsage{
		PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total,
		CacheReadInputTokens: u.CacheReadInputTokens, CacheCreationInputTokens: u.CacheCreationInputTokens,
		CachedTokens: cached,
	}
}
func mergeUsage(dst *tokenUsage, src tokenUsage) {
	if src.PromptTokens != 0 {
		dst.PromptTokens = src.PromptTokens
	}
	if src.CompletionTokens != 0 {
		dst.CompletionTokens = src.CompletionTokens
	}
	if src.CacheReadInputTokens != 0 {
		dst.CacheReadInputTokens = src.CacheReadInputTokens
	}
	if src.CacheCreationInputTokens != 0 {
		dst.CacheCreationInputTokens = src.CacheCreationInputTokens
	}
	if src.CachedTokens != 0 {
		dst.CachedTokens = src.CachedTokens
	}
	if src.TotalTokens != 0 && src.PromptTokens != 0 && src.CompletionTokens != 0 {
		dst.TotalTokens = src.TotalTokens
	} else {
		dst.TotalTokens = dst.PromptTokens + dst.CompletionTokens
	}
}

func enrichArchiveMetadata(dir string, meta *metadata) {
	if data, err := os.ReadFile(filepath.Join(dir, "request.body")); err == nil {
		var request struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(data, &request) == nil {
			meta.Model = request.Model
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, "response.body"))
	if err != nil {
		return
	}
	var response struct {
		Model string    `json:"model"`
		Usage wireUsage `json:"usage"`
	}
	if json.Unmarshal(data, &response) == nil {
		if response.Model != "" {
			meta.Model = response.Model
		}
		meta.Usage = normalizedUsage(response.Usage)
		return
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Model   string    `json:"model"`
			Usage   wireUsage `json:"usage"`
			Message *struct {
				Model string    `json:"model"`
				Usage wireUsage `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(payload), &chunk) == nil {
			if chunk.Model != "" {
				meta.Model = chunk.Model
			}
			mergeUsage(&meta.Usage, normalizedUsage(chunk.Usage))
			if chunk.Message != nil {
				if chunk.Message.Model != "" {
					meta.Model = chunk.Message.Model
				}
				mergeUsage(&meta.Usage, normalizedUsage(chunk.Message.Usage))
			}
		}
	}
}

func readOptionalSecret(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		log.Fatalf("read %s: %v", path, err)
	}
	return strings.TrimSpace(string(b))
}

func configureExitNode(ctx context.Context, server *tsnet.Server, exitNode string) error {
	lc, err := server.LocalClient()
	if err != nil {
		return err
	}
	for {
		status, err := lc.Status(ctx)
		if err == nil && status.BackendState == "Running" {
			prefs := &ipn.MaskedPrefs{ExitNodeIPSet: true, ExitNodeAllowLANAccessSet: true}
			prefs.ExitNodeAllowLANAccess = false
			if err := prefs.SetExitNodeIP(exitNode, status); err != nil {
				return err
			}
			if _, err := lc.EditPrefs(ctx, prefs); err != nil {
				return err
			}
			log.Printf("embedded Tailscale is running through exit node %s", exitNode)
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func tsnetDialContext(server *tsnet.Server) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, portText, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		port, err := net.LookupPort("tcp", portText)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		ns, err := server.Netstack(ctx)
		if err != nil {
			return nil, err
		}
		v4, v6 := server.TailscaleIPs()
		var lastErr error
		for _, ip := range ips {
			if !ip.IsValid() {
				continue
			}
			src := v4
			if ip.Is6() {
				src = v6
			}
			conn, err := ns.DialContextTCPWithBind(ctx, src, netip.AddrPortFrom(ip.Unmap(), uint16(port)))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		if lastErr == nil {
			lastErr = fmt.Errorf("no IP addresses for %s", host)
		}
		return nil, lastErr
	}
}

func loadServiceEnvironment() {
	path := getenv("SERVICE_ENV_FILE", "/opt/zhipu-llm-proxy/config/service.env")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if ok && os.Getenv(strings.TrimSpace(name)) == "" {
			_ = os.Setenv(strings.TrimSpace(name), strings.TrimSpace(value))
		}
	}
}

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func newEmbeddedTailscale(stateDir, authKeyFile string) *tsnet.Server {
	hostname := getenv("TAILSCALE_HOSTNAME", "zhipu-llm-egress")
	return &tsnet.Server{Dir: stateDir, Hostname: hostname, AuthKey: readOptionalSecret(authKeyFile), Ephemeral: false, UserLogf: log.Printf, Logf: log.Printf}
}

func loginTailscale() {
	stateDir := getenv("TAILSCALE_STATE_DIR", "/opt/zhipu-llm-proxy/data/tailscale")
	authKeyFile := getenv("TAILSCALE_AUTH_KEY_FILE", "/opt/zhipu-llm-proxy/config/tailscale-auth-key")
	exitNode := requiredEnv("TAILSCALE_EXIT_NODE")
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		log.Fatal(err)
	}
	server := newEmbeddedTailscale(stateDir, authKeyFile)
	if err := server.Start(); err != nil {
		log.Fatalf("start embedded Tailscale: %v", err)
	}
	log.Printf("waiting for Tailscale login; open the authorization URL printed below if requested")
	if err := configureExitNode(context.Background(), server, exitNode); err != nil {
		_ = server.Close()
		log.Fatalf("configure exit node: %v", err)
	}
	if err := server.Close(); err != nil {
		log.Printf("close embedded Tailscale after login: %v", err)
	}
	log.Printf("login complete; state saved in %s", stateDir)
	if stateDir == "/opt/zhipu-llm-proxy/data/tailscale" {
		if _, err := os.Stat(systemdUnit); err == nil {
			if err := run("systemctl", "restart", "zhipu-llm-proxy.service"); err != nil {
				log.Printf("service restart failed: %v", err)
			}
			if err := run("systemctl", "reload", "nginx"); err != nil {
				log.Printf("nginx reload failed: %v", err)
			}
		}
	}
}

func runServer() {
	listen := getenv("LISTEN_ADDR", "127.0.0.1:18080")
	keysFile := getenv("CLIENT_KEYS_FILE", "/opt/zhipu-llm-proxy/config/client-keys")
	upstreamKeyFile := getenv("UPSTREAM_KEY_FILE", "/opt/zhipu-llm-proxy/config/upstream-key")
	archiveRoot := getenv("ARCHIVE_DIR", "/opt/zhipu-llm-proxy/data/archive")
	tailscaleDir := getenv("TAILSCALE_STATE_DIR", "/opt/zhipu-llm-proxy/data/tailscale")
	authKeyFile := getenv("TAILSCALE_AUTH_KEY_FILE", "/opt/zhipu-llm-proxy/config/tailscale-auth-key")
	exitNode := requiredEnv("TAILSCALE_EXIT_NODE")
	if err := loadKeys(keysFile); err != nil {
		log.Fatal(err)
	}
	if err := loadUpstreamKey(upstreamKeyFile); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(archiveRoot, 0700); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(tailscaleDir, 0700); err != nil {
		log.Fatal(err)
	}

	ts := newEmbeddedTailscale(tailscaleDir, authKeyFile)
	defer ts.Close()
	if err := ts.Start(); err != nil {
		log.Fatalf("start embedded Tailscale: %v", err)
	}
	if err := configureExitNode(context.Background(), ts, exitNode); err != nil {
		log.Fatalf("configure exit node: %v", err)
	}

	reload := make(chan os.Signal, 1)
	signal.Notify(reload, syscall.SIGHUP)
	go func() {
		for range reload {
			if err := loadKeys(keysFile); err != nil {
				log.Printf("client key reload failed: %v", err)
			}
			if err := loadUpstreamKey(upstreamKeyFile); err != nil {
				log.Printf("upstream key reload failed: %v", err)
			}
		}
	}()

	transport := newNodeLikeTransport(tsnetDialContext(ts))
	client := &http.Client{Transport: transport}
	admin := newAdminServer(keysFile, upstreamKeyFile, archiveRoot, ts)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, adminPrefix) || strings.HasPrefix(r.URL.Path, portalPrefix) {
			admin.ServeHTTP(w, r)
			return
		}
		expectedMethod := ""
		anthropicRequest := false
		switch r.URL.Path {
		case "/api/coding/paas/v4/chat/completions":
			expectedMethod = http.MethodPost
		case "/api/coding/paas/v4/models":
			expectedMethod = http.MethodGet
		case "/api/anthropic/v1/messages", "/api/anthropic/v1/messages/count_tokens":
			expectedMethod = http.MethodPost
			anthropicRequest = true
		case "/api/anthropic/v1/models":
			expectedMethod = http.MethodGet
			anthropicRequest = true
		default:
			http.NotFound(w, r)
			return
		}
		if r.Method != expectedMethod {
			w.Header().Set("Allow", expectedMethod)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		credentialHeader := r.Header.Get("Authorization")
		if credentialHeader == "" {
			credentialHeader = r.Header.Get("X-Api-Key")
		}
		clientKeyID, authenticated := authenticateClientKey(credentialHeader)
		if !authenticated {
			log.Printf("DENY ip=%s method=%s uri=%q", clientIP(r.RemoteAddr, r.Header), r.Method, r.URL.RequestURI())
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":{"message":"invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}`)
			return
		}

		id, err := requestID()
		if err != nil {
			http.Error(w, "request id unavailable", http.StatusInternalServerError)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
		dir := filepath.Join(archiveRoot, id)
		if err := os.Mkdir(dir, 0700); err != nil {
			http.Error(w, "archive unavailable", http.StatusInsufficientStorage)
			return
		}
		reqFile, err := os.OpenFile(filepath.Join(dir, "request.body"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			http.Error(w, "archive unavailable", http.StatusInsufficientStorage)
			return
		}
		defer reqFile.Close()

		u := &url.URL{Scheme: "https", Host: upstreamHost, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
		meta := &metadata{ID: id, StartedAt: time.Now().UTC().Format(time.RFC3339Nano), RemoteAddr: clientIP(r.RemoteAddr, r.Header), Method: r.Method, RequestURI: r.URL.RequestURI(), ClientKeyID: clientKeyID, RequestHeaders: clonedRedactedHeaders(r.Header), UpstreamURL: u.String()}
		if err := writeJSON(filepath.Join(dir, "metadata.json"), meta); err != nil {
			http.Error(w, "archive unavailable", http.StatusInsufficientStorage)
			return
		}

		up, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), io.TeeReader(r.Body, reqFile))
		if err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		copyHeader(up.Header, r.Header)
		credential := upstreamCredential.Load()
		if credential == nil {
			http.Error(w, "upstream credential unavailable", http.StatusServiceUnavailable)
			return
		}
		if anthropicRequest {
			up.Header.Del("Authorization")
			up.Header.Set("X-Api-Key", credential.value)
		} else {
			up.Header.Del("X-Api-Key")
			up.Header.Set("Authorization", "Bearer "+credential.value)
		}
		up.Host = upstreamHost
		up.ContentLength = r.ContentLength
		if _, exists := up.Header["User-Agent"]; !exists {
			up.Header["User-Agent"] = nil
		}

		resp, err := client.Do(up)
		if syncErr := reqFile.Sync(); err == nil && syncErr != nil {
			err = syncErr
		}
		if err != nil {
			meta.Error = err.Error()
			meta.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
			_ = writeJSON(filepath.Join(dir, "metadata.json"), meta)
			if r.Context().Err() == nil {
				log.Printf("id=%s upstream error: %v", id, err)
				http.Error(w, "upstream unavailable", http.StatusBadGateway)
			}
			return
		}
		defer resp.Body.Close()
		meta.ResponseStatus = resp.StatusCode
		meta.ResponseHeaders = clonedRedactedHeaders(resp.Header)
		if err := writeJSON(filepath.Join(dir, "metadata.json"), meta); err != nil {
			http.Error(w, "archive unavailable", http.StatusInsufficientStorage)
			return
		}
		respFile, err := os.OpenFile(filepath.Join(dir, "response.body"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			http.Error(w, "archive unavailable", http.StatusInsufficientStorage)
			return
		}
		defer respFile.Close()

		copyHeader(w.Header(), resp.Header)
		w.Header().Set("X-Archive-ID", id)
		w.WriteHeader(resp.StatusCode)
		flusher, _ := w.(http.Flusher)
		buf := make([]byte, 32*1024)
		complete := true
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, err := respFile.Write(buf[:n]); err != nil {
					complete = false
					meta.Error = "archive write: " + err.Error()
					break
				}
				if _, err := w.Write(buf[:n]); err != nil {
					complete = false
					meta.Error = "client write: " + err.Error()
					break
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				complete = false
				meta.Error = "upstream read: " + readErr.Error()
				break
			}
		}
		if err := respFile.Sync(); err != nil {
			complete = false
			meta.Error = "archive sync: " + err.Error()
		}
		meta.Complete = complete
		meta.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		enrichArchiveMetadata(dir, meta)
		if err := writeJSON(filepath.Join(dir, "metadata.json"), meta); err != nil {
			log.Printf("id=%s final metadata error: %v", id, err)
		}
		log.Printf("id=%s status=%d complete=%t", id, resp.StatusCode, complete)
	})

	srv := &http.Server{Addr: listen, Handler: handler, ReadHeaderTimeout: 15 * time.Second, WriteTimeout: 0, IdleTimeout: 120 * time.Second}
	log.Printf("listening on %s, upstream=https://%s via embedded Tailscale", listen, upstreamHost)
	log.Fatal(srv.ListenAndServe())
}
func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
