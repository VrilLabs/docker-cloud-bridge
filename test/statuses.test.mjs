import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mapState, buildStatusRequest, publishStatus } from '../statuses.mjs';

const sha = 'a'.repeat(40);
const job = { id: 'j1', project: 'app', task: 'test', commit: sha, status: 'passed', exitCode: 0, finished: '2026-01-01T00:00:00.000Z', stdout: 'SECRET-LOG-OUTPUT', stderr: 'more' };
const gh = { repo: 'https://github.com/o/r.git', status: { provider: 'github', tokenEnv: 'GH_STATUS' } };
const gl = { repo: 'https://gitlab.com/g/sub/r.git', status: { provider: 'gitlab', tokenEnv: 'GL_STATUS' } };
const hook = { repo: 'https://github.com/o/r.git', status: { provider: 'webhook', url: 'https://hooks.example.com/bridge', secretEnv: 'HOOK_SECRET' } };

test('job states map onto each forge vocabulary', () => {
  assert.deepEqual(['queued', 'running', 'passed', 'failed', 'error', 'interrupted'].map(s => mapState('github', s)), ['pending', 'pending', 'success', 'failure', 'error', 'error']);
  assert.deepEqual(['queued', 'running', 'passed', 'failed', 'error', 'interrupted'].map(s => mapState('gitlab', s)), ['pending', 'running', 'success', 'failed', 'failed', 'failed']);
  assert.equal(mapState('github', 'bogus'), 'error');
});

test('GitHub request: commit status API, bearer token from env, no logs in the body', () => {
  const { url, init } = buildStatusRequest({ project: gh, task: 'test', job, env: { GH_STATUS: 'tok' } });
  assert.equal(url, `https://api.github.com/repos/o/r/statuses/${sha}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(init.body);
  assert.deepEqual(body, { state: 'success', context: 'docker-cloud-bridge/test', description: 'Build passed' });
  assert(!init.body.includes('SECRET-LOG-OUTPUT'));
  assert.equal(init.redirect, 'error');
});

test('GitLab request: URL-encoded project path, PRIVATE-TOKEN header', () => {
  const { url, init } = buildStatusRequest({ project: gl, task: 'test', job: { ...job, status: 'failed', exitCode: 3 }, env: { GL_STATUS: 'glpat' } });
  assert.equal(url, `https://gitlab.com/api/v4/projects/g%2Fsub%2Fr/statuses/${sha}`);
  assert.equal(init.headers['PRIVATE-TOKEN'], 'glpat');
  assert.deepEqual(JSON.parse(init.body), { state: 'failed', name: 'docker-cloud-bridge/test', description: 'Build failed (exit 3)' });
});

test('GitHub Enterprise and self-hosted GitLab use the operator baseUrl; github on another host needs one', () => {
  const ghe = { repo: 'https://git.corp.example/o/r', status: { provider: 'github', tokenEnv: 'GH_STATUS', baseUrl: 'https://git.corp.example/api/v3' } };
  assert.equal(buildStatusRequest({ project: ghe, task: 't', job, env: { GH_STATUS: 'x' }, allowedHosts: ['git.corp.example'] }).url, `https://git.corp.example/api/v3/repos/o/r/statuses/${sha}`);
  const noBase = { repo: 'https://git.corp.example/o/r', status: { provider: 'github', tokenEnv: 'GH_STATUS' } };
  assert.throws(() => buildStatusRequest({ project: noBase, task: 't', job, env: { GH_STATUS: 'x' }, allowedHosts: ['git.corp.example'] }), /baseUrl/);
});

test('webhook: signed JSON without logs; refuses to send unsigned when a secret is configured but missing', () => {
  const { url, init } = buildStatusRequest({ project: hook, task: 'test', projectName: 'app', job, env: { HOOK_SECRET: 's3cret' } });
  assert.equal(url, 'https://hooks.example.com/bridge');
  const sig = 'sha256=' + createHmac('sha256', 's3cret').update(init.body).digest('hex');
  assert.equal(init.headers['X-Bridge-Signature'], sig);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['commit', 'event', 'exitCode', 'finishedAt', 'jobId', 'project', 'repo', 'status', 'task']);
  assert(!init.body.includes('SECRET-LOG-OUTPUT'));
  assert.throws(() => buildStatusRequest({ project: hook, task: 'test', projectName: 'app', job, env: {} }), /HOOK_SECRET/);
});

test('missing token is reported, not silently skipped', () => {
  assert.throws(() => buildStatusRequest({ project: gh, task: 'test', job, env: {} }), /GH_STATUS is not set/);
});

test('publishStatus never throws and never leaks the token', async () => {
  const calls = [];
  const ok = await publishStatus({ project: gh, task: 'test', job, env: { GH_STATUS: 'tok' }, fetch: async (u, i) => { calls.push([u, i]); return { ok: true, status: 201 }; } });
  assert.deepEqual(ok, { ok: true, state: 'success', httpStatus: 201 });
  assert.equal(calls.length, 1);
  const rejected = await publishStatus({ project: gh, task: 'test', job, env: { GH_STATUS: 'tok-123' }, fetch: async () => ({ ok: false, status: 422 }) });
  assert.deepEqual(rejected, { ok: false, state: 'success', httpStatus: 422, error: 'HTTP 422' });
  const boom = await publishStatus({ project: gh, task: 'test', job, env: { GH_STATUS: 'tok-123' }, fetch: async () => { throw new Error('connect failed token tok-123'); } });
  assert.equal(boom.ok, false);
  assert(!boom.error.includes('tok-123'));
  const none = await publishStatus({ project: { repo: gh.repo }, task: 'test', job, env: {}, fetch: async () => { throw new Error('should not be called'); } });
  assert.deepEqual(none, { ok: true, skipped: 'not configured' });
  const cfgErr = await publishStatus({ project: gh, task: 'test', job, env: {}, fetch: async () => ({ ok: true, status: 200 }) });
  assert.equal(cfgErr.ok, false);
});
