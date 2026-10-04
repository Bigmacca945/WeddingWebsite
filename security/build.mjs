import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'deploy');
const files = [
  ['index.html', 'text/html; charset=utf-8'],
  ['rsvp.html', 'text/html; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['script.js', 'text/javascript; charset=utf-8']
];
const allowedOutput = new Set(['index.html', '_worker.js', '_routes.json']);
await mkdir(output, { recursive: true });
const unexpected = (await readdir(output)).filter(name => !allowedOutput.has(name));
if (unexpected.length) {
  throw new Error(`Unexpected files in deploy (refusing a potentially unsafe upload): ${unexpected.join(', ')}`);
}

const content = {};
for (const [name, contentType] of files) {
  content[`/${name}`] = { body: await readFile(resolve(root, name), 'utf8'), contentType };
}
const source = await readFile(new URL('worker.mjs', import.meta.url), 'utf8');
const login = await readFile(new URL('login.html', import.meta.url), 'utf8');

// Private content exists only in the executable Worker, never in the public asset store.
await writeFile(resolve(output, '_worker.js'),
  `${source}\nexport default createWeddingWorker(${JSON.stringify(content)}, ${JSON.stringify(login)});\n`);
await writeFile(resolve(output, 'index.html'), '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Private website unavailable</title></head><body><h1>Private website unavailable</h1><p>Please try again later.</p></body></html>\n');
await writeFile(resolve(output, '_routes.json'), JSON.stringify({ version: 1, include: ['/*'], exclude: [] }, null, 2) + '\n');
console.log(`Protected upload prepared: ${output}\nUpload only this folder, never the repository root. No secrets are included.`);
