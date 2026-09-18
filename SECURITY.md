# Security Policy

Please do not open public issues containing API keys, Tailscale state, archived conversations, private certificates, or other credentials.

Report security vulnerabilities privately through GitHub's **Security advisories → Report a vulnerability** page for this repository.

Before sharing logs or archives, remove:

- `/opt/zhipu-llm-proxy/config/`
- `/opt/zhipu-llm-proxy/data/tailscale/`
- request and response bodies
- authorization, cookies, API keys, hostnames and private addresses

This project archives complete authenticated request and response bodies by design. Operators are responsible for access control, retention, encryption at rest, backups, and regulatory compliance.
