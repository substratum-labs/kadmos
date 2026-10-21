import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CandidateIdentity, Digest, FileIdentity, RepositoryPolicy } from './contracts.js';
export interface WorkspaceRequest { readonly source: string; readonly destination: string; readonly policy: RepositoryPolicy }
export interface WorkspaceResult { readonly status: 'pending' | 'created' | 'refused'; readonly workspace: string | null; readonly diagnostics: readonly string[] }
export const hashBytes = (bytes: string | Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function containsPath(root: string, path: string): boolean {
  const r = relative(root, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
/** The OS /var and /tmp aliases on macOS are trusted roots, not candidate aliases. */
export function safePath(path: string): string {
  const absolute = resolve(path);
  let part = absolute;
  while (true) {
    if (existsSync(part) || (() => { try { lstatSync(part); return true; } catch { return false; } })()) {
      if (lstatSync(part).isSymbolicLink()) {
        const systemAlias = process.platform === 'darwin' && ((part === '/var' && realpathSync(part) === '/private/var') || (part === '/tmp' && realpathSync(part) === '/private/tmp'));
        if (!systemAlias) throw new Error(`symlink path refused: ${part}`);
      }
    }
    const parent = dirname(part); if (parent === part) break; part = parent;
  }
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(safePath(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
}
function git(root: string, argv: string[]): string {
  const r = spawnSync('git', argv, { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`git ${argv[0]} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}
function validateRelative(path: string): void {
  const text = path.endsWith('/') ? path.slice(0, -1) : path;
  if (!text || isAbsolute(text) || text.includes('\\') || text.includes('\0') || text.split('/').some(x => !x || x === '.' || x === '..') || /^[A-Za-z]:/.test(text)) throw new Error(`invalid relative path: ${path}`);
}
function matches(path: string, entry: string): boolean { return entry.endsWith('/') ? path.startsWith(entry) : path === entry; }
function scan(root: string, excluded: readonly string[]): FileIdentity[] {
  const files: FileIdentity[] = [], seen = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (dir === root && name === '.git') continue;
      const full = join(dir, name), path = relative(root, full).split(sep).join('/'); validateRelative(path);
      const lower = path.toLowerCase(); if (seen.has(lower)) throw new Error(`case-colliding path: ${path}`); seen.add(lower);
      const st = lstatSync(full);
      // Even excluded paths may not hide aliases or special files.
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error(`unsafe file: ${path}`);
      if (st.isDirectory()) walk(full);
      else if (!excluded.some(x => matches(path, x))) files.push({ path, sha256: hashBytes(readFileSync(full)), executable: (st.mode & 0o111) !== 0 });
    }
  };
  walk(root); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function snapshotCandidate(workspace: string, policy: RepositoryPolicy): CandidateIdentity {
  const root = safePath(workspace);
  for (const path of [...policy.allowedPaths, ...policy.protectedPaths, ...policy.excludedOutputs]) validateRelative(path);
  if (!/^[a-f0-9]{40,64}$/.test(policy.baseCommit)) throw new Error('invalid base commit');
  const files = scan(root, policy.excludedOutputs);
  const current = new Set(files.map(x => x.path));
  const base = git(root, ['ls-tree', '-rz', '--name-only', policy.baseCommit]).split('\0').filter(Boolean);
  const deleted = base.filter(x => !current.has(x) && !policy.excludedOutputs.some(y => matches(x, y))).sort();
  const value = { baseCommit: policy.baseCommit, files, deleted };
  return { ...value, digest: hashBytes(JSON.stringify(value)) };
}
export function createWorkspace(input: WorkspaceRequest): WorkspaceResult {
  let owned = false, destination = '';
  try {
    const source = safePath(input.source); destination = safePath(input.destination);
    if (source !== safePath(input.policy.sourceRoot)) throw new Error('source differs from frozen policy');
    if (containsPath(source, destination) || containsPath(destination, source) || existsSync(destination)) throw new Error('destination must be new and outside source');
    if (git(source, ['rev-parse', '--show-toplevel']).trim() !== source) throw new Error('source must be repository root');
    if (git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) throw new Error('dirty source refused');
    if (git(source, ['rev-parse', 'HEAD']).trim() !== input.policy.baseCommit) throw new Error('source HEAD differs from frozen base');
    const original = snapshotCandidate(source, input.policy); // Refuse unsafe files before creating anything.
    mkdirSync(destination); owned = true;
    git(destination, ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '--no-checkout', '--', source, '.']);
    git(destination, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', input.policy.baseCommit]);
    if (snapshotCandidate(destination, input.policy).digest !== original.digest) throw new Error('checkout differs from source snapshot');
    return { status: 'created', workspace: input.destination, diagnostics: [] };
  } catch (error) {
    if (owned) rmSync(destination, { recursive: true, force: true });
    return { status: 'refused', workspace: null, diagnostics: [String(error)] };
  }
}
