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
	nginxSite    = "/etc/nginx/sites-enabled/zhipu-llm-proxy.conf"
	appVersion   = "2.0.1"
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

func nginxTemplate(serverName, certificate, certificateKey string) string {
	return fmt.Sprintf(`server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name %s;

    ssl_certificate %s;
    ssl_certificate_key %s;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
`, serverName, certificate, certificateKey)
}

func main() {
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "serve":
		runServer()
	case "login":
		loginTailscale()
	case "diagnose-tls":
		diagnoseTLS()
	case "install":
		force := len(os.Args) > 2 && os.Args[2] == "--force"
		if err := install(force); err != nil {
			fmt.Fprintln(os.Stderr, "install:", err)
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
		fmt.Fprintf(os.Stderr, "usage: %s [serve|login|diagnose-tls|install [--force]|uninstall|version]\n", os.Args[0])
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

func safeInstallValue(name string, path bool) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	if strings.ContainsAny(value, "\r\n\t ;{}$") {
		return "", fmt.Errorf("%s contains unsafe characters", name)
	}
	if path && !filepath.IsAbs(value) {
		return "", fmt.Errorf("%s must be an absolute path", name)
	}
	return value, nil
}

func install(force bool) error {
	if err := requireRoot(); err != nil {
		return err
	}
	serverName, err := safeInstallValue("PUBLIC_SERVER_NAME", false)
	if err != nil {
		return err
	}
	certificate, err := safeInstallValue("TLS_CERTIFICATE", true)
	if err != nil {
		return err
	}
	certificateKey, err := safeInstallValue("TLS_CERTIFICATE_KEY", true)
	if err != nil {
		return err
	}
	exitNode, err := safeInstallValue("TAILSCALE_EXIT_NODE", false)
	if err != nil {
		return err
	}
	if _, err := os.Stat(certificate); err != nil {
		return fmt.Errorf("TLS_CERTIFICATE: %w", err)
	}
	if _, err := os.Stat(certificateKey); err != nil {
		return fmt.Errorf("TLS_CERTIFICATE_KEY: %w", err)
	}
	if _, err := exec.LookPath("nginx"); err != nil {
		return errors.New("nginx is required")
	}
	if st, err := os.Stat(filepath.Dir(nginxSite)); err != nil || !st.IsDir() {
		return fmt.Errorf("nginx sites-enabled directory is required: %s", filepath.Dir(nginxSite))
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
	for _, f := range []string{appRoot + "/config/upstream-key", appRoot + "/config/client-keys"} {
		fd, err := os.OpenFile(f, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return err
		}
		fd.Close()
		if err := os.Chmod(f, 0600); err != nil {
			return err
		}
	}
	if err := installFile(appRoot+"/config/service.env", "TAILSCALE_EXIT_NODE="+exitNode+"\n", 0600, force); err != nil {
		return err
	}
	if err := copySelf(force); err != nil {
		return err
	}
	if err := installFile(systemdUnit, systemdTemplate, 0644, force); err != nil {
		return err
	}
	if err := installFile(nginxSite, nginxTemplate(serverName, certificate, certificateKey), 0644, force); err != nil {
		return err
	}
	if err := run("/usr/sbin/nginx", "-t"); err != nil {
		return fmt.Errorf("nginx validation: %w", err)
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	statePath := appRoot + "/data/tailscale/tailscaled.state"
	if st, err := os.Stat(statePath); err == nil && st.Size() > 0 {
		if err := run("systemctl", "enable", "--now", "zhipu-llm-proxy.service"); err != nil {
			return err
		}
		return run("systemctl", "reload", "nginx")
	}
	if err := run("systemctl", "enable", "zhipu-llm-proxy.service"); err != nil {
		return err
	}
	fmt.Println("installation complete; run `" + installedBin + " login` before starting the service")
	return nil
}

func uninstall() error {
	if err := requireRoot(); err != nil {
		return err
	}
	_ = run("systemctl", "disable", "--now", "zhipu-llm-proxy.service")
	for _, p := range []string{systemdUnit, nginxSite, installedBin} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if _, err := exec.LookPath("nginx"); err == nil {
		_ = run("systemctl", "reload", "nginx")
	}
	fmt.Println("preserved", strings.Join([]string{appRoot + "/config", appRoot + "/data", appRoot + "/src"}, ", "))
	return nil
}
