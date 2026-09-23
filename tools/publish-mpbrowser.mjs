// Publish mpbrowser.html to the production tree: the page is copied with every
// ./sdk/ path rewritten to ./sdkmp/ (the FROZEN published copy of the SDK), and
// exactly the modules and assets that page reaches — followed transitively
// through the import graph — are refreshed alongside it. Nothing else in sdkmp
// is touched, and nothing the page does not use is dragged in.
//
//   node tools/publish-mpbrowser.mjs <destRoot> [--dry]
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.cwd();
const DEST = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!DEST) { console.error('usage: node tools/publish-mpbrowser.mjs <destRoot> [--dry]'); process.exit(1); }

const html = fs.readFileSync(path.join(SRC, 'mpbrowser.html'), 'utf8');

// every sdk/ path the page names, however it is written
const refs = new Set();
for (const m of html.matchAll(/["'`(]\.?\/?(sdk\/[A-Za-z0-9_\-./]+)["'`)]/g)) refs.add(m[1]);

// follow relative imports inside the sdk graph
const queue = [...refs], seen = new Set();
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  if (!/\.(js|mjs)$/.test(rel)) continue;
  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) { console.warn('  ! missing', rel); continue; }
  const code = fs.readFileSync(abs, 'utf8');
  for (const m of code.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)) {
    const spec = m[1] || m[2];
    if (!spec || !spec.startsWith('.')) continue;                 // bare / CDN specifiers stay
    const target = path.relative(SRC, path.resolve(path.dirname(abs), spec)).replace(/\\/g, '/');
    if (target.startsWith('sdk/')) queue.push(target);
  }
}
const files = [...seen].sort();
console.log(`page reaches ${files.length} files under sdk/`);

let copied = 0, added = 0, bytes = 0;
for (const rel of files) {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) continue;
  const to = path.join(DEST, rel.replace(/^sdk\//, 'sdkmp/'));
  const fresh = !fs.existsSync(to);
  const src = fs.readFileSync(from);
  if (!fresh && Buffer.compare(src, fs.readFileSync(to)) === 0) continue;
  bytes += src.length;
  if (fresh) added++; else copied++;
  console.log(`  ${fresh ? 'NEW ' : 'upd '} ${rel} → ${rel.replace(/^sdk\//, 'sdkmp/')} (${(src.length / 1024).toFixed(0)} kB)`);
  if (!DRY) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, src); }
}

// the page itself: ./sdk/ → ./sdkmp/ everywhere, however the path is spelled
const out = html
  .replace(/(["'`(])\.\/sdk\//g, '$1./sdkmp/')
  .replace(/(["'`(])sdk\//g, '$1sdkmp/');
const left = [...out.matchAll(/["'`(]\.?\/?sdk\//g)].length;
if (left) { console.error(`REFUSING: ${left} sdk/ paths survived the rewrite`); process.exit(1); }
if (!DRY) fs.writeFileSync(path.join(DEST, 'mpbrowser.html'), out);
console.log(`mpbrowser.html rewritten (${(out.length / 1024).toFixed(0)} kB) · ${added} new + ${copied} updated modules/assets, ${(bytes / 1048576).toFixed(1)} MB`);
if (DRY) console.log('(dry run — nothing written)');
