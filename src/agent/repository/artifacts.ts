import type { DeliveryValidationInput, DeliveryValidation } from './contracts.js';
/** Task B seam. Task D implements final exact-input/readback eligibility. */
export function validateDelivery(_input: DeliveryValidationInput): DeliveryValidation { return {status:'pending',manifest:null,diagnostics:['NOT_IMPLEMENTED: delivery validation']}; }
