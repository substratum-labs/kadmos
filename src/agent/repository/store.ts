import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { safePath } from './workspace.js';

/** Host-only, create-once record directory. A stranded reservation fails closed. */
export function createAtomicJson(recordDir: string, value: unknown): void {
  if (!isAbsolute(recordDir)) throw new Error('record directory must be absolute');
  const bytes = JSON.stringify(value);
  if (bytes === undefined) throw new Error('JSON record required');
  const dir = safePath(recordDir);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  safePath(dirname(dir));
  // mkdir is the exclusive reservation: rename never replaces another writer's record.
  mkdirSync(dir, { mode: 0o700 });
  const temp = join(dir, `.record.${randomUUID()}.tmp`);
  try {
    safePath(dir);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, join(dir, 'record.json'));
    const directory = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { rmSync(temp, { force: true }); }
}

export function readAtomicJson(recordDir: string): unknown {
  if (!isAbsolute(recordDir)) throw new Error('record directory must be absolute');
  const file = safePath(join(recordDir, 'record.json'));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('record must be regular');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}
