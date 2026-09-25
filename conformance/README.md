# Conformance Fixtures

This directory is the language-neutral conformance boundary between the TypeScript implementation and any later Rust verifier.

Fixtures record valid inputs, invalid inputs, canonical encodings, admission
transitions, and expected decisions.

## Canonical Order Settlement Fixture

`fixtures/order_settlement.world.yaml` provides the canonical World IR
specification for order settlement with conservation of value across all lifecycle states.

The World model specifies:
- 5 States: `CREATED` (initial), `PAYMENT_PENDING`, `PAID`, `FULFILLED` (terminal), `CANCELLED` (terminal).
- 4 Context Variables: `order_amount`, `escrow_balance`, `refunded_amount`, `settled_amount`.
- Invariants:
  - `INV-01-CONSERVATION-OF-VALUE`: `escrow_balance + refunded_amount + settled_amount <= order_amount`
  - `INV-02-NO-NEGATIVE-BALANCES`: `escrow_balance >= 0 && refunded_amount >= 0 && settled_amount >= 0`
  - `INV-03-FULFILLED-SETTLEMENT`: `state == 'FULFILLED' => (settled_amount == order_amount && escrow_balance == 0)`
- Transitions:
  - `INITIATE_PAYMENT`: `CREATED` -> `PAYMENT_PENDING` (directive: `DISPATCH_PAYMENT_GATEWAY`)
  - `CONFIRM_PAYMENT`: `PAYMENT_PENDING` -> `PAID` (guard: `event.captured_amount == order_amount`, effect: `escrow_balance = order_amount`)
  - `DISPATCH_GOODS`: `PAID` -> `FULFILLED` (guard: `escrow_balance == order_amount`, directive: `INVOKE_LOGISTICS_DISPATCH`, effects: `settled_amount = escrow_balance`, `escrow_balance = 0`)
  - `CANCEL_AND_REFUND`: `PAID` -> `CANCELLED` (guard: `escrow_balance == order_amount`, directive: `DISPATCH_REFUND`, effects: `refunded_amount = escrow_balance`, `escrow_balance = 0`)
  - `ABORT_UNPAID`: `CREATED` -> `CANCELLED` (guard: `true`)

All invariants are evaluated uniformly on post-states. In terminal states (`FULFILLED`, `CANCELLED`), all conservation and settlement invariants hold true without requiring ad-hoc bypasses or magic variables.

Run `pnpm run verify` (`pnpm run test && pnpm run typecheck`) to verify conformance.
