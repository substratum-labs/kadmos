import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'kadmos-packed-types-'));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, 'pnpm must supply npm_execpath');
  run(process.execPath, [pnpm, 'pack', '--pack-destination', temporary]);
  const archiveName = readdirSync(temporary).find(name => name.endsWith('.tgz'));
  assert.ok(archiveName, 'pnpm pack did not create a tarball');
  const archive = join(temporary, archiveName);
  const packageDir = join(temporary, 'consumer', 'node_modules', '@substratum-labs', 'kadmos');
  mkdirSync(packageDir, { recursive: true });
  run('tar', ['-xzf', archive, '-C', packageDir, '--strip-components=1']);
  assert.deepEqual(readdirSync(join(packageDir, 'dist')), ['src']);
  assert.ok(!readdirSync(packageDir).some(name => ['tests', 'examples'].includes(name)));
  assert.ok(readdirSync(join(packageDir, 'dist', 'src', 'types')).includes('ports.d.ts'));
  assert.ok(readdirSync(join(packageDir, 'dist', 'src', 'types')).includes('ports.js'));
  const consumer = join(temporary, 'consumer');
  writeFileSync(join(consumer, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(consumer, 'probe.ts'), `import { Queue, Worker, Job, QueueEvents } from '@substratum-labs/kadmos/adapters/bullmq';
import { createWorldChecker, type StepVerdict } from '@substratum-labs/kadmos';
void [Queue, Worker, Job, QueueEvents, createWorldChecker];
const verdict: StepVerdict | undefined = undefined;
void verdict;
`);
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true,
    typeRoots: [join(root, 'node_modules', '@types')], types: ['node'],
  }, files: ['probe.ts'] }));
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const output = run(process.execPath, [tsc, '-p', join(consumer, 'tsconfig.json'), '--noEmit'], consumer);
  assert.equal(output.trim(), '', `unexpected TypeScript diagnostics:\n${output}`);
  console.log('Packed NodeNext consumer typecheck: 0 diagnostics');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
