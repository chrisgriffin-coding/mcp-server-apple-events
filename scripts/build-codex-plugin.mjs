import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputDirectory = path.join(projectRoot, 'plugin-dist');
const outputFile = path.join(outputDirectory, 'index.mjs');
const hashFile = `${outputFile}.sha256`;

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, 'src', 'index.ts')],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  legalComments: 'eof',
  sourcemap: false,
});

await fs.chmod(outputFile, 0o755);
const bundle = await fs.readFile(outputFile);
const hash = crypto.createHash('sha256').update(bundle).digest('hex');
await fs.writeFile(hashFile, `${hash}\n`, { mode: 0o644 });

console.log(`Codex plugin bundle: ${path.relative(projectRoot, outputFile)}`);
console.log(`CODEX_PLUGIN_BUNDLE_SHA256=${hash}`);
