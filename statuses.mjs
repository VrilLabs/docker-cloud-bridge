// Publishes build results to a git forge. The bridge posts statuses itself, so forge tokens never enter a sandbox,
// and only the job state is sent: never logs, which may contain secrets.
import { createHmac } from 'node:crypto';
import { gitHosts, repoInfo } from './config.mjs';

const TIMEOUT_MS = 10_000;
const GITHUB_STATES = { queued: 'pending', running: 'pending', passed: 'success', failed: 'failure', error: 'error', interrupted: 'error' };
const GITLAB_STATES = { queued: 'pending', running: 'running', passed: 'success', failed: 'failed', error: 'failed', interrupted: 'failed' };

export const mapState = (provider, status) => ((provider === 'gitlab' ? GITLAB_STATES : GITHUB_STATES)[status] ?? (provider === 'gitlab' ? 'failed' : 'error'));

const describe = job => {
  const text = { queued: 'Build queued', running: 'Build running', passed: 'Build passed', failed: 'Build failed', error: 'Build errored', interrupted: 'Build interrupted' }[job.status] || 'Build finished';
  return job.status === 'failed' && Number.isInteger(job.exitCode) ? `${text} (exit ${job.exitCode})` : text;
};

const requireToken = (cfg, env) => {
  const token = env[cfg.tokenEnv];
  if (typeof token !== 'string' || token === '') throw new Error(`${cfg.tokenEnv} is not set on the bridge`);
  return token;
};

const post = (url, headers, bodyObject) => ({
  url,
  init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'docker-cloud-bridge', ...headers }, body: JSON.stringify(bodyObject), redirect: 'error' },
});

export function buildStatusRequest({ project, projectName, task, job, env = process.env, allowedHosts = gitHosts(env) }) {
  const cfg = project.status;
  const context = `docker-cloud-bridge/${task}`;
  if (cfg.provider === 'webhook') {
    const payload = { event: 'docker-cloud-bridge.build', project: projectName ?? job.project, task, repo: project.repo, commit: job.commit, jobId: job.id, status: job.status, exitCode: job.exitCode ?? null, finishedAt: job.finished ?? null };
    const body = JSON.stringify(payload);
    const headers = {};
    if (cfg.secretEnv) {
      const secret = env[cfg.secretEnv];
      if (typeof secret !== 'string' || secret === '') throw new Error(`${cfg.secretEnv} is not set on the bridge`);
      headers['X-Bridge-Signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    }
    return { url: cfg.url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'docker-cloud-bridge', ...headers }, body, redirect: 'error' } };
  }
  const { host, path } = repoInfo(project.repo, allowedHosts);
  const token = requireToken(cfg, env);
  if (cfg.provider === 'gitlab') {
    const base = (cfg.baseUrl || `https://${host}`).replace(/\/$/, '');
    return post(`${base}/api/v4/projects/${encodeURIComponent(path)}/statuses/${job.commit}`, { 'PRIVATE-TOKEN': token }, { state: mapState('gitlab', job.status), name: context, description: describe(job) });
  }
  if (!cfg.baseUrl && host !== 'github.com') throw new Error(`GitHub status for ${host} needs status.baseUrl (the API root)`);
  const base = (cfg.baseUrl || 'https://api.github.com').replace(/\/$/, '');
  return post(`${base}/repos/${path}/statuses/${job.commit}`, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, { state: mapState('github', job.status), context, description: describe(job) });
}

// Never throws: a failed status report must not fail the build. Errors are scrubbed of secret values.
export async function publishStatus({ project, projectName, task, job, env = process.env, fetch: fetchImpl = fetch }) {
  if (!project.status) return { ok: true, skipped: 'not configured' };
  const state = project.status.provider === 'webhook' ? job.status : mapState(project.status.provider, job.status);
  const secrets = [project.status.tokenEnv, project.status.secretEnv].map(n => env[n]).filter(Boolean);
  const scrub = text => secrets.reduce((acc, s) => acc.split(s).join('[REDACTED]'), String(text));
  try {
    const { url, init } = buildStatusRequest({ project, projectName, task, job, env });
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? { ok: true, state, httpStatus: res.status } : { ok: false, state, httpStatus: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, state, error: scrub(e.message).slice(0, 300) };
  }
}
