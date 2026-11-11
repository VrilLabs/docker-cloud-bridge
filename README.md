# Docker Cloud CI MCP Bridge

A small single-user fallback CI execution bridge. Not a proxy for Docker's MCP Gateway.
Perplexity -> HTTPS /mcp (Bearer API key) -> Docker Sandboxes SDK (Docker ID + PAT).
No Docker socket, host shell execution, OAuth callback, model API key or sbx installation required.

## Quick start (Node 22+, one replica only)

1. Extract archive and enter directory. Run `npm install` (internet required). Review the resolved Docker SDK version and commit package-lock.json before production; Docker SDK is deliberately not version-guessed. MCP SDK is pinned to the official v1 API reviewed via Context7.
2. `cp .env.example .env; cp projects.example.json projects.json; chmod 600 .env`
3. Generate a key: `openssl rand -hex 32`. Put it in BRIDGE_API_KEY. Never paste the Docker PAT into a chat or connector form.
4. Create Docker PAT with **Allow Cloud Sandboxes access**; set DOCKER_ID and DOCKER_PAT. Requires active Agentic Platform subscription; compute is separately billed.
5. Edit projects.json to allow only repositories and scripts you trust. Only exact 40-character commit SHAs accepted. Caller cannot choose a URL, shell command, kit or secret.
6. `npm test`. For a no-cost transport test set MOCK_DOCKER=1, then `npm start`. In another terminal run `node --env-file=.env scripts/smoke.mjs`.
7. Set MOCK_DOCKER=0 and restart for real execution. Use a disposable repository for the first build. Shell kit must have git and your build tools; example task checks node/npm and fails if missing. This package does NOT assume shell kit contains a full language toolchain. Customize scripts to bootstrap trusted pinned tooling, or adapt the SDK launch to a reviewed image/kit using Docker's image documentation.
8. Run behind an HTTPS reverse proxy on a persistent host. Caddyfile supplied; set BRIDGE_DOMAIN in the Caddy service environment. Run Caddy on the same host as this app. Keep app bound to 127.0.0.1, firewall port 8080, expose 443 (and 80 for ACME if needed). Run app under a non-root service account with a service manager and an explicit working directory. Do not expose it directly over plain HTTP.

## Connect Perplexity

Plugins -> Add custom -> Add MCP connector -> Remote.
URL: https://YOUR_DOMAIN/mcp
Transport: Streamable HTTP. Authentication: API Key, not OAuth.
API key: BRIDGE_API_KEY. Server expects `Authorization: Bearer <key>`.
The official Perplexity guide does not specify the API Key field's exact wire encoding. Validate this with smoke.mjs and connector setup; if your client sends a different standard authorization format, adjust the auth middleware deliberately, not by disabling auth. There is no arbitrary custom-header field in the connector form.

Tools: list_projects, start_build, get_build_status, get_build_logs.
Example request: list approved tasks, then ask me to approve a test of project my-app at exact commit SHA. Start only after approval, generate a UUID request_id, and poll status. Reuse the SAME request_id when retrying a timed-out start call. Read logs after completion.

## Behavior and limitations

* Uses official SDK PAT exchange, shell kit launch, waitUntilRunning, processes.run, refresh/delete/waitUntilDeleted.
* start_build returns a job ID immediately; poll status. Results and bounded tail logs persist in data/. Logs are collected on process completion, not live streamed. The SDK can buffer more output before truncation here; constrain noisy build output in your trusted script.
* One active job, one process/replica. request_id deduplication retained on disk. No distributed lock or queue. Local disk must persist across restarts. Manually prune old job records when idle; there is no retention scheduler.
* Process timeout is ten minutes; launch/wait timeouts two minutes each. Timeout is not a billing cap. Cleanup attempted in finally, including failed builds. SDK timeouts or a crash can orphan resources. On restart active records become interrupted; inspect Docker Console and delete orphans before retrying. A creation timeout can occur before the sandbox name reaches the bridge. Set account budget alerts and review Console resources. No claim of crash-safe cleanup or auto-expiry.
* Default SDK small compute: 2 CPUs/4 GiB. No network/secret policy is automatically configured by this implementation. Review Docker defaults before handling private code. No Docker secret attached and no GitHub credential is passed; PUBLIC repos only out of the box. Private repos need a separate, explicitly reviewed secret attachment and git authentication setup. Do not put PATs in repo URLs or scripts.
* Default workflow is CI (test/build). No deployment/registry credentials, artifact upload, prod deploy, rollback, cancellations, automatic failover scheduler or GitHub status publishing. Add a fixed allowlisted deployment task only after designing narrowly scoped credentials, independent approval enforcement and rollback.
* Task execution is a billable, side-effecting operation, even for tests. Tool description instructs client to request approval, but does NOT provide a server-side human approval gate. Possession of bridge API key permits running ANY allowlisted task/commit. Use only trusted connector owners. Do not add production deployment credentials unless you implement an independent approval gate.
* An allowlisted repo is not a security boundary against malicious code within that repo. Tests/package scripts execute code from the selected commit. Do not execute unreviewed fork/PR code with secrets. npm ci --ignore-scripts only disables installation lifecycle scripts; npm test/build still execute code.
* Logs are untrusted and may include secrets deliberately printed by code. Only bridge key and Docker PAT are redacted; this is not a generic secret scanner. Docker PAT remains on bridge host and is never deliberately injected into sandbox.
* Require HTTPS, keep API key secret, rotate credentials, limit inbound traffic/rate at proxy. Origin-bearing requests rejected unless ALLOWED_ORIGIN matches; non-browser MCP requests normally omit Origin.

## Verification status

Policy tests can run offline with Node. Dependency installation, MCP smoke testing and real Docker execution require network access/credentials and have NOT been performed by the artifact generator. No live cloud resources were created. Dependency compatibility is based on official examples, not a live integration certification.

## Official references consulted

https://docs.docker.com/ai/sandboxes-api/
https://docs.docker.com/ai/sandboxes-api/authentication/
https://docs.docker.com/ai/sandboxes-api/get-started/
https://docs.docker.com/ai/sandboxes-api/concepts/
https://docs.docker.com/ai/sandboxes-api/cookbook/create-your-first-sandbox/
https://docs.docker.com/ai/sandboxes-api/cookbook/run-your-first-command/
https://docs.docker.com/ai/sandboxes-api/limits/
https://github.com/modelcontextprotocol/typescript-sdk/tree/1.32.2
https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors

Docker CLI cloud secret store and web Agentic Platform secrets are separate. Earlier chat advice implying they are interchangeable was inaccurate. This bridge authenticates directly through the documented SDK API, not by borrowing the Gateway's OAuth session.
