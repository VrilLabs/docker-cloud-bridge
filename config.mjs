// Operator-side configuration rules. Everything an agent may influence (which env var NAMES to forward)
// is checked against what the operator declared in projects.json; values only ever come from the bridge's environment.

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/; // exact DNS name: no wildcard, IP literal or port
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'expect', 'cookie', 'set-cookie']);
const BASE_RESERVED = ['BRIDGE_API_KEY', 'DOCKER_PAT', 'DOCKER_ID'];
const MAX_VALUE_BYTES = 8192;
const MAX_FORWARD = 16;
const MAX_ARTIFACT_ENTRIES = 8;
const MAX_INJECT_HOSTS = 10;
const STATUS_PROVIDERS = ['github', 'gitlab', 'webhook'];

export const gitHosts = env => (env.ALLOWED_GIT_HOSTS || 'github.com,gitlab.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export function repoInfo(repo, allowedHosts = ['github.com', 'gitlab.com']) {
  const m = /^https:\/\/([a-z0-9.-]+)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,4})$/.exec(String(repo));
  if (!m) throw new Error('Repository must be https://<host>/<owner>/<repo> without credentials, port or query');
  const [, host, rawPath] = m;
  if (!allowedHosts.includes(host)) throw new Error(`Git host ${host} is not allowed (ALLOWED_GIT_HOSTS)`);
  const path = rawPath.replace(/\.git$/, '');
  if (path.split('/').some(s => s === '.' || s === '..' || s === '')) throw new Error('Invalid repository path');
  return { host, path };
}

export function safeArtifactPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
  if (!/^[A-Za-z0-9._@%+=,/-]+$/.test(p) || p.startsWith('/') || p.startsWith('~')) return false; // conservative charset: safe to pass to a shell as an argument
  const segments = p.replace(/\/$/, '').split('/');
  return segments.every(s => s.length > 0 && s !== '.' && s !== '..');
}

export function normalizeTask(raw) {
  if (typeof raw === 'string') return { script: raw, forward: {}, artifacts: [] };
  return { script: raw?.script, forward: raw?.forward || {}, artifacts: raw?.artifacts || [] };
}

export function reservedNames(config) {
  const names = new Set(BASE_RESERVED);
  for (const p of Object.values(config || {})) for (const n of [p?.auth?.tokenEnv, p?.status?.tokenEnv, p?.status?.secretEnv]) if (n) names.add(n);
  return names;
}

const formatOk = f => {
  const tokens = [...String(f).matchAll(/%(.?)/g)].map(m => m[1]);
  return tokens.every(t => t === 's' || t === '%') && tokens.filter(t => t === 's').length === 1;
};

function checkForwardEntry(name, spec, reserved, where, problems) {
  if (!ENV_NAME.test(name)) return problems.push(`${where}: forward name "${name}" must match ${ENV_NAME}`);
  if (reserved.has(name)) return problems.push(`${where}: ${name} is reserved and cannot be forwarded`);
  if (spec?.mode === 'env') return;
  if (spec?.mode !== 'inject') return problems.push(`${where}: forward ${name} mode must be "inject" or "env"`);
  const hosts = spec.hosts;
  if (Array.isArray(hosts) && hosts.includes('github.com')) problems.push(`${where}: forward ${name} cannot inject for github.com (Docker manages it); use the project "auth" setting for GitHub access`);
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > MAX_INJECT_HOSTS || !hosts.every(h => HOST.test(h))) problems.push(`${where}: forward ${name} needs 1-${MAX_INJECT_HOSTS} exact lowercase DNS hosts (no wildcards, IPs or ports)`);
  if (!HEADER.test(spec.header || '') || BLOCKED_HEADERS.has(String(spec.header).toLowerCase())) problems.push(`${where}: forward ${name} header is invalid or not allowed`);
  if (!formatOk(spec.format ?? '%s')) problems.push(`${where}: forward ${name} format must contain exactly one %s`);
}

function checkStatus(status, where, problems) {
  if (!STATUS_PROVIDERS.includes(status.provider)) return problems.push(`${where}: status provider must be one of ${STATUS_PROVIDERS.join(', ')}`);
  for (const key of ['tokenEnv', 'secretEnv']) if (status[key] !== undefined && !ENV_NAME.test(status[key])) problems.push(`${where}: status ${key} must be an environment variable name`);
  if (status.provider !== 'webhook' && !status.tokenEnv) problems.push(`${where}: status ${status.provider} requires tokenEnv`);
  for (const key of ['url', 'baseUrl']) {
    if (status[key] === undefined) continue;
    let u;
    try { u = new URL(status[key]); } catch { problems.push(`${where}: status ${key} is not a valid URL`); continue; }
    if (u.protocol !== 'https:') problems.push(`${where}: status ${key} must use https`);
    if (u.username || u.password) problems.push(`${where}: status ${key} must not contain credentials`);
  }
  if (status.provider === 'webhook' && !status.url) problems.push(`${where}: status webhook requires url`);
}

export function validateConfig(config, env = process.env) {
  const problems = [];
  const hosts = gitHosts(env);
  const reserved = reservedNames(config);
  for (const [project, p] of Object.entries(config || {})) {
    const where = project;
    try { repoInfo(p?.repo, hosts); } catch (e) { problems.push(`${where}: ${e.message}`); }
    if (p?.auth) {
      if (!ENV_NAME.test(p.auth.tokenEnv || '')) problems.push(`${where}: auth tokenEnv must be an environment variable name`);
      if (p.auth.scheme !== undefined && !['basic', 'bearer'].includes(p.auth.scheme)) problems.push(`${where}: auth scheme must be "basic" or "bearer"`);
    }
    if (p?.status) checkStatus(p.status, where, problems);
    if (!p?.tasks || typeof p.tasks !== 'object' || Object.keys(p.tasks).length === 0) problems.push(`${where}: at least one task is required`);
    for (const [task, raw] of Object.entries(p?.tasks || {})) {
      const t = normalizeTask(raw);
      const tw = `${project}/${task}`;
      if (typeof t.script !== 'string' || t.script.trim() === '') problems.push(`${tw}: script is required`);
      if (!Array.isArray(t.artifacts) || t.artifacts.length > MAX_ARTIFACT_ENTRIES || !t.artifacts.every(safeArtifactPath)) problems.push(`${tw}: artifacts must be up to ${MAX_ARTIFACT_ENTRIES} relative paths without "..", absolute paths or backslashes`);
      for (const [name, spec] of Object.entries(t.forward)) checkForwardEntry(name, spec, reserved, tw, problems);
    }
  }
  if (problems.length) throw new Error(`Invalid projects config:\n- ${problems.join('\n- ')}`);
}

export function planForward(task, requested = [], env = process.env, reserved = new Set(BASE_RESERVED)) {
  const names = [...new Set(requested)];
  if (names.length > MAX_FORWARD) throw new Error(`Too many forwarded variables (max ${MAX_FORWARD})`);
  const plan = { inject: [], env: {} };
  for (const name of names) {
    const spec = Object.hasOwn(task.forward, name) ? task.forward[name] : undefined;
    if (!spec || reserved.has(name)) throw new Error(`${name} is not forwardable for this task`);
    const value = env[name];
    if (typeof value !== 'string' || value === '') throw new Error(`${name} is not set on the bridge`);
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error(`${name} value is too large`);
    if (/[\0\r\n]/.test(value)) throw new Error(`${name} value is invalid (control characters)`);
    if (spec.mode === 'env') plan.env[name] = value;
    else plan.inject.push({ name, value, injection: { hosts: [...spec.hosts], header: spec.header, format: spec.format ?? '%s', envVar: name } });
  }
  return plan;
}

// Everything a build needs from the bridge's environment, resolved up front so a bad request fails before a job is queued.
export function prepareRun(spec, requested = [], env = process.env, reserved = new Set(BASE_RESERVED)) {
  const forward = planForward(spec.task, requested, env, reserved);
  const git = gitAuthSecret(spec.project, env);
  const secrets = [
    ...(git ? [{ label: 'git', create: git.create }] : []),
    ...forward.inject.map(i => ({ label: i.name, create: { custom: { value: i.value, injection: i.injection } } })),
  ];
  const redactions = [env.BRIDGE_API_KEY, env.DOCKER_PAT, ...Object.values(forward.env), ...forward.inject.map(i => i.value), ...(git?.redactions ?? [])].filter(Boolean);
  return { secrets, env: forward.env, forwarded: [...new Set(requested)], redactions };
}

const DEFAULT_USER ={ 'github.com': 'x-access-token', 'gitlab.com': 'oauth2' };

// Returns the payload for client.secrets.create (minus displayName) plus every string that must be redacted from logs.
// github.com is a managed Docker integration: custom injection for it is rejected, so the native "github" token type is used.
// Every other forge gets a custom secret that Docker's proxy injects as an Authorization header for that one host.
export function gitAuthSecret(project, env = process.env) {
  if (!project.auth) return undefined;
  const { host } = repoInfo(project.repo, gitHosts(env));
  const token = env[project.auth.tokenEnv];
  if (typeof token !== 'string' || token === '') throw new Error(`${project.auth.tokenEnv} is not set on the bridge`);
  if (/[\s\0]/.test(token) || Buffer.byteLength(token) > MAX_VALUE_BYTES) throw new Error(`${project.auth.tokenEnv} value is invalid`);
  if (host === 'github.com') return { create: { serviceType: 'github', token: { value: token } }, redactions: [token] };
  const scheme = project.auth.scheme || 'basic';
  const user = project.auth.username || DEFAULT_USER[host] || 'git';
  const value = scheme === 'bearer' ? token : Buffer.from(`${user}:${token}`).toString('base64');
  const injection = { hosts: [host], header: 'Authorization', format: scheme === 'bearer' ? 'Bearer %s' : 'Basic %s' };
  return { create: { custom: { value, injection } }, redactions: [token, value] };
}
