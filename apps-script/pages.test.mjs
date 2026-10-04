import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const embedSource = await readFile(new URL('../rsvp-embed.js', import.meta.url), 'utf8');

test('name-only RSVP UI has no code prompt or code payload', async () => {
  const form = await readFile(new URL('Rsvp.html', import.meta.url), 'utf8');
  const page = await readFile(new URL('../rsvp.html', import.meta.url), 'utf8');
  assert.doesNotMatch(form, /invite-code|codeInput|accessCode|invitation code/i);
  assert.doesNotMatch(page, /invitation code/i);
  assert.match(form, /firstName: firstNameInput\.value/);
  assert.match(form, /token: group\.token/);
});

function embedFixture(appUrl) {
  const elements = {
    'rsvp-sheet-frame': { hidden: true, style: {} },
    'rsvp-connection-status': { hidden: false, textContent: 'Not connected', setAttribute() {} },
    'rsvp-open-form': { hidden: true }
  };
  const events = {};
  const context = {
    document: { getElementById: id => elements[id] },
    window: { WEDDING_RSVP: { appUrl }, addEventListener: (name, fn) => { events[name] = fn; } },
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
    URL, Number, Math
  };
  vm.runInNewContext(embedSource, context);
  return { elements, events };
}

test('embed leaves missing or invalid configuration visibly disconnected', () => {
  for (const url of ['', 'http://script.google.com/macros/s/fake/exec', 'https://attacker.example/exec', 'https://script.google.com/macros/s/fake/dev']) {
    const { elements } = embedFixture(url);
    assert.equal(elements['rsvp-sheet-frame'].hidden, true);
    assert.equal(elements['rsvp-sheet-frame'].src, undefined);
    assert.equal(elements['rsvp-open-form'].hidden, true);
    assert.equal(elements['rsvp-connection-status'].hidden, false);
  }
});

test('embed loads only an Apps Script deployment and accepts only its matching resize channel', () => {
  const { elements, events } = embedFixture('https://script.google.com/macros/s/testDeployment/exec');
  const frame = elements['rsvp-sheet-frame'];
  assert.equal(frame.hidden, false);
  assert.match(frame.src, /channel=12345678/);
  const message = { type: 'wedding-rsvp-height', channel: '12345678-1234-1234-1234-123456789abc', height: 1000 };
  for (const event of [
    { origin: 'https://attacker.example', data: message },
    { origin: 'https://script.googleusercontent.com.attacker.example', data: message },
    { origin: 'https://script.googleusercontent.com', data: { ...message, channel: 'wrong' } },
    { origin: 'https://script.googleusercontent.com', data: { ...message, height: NaN } }
  ]) events.message(event);
  assert.equal(frame.style.height, undefined);
  events.message({ origin: 'https://n-test-script.googleusercontent.com', data: message });
  assert.equal(frame.style.height, '1000px');
  assert.equal(elements['rsvp-connection-status'].hidden, true);
  events.message({ origin: 'https://script.googleusercontent.com', data: { ...message, height: 99999 } });
  assert.equal(frame.style.height, '4000px');
});

test('GitHub Pages build publishes only the public allow-list, not private or backend files', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'wedding-pages-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, 'apps-script'));
  await mkdir(join(temp, 'private'));
  await copyFile(new URL('build-pages.mjs', import.meta.url), join(temp, 'apps-script', 'build-pages.mjs'));
  const files = ['index.html', 'rsvp.html', 'styles.css', 'script.js', 'rsvp-config.js', 'rsvp-embed.js'];
  for (const filename of files) await copyFile(new URL(filename, root), join(temp, filename));
  await writeFile(join(temp, 'private', 'guests.tsv'), 'PRIVATE_GUEST_IMPORT_SENTINEL');
  await writeFile(join(temp, 'apps-script', 'Code.gs'), 'PRIVATE_SERVER_SOURCE_SENTINEL');
  await writeFile(join(temp, 'rsvp-config.js'), "window.WEDDING_RSVP = Object.freeze({ appUrl: 'https://script.google.com/macros/s/testDeployment/exec' });");
  execFileSync(process.execPath, [join(temp, 'apps-script', 'build-pages.mjs')], { stdio: 'pipe' });
  assert.deepEqual((await readdir(join(temp, 'pages-deploy'))).sort(), files.sort());
  const html = await readFile(join(temp, 'pages-deploy', 'rsvp.html'), 'utf8');
  assert.doesNotMatch(html, /action="\/rsvp|action="\/logout|RSVP_DYNAMIC|href="\/index|src="\/script/);
  assert.match(html, /src="rsvp-embed\.js/);
  for (const filename of files) {
    assert.doesNotMatch(await readFile(join(temp, 'pages-deploy', filename), 'utf8'), /PRIVATE_GUEST_IMPORT_SENTINEL|PRIVATE_SERVER_SOURCE_SENTINEL/);
  }
  await writeFile(join(temp, 'pages-deploy', 'accidental-private.tsv'), 'private');
  assert.throws(() => execFileSync(process.execPath, [join(temp, 'apps-script', 'build-pages.mjs')], { stdio: 'pipe' }), /Unexpected files/);
  await writeFile(join(temp, 'rsvp-config.js'), "window.WEDDING_RSVP = {appUrl:''};");
  assert.throws(() => execFileSync(process.execPath, [join(temp, 'apps-script', 'build-pages.mjs')], { stdio: 'pipe' }), /deployed Apps Script/);
});
