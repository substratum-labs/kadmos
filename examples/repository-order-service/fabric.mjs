import { post, apply } from './http-client.mjs';
import { save } from './persistence.mjs';
// The verifier supplies the frozen checker and endpoint for these scoped fixtures.
export async function settle(checker, port, id, mode, queryMode) {
  const verdict = checker.step({ transitionId: 'INITIATE_PAYMENT', proposedDirective: 'DISPATCH_PAYMENT_GATEWAY' });
  if (!verdict.allowed) throw Error('GUARD_ORDER: ' + JSON.stringify(verdict));
  let result;
  try { result = await apply(port, id, mode); }
  catch {
    try { result = await post(port, 'query', id, queryMode); }
    catch { result = { outcome: 'unknown' }; }
  }
  if (result.outcome === 'not_committed') checker.rollbackLastStep();
  return save(result.outcome);
}
