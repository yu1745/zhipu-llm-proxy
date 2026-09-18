# zhipu-llm-proxy

面向智谱 Coding Plan 的 OpenAI 兼容反向代理。它在本地验证客户 Key，以服务端保存的智谱 Key替换 `Authorization`，完整归档请求与响应，并通过内嵌 Tailscale userspace 网络及指定 Exit Node访问智谱。

> 本项目会持久化完整对话内容。部署者必须自行满足隐私告知、数据保护、磁盘容量、备份和删除请求等合规要求。

## 数据路径

```text
Client --HTTPS--> nginx --HTTP/1.1--> zhipu-llm-proxy
                                      |-- authenticate client key
                                      |-- archive request/response
                                      |-- replace Authorization + Host
                                      `-- embedded tsnet --> Exit Node --> open.bigmodel.cn
```

- 上游固定为 `https://open.bigmodel.cn`，请求路径和查询字符串保持不变。
- 上游 TLS ClientHello 模拟 Node.js 22.23.1/OpenSSL 3.5.x，使用 HTTP/1.1。
- `tsnet` 使用 MetaCubeX 的 Tailscale fork，以 userspace netstack完成 Exit Node拨号。
- 无效客户 Key 在本地返回 `401`，不会进入 Tailscale。

## 前置要求

- Linux amd64
- systemd
- 一个允许使用 Exit Node 的 Tailscale账户
- 一个在线并已获批准的 Tailscale Exit Node
- Go 1.25+（仅源码构建需要；`GOTOOLCHAIN=auto` 可自动获取匹配工具链）
- Nginx（可选，用于公网 HTTPS和子路由集成）

Go 服务可以独立提供 HTTP，默认只监听 `127.0.0.1:18080`。如需直接提供 HTTP，可在 `service.env` 中修改 `LISTEN_ADDR`，但不建议把未加密 HTTP直接暴露到公网。

Nginx不是运行必需依赖。可选的 Nginx集成只生成一个 `location` snippet，不创建虚拟主机、不监听端口、不处理域名或证书。

## 构建

```bash
git clone https://github.com/yu1745/zhipu-llm-proxy.git
cd zhipu-llm-proxy
go build -trimpath -o zhipu-llm-proxy .
```

## 安装

```bash
sudo ./zhipu-llm-proxy install
```

安装本身不要求 Nginx、域名、证书或已完成 Tailscale登录。

安装器会创建：

```text
/opt/zhipu-llm-proxy/
├── bin/zhipu-llm-proxy
├── config/
│   ├── service.env
│   ├── upstream-key
│   └── client-keys
└── data/
    ├── archive/
    └── tailscale/
```

以及 systemd入口：

```text
/etc/systemd/system/zhipu-llm-proxy.service
```

配置 Exit Node：

```bash
sudo editor /opt/zhipu-llm-proxy/config/service.env
```

至少填写：

```text
TAILSCALE_EXIT_NODE=100.x.y.z
```

已存在且内容不同的 systemd文件默认不会覆盖；确认后可用 `install --force`。

## 配置 Key

智谱上游 Key：

```bash
sudo sh -c 'printf "%s\n" "YOUR_ZHIPU_KEY" > /opt/zhipu-llm-proxy/config/upstream-key'
```

客户 Key每行一个：

```bash
sudo tee /opt/zhipu-llm-proxy/config/client-keys >/dev/null <<'EOF'
customer-key-1
customer-key-2
EOF
sudo chmod 600 /opt/zhipu-llm-proxy/config/{upstream-key,client-keys}
```

修改 Key后热加载：

```bash
sudo systemctl kill -s HUP zhipu-llm-proxy
```

## 登录 Tailscale

首次安装后执行：

```bash
sudo env TAILSCALE_EXIT_NODE=100.x.y.z \
  /opt/zhipu-llm-proxy/bin/zhipu-llm-proxy login
```

打开终端中显示的登录 URL。成功后状态保存在：

```text
/opt/zhipu-llm-proxy/data/tailscale/
```

该目录包含节点私钥，不得公开、提交或由两个运行实例同时使用。

## 可选 Nginx子路由

生成 snippet：

```bash
sudo /opt/zhipu-llm-proxy/bin/zhipu-llm-proxy install-nginx
```

生成路径：

```text
/etc/nginx/snippets/zhipu-llm-proxy.conf
```

在已有的 HTTPS `server {}` 内引用：

```nginx
include /etc/nginx/snippets/zhipu-llm-proxy.conf;
```

然后验证并无中断加载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

该 snippet 只占用：

```text
/api/coding/paas/v4/chat/completions
/api/coding/paas/v4/models
```

不会接管站点的其他路径。

## OpenAI兼容端点

```text
POST /api/coding/paas/v4/chat/completions
GET  /api/coding/paas/v4/models
```

智谱 Coding Plan的 List Models接口已经过真实请求验证，会返回 OpenAI格式的 `object: list` 响应。支持自动发现模型的客户端无需手工填写模型；不支持自动发现时可使用 `glm-5.3`。

```text
Base URL: https://api.example.com/api/coding/paas/v4
API Key:  客户 Key
```

示例：

```bash
curl https://api.example.com/api/coding/paas/v4/chat/completions \
  -H 'Authorization: Bearer customer-key-1' \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

## 对话归档

每个通过鉴权的请求创建一个独立目录：

```text
/opt/zhipu-llm-proxy/data/archive/<timestamp>-<random-id>/
├── metadata.json
├── request.body
└── response.body
```

- 请求体和响应体按原始字节归档，包括 SSE。
- 常见凭据请求头在 `metadata.json` 中脱敏。
- 无效客户 Key不产生对话归档。
- 默认永久保留，没有自动轮转或容量上限。

部署者应监控磁盘空间并制定符合自身要求的保留策略。归档可能包含提示词、代码、个人信息、模型推理内容和响应中的其他敏感信息。不要把 `data/` 放入 Git仓库。

## 命令

```bash
zhipu-llm-proxy serve
zhipu-llm-proxy login
zhipu-llm-proxy diagnose-tls
zhipu-llm-proxy install [--force]
zhipu-llm-proxy install-nginx [--force]
zhipu-llm-proxy uninstall
zhipu-llm-proxy version
```

`diagnose-tls` 会直接请求 `https://tls.peet.ws/api/all`，仅用于检查 ClientHello，不经过嵌入式 Tailscale。

## 环境变量

| 变量 | 默认值/说明 |
|---|---|
| `LISTEN_ADDR` | `127.0.0.1:18080` |
| `CLIENT_KEYS_FILE` | `/opt/zhipu-llm-proxy/config/client-keys` |
| `UPSTREAM_KEY_FILE` | `/opt/zhipu-llm-proxy/config/upstream-key` |
| `ARCHIVE_DIR` | `/opt/zhipu-llm-proxy/data/archive` |
| `TAILSCALE_STATE_DIR` | `/opt/zhipu-llm-proxy/data/tailscale` |
| `TAILSCALE_AUTH_KEY_FILE` | 可选 auth key 文件 |
| `TAILSCALE_EXIT_NODE` | 必填，Exit Node IP或名称 |
| `TAILSCALE_HOSTNAME` | `zhipu-llm-egress` |

`service.env` 会由 `serve` 和 `login` 子命令自动读取；显式设置的环境变量优先。

## 安全说明

- 服务目前以 root运行。可以直接提供 HTTP，但不要在不可信网络公开未加密端口。
- `upstream-key`、`client-keys`、`service.env` 和 Tailscale状态权限应保持为 `0600/0700`。
- 上游 DNS目前由宿主机解析，TCP连接通过 Exit Node。
- TLS指纹模拟只覆盖 ClientHello/ALPN，不代表完整 Node运行时行为。
- 完整对话归档是本项目的设计要求；这也意味着磁盘耗尽和数据泄露风险需要由部署者主动管理。

## 卸载

```bash
sudo /opt/zhipu-llm-proxy/bin/zhipu-llm-proxy uninstall
```

卸载不会删除以下数据：

```text
/opt/zhipu-llm-proxy/config/
/opt/zhipu-llm-proxy/data/
/opt/zhipu-llm-proxy/src/
```

## 依赖说明

本项目使用 `github.com/metacubex/tailscale`，因为其提供了 Mihomo采用的 userspace Exit Node netstack拨号路径。它不是官方 `tailscale.com` 模块的原样发布版本。

## License

MIT
