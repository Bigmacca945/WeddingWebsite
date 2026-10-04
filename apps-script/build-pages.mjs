import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'pages-deploy');
const publicFiles = ['index.html', 'rsvp.html', 'styles.css', 'script.js', 'rsvp-config.js', 'rsvp-embed.js'];
const config = { window: {} };
vm.runInNewContext(await readFile(resolve(root, 'rsvp-config.js'), 'utf8'), config, { timeout: 1000 });
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(config.window.WEDDING_RSVP?.appUrl || '')) {
  throw new Error('Set appUrl in rsvp-config.js to the deployed Apps Script /exec URL before publishing.');
}
await mkdir(output, { recursive: true });
const unexpected = (await readdir(output)).filter(name => !publicFiles.includes(name));
if (unexpected.length) {
  throw new Error(`Unexpected files in pages-deploy; refusing to publish: ${unexpected.join(', ')}`);
}
for (const filename of publicFiles) {
  await copyFile(resolve(root, filename), resolve(output, filename));
}
console.log(`GitHub Pages files prepared: ${output}\nNo guest list, Apps Script server source, or private import is included.`);
