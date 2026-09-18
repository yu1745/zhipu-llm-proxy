package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	appRoot      = "/opt/zhipu-llm-proxy"
	installedBin = appRoot + "/bin/zhipu-llm-proxy"
	systemdUnit  = "/etc/systemd/system/zhipu-llm-proxy.service"
	nginxSnippet = "/etc/nginx/snippets/zhipu-llm-proxy.conf"
	appVersion   = "2.1.0"
)

const systemdTemplate = `[Unit]
Description=Zhipu Coding Plan archival proxy with embedded Tailscale
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/zhipu-llm-proxy/bin/zhipu-llm-proxy serve
Restart=on-failure
RestartSec=5
User=root
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
EnvironmentFile=/opt/zhipu-llm-proxy/config/service.env
ReadOnlyPaths=/opt/zhipu-llm-proxy/config
ReadWritePaths=/opt/zhipu-llm-proxy/data
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`

const nginxTemplate = `# OpenAI-compatible Chat Completions
location = /api/coding/paas/v4/chat/completions {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    client_max_body_size 100m;
}

# OpenAI-compatible List Models
location = /api/coding/paas/v4/models {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

# Anthropic-compatible Messages
location = /api/anthropic/v1/messages {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    client_max_body_size 100m;
}
location = /api/anthropic/v1/messages/count_tokens {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}
location = /api/anthropic/v1/models {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

# HTTPS-only administrator dashboard
location ^~ /zhipu-proxy/admin/ {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}

# HTTPS-only client usage portal
location ^~ /zhipu-proxy/portal/ {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
`

func main() {
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "serve":
		loadServiceEnvironment()
		runServer()
	case "login":
		loadServiceEnvironment()
		loginTailscale()
	case "diagnose-tls":
		diagnoseTLS()
	case "set-admin-password":
		if err := setAdminPassword(); err != nil {
			fmt.Fprintln(os.Stderr, "set-admin-password:", err)
			os.Exit(1)
		}
	case "install":
		force := len(os.Args) > 2 && os.Args[2] == "--force"
		if err := install(force); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
			os.Exit(1)
		}
	case "install-nginx":
		force := len(os.Args) > 2 && os.Args[2] == "--force"
		if err := installNginx(force); err != nil {
			fmt.Fprintln(os.Stderr, "install-nginx:", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := uninstall(); err != nil {
			fmt.Fprintln(os.Stderr, "uninstall:", err)
			os.Exit(1)
		}
	case "version", "--version", "-v":
		fmt.Println(appVersion)
	default:
		fmt.Fprintf(os.Stderr, "usage: %s [serve|login|diagnose-tls|set-admin-password|install [--force]|install-nginx [--force]|uninstall|version]\n", os.Args[0])
		os.Exit(2)
	}
}

func diagnoseTLS() {
	dialer := &net.Dialer{}
	client := &http.Client{Transport: newNodeLikeTransport(dialer.DialContext)}
	resp, err := client.Get("https://tls.peet.ws/api/all")
	if err != nil {
		fmt.Fprintln(os.Stderr, "diagnose-tls:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(os.Stdout, resp.Body)
}

func requireRoot() error {
	if os.Geteuid() != 0 {
		return errors.New("must run as root")
	}
	return nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".install-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
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

func installFile(path, content string, mode os.FileMode, force bool) error {
	old, err := os.ReadFile(path)
	if err == nil {
		if string(old) == content {
			return nil
		}
		if !force {
			return fmt.Errorf("%s exists with different content; use --force", path)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return atomicWrite(path, []byte(content), mode)
}

func copySelf(force bool) error {
	src, err := os.Executable()
	if err != nil {
		return err
	}
	src, err = filepath.EvalSymlinks(src)
	if err != nil {
		return err
	}
	dstAbs, _ := filepath.Abs(installedBin)
	if src == dstAbs {
		return nil
	}
	if _, err := os.Stat(installedBin); err == nil && !force {
		return fmt.Errorf("%s already exists; use --force", installedBin)
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(installedBin), 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(installedBin), ".binary-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0755); err != nil {
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
	return os.Rename(name, installedBin)
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

func ensureFile(path, content string, mode os.FileMode) error {
	fd, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if os.IsExist(err) {
		return os.Chmod(path, mode)
	}
	if err != nil {
		return err
	}
	if _, err := fd.WriteString(content); err != nil {
		fd.Close()
		return err
	}
	return fd.Close()
}

func install(force bool) error {
	if err := requireRoot(); err != nil {
		return err
	}
	for _, d := range []struct {
		path string
		mode os.FileMode
	}{
		{appRoot + "/bin", 0755}, {appRoot + "/src", 0755},
		{appRoot + "/config", 0700}, {appRoot + "/data", 0700},
		{appRoot + "/data/archive", 0700}, {appRoot + "/data/tailscale", 0700},
	} {
		if err := os.MkdirAll(d.path, d.mode); err != nil {
			return err
		}
		if err := os.Chmod(d.path, d.mode); err != nil {
			return err
		}
	}
	for _, f := range []struct{ path, content string }{
		{appRoot + "/config/upstream-key", ""},
		{appRoot + "/config/client-keys", ""},
		{appRoot + "/config/admin-password", ""},
		{appRoot + "/config/service.env", "# Required before login/start\nTAILSCALE_EXIT_NODE=\nTAILSCALE_HOSTNAME=zhipu-llm-egress\n# LISTEN_ADDR=127.0.0.1:18080\n"},
	} {
		if err := ensureFile(f.path, f.content, 0600); err != nil {
			return err
		}
	}
	if err := copySelf(force); err != nil {
		return err
	}
	if err := installFile(systemdUnit, systemdTemplate, 0644, force); err != nil {
		return err
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err := run("systemctl", "enable", "zhipu-llm-proxy.service"); err != nil {
		return err
	}
	fmt.Println("installation complete; configure service.env and keys, then run `" + installedBin + " login`")
	return nil
}

func installNginx(force bool) error {
	if err := requireRoot(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(nginxSnippet), 0755); err != nil {
		return err
	}
	if err := installFile(nginxSnippet, nginxTemplate, 0644, force); err != nil {
		return err
	}
	fmt.Println("nginx snippet installed at", nginxSnippet)
	fmt.Println("add `include " + nginxSnippet + ";` inside your existing nginx server block, then validate and reload nginx")
	return nil
}

func uninstall() error {
	if err := requireRoot(); err != nil {
		return err
	}
	_ = run("systemctl", "disable", "--now", "zhipu-llm-proxy.service")
	for _, p := range []string{systemdUnit, installedBin} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	fmt.Println("preserved", strings.Join([]string{appRoot + "/config", appRoot + "/data", appRoot + "/src", nginxSnippet}, ", "))
	return nil
}
