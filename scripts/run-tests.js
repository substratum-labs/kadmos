import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('dist/tests')
  .filter(name => name.endsWith('.test.js'))
  .map(name => join('dist', 'tests', name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const packedTypes = spawnSync(process.execPath, [join('scripts', 'test-packed-types.js')], { stdio: 'inherit' });
  if (packedTypes.error) throw packedTypes.error;
  process.exitCode = packedTypes.status ?? 1;
}
