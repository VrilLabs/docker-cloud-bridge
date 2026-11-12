// Artifact export: the operator declares paths per task; the bridge lists them inside the sandbox with standard tools
// (so symlink escapes are resolved by the sandbox's own readlink), reads each file under strict caps, hashes it,
// and stores it privately on the bridge's persistent volume.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const WORKDIR = '/tmp/ci-work';
const SAFE_NAME = /^[A-Za-z0-9._@%+=,/-]+$/;
const MAX_LISTED = 500;
const UUID = /^[a-f0-9-]{36}$/;

// Declared paths arrive as positional arguments ($@), never interpolated into this text.
// Directories (trailing "/") expand to regular files only; anything that resolves outside the work dir is dropped.
const LIST_SCRIPT = `cd ${WORKDIR} || exit 0
for p in "$@"; do
  p="./$p"
  case "$p" in
    */) find "$p" -type f 2>/dev/null ;;
    *) if [ -f "$p" ] && [ ! -L "$p" ]; then echo "$p"; fi ;;
  esac
done | head -n ${MAX_LISTED} | while IFS= read -r f; do
  r=$(readlink -f -- "$f" 2>/dev/null) || continue
  case "$r" in ${WORKDIR}/*) printf '%s\\n' "$f" ;; esac
done
`;

export async function collectArtifacts(sandbox, declared, limits) {
  const files = [];
  const skipped = [];
  if (declared.length === 0) return { files, skipped };
  const listing = await sandbox.processes.run({ args: ['sh', '-c', LIST_SCRIPT, 'sh', ...declared] }, { timeoutMs: 60_000 });
  const seen = new Set();
  let total = 0;
  for (const raw of String(listing.stdout).split('\n')) {
    const path = raw.replace(/\r$/, '').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const segments = path.split('/');
    if (!SAFE_NAME.test(path) || path.startsWith('/') || segments.some(s => s === '' || s === '.' || s === '..')) { skipped.push({ path, reason: 'unsupported or outside-workdir name' }); continue; }
    if (files.length >= limits.maxFiles) { skipped.push({ path, reason: `file count limit (${limits.maxFiles}) reached` }); continue; }
    let bytes;
    try { bytes = await sandbox.files.read(`${WORKDIR}/${path}`, { maxBytes: limits.maxFileBytes + 1 }); }
    catch { skipped.push({ path, reason: 'read failed' }); continue; }
    if (bytes.length > limits.maxFileBytes) { skipped.push({ path, reason: `too large (limit ${limits.maxFileBytes} bytes)` }); continue; }
    if (total + bytes.length > limits.maxTotalBytes) { skipped.push({ path, reason: `total size limit (${limits.maxTotalBytes} bytes) reached` }); continue; }
    total += bytes.length;
    files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes });
  }
  return { files, skipped };
}

const jobDir = (dataDir, jobId) => {
  if (!UUID.test(jobId)) throw new Error('invalid job id');
  return join(dataDir, 'artifacts', jobId);
};

export async function storeArtifacts(dataDir, jobId, files) {
  const dir = jobDir(dataDir, jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const meta = [];
  for (const [index, f] of files.entries()) {
    await writeFile(join(dir, String(index)), f.bytes, { mode: 0o600 });
    meta.push({ index, path: f.path, size: f.size, sha256: f.sha256 });
  }
  return meta;
}

export async function loadArtifact(dataDir, jobId, entry) {
  const dir = jobDir(dataDir, jobId);
  if (!Number.isInteger(entry.index) || entry.index < 0) throw new Error('invalid artifact index');
  const bytes = await readFile(join(dir, String(entry.index)));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('artifact integrity check failed');
  return bytes;
}
