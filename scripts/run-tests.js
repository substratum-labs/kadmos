import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const allFiles = readdirSync('dist/tests')
  .filter(name => name.endsWith('.test.js'))
  .map(name => join('dist', 'tests', name));
const posixQualification = allFiles.filter(file => /test_(?:coding_backend|host_process|repository_(?!contracts|portable)|world_revision)/.test(file));
const files = process.platform === 'win32' ? allFiles.filter(file => !posixQualification.includes(file)) : allFiles;
console.log(JSON.stringify({ suite: process.platform === 'win32' ? 'legacy + portable repository boundary' : 'full POSIX qualification', platform: process.platform, executedFiles: files, notExecuted: process.platform === 'win32' ? posixQualification : [], posixQualification: process.platform === 'win32' ? 'NOT_EXECUTED / unqualified' : 'executed; fixture qualification only' }));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const packedTypes = spawnSync(process.execPath, [join('scripts', 'test-packed-types.js')], { stdio: 'inherit' });
  if (packedTypes.error) throw packedTypes.error;
  process.exitCode = packedTypes.status ?? 1;
}
