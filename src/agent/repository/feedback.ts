import type { FailureRoute, VerificationReceipt } from './contracts.js';
/** Only ordinary, independently observed code failures can request an automatic repair. */
export function classifyFailure(receipt: VerificationReceipt): FailureRoute {
 if(receipt.status==='protected_change' || receipt.status==='drift')return 'NEEDS_REVIEW';
 if(receipt.status==='incomplete' || receipt.failureKind==='environment')return 'ENVIRONMENT_BLOCKED';
 if(receipt.status!=='failed' || receipt.checks.some(c=>c.process.treeStopped!==true || ['timeout','cancelled','launch_failed'].includes(c.status)))return 'NEEDS_REVIEW';
 switch(receipt.failureKind) {
  case 'compile': case 'functional': case 'guard': return 'CODE_REPAIR';
  case 'requirement':return 'WORLD_CHANGE_REQUIRED';
  case 'core':return 'CORE_MISMATCH';
  default:return 'NEEDS_REVIEW';
 }
}
