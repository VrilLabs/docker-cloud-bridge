import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectArtifacts, storeArtifacts, loadArtifact, WORKDIR } from '../artifacts.mjs';

const limits = { maxFiles: 3, maxFileBytes: 10, maxTotalBytes: 15 };
const sandboxWith = (listing, files) => {
  const reads = [];
  return {
    reads,
    processes: { run: async ({ args }) => ({ exitCode: 0, stdout: listing(args), stderr: '' }) },
    files: { read: async (path, opts) => { reads.push([path, opts]); if (!(path in files)) throw new Error('ENOENT'); return new TextEncoder().encode(files[path]); } },
  };
};
const sha = s => createHash('sha256').update(s).digest('hex');

test('collects declared files with size and sha256, reading only inside the work dir with a byte cap', async () => {
  const sb = sandboxWith(() => 'dist/a.txt\nreports/r.json\n', { [`${WORKDIR}/dist/a.txt`]: 'hello', [`${WORKDIR}/reports/r.json`]: '{"ok":1}' });
  const out = await collectArtifacts(sb, ['dist/a.txt', 'reports/'], limits);
  assert.deepEqual(out.files.map(f => [f.path, f.size, f.sha256]), [['dist/a.txt', 5, sha('hello')], ['reports/r.json', 8, sha('{"ok":1}')]]);
  assert.deepEqual(out.skipped, []);
  assert(sb.reads.every(([p, o]) => p.startsWith(`${WORKDIR}/`) && o.maxBytes === limits.maxFileBytes + 1));
});

test('declared paths are passed as arguments, never interpolated into the script', async () => {
  let seen;
  const sb = sandboxWith(args => { seen = args; return ''; }, {});
  await collectArtifacts(sb, ['dist/a.txt', 'out/'], limits);
  assert.deepEqual(seen.slice(0, 2), ['sh', '-c']);
  assert(!seen[2].includes('dist/a.txt'), 'script text must not contain the declared paths');
  assert.deepEqual(seen.slice(3), ['sh', 'dist/a.txt', 'out/']);
  assert(seen[2].includes('p="./$p"'), 'a path starting with "-" must never be parsed as a find/test option');
});

test('skips oversized files, odd names, traversal and over-limit counts; reports why', async () => {
  const listing = ['ok.txt', 'big.bin', 'sp ace.txt', '../etc/passwd', '/etc/passwd', 'a.txt', 'b.txt', 'c.txt'].join('\n');
  const sb = sandboxWith(() => listing, { [`${WORKDIR}/ok.txt`]: 'ok', [`${WORKDIR}/big.bin`]: 'x'.repeat(11), [`${WORKDIR}/a.txt`]: 'a', [`${WORKDIR}/b.txt`]: 'b', [`${WORKDIR}/c.txt`]: 'c' });
  const out = await collectArtifacts(sb, ['x/'], limits);
  assert.deepEqual(out.files.map(f => f.path), ['ok.txt', 'a.txt', 'b.txt']);
  const reasons = Object.fromEntries(out.skipped.map(s => [s.path, s.reason]));
  assert.match(reasons['big.bin'], /too large/);
  assert.match(reasons['sp ace.txt'], /name/);
  assert.match(reasons['../etc/passwd'], /name|outside/);
  assert.match(reasons['/etc/passwd'], /name|outside/);
  assert.match(reasons['c.txt'], /limit/);
});

test('total byte cap applies across files', async () => {
  const sb = sandboxWith(() => 'a\nb\n', { [`${WORKDIR}/a`]: 'x'.repeat(10), [`${WORKDIR}/b`]: 'y'.repeat(10) });
  const out = await collectArtifacts(sb, ['a', 'b'], limits);
  assert.deepEqual(out.files.map(f => f.path), ['a']);
  assert.match(out.skipped[0].reason, /total/);
});

test('a read failure is recorded, not thrown', async () => {
  const sb = sandboxWith(() => 'missing.txt\n', {});
  const out = await collectArtifacts(sb, ['missing.txt'], limits);
  assert.deepEqual(out.files, []);
  assert.match(out.skipped[0].reason, /read failed/);
});

test('store writes private files under the job id and load verifies the hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'art-'));
  const bytes = new TextEncoder().encode('payload');
  const meta = await storeArtifacts(dir, '11111111-1111-1111-1111-111111111111', [{ path: 'dist/a.txt', size: 7, sha256: sha('payload'), bytes }]);
  assert.deepEqual(meta, [{ index: 0, path: 'dist/a.txt', size: 7, sha256: sha('payload') }]);
  const file = join(dir, 'artifacts', '11111111-1111-1111-1111-111111111111', '0');
  assert.equal(await readFile(file, 'utf8'), 'payload');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const loaded = await loadArtifact(dir, '11111111-1111-1111-1111-111111111111', meta[0]);
  assert.equal(Buffer.from(loaded).toString(), 'payload');
  await assert.rejects(() => loadArtifact(dir, '11111111-1111-1111-1111-111111111111', { ...meta[0], sha256: sha('tampered') }), /integrity/);
  await assert.rejects(() => loadArtifact(dir, '../etc', meta[0]), /invalid/);
});
