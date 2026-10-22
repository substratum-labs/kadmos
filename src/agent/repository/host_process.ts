import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackendStatus } from './contracts.js';

export const quotaPattern = /usage_limit_reached|quota_exceeded|insufficient_quota|usage limit|quota (?:exceeded|exhausted)/i;
interface Member { pid: number; ppid: number; group: number; state: string }
function processes(): Member[] | null {
  let ps;
  try { ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 1_000 }); } catch { return null; }
  if (ps.error || ps.status !== 0) return null;
  const lines = ps.stdout.trim().split('\n');
  const members: Member[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || fields.slice(0, 3).some(value => !/^\d+$/.test(value))) return null;
    const pid = Number(fields[0]), ppid = Number(fields[1]), group = Number(fields[2]);
    if (![pid, ppid, group].every(Number.isSafeInteger) || pid <= 0 || group < 0) return null;
    // Linux kernel/sessionless rows may have PGID0. Keep them in inventory;
    // only the positive child group or rooted lineage can select cleanup PIDs.
    members.push({ pid, ppid, group, state: fields[3] ?? '' });
  }
  return members;
}
function signalPid(pid: number, signal: NodeJS.Signals): void { try { process.kill(pid, signal); } catch { /* absence is checked using a fresh process inventory */ } }
export interface Observation { pid: number | null; exitCode: number | null; signal: string | null; reason: BackendStatus | null; treeStopped: boolean | 'unknown'; diagnostics: string[] }
/** Sampled trusted-local lineage qualification; unresolved group departures fail closed. */
export async function supervise(executable: string, argv: readonly string[], cwd: string, input: string, stdoutPath: string, stderrPath: string, signal: AbortSignal, deadline: number, graceMs: number, inspectQuota: boolean): Promise<Observation> {
  const out = openSync(stdoutPath, 'wx', 0o600);
  let err: number;
  try { err = openSync(stderrPath, 'wx', 0o600); } catch (error) { closeSync(out); throw error; }
  const result: Observation = { pid: null, exitCode: null, signal: null, reason: null, treeStopped: 'unknown', diagnostics: [] };
  let exited = false, escaped = false, inventoryFailed = false, lineageLost = false, cleaning = false;
  const departed = new Map<number, Member>();
  const naturallyClosed = new Set<number>();
  const observations: { at: string; phase: string; members: Member[] | null }[] = [];
  let observationCount = 0, observationMemberCount = 0;
  const observationPhases: Record<string, number> = {};
  let phase = 'running';
  const record = (members: Member[] | null): void => {
    observationCount++;
    observationMemberCount += members?.length ?? 0;
    observationPhases[phase] = (observationPhases[phase] ?? 0) + 1;
    // Retain the latest 64 samples; lineage summaries remain independent of retention.
    if (observations.length === 64) observations.shift();
    observations.push({ at: new Date().toISOString(), phase, members });
  };
  const tracked = new Set<number>();
  const history = new Map<number, Member>();
  let child: ReturnType<typeof spawn>;
  try { child = spawn(executable, [...argv], { cwd, shell: false, detached: true, stdio: ['pipe', out, err] }); }
  catch (error) { closeSync(out); closeSync(err); return { ...result, reason: 'launch_failed', diagnostics: [String(error)] }; }
  result.pid = child.pid ?? null;
  if (child.pid) tracked.add(child.pid);
  const done = new Promise<void>(resolveDone => {
    child.once('error', error => { result.reason = 'launch_failed'; result.diagnostics.push(String(error)); exited = true; resolveDone(); });
    child.once('exit', (code, sig) => { result.exitCode = code; result.signal = sig; exited = true; resolveDone(); });
  });
  child.stdin?.on('error', error => result.diagnostics.push(`stdin: ${error.message}`));
  const inventory = (): Member[] => {
    const all = processes();
    if (!all) { inventoryFailed = true; record(null); return []; }
    let added = true;
    while (added) {
      added = false;
      for (const p of all) if ((p.group === result.pid || tracked.has(p.ppid)) && !tracked.has(p.pid)) { tracked.add(p.pid); added = true; }
    }
    const members = all.filter(p => tracked.has(p.pid) || p.group === result.pid);
    for (const p of members) history.set(p.pid, p);
    record(members);
    const current = new Map(members.map(p => [p.pid, p]));
    const rooted = (pid: number): boolean => {
      const visited = new Set<number>();
      while (pid !== result.pid) {
        if (visited.has(pid)) return false;
        visited.add(pid);
        const parent = current.get(pid);
        if (!parent) return false;
        pid = parent.ppid;
      }
      return current.has(pid);
    };
    for (const p of members) if (p.group !== result.pid) {
      escaped = true;
      if (naturallyClosed.has(p.pid) || !rooted(p.pid)) lineageLost = true;
      departed.set(p.pid, p);
    }
    const closedBranch = (pid: number, visited = new Set<number>()): boolean => {
      if (current.has(pid)) return rooted(pid);
      if (visited.has(pid)) return false;
      visited.add(pid);
      const last = departed.get(pid);
      // Every missing link must itself be an observed departure. This allows a
      // naturally exiting nested tool subtree to disappear in the same sample.
      return last !== undefined && closedBranch(last.ppid, visited);
    };
    for (const [pid] of departed) if (!current.has(pid) && !naturallyClosed.has(pid)) {
      // Only pre-signal observed absence anchored to a still-live rooted ancestor
      // qualifies. Reparenting is sticky even if the process later disappears.
      if (!cleaning && closedBranch(pid)) naturallyClosed.add(pid);
      else lineageLost = true;
    }
    return members;
  };
  try {
    closeSync(out); closeSync(err);
    child.stdin?.end(input);
    // Poll in the supervisor, never by model turns. Check even on normal exit.
    while (!exited) {
      inventory();
      if (signal.aborted) result.reason = 'cancelled';
      else if (Date.now() >= deadline) result.reason = 'timeout';
      else if (inspectQuota && quotaPattern.test(readFileSync(stderrPath, 'utf8') + readFileSync(stdoutPath, 'utf8'))) result.reason = 'quota';
      else if (statSync(stdoutPath).size + statSync(stderrPath).size > 8 * 1024 * 1024) result.reason = 'malformed';
      if (result.reason) break;
      await Promise.race([done, delay(25)]);
    }
  } catch (error) {
    inventoryFailed = true;
    result.reason = 'launch_failed';
    result.diagnostics.push(`supervision: ${String(error)}`);
  } finally {
    try {
      if (result.pid) {
        phase = 'qualification';
        const members = inventory();
        const unresolvedDeparture = [...departed.keys()].some(pid => !naturallyClosed.has(pid));
        if (unresolvedDeparture) lineageLost = true;
        cleaning = true;
        phase = 'cleanup';
        // Stop children first, giving a live parent the chance to reap them.
        const known = new Set([...tracked, ...departed.keys(), ...members.map(p => p.pid)]);
        for (const pid of known) if (pid !== result.pid) signalPid(pid, 'SIGTERM');
        if ([...known].some(pid => pid !== result.pid)) await delay(Math.min(50, graceMs));
        signalPid(-result.pid, 'SIGTERM');
        const until = Date.now() + graceMs;
        while (Date.now() < until && inventory().length) await delay(20);
        for (const p of inventory()) known.add(p.pid);
        for (const pid of new Set([...known, ...tracked, ...departed.keys()])) signalPid(pid, 'SIGKILL');
        signalPid(-result.pid, 'SIGKILL');
        // Always reap our direct child; SIGKILL makes an ordinary POSIX child finite.
        await done;
        const reapUntil = Date.now() + 500;
        while (Date.now() < reapUntil && inventory().length) await delay(20);
        const remaining = inventory();
        writeFileSync(stdoutPath + '.lifecycle.json', JSON.stringify({ tracked: [...history.values()], observations, observationLimit: 64, observationCount, observationMemberCount, observationPhases, observationsDropped: observationCount - observations.length, observationsTruncated: observationCount > observations.length, observationsSpilled: 0, retainedMemberCount: observations.reduce((n, o) => n + (o.members?.length ?? 0), 0), remaining, escaped, naturallyClosed: [...naturallyClosed], lineageLost, inventoryFailed, qualification: 'Sampled trusted-local lineage only; natural PGID departures require observed absent branches with live rooted ancestor before cleanup; true qualifies only the observed closed chain; rapid unobserved escapes are outside this sampling guarantee' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        result.treeStopped = !lineageLost && !inventoryFailed && remaining.length === 0 ? true : 'unknown';
        if (lineageLost) result.diagnostics.push('unresolved or reparented process-group departure; tree qualification unknown');
        if (inventoryFailed || remaining.length) result.diagnostics.push('process inventory/stop could not be qualified');
      } else await done;
    } catch (error) {
      result.treeStopped = 'unknown';
      result.reason = 'launch_failed';
      result.diagnostics.push(`cleanup/telemetry: ${String(error)}`);
      // An I/O or cleanup exception must never strand a known process.
      for (const pid of new Set([...tracked, ...departed.keys()])) signalPid(pid, 'SIGKILL');
      if (result.pid) signalPid(-result.pid, 'SIGKILL');
      await done;
      throw error; // Preserve the backend API while guaranteeing emergency cleanup first.
    }
  }
  if (result.reason) result.diagnostics.push(`process ${result.reason}`);
  return result;
}
