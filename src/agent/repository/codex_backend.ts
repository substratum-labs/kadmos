import { backendSnapshotPolicy } from './context.js';
import { supervise, quotaPattern, type Observation } from './host_process.js';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { BackendOptions, BackendStatus, CodingBackend, CodingResult, CodingTask, ProcessEvidence, Usage } from './contracts.js';
import { containsPath, safePath, snapshotCandidate } from './workspace.js';

function executablePath(value: string): string {
  const choices = isAbsolute(value) ? [value] : value.includes('/') ? [resolve(value)] : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, value));
  const found = choices.find(path => { try { return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0; } catch { return false; } });
  if (!found) throw new Error(`executable unavailable: ${value}`);
  // Installed CLI launchers may themselves be symlinks. Record the actual target.
  return realpathSync(found);
}
function parseOutput(stdout: string): { malformed: boolean; usage: Usage; quota: boolean } {
  let completed = false, malformed = false, usage: Usage = 'unknown', quota = false;
  for (const line of stdout.split('\n').filter(x => x.trim())) {
    try {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') { malformed = true; continue; }
      quota ||= quotaPattern.test(line);
      if (event.type === 'turn.completed') {
        completed = true;
        const u = (event as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
        if (u && Number.isSafeInteger(u.input_tokens) && Number.isSafeInteger(u.output_tokens) && Number(u.input_tokens) >= 0 && Number(u.output_tokens) >= 0 && Number.isSafeInteger(Number(u.input_tokens) + Number(u.output_tokens))) usage = { tokens: Number(u.input_tokens) + Number(u.output_tokens), costUsd: 'unknown' };
      }
    } catch { malformed = true; }
  }
  return { malformed: malformed || !completed, usage, quota };
}
/** Literal argv shared by the adapter and portable transport qualification. */
export function codexArguments(prefixArgs: readonly string[], workspace: string): string[] {
  return [...prefixArgs, 'exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--cd', workspace, '-'];
}
export class CodexBackend implements CodingBackend {
  constructor(readonly options: BackendOptions) {}
  async run(task: CodingTask, signal: AbortSignal): Promise<CodingResult> {
    let evidence: ProcessEvidence = { executable: this.options.executable, version: 'unknown', argv: [], cwd: task.workspace, pid: null, processGroup: null, exitCode: null, signal: null, stdoutPath: '', stderrPath: '', startedAt: null, endedAt: null, treeStopped: 'unknown', usage: 'unknown' };
    const refused = (status: BackendStatus, diagnostic: string): CodingResult => ({ runId: task.runId, attemptId: task.attemptId, status, process: evidence, candidate: null, diagnostics: [diagnostic] });
    let attemptDir = '', executable = '', workspace = '';
    try {
      for (const key of ['maxAttempts', 'attemptMs', 'verifierMs', 'overallMs', 'killGraceMs'] as const) { const value = task.limits[key]; if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('limits must be finite positive safe timer integers'); }
      if (!Number.isSafeInteger(task.deadlineEpochMs)) throw new Error('invalid deadline');
      if (!/^[a-zA-Z0-9_-]+$/.test(task.attemptId)) throw new Error('invalid attempt ID');
      if (signal.aborted) return refused('cancelled', 'aborted before launch');
      if (Date.now() >= task.deadlineEpochMs) return refused('timeout', 'deadline expired before launch');
      if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('process tree termination unqualified on this platform; no process launched');
      workspace = safePath(task.workspace);
      const artifacts = safePath(task.artifactDir);
      if (containsPath(workspace, artifacts) || containsPath(artifacts, workspace)) throw new Error('artifacts must be outside candidate');
      // Validate all candidate entries before launching; no aliases/special files.
      snapshotCandidate(workspace, backendSnapshotPolicy(task));
      executable = executablePath(this.options.executable);
      attemptDir = join(artifacts, 'attempts', task.attemptId); safePath(attemptDir);
      mkdirSync(join(artifacts, 'attempts'), { recursive: true }); mkdirSync(attemptDir);
    } catch (error) { return refused(String(error).includes('executable unavailable:') ? 'launch_failed' : 'not_started', String(error)); }
    const startedAt = new Date().toISOString();
    const deadline = Math.min(task.deadlineEpochMs, Date.now() + task.limits.attemptMs);
    const stdoutPath = join(attemptDir, 'stdout.jsonl'), stderrPath = join(attemptDir, 'stderr.txt');
    const argv = codexArguments(this.options.prefixArgs, task.workspace);
    writeFileSync(join(attemptDir, 'stdin.txt'), task.instructions, { flag: 'wx', mode: 0o600 });
    // Probe the actual executable, not the scripted fixture prefix. Bounded and supervised too.
    const versionOut = join(attemptDir, 'version.stdout'), versionErr = join(attemptDir, 'version.stderr');
    const versionResult = await supervise(executable, ['--version'], workspace, '', versionOut, versionErr, signal, Math.min(deadline, Date.now() + 5_000), task.limits.killGraceMs, false);
    const version = versionResult.exitCode === 0 && versionResult.treeStopped === true ? readFileSync(versionOut, 'utf8').trim() || 'unknown' : 'unknown';
    let observed: Observation;
    if (signal.aborted || Date.now() >= deadline || versionResult.treeStopped !== true) {
      writeFileSync(stdoutPath, '', { flag: 'wx' }); writeFileSync(stderrPath, '', { flag: 'wx' });
      observed = { pid: null, exitCode: null, signal: null, reason: signal.aborted ? 'cancelled' : Date.now() >= deadline ? 'timeout' : 'launch_failed', treeStopped: versionResult.treeStopped, diagnostics: ['main process not launched after version probe', ...versionResult.diagnostics] };
    } else observed = await supervise(executable, argv, workspace, task.instructions, stdoutPath, stderrPath, signal, deadline, task.limits.killGraceMs, true);
    const output = parseOutput(readFileSync(stdoutPath, 'utf8'));
    const stderr = readFileSync(stderrPath, 'utf8');
    let status: BackendStatus = observed.reason ?? (output.quota || quotaPattern.test(stderr) ? 'quota' : output.malformed && observed.exitCode === 0 ? 'malformed' : 'exited');
    if (observed.treeStopped !== true && status === 'exited') status = 'launch_failed';
    evidence = { executable, version, argv, cwd: task.workspace, pid: observed.pid, processGroup: observed.pid, exitCode: observed.exitCode, signal: observed.signal, stdoutPath, stderrPath, startedAt, endedAt: new Date().toISOString(), treeStopped: observed.treeStopped, usage: output.usage };
    let candidate = null;
    const diagnostics = [...observed.diagnostics];
    if (status !== 'exited') diagnostics.push(`backend ${status}`);
    if (observed.exitCode !== null && observed.exitCode !== 0) diagnostics.push(`exit ${observed.exitCode}`);
    if (status === 'exited' && observed.exitCode === 0 && observed.treeStopped === true) {
      try { candidate = snapshotCandidate(workspace, backendSnapshotPolicy(task)); }
      catch (error) { status = 'malformed'; diagnostics.push(String(error)); }
    }
    const result: CodingResult = { runId: task.runId, attemptId: task.attemptId, status, process: evidence, candidate, diagnostics };
    const temporary = join(attemptDir, 'process.json.tmp');
    writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, join(attemptDir, 'process.json'));
    return result;
  }
}
