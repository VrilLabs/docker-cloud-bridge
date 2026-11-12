import { createHash, timingSafeEqual } from 'node:crypto';
import { gitHosts, normalizeTask, repoInfo } from './config.mjs';
const digest = s => createHash('sha256').update(s).digest();
// API-key connectors differ in how the key is sent: "Authorization: Bearer <key>", a bare
// "Authorization: <key>", or "X-API-Key: <key>". All carry the same secret and are compared the same way.
export function credentialFrom(headers = {}) {
  const auth = String(headers.authorization || '').trim();
  const bearer = /^bearer\s+(.+)$/i.exec(auth);
  const given = bearer ? bearer[1] : (/^basic\s/i.test(auth) ? '' : auth || String(headers['x-api-key'] || ''));
  return given.trim();
}
export function authorized(headers, key) {
  const given = credentialFrom(headers);
  return given.length > 0 && timingSafeEqual(digest(given), digest(key));
}
// Metadata only (header names and lengths, never values) for diagnosing a connector that gets 401.
// presented/expected are 8-hex-char SHA-256 prefixes: enough to tell whether two keys match, useless for recovering one.
export function describeAuth(headers = {}, key = '') {
  const auth = String(headers.authorization || '');
  const given = credentialFrom(headers);
  const tag = s => (s ? digest(s).toString('hex').slice(0, 8) : null);
  return { headers: Object.keys(headers).sort(), authScheme: auth ? auth.split(/\s+/)[0].toLowerCase().slice(0, 12) : null, credentialLength: given.length, presented: tag(given), expected: tag(key), expectedLength: key.length };
}
export function resolveJob(config, project, task, commit, env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Require full 40-character lowercase commit SHA');
  const p = Object.hasOwn(config, project) ? config[project] : undefined;
  const raw = p && Object.hasOwn(p.tasks || {}, task) ? p.tasks[task] : undefined;
  if (!raw) throw new Error('Project/task not allowed');
  const t = normalizeTask(raw);
  if (typeof t.script !== 'string' || t.script.trim() === '') throw new Error('Project/task not allowed');
  repoInfo(p.repo, gitHosts(env)); // throws on credentials, ports, odd paths or hosts outside ALLOWED_GIT_HOSTS
  return { repo: p.repo, script: t.script, project: p, projectName: project, taskName: task, task: t };
}
export function scriptFor(job, commit) {
  return `set -eu
export GIT_TERMINAL_PROMPT=0
command -v git >/dev/null
mkdir -p /tmp/ci-work
cd /tmp/ci-work
git init -q
git remote add origin '${job.repo}'
git fetch --depth=1 origin '${commit}'
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = '${commit}'
${job.script}
`;
}
