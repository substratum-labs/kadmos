import type { IWorldChecker, WorldContext } from "./types/ports.js";
import type { WorldSpec } from "./types/world.js";

/** T-333 RED stub. T-334 implements the runtime gatekeeper. */
export function createWorldChecker(
  _spec: WorldSpec,
  _initialContext: Partial<WorldContext>,
): IWorldChecker {
  throw new Error("World checker not implemented");
}
