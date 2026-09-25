import type { WorldSpec } from "./types/world.js";

export interface WorldProjection {
  readonly portsDts: string;
  readonly worldCheckerTs: string;
}

/** T-333 RED stub. T-334 implements parsing and fail-closed validation. */
export function parseWorldSpec(_source: string): WorldSpec {
  throw new Error("World parser not implemented");
}

/** T-333 RED stub. T-334 implements deterministic code projection. */
export function compileWorldSpec(_spec: WorldSpec): WorldProjection {
  throw new Error("World compiler not implemented");
}
