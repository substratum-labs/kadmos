export type { CodingBackend, CodingTask, CodingResult } from './contracts.js';
import type { BackendOptions } from './contracts.js';
import { CodexBackend } from './codex_backend.js';
/** Deterministic host-owned executable fixture, with the same argv/process contract. */
export class ScriptedBackend extends CodexBackend {
  constructor(options: BackendOptions) { super(options); }
}
