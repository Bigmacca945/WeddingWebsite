import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('deployment contains no public wedding assets, even if the Worker is bypassed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wedding-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'security'));
  for (const filename of ['build.mjs', 'worker.mjs', 'login.html']) {
    await copyFile(new URL(filename, import.meta.url), join(root, 'security', filename));
  }
  for (const filename of ['index.html', 'rsvp.html', 'styles.css', 'script.js']) {
    await copyFile(new URL(`../${filename}`, import.meta.url), join(root, filename));
  }
  execFileSync(process.execPath, [join(root, 'security', 'build.mjs')], { stdio: 'pipe' });
  assert.deepEqual((await readdir(join(root, 'deploy'))).sort(), ['_routes.json', '_worker.js', 'index.html']);
  const fallback = await readFile(join(root, 'deploy', 'index.html'), 'utf8');
  assert.doesNotMatch(fallback, /Cathan|Laura|2027|Marlborough|Russell|ACCESS_CODE/);
  const workerSource = await readFile(join(root, 'deploy', '_worker.js'), 'utf8');
  assert.doesNotMatch(workerSource, /ACCESS_CODE|weddingInviteUnlocked|env\.ASSETS/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'deploy', '_routes.json'), 'utf8')),
    { version: 1, include: ['/*'], exclude: [] });

  // Execute the exact generated artifact, not just the source factory.
  const { default: deployed } = await import(pathToFileURL(join(root, 'deploy', '_worker.js')).href);
  const log = t.mock.method(console, 'error', () => {});
  const denied = await deployed.fetch(new Request('https://example.pages.dev/rsvp.html'), {});
  assert.equal(denied.status, 503);
  assert.doesNotMatch(await denied.text(), /Cathan|Laura|2027|Russell/);
  assert.ok(log.mock.callCount() > 0);

  await writeFile(join(root, 'deploy', 'accidental-private.html'), 'private');
  assert.throws(() => execFileSync(process.execPath, [join(root, 'security', 'build.mjs')], { stdio: 'pipe' }),
    /Unexpected files in deploy/);
});
