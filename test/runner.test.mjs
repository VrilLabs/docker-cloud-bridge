import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, purgeOrphanSecrets } from '../runner.mjs';
import { prepareRun, reservedNames } from '../config.mjs';
import { resolveJob } from '../policy.mjs';

const sha = 'b'.repeat(40);
const ID = '22222222-2222-2222-2222-222222222222';
const GIT_TOKEN = 'ghp_PRIVATE_CLONE_TOKEN';
const NPM = 'npm_FORWARDED_SECRET';
const DEPLOY = 'staging-value-123';
const env = { BRIDGE_API_KEY: 'k'.repeat(40), DOCKER_PAT: 'dckr_pat_SECRET', GH_CLONE: GIT_TOKEN, GH_STATUS: 'ghs_STATUS_TOKEN', NPM_TOKEN: NPM, DEPLOY_ENV: DEPLOY };
const config = {
  app: {
    repo: 'https://github.com/o/private.git',
    auth: { tokenEnv: 'GH_CLONE' },
    status: { provider: 'github', tokenEnv: 'GH_STATUS' },
    tasks: {
      test: {
        script: 'npm test',
        artifacts: ['dist/'],
        forward: { NPM_TOKEN: { mode: 'inject', hosts: ['registry.npmjs.org'], header: 'Authorization', format: 'Bearer %s' }, DEPLOY_ENV: { mode: 'env' } },
      },
      plain: 'true',
    },
  },
};

const fakeDocker = (opts = {}) => {
  const log = { secrets: [], launched: [], runs: [], secretsDeleted: [], sandboxDeleted: 0 };
  const sandbox = {
    name: 'sandboxes/sbx1',
    waitUntilRunning: async () => sandbox,
    processes: { run: async spec => { log.runs.push(spec); return opts.run ? opts.run(spec) : { exitCode: 0, stdout: 'ok', stderr: '' }; } },
    files: { read: async () => new TextEncoder().encode('artifact-bytes') },
    refresh: async () => sandbox,
    delete: async () => ({ waitUntilDeleted: async () => { log.sandboxDeleted++; } }),
  };
  const client = {
    secrets: { create: async input => { if (opts.secretCreateFails) throw new Error('quota'); const s = { name: `secrets/s${log.secrets.length}`, delete: async () => { if (opts.secretDeleteFails) throw new Error('denied'); log.secretsDeleted.push(s.name); } }; log.secrets.push(input); return s; } },
    kits: { launch: async (kit, input) => { if (opts.launchFails) throw new Error(`launch failed for ${GIT_TOKEN}`); log.launched.push([kit, input]); return sandbox; } },
  };
  return { client, log };
};

const setup = async ({ docker = fakeDocker(), mock = false, fetchImpl } = {}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'runner-'));
  const saved = [];
  const fetches = [];
  const runner = createRunner({
    client: mock ? null : docker.client,
    env,
    dataDir,
    save: async j => { saved.push(JSON.stringify(j)); },
    fetch: fetchImpl || (async (url, init) => { fetches.push({ url, init }); return { ok: true, status: 201 }; }),
    limits: { maxFiles: 5, maxFileBytes: 1024, maxTotalBytes: 4096 },
  });
  return { runner, docker, saved, fetches, dataDir };
};
const jobFor = () => ({ id: ID, project: 'app', task: 'test', commit: sha, status: 'queued', stdout: '', stderr: '', created: 'now' });
const prep = (task = 'test', forward = ['NPM_TOKEN', 'DEPLOY_ENV']) => {
  const spec = resolveJob(config, 'app', task, sha, env);
  return { spec, plan: prepareRun(spec, forward, env, reservedNames(config)) };
};

test('prepareRun builds secrets, env and a redaction list without exposing the caller to values', () => {
  const { plan } = prep();
  assert.deepEqual(plan.forwarded, ['NPM_TOKEN', 'DEPLOY_ENV']);
  assert.deepEqual(plan.secrets.map(s => s.label), ['git', 'NPM_TOKEN']);
  assert.deepEqual(plan.env, { DEPLOY_ENV: DEPLOY });
  for (const v of [GIT_TOKEN, NPM, DEPLOY, env.DOCKER_PAT, env.BRIDGE_API_KEY]) assert(plan.redactions.includes(v), v);
  assert.deepEqual(prep('plain', []).plan.secrets.map(s => s.label), ['git'], 'a task that forwards nothing still gets repo auth');
});

test('real run: secrets created and attached, env-mode value only in process env, everything cleaned up, nothing leaks', async () => {
  const docker = fakeDocker({ run: async () => ({ exitCode: 0, stdout: `build ok ${NPM} ${DEPLOY} ${GIT_TOKEN} ${env.DOCKER_PAT}`, stderr: `warn ${env.BRIDGE_API_KEY}` }) });
  const { runner, saved, fetches, dataDir } = await setup({ docker });
  const { spec, plan } = prep();
  const job = jobFor();
  await runner.execute(job, spec, plan);

  assert.equal(job.status, 'passed');
  assert.equal(docker.log.secrets.length, 2);
  const [git, npm] = docker.log.secrets;
  assert.deepEqual(git, { displayName: `bridge-${ID.slice(0, 8)}-0`, serviceType: 'github', token: { value: GIT_TOKEN } });
  assert.deepEqual(npm.custom.injection, { hosts: ['registry.npmjs.org'], header: 'Authorization', format: 'Bearer %s', envVar: 'NPM_TOKEN' });
  assert.equal(npm.custom.value, NPM);

  const [kit, launch] = docker.log.launched[0];
  assert.equal(kit, 'shell');
  assert.deepEqual(launch.storage, { secrets: ['secrets/s0', 'secrets/s1'] });
  assert.equal(launch.network, undefined);

  const run = docker.log.runs[0];
  assert.deepEqual(run.env, { DEPLOY_ENV: DEPLOY }, 'only env-mode values reach the process; inject-mode never does');
  assert(!JSON.stringify(run).includes(NPM));
  assert(!JSON.stringify(run).includes(GIT_TOKEN));

  for (const v of [NPM, DEPLOY, GIT_TOKEN, env.DOCKER_PAT, env.BRIDGE_API_KEY]) {
    assert(!job.stdout.includes(v) && !job.stderr.includes(v), `log leaked ${v}`);
    assert(!saved.some(s => s.includes(v)), `persisted record leaked ${v}`);
  }
  assert(job.stdout.includes('[REDACTED]'));

  assert.deepEqual(docker.log.secretsDeleted, ['secrets/s0', 'secrets/s1']);
  assert.equal(docker.log.sandboxDeleted, 1);
  assert.equal(job.cleanup, 'deleted');
  assert.equal(job.secretsCleanup, 'deleted');
  assert.deepEqual(job.forwarded, ['NPM_TOKEN', 'DEPLOY_ENV']);

  assert.deepEqual(fetches.map(f => JSON.parse(f.init.body).state), ['pending', 'success']);
  assert(fetches.every(f => f.url === `https://api.github.com/repos/o/private/statuses/${sha}`));
  assert(!fetches.some(f => f.init.body.includes('build ok')), 'logs are never posted to the forge');
  assert.deepEqual(job.statusReports.map(r => [r.ok, r.state]), [[true, 'pending'], [true, 'success']]);
  assert(dataDir);
});

test('a failing build still reports failure and cleans up', async () => {
  const docker = fakeDocker({ run: async () => ({ exitCode: 2, stdout: '', stderr: 'boom' }) });
  const { runner, fetches } = await setup({ docker });
  const { spec, plan } = prep('test', []);
  const job = jobFor();
  await runner.execute(job, spec, plan);
  assert.equal(job.status, 'failed');
  assert.equal(job.exitCode, 2);
  assert.deepEqual(fetches.map(f => JSON.parse(f.init.body).state), ['pending', 'failure']);
  assert.equal(docker.log.secretsDeleted.length, 1);
});

test('launch failure: error status published, secrets deleted, error message scrubbed', async () => {
  const docker = fakeDocker({ launchFails: true });
  const { runner, fetches, saved } = await setup({ docker });
  const { spec, plan } = prep();
  const job = jobFor();
  await runner.execute(job, spec, plan);
  assert.equal(job.status, 'error');
  assert(!job.error.includes(GIT_TOKEN));
  assert(job.error.includes('[REDACTED]'));
  assert.deepEqual(docker.log.secretsDeleted, ['secrets/s0', 'secrets/s1']);
  assert.equal(JSON.parse(fetches.at(-1).init.body).state, 'error');
  assert(!saved.some(s => s.includes(GIT_TOKEN)));
});

test('secret creation failure aborts before any sandbox exists and deletes what was created', async () => {
  const docker = fakeDocker({ secretCreateFails: true });
  const { runner } = await setup({ docker });
  const { spec, plan } = prep();
  const job = jobFor();
  await runner.execute(job, spec, plan);
  assert.equal(job.status, 'error');
  assert.equal(docker.log.launched.length, 0);
});

test('a secret that cannot be deleted is surfaced loudly', async () => {
  const docker = fakeDocker({ secretDeleteFails: true });
  const { runner } = await setup({ docker });
  const { spec, plan } = prep('test', []);
  const job = jobFor();
  await runner.execute(job, spec, plan);
  assert.match(job.secretsCleanup, /^FAILED/);
  assert.equal(job.status, 'passed', 'cleanup trouble does not rewrite the build result');
});

test('artifacts are collected, stored and described on the job', async () => {
  const docker = fakeDocker({ run: async spec => (spec.args[2].includes('readlink') ? { exitCode: 0, stdout: 'dist/a.bin\n', stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' }) });
  const { runner } = await setup({ docker });
  const { spec, plan } = prep('test', []);
  const job = jobFor();
  await runner.execute(job, spec, plan);
  assert.equal(job.artifacts.length, 1);
  assert.deepEqual([job.artifacts[0].path, job.artifacts[0].size], ['dist/a.bin', 14]);
  assert.equal(job.artifactsError, undefined);
});

test('status failures never fail the build and are recorded', async () => {
  const { runner } = await setup({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  const { spec, plan } = prep('test', []);
  const job = jobFor();
  await runner.execute(job, spec, plan);
  assert.equal(job.status, 'passed');
  assert(job.statusReports.every(r => r.ok === false && r.httpStatus === 403));
});

test('startup purge deletes only old bridge-* stored secrets, never another instance\'s in-flight ones', async () => {
  const deleted = [];
  const NOW = Date.parse('2026-01-01T12:00:00Z');
  const OLD = new Date(NOW - 60 * 60_000);
  const FRESH = new Date(NOW - 5 * 60_000);
  const make = (displayName, createdAt = OLD, fail = false) => ({ displayName, createdAt, delete: async () => { if (fail) throw new Error('denied'); deleted.push(displayName); } });
  const all = [
    make('bridge-0a1b2c3d-0'), make('my-own-secret'), make('bridge-notahexid-1'), make('bridge-deadbeef-12'),
    make('bridge-cafebabe-0', OLD, true), make('bridge-0a1b2c3d-0-extra'), { delete: async () => deleted.push('nameless') },
    make('bridge-feedface-0', FRESH), make('bridge-badc0ffe-0', undefined), make('bridge-badc0de0-0', new Date('nonsense')),
  ];
  all[8].createdAt = undefined;
  const client = { secrets: { all: () => ({ async *[Symbol.asyncIterator]() { yield* all; } }) } };
  const out = await purgeOrphanSecrets(client, { now: () => NOW });
  assert.deepEqual(deleted, ['bridge-0a1b2c3d-0', 'bridge-deadbeef-12']);
  assert.deepEqual(out, { purged: ['bridge-0a1b2c3d-0', 'bridge-deadbeef-12'], failed: ['bridge-cafebabe-0'] });
  const all2 = [make('bridge-feedface-1', FRESH)];
  const eager = await purgeOrphanSecrets({ secrets: { all: () => ({ async *[Symbol.asyncIterator]() { yield* all2; } }) } }, { now: () => NOW, minAgeMs: 0 });
  assert.deepEqual(eager.purged, ['bridge-feedface-1'], 'minAgeMs is adjustable');
});

test('mock mode: no Docker, no forge calls, forwarding still validated up front', async () => {
  const { runner, fetches } = await setup({ mock: true });
  const { spec, plan } = prep();
  const job = jobFor();
  await runner.execute(job, spec, plan);
  assert.equal(job.status, 'passed');
  assert.match(job.stdout, /Mock CI/);
  assert.equal(fetches.length, 0);
  assert.deepEqual(job.forwarded, ['NPM_TOKEN', 'DEPLOY_ENV']);
  assert.throws(() => prepareRun(resolveJob(config, 'app', 'test', sha, env), ['HOME'], env, reservedNames(config)), /not forwardable/);
});
