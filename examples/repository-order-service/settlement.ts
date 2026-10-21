import type { IWorldChecker } from '../../src/types/ports.js';
import type { EffectRecord } from '../../src/agent/repository/contracts.js';
export interface SettlementInput {
 readonly operationId: string; readonly checker: IWorldChecker;
 readonly actuator: { readonly executable: string; readonly argv: readonly string[] };
 readonly query: { readonly executable: string; readonly argv: readonly string[] };
 readonly recordPath: string; readonly signal: AbortSignal;
}
/** Task B fixture seam only. Task F implements serialization/reconstruction/reconciliation. */
export async function settleOperation(input: SettlementInput): Promise<EffectRecord> {
 return {operationId:input.operationId,outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:false,trace:[]};
}
