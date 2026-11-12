import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, normalizeTask, repoInfo, planForward, gitAuthSecret, safeArtifactPath, reservedNames } from '../config.mjs';

const base = (over = {}) => ({
  app: { repo: 'https://github.com/example/app.git', tasks: { test: 'npm test' }, ...over },
});
const problems = (cfg, env = {}) => { try { validateConfig(cfg, env); return ''; } catch (e) { return e.message; } };

test('legacy string task and object task both normalize', () => {
  assert.deepEqual(normalizeTask('npm test'), { script: 'npm test', forward: {}, artifacts: [] });
  const t = normalizeTask({ script: 'make', artifacts: ['dist/a.tgz'], forward: { NPM_TOKEN: { mode: 'inject', hosts: ['registry.npmjs.org'], header: 'Authorization', format: 'Bearer %s' } } });
  assert.equal(t.script, 'make');
  assert.deepEqual(t.artifacts, ['dist/a.tgz']);
});

test('repo hosts: github and gitlab by default, others only when allowlisted; no credentials, ports or odd paths', () => {
  assert.deepEqual(repoInfo('https://github.com/o/r.git'), { host: 'github.com', path: 'o/r' });
  assert.deepEqual(repoInfo('https://gitlab.com/g/sub/r'), { host: 'gitlab.com', path: 'g/sub/r' });
  assert.throws(() => repoInfo('https://git.example.com/o/r'), /host/i);
  assert.deepEqual(repoInfo('https://git.example.com/o/r', ['git.example.com']), { host: 'git.example.com', path: 'o/r' });
  for (const bad of ['http://github.com/o/r', 'https://user:pw@github.com/o/r', 'https://github.com:8443/o/r', 'https://github.com/o', 'https://github.com/o/r?x=1', 'https://github.com/../r', 'https://github.com/o/r/../x', 'ssh://github.com/o/r', 'https://github.com/o/r;rm -rf /'])
    assert.throws(() => repoInfo(bad), undefined, bad);
});

test('forwarding: only operator-allowlisted names, values read from the bridge environment, never from the caller', () => {
  const task = normalizeTask({ script: 'x', forward: {
    NPM_TOKEN: { mode: 'inject', hosts: ['registry.npmjs.org'], header: 'Authorization', format: 'Bearer %s' },
    DEPLOY_ENV: { mode: 'env' },
  } });
  const env = { NPM_TOKEN: 'tok', DEPLOY_ENV: 'staging', BRIDGE_API_KEY: 'k'.repeat(40), DOCKER_PAT: 'pat' };
  const plan = planForward(task, ['NPM_TOKEN', 'DEPLOY_ENV'], env);
  assert.deepEqual(plan.inject, [{ name: 'NPM_TOKEN', value: 'tok', injection: { hosts: ['registry.npmjs.org'], header: 'Authorization', format: 'Bearer %s', envVar: 'NPM_TOKEN' } }]);
  assert.deepEqual(plan.env, { DEPLOY_ENV: 'staging' });
  assert.deepEqual(planForward(task, [], env), { inject: [], env: {} });
  assert.deepEqual(planForward(task, ['NPM_TOKEN', 'NPM_TOKEN'], env).inject.length, 1, 'duplicates collapse');
  assert.throws(() => planForward(task, ['BRIDGE_API_KEY'], env), /not forwardable/);
  assert.throws(() => planForward(task, ['DOCKER_PAT'], env), /not forwardable/);
  assert.throws(() => planForward(task, ['HOME'], env), /not forwardable/);
  assert.throws(() => planForward(task, ['__proto__'], env), /not forwardable/);
  assert.throws(() => planForward(task, ['NPM_TOKEN'], {}), /not set on the bridge/);
  assert.throws(() => planForward(task, ['NPM_TOKEN'], { NPM_TOKEN: '' }), /not set on the bridge/);
  assert.throws(() => planForward(task, ['NPM_TOKEN'], { NPM_TOKEN: 'a\nb' }), /invalid/);
  assert.throws(() => planForward(task, ['NPM_TOKEN'], { NPM_TOKEN: 'x'.repeat(9000) }), /too large/);
});

test('private repo auth: github uses Docker\'s native token secret; other forges get a host-scoped injection secret', () => {
  const project = { repo: 'https://github.com/o/r.git', auth: { tokenEnv: 'GH_CLONE' } };
  const s = gitAuthSecret(project, { GH_CLONE: 'ghp_secret' });
  assert.deepEqual(s.create, { serviceType: 'github', token: { value: 'ghp_secret' } }, 'github.com is a managed integration; custom injection is rejected by Docker');
  assert.deepEqual(s.redactions, ['ghp_secret']);
  const gl = gitAuthSecret({ repo: 'https://gitlab.com/g/r.git', auth: { tokenEnv: 'GL' } }, { GL: 'glpat-1' });
  assert.equal(gl.create.custom.value, Buffer.from('oauth2:glpat-1').toString('base64'));
  assert.deepEqual(gl.create.custom.injection, { hosts: ['gitlab.com'], header: 'Authorization', format: 'Basic %s' });
  assert(gl.redactions.includes('glpat-1') && gl.redactions.includes(gl.create.custom.value), 'both the raw token and its encoded form are redacted');
  const bearer = gitAuthSecret({ repo: 'https://gitlab.com/o/r', auth: { tokenEnv: 'T', scheme: 'bearer' } }, { T: 'abc' });
  assert.deepEqual([bearer.create.custom.value, bearer.create.custom.injection.format], ['abc', 'Bearer %s']);
  const selfHosted = gitAuthSecret({ repo: 'https://git.corp.example/o/r', auth: { tokenEnv: 'T', username: 'ci' } }, { T: 'abc', ALLOWED_GIT_HOSTS: 'git.corp.example' });
  assert.equal(selfHosted.create.custom.value, Buffer.from('ci:abc').toString('base64'));
  assert.deepEqual(selfHosted.create.custom.injection.hosts, ['git.corp.example']);
  assert.equal(gitAuthSecret({ repo: 'https://github.com/o/r' }, {}), undefined, 'public repos need no secret');
  assert.throws(() => gitAuthSecret(project, {}), /GH_CLONE is not set/);
  assert.throws(() => gitAuthSecret(project, { GH_CLONE: 'a b\n' }), /invalid/);
});

test('artifact paths must be relative, normalized and inside the work dir', () => {
  for (const ok of ['dist/app.tgz', 'reports/', 'a.txt', 'a/b/c.json']) assert(safeArtifactPath(ok), ok);
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a\\b', '', ' ', 'a\0b', '~/x', 'a//b', '.', './x', 'x'.repeat(201), "a'b", 'a b', 'a;b', 'a$(x)', 'a`b`', 'a\nb', 'a*', '$HOME/x']) assert(!safeArtifactPath(bad), JSON.stringify(bad));
});

test('validateConfig accepts a full valid project and reports every problem otherwise', () => {
  const good = base({
    auth: { tokenEnv: 'GH_CLONE' },
    status: { provider: 'github', tokenEnv: 'GH_STATUS' },
    tasks: { test: { script: 'npm test', artifacts: ['coverage/'], forward: { NPM_TOKEN: { mode: 'inject', hosts: ['registry.npmjs.org'], header: 'Authorization', format: 'Bearer %s' } } } },
  });
  assert.equal(problems(good), '');
  assert.match(problems({ app: { repo: 'https://evil.example/o/r', tasks: { t: 'x' } } }), /host/i);
  assert.match(problems(base({ tasks: { t: { script: '' } } })), /script/);
  assert.match(problems(base({ tasks: { t: { script: 'x', artifacts: ['../x'] } } })), /artifact/);
  assert.match(problems(base({ tasks: { t: { script: 'x', artifacts: Array(9).fill('a') } } })), /artifact/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { BRIDGE_API_KEY: { mode: 'env' } } } } })), /reserved/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { lower: { mode: 'env' } } } } })), /name/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { A: { mode: 'sideload' } } } } })), /mode/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { A: { mode: 'inject', hosts: ['*.evil.com'], header: 'Authorization', format: '%s' } } } } })), /host/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { A: { mode: 'inject', hosts: ['1.2.3.4'], header: 'Authorization', format: '%s' } } } } })), /host/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { A: { mode: 'inject', hosts: ['github.com'], header: 'Authorization', format: 'Bearer %s' } } } } })), /github\.com.*auth/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { A: { mode: 'inject', hosts: ['a.com'], header: 'Cookie', format: '%s' } } } } })), /header/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { A: { mode: 'inject', hosts: ['a.com'], header: 'Authorization', format: 'Bearer' } } } } })), /format/);
  assert.match(problems(base({ tasks: { t: { script: 'x', forward: { A: { mode: 'inject', hosts: ['a.com'], header: 'Authorization', format: '%s %s' } } } } })), /format/);
  assert.match(problems(base({ status: { provider: 'carrier-pigeon' } })), /provider/);
  assert.match(problems(base({ status: { provider: 'webhook', url: 'http://x.example/h' } })), /https/);
  assert.match(problems(base({ status: { provider: 'webhook', url: 'https://u:p@x.example/h' } })), /credentials/);
  assert.match(problems(base({ status: { provider: 'gitlab', tokenEnv: 'lower' } })), /tokenEnv/);
  assert.match(problems(base({ auth: { tokenEnv: 'GH', scheme: 'digest' } })), /scheme/);
});

test('the shipped example and the deployed projects.json both validate', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['projects.example.json', 'projects.json']) {
    const config = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.equal(problems(config), '', file);
  }
});

test('credential env vars used by auth and status are never forwardable', () => {
  const cfg = base({ auth: { tokenEnv: 'GH_CLONE' }, status: { provider: 'webhook', url: 'https://h.example/x', secretEnv: 'HOOK_SECRET' } });
  const names = reservedNames(cfg);
  for (const n of ['BRIDGE_API_KEY', 'DOCKER_PAT', 'DOCKER_ID', 'GH_CLONE', 'HOOK_SECRET']) assert(names.has(n), n);
  const bad = base({ auth: { tokenEnv: 'GH_CLONE' }, tasks: { t: { script: 'x', forward: { GH_CLONE: { mode: 'env' } } } } });
  assert.match(problems(bad), /reserved/);
});
