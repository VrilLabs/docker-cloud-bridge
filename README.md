# Docker Cloud CI MCP Bridge

A small single-user fallback CI execution bridge. Not a proxy for Docker's MCP Gateway.
Cloud Container (i.e. Perplexity Computer) -> HTTPS /mcp (Bearer API key) -> Docker Sandboxes SDK (Docker ID + PAT).
No Docker socket, host shell execution, OAuth callback, model API key or sbx installation required.

## Quick start (Node 22+, one replica only)

1. Extract archive and enter directory. Run `npm install` (internet required). Review the resolved Docker SDK version and commit package-lock.json before production; Docker SDK is deliberately not version-guessed. MCP SDK is pinned to the official v1 API reviewed via Context7.
2. `cp .env.example .env; cp projects.example.json projects.json; chmod 600 .env`
3. Generate a key: `openssl rand -hex 32`. Put it in BRIDGE_API_KEY. Never paste the Docker PAT into a chat or connector form.
4. Create Docker PAT with **Allow Cloud Sandboxes access**; set DOCKER_ID and DOCKER_PAT. Requires active Agentic Platform subscription; compute is separately billed.
5. Edit projects.json to allow only repositories and scripts you trust. Only exact 40-character commit SHAs accepted. Caller cannot choose a URL, shell command, kit or secret.
6. `npm test`. For a no-cost transport test set MOCK_DOCKER=1, then `npm start`. In another terminal run `node --env-file=.env scripts/smoke.mjs`.
7. Set MOCK_DOCKER=0 and restart for real execution. Use a disposable repository for the first build. Shell kit must have git and your build tools; example task checks node/npm and fails if missing. This package does NOT assume shell kit contains a full language toolchain. Customize scripts to bootstrap trusted pinned tooling, or adapt the SDK launch to a reviewed image/kit using Docker's image documentation.
8. Deploy on Railway (below). It terminates HTTPS for you, so no reverse proxy is needed.

## Deploy on Railway

Requires the Railway CLI (`railway login`). Run from this directory. `railway.json` sets the start command, `/healthz` healthcheck, restart policy and a single replica.

```bash
railway init                      # or: railway link
railway add --service docker-ci-bridge
railway volume add --mount-path /data   # persistent job records; REQUIRED (the app refuses to start on Railway without one)
railway variables --set "BRIDGE_API_KEY=$(openssl rand -hex 32)" --set "MOCK_DOCKER=1"
railway up                        # first deploy in mock mode (no billable sandboxes)
railway domain                    # public HTTPS URL -> https://<domain>/mcp
```

Then validate: `BRIDGE_URL=https://<domain>/mcp BRIDGE_API_KEY=<key> node scripts/smoke.mjs`.

For real execution set the Docker credentials **in the Railway dashboard** (so they never enter shell history or chat): `DOCKER_ID`, `DOCKER_PAT`, and `MOCK_DOCKER=0`, then redeploy. Optional: `ALLOWED_ORIGIN`, `PROJECTS_FILE`.

Railway notes:
* The app binds `0.0.0.0` and `$PORT` automatically when `RAILWAY_ENVIRONMENT_NAME` is set; locally it stays on `127.0.0.1`.
* `DATA_DIR` defaults to `RAILWAY_VOLUME_MOUNT_PATH`. Keep `numReplicas` at 1: the one-build-at-a-time lock and `request_id` dedupe are in-process.
* Services with a volume redeploy with brief downtime, and a redeploy kills any running build. On restart that job is marked `interrupted`; check Docker Console for the orphaned sandbox before retrying. Avoid deploying while a build is running.
* `projects.json` is committed and shipped with the deploy, so edit the allowlist (repo URLs and scripts) before `railway up`.

## Agent skill

`skills/docker-cloud-bridge/SKILL.md` teaches coding agents how to run builds through the bridge and how to deploy and debug it. The same file is checked in where each tool looks for project skills:

| Tool | Location |
|---|---|
| Universal (`npx skills add VrilLabs/docker-cloud-bridge`, any Agent Skills client) | `skills/docker-cloud-bridge/` |
| Claude Code | `.claude/skills/docker-cloud-bridge/` |
| Codex (also read by OpenCode) | `.agents/skills/docker-cloud-bridge/` |
| OpenCode | `.opencode/skills/docker-cloud-bridge/` |

`skills/` is the canonical copy. If you edit it, copy the file to the other three locations so they don't drift.

## Private repos, secret forwarding, artifacts and status reports

All four are configured by the operator in `projects.json`. The caller (an agent) can only pick among what was declared, and it never sees or supplies a secret value.

```json
{
  "my-app": {
    "repo": "https://github.com/OWNER/PRIVATE_REPO.git",
    "auth": { "tokenEnv": "GH_CLONE_TOKEN" },
    "status": { "provider": "github", "tokenEnv": "GH_STATUS_TOKEN" },
    "tasks": {
      "build": {
        "script": "npm ci --ignore-scripts\nnpm test\nnpm run build",
        "artifacts": ["dist/", "coverage/lcov.info"],
        "forward": {
          "NPM_TOKEN": { "mode": "inject", "hosts": ["registry.npmjs.org"], "header": "Authorization", "format": "Bearer %s" },
          "DEPLOY_ENV": { "mode": "env" }
        }
      }
    }
  }
}
```

A task may still be a plain string (the script), exactly as before.

**Private repositories (`auth`).** `tokenEnv` names a bridge environment variable holding a read-only token (a fine-grained GitHub token with *Contents: read* on that one repo, or a GitLab deploy/project token with `read_repository`). For each build the bridge stores it as a Docker stored secret and attaches it to the sandbox; Docker's proxy adds the credential to requests for the repo host only, so the token is **never written into the sandbox**. GitHub uses Docker's native `github` secret type (Docker rejects custom injection for managed hosts). Other forges get a custom `Authorization` injection (`scheme` `basic` (default, user `oauth2` on gitlab.com or `username`) or `bearer`). Repo hosts default to `github.com,gitlab.com`; set `ALLOWED_GIT_HOSTS` (comma separated) to use others. It replaces the default list, so include `github.com`/`gitlab.com` if you still need them. The stored secret is deleted when the build ends, and any `bridge-*` secret left by a crash is purged at startup.

**Forwarding environment variables (`forward` + `forward_env`).** The agent calls `start_build` with `forward_env: ["NPM_TOKEN"]`: names only. A name is accepted only if the operator listed it under that task's `forward`; the value is read from the bridge's own environment (for example a Railway variable), never from the caller. Two modes:

* `inject` (preferred): Docker's proxy adds the value to the named header on requests to the listed exact hosts. The sandbox only sees a placeholder in `$NPM_TOKEN`, so a build script cannot print or exfiltrate the real value, but it can still make requests to those hosts. Hosts must be exact lowercase DNS names (max 10). `format` has exactly one `%s`. `github.com` is not allowed here; use `auth`.
* `env`: the raw value is placed in the build process environment. Use only for non-sensitive settings or when you accept that the commit's code can read it.

`BRIDGE_API_KEY`, `DOCKER_ID`, `DOCKER_PAT` and any variable used as `auth.tokenEnv`, `status.tokenEnv` or `status.secretEnv` can never be forwarded. At most 16 names per build.

**Artifacts (`artifacts`).** Up to 8 relative paths per task (files, or directories ending in `/`) inside the checkout. After the script finishes (pass or fail) the bridge lists them with the sandbox's own tools, drops anything that resolves outside the work dir (symlinks) and reads each file under caps: `ARTIFACT_MAX_FILES` (20), `ARTIFACT_MAX_FILE_BYTES` (5 MiB), `ARTIFACT_MAX_TOTAL_BYTES` (20 MiB). Files are hashed (sha256) and stored under `DATA_DIR/artifacts/<job id>/`. The `get_build_artifacts` tool lists them; with `index` it returns files up to `ARTIFACT_INLINE_MAX_BYTES` (256 KiB) as base64; anything can be fetched with `GET /artifacts/<job id>/<index>` using the same `Authorization` header. Contents are untrusted data.

**Status reports (`status`).** The bridge itself posts the build state to the forge (so these tokens never enter a sandbox) when a build starts and when it finishes. Logs are never sent. Failures are recorded on the job (`statusReport`) and never fail the build.

* `github`: commit status API; the token needs *Commit statuses: write* on the repo. GitHub Enterprise: set `baseUrl` to the API root.
* `gitlab`: commit status API with a `PRIVATE-TOKEN` (scope `api`). Self-hosted: set `baseUrl`.
* `webhook`: any other git host or CI glue. `POST` of a small JSON document (`project`, `task`, `repo`, `commit`, `jobId`, `status`, `exitCode`, `finishedAt`) to an https `url`, signed with `X-Bridge-Signature: sha256=<hmac>` when `secretEnv` is set.

Config is validated at startup and the bridge refuses to start with a message listing every problem. In `MOCK_DOCKER=1` mode nothing is posted to forges.

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
* Default SDK small compute: 2 CPUs/4 GiB. No network policy is configured by this implementation (Docker rejected inline network policies on the account used for verification; use Docker governance policies if you need egress control). Private repos, forwarded variables, artifacts and status reports are opt-in per project in `projects.json` (see the section above). Do not put PATs in repo URLs or scripts.
* Default workflow is CI (test/build). No deployment/registry credentials, prod deploy, rollback, cancellations or automatic failover scheduler. Add a fixed allowlisted deployment task only after designing narrowly scoped credentials, independent approval enforcement and rollback. Exported artifacts accumulate on the volume (capped per build, no retention scheduler); prune `DATA_DIR/artifacts/` when idle.
* Task execution is a billable, side-effecting operation, even for tests. Tool description instructs client to request approval, but does NOT provide a server-side human approval gate. Possession of bridge API key permits running ANY allowlisted task/commit. Use only trusted connector owners. Do not add production deployment credentials unless you implement an independent approval gate.
* An allowlisted repo is not a security boundary against malicious code within that repo. Tests/package scripts execute code from the selected commit. Do not execute unreviewed fork/PR code with secrets. npm ci --ignore-scripts only disables installation lifecycle scripts; npm test/build still execute code.
* Logs are untrusted and may include secrets deliberately printed by code. The bridge key, Docker PAT, the repo token and every forwarded value are redacted from logs, job records, error messages and artifact names; this is not a generic secret scanner and artifact contents are not scanned. The Docker PAT remains on the bridge host and is never injected into a sandbox.
* Railway provides HTTPS only; there is no rate limiting, so keep the API key secret (32+ chars enforced) and rotate credentials. Origin-bearing requests rejected unless ALLOWED_ORIGIN matches; non-browser MCP requests normally omit Origin.

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
