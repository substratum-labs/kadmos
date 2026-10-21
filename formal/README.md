# Kadmos Formal Verification (`formal/`)

This directory contains the Lean 4 formal specification and verification models for **Kadmos**, built on top of [`substratum-labs/harmonia`](https://github.com/substratum-labs/harmonia) (`v0.1.0`):

- **`Harmonia.Applications.Kadmos.{World,Interpreter,System,Balance}`**: Formal semantics for the Kadmos World IR subset (guards, sequential effects, failure-frame preservation, and reachable safety invariants) embedded into `Harmonia.Foundation.TransitionSystem`.
- **`Harmonia.Applications.Kadmos.Bridge.{Syntax,Certificate,Fixtures}`**: Fail-closed bridge from actual Kadmos WorldSpec IR definitions (`conformance/kadmos-ir-bridge/`) into the Lean 4 reference interpreter.

## Building and Auditing

With [elan](https://github.com/leanprover/elan) installed:

```sh
cd formal
lake update
lake build
lake build kadmosWorldTest kadmosWorldAudit kadmosWorldAuditRejection
lake build kadmosBridgeSyntaxTest kadmosBridgeCertificateTest kadmosBridgeFixturesTest kadmosBridgeAudit kadmosBridgeAuditRejection
```
