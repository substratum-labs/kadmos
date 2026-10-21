import type { BackendOptions, CodingBackend, CodingResult, CodingTask } from './contracts.js';
/** Task B stub: does not launch a process. Task C must implement the frozen contract. */
export class CodexBackend implements CodingBackend {
  constructor(readonly options: BackendOptions) {}
  async run(task: CodingTask, _signal: AbortSignal): Promise<CodingResult> {
    return { runId: task.runId, attemptId: task.attemptId, status: 'not_started', candidate: null,
      diagnostics: ['NOT_IMPLEMENTED: physical backend'],
      process: { executable: this.options.executable, version: 'unknown', argv: [], cwd: task.workspace,
        pid: null, processGroup: null, exitCode: null, signal: null, stdoutPath: '', stderrPath: '',
        startedAt: null, endedAt: null, treeStopped: 'unknown', usage: 'unknown' } };
  }
}
