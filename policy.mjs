import { timingSafeEqual } from 'node:crypto';
export function authorized(header, key) {
  const a = Buffer.from(header || ''), b = Buffer.from('Bearer ' + key);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function resolveJob(config, project, task, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Require full 40-character lowercase commit SHA');
  const p = Object.hasOwn(config, project) ? config[project] : undefined;
  const script = p && Object.hasOwn(p.tasks || {}, task) ? p.tasks[task] : undefined;
  if (!script || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(p.repo)) throw new Error('Project/task not allowed or invalid GitHub URL');
  if (p.repo.includes('@')) throw new Error('Credentials in URL forbidden');
  return { repo: p.repo, script };
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
