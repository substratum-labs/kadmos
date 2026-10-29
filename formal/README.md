# Kadmos Formal Verification (`formal/`)

This directory contains the Lean 4 formal specification and verification models for **Kadmos**, built on top of [`substratum-labs/harmonia`](https://github.com/substratum-labs/harmonia) (`v0.3.0`):

- **`Harmonia.Applications.Kadmos.{World,Interpreter,System,Balance}`**: Formal semantics for the Kadmos World IR subset (guards, sequential effects, failure-frame preservation, and reachable safety invariants) embedded into `Harmonia.Foundation.TransitionSystem`.
- **`Harmonia.Applications.Kadmos.Bridge.{Syntax,Certificate,Fixtures}`**: Fail-closed bridge from actual Kadmos WorldSpec IR definitions (`conformance/kadmos-ir-bridge/`) into the Lean 4 reference interpreter.

- **`Harmonia.Applications.Kadmos.Protocols`**: Choice-free bridges from accepted World transitions to quorum leases, two-phase commit, and Byzantine quorum certificates, with concrete balance execution and refusal witnesses.

## Building and Auditing

With [elan](https://github.com/leanprover/elan) installed:

```sh
cd formal
lake update
lake build
lake build kadmosWorldTest kadmosWorldAudit kadmosWorldAuditRejection
lake build kadmosBridgeSyntaxTest kadmosBridgeCertificateTest kadmosBridgeFixturesTest kadmosBridgeAudit kadmosBridgeAuditRejection
lake build kadmosProtocolsTest kadmosProtocolsAudit kadmosProtocolsAuditRejection
```

Run Lake commands serially. The protocol audit permits only `propext` and
`Quot.sound`, including dependencies of definitions and equality instances.

The self-contained source inventories and bridge provenance checks also provide
hostile mutation tests:

```sh
python3 scripts/check_kadmos_bridge_artifacts.py
python3 scripts/check_kadmos_bridge_artifacts.py --self-test
python3 scripts/check_kadmos_world_audit.py
python3 scripts/check_kadmos_world_audit.py --self-test
python3 scripts/check_kadmos_bridge_audit.py
python3 scripts/check_kadmos_bridge_audit.py --self-test
python3 scripts/check_kadmos_protocols_audit.py
python3 scripts/check_kadmos_protocols_audit.py --self-test
```
