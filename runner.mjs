// Executes one build: attaches Docker-native stored secrets (injected by Docker's proxy, never written into the sandbox),
// runs the operator-approved script, exports declared artifacts, reports status to the forge, and always cleans up.
import { scriptFor } from './policy.mjs';
import { publishStatus } from './statuses.mjs';
import { collectArtifacts, storeArtifacts } from './artifacts.mjs';

const LAUNCH_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 600_000;
const MAX_LOG_CHARS = 64_000;
const MAX_STATUS_REPORTS = 6;
const CLEANUP_FAILED = 'FAILED: inspect Docker Console';

const redactor = values => {
  const ordered = [...new Set(values)].filter(v => typeof v === 'string' && v !== '').sort((a, b) => b.length - a.length);
  return text => ordered.reduce((acc, v) => acc.split(v).join('[REDACTED]'), String(text ?? '')).slice(-MAX_LOG_CHARS);
};

// A crash mid-build can leave a stored secret (holding a real token) in Docker's store. Only secrets matching our own
// naming scheme AND older than any build can legitimately run (launch 2 min + wait 2 min + script 10 min) are purged,
// so a second bridge instance sharing the Docker account (a dev copy, say) can never delete an in-flight build's secret.
const ORPHAN_NAME = /^bridge-[a-f0-9]{8}-\d+$/;
const ORPHAN_MIN_AGE_MS = 30 * 60_000;
export async function purgeOrphanSecrets(client, { minAgeMs = ORPHAN_MIN_AGE_MS, now = Date.now } = {}) {
  const purged = [];
  const failed = [];
  for await (const secret of client.secrets.all()) {
    if (!ORPHAN_NAME.test(secret.displayName ?? '')) continue;
    const created = secret.createdAt ? new Date(secret.createdAt).getTime() : NaN;
    if (!Number.isFinite(created) || now() - created < minAgeMs) continue;
    try { await secret.delete(); purged.push(secret.displayName); } catch { failed.push(secret.displayName); }
  }
  return { purged, failed };
}

export function createRunner({ client, env = process.env, fetch: fetchImpl = globalThis.fetch, dataDir, save, limits, now = () => new Date().toISOString() }) {
  const report = async (job, spec) => {
    if (!client) return; // mock mode must never post statuses to a real commit
    const result = await publishStatus({ project: spec.project, projectName: spec.projectName, task: spec.taskName, job, env, fetch: fetchImpl });
    if (result.skipped) return;
    job.statusReports = [...(job.statusReports || []), { ...result, at: now() }].slice(-MAX_STATUS_REPORTS);
    await save(job);
  };

  const collect = async (job, spec, sandbox, redact) => {
    if (spec.task.artifacts.length === 0) return;
    try {
      const { files, skipped } = await collectArtifacts(sandbox, spec.task.artifacts, limits);
      // File names come from the sandbox (untrusted output), so they get the same redaction and length cap as logs.
      const label = p => redact(p).slice(0, 200);
      if (files.length) job.artifacts = (await storeArtifacts(dataDir, job.id, files)).map(a => ({ ...a, path: label(a.path) }));
      if (skipped.length) job.artifactsSkipped = skipped.map(s => ({ path: label(s.path), reason: s.reason }));
    } catch (e) {
      job.artifactsError = redact(e.message);
    }
  };

  const cleanup = async (job, sandbox, secrets, redact) => {
    if (sandbox) {
      try { const latest = await sandbox.refresh(); const deleting = await latest.delete({ force: true }); await deleting?.waitUntilDeleted(); job.cleanup = 'deleted'; }
      catch (e) { job.cleanup = CLEANUP_FAILED; job.cleanupError = redact(e.message); }
    }
    if (secrets.length) {
      const failures = [];
      for (const secret of secrets) { try { await secret.delete(); } catch (e) { failures.push(redact(e.message)); } }
      job.secretsCleanup = failures.length ? `${CLEANUP_FAILED} (stored secrets named bridge-${job.id.slice(0, 8)}-*)` : 'deleted';
      if (failures.length) job.secretsCleanupError = failures.join('; ').slice(0, 500);
    }
  };

  async function execute(job, spec, plan) {
    const redact = redactor(plan.redactions);
    const secrets = [];
    let sandbox;
    try {
      job.status = 'running';
      job.forwarded = plan.forwarded;
      await save(job);
      await report(job, spec);
      if (!client) {
        await new Promise(r => setTimeout(r, 100));
        job.stdout = 'Mock CI completed (no real build executed)';
        job.stderr = '';
        job.exitCode = 0;
      } else {
        for (const [i, s] of plan.secrets.entries()) {
          try { secrets.push(await client.secrets.create({ displayName: `bridge-${job.id.slice(0, 8)}-${i}`, ...s.create })); }
          catch (e) { throw new Error(`Docker rejected the stored secret for "${s.label}": ${e.code ?? e.message}`); }
        }
        const launch = { resources: 'small' };
        if (secrets.length) launch.storage = { secrets: secrets.map(s => s.name) };
        sandbox = await client.kits.launch('shell', launch, { timeoutMs: LAUNCH_TIMEOUT_MS });
        job.sandbox = sandbox.name;
        await save(job);
        sandbox = await sandbox.waitUntilRunning({ timeoutMs: LAUNCH_TIMEOUT_MS });
        const run = { args: ['sh', '-c', scriptFor(spec, job.commit)] };
        if (Object.keys(plan.env).length) run.env = plan.env;
        const result = await sandbox.processes.run(run, { timeoutMs: RUN_TIMEOUT_MS });
        job.stdout = redact(result.stdout);
        job.stderr = redact(result.stderr);
        job.exitCode = result.exitCode;
        await collect(job, spec, sandbox, redact);
      }
      job.status = job.exitCode === 0 ? 'passed' : 'failed';
    } catch (e) {
      job.status = 'error';
      job.error = redact(e.message);
    } finally {
      await cleanup(job, sandbox, secrets, redact);
      job.finished = now();
      await save(job);
      await report(job, spec);
    }
  }

  return { execute };
}
