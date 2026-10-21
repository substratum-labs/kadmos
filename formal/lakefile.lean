import Lake
open Lake DSL

package "kadmos-formal" where
  version := v!"0.1.0"

require harmonia from git
  "https://github.com/substratum-labs/harmonia" @ "v0.1.0"

@[default_target]
lean_lib «KadmosFormal» where
  roots := #[`KadmosFormal, `KadmosFormal.Bridge.Syntax,
    `KadmosFormal.Bridge.Certificate, `KadmosFormal.Bridge.Fixtures]

lean_lib kadmosWorldTest where
  roots := #[`HarmoniaTests.KadmosWorldIR, `HarmoniaTests.KadmosWorldInterpreter, `HarmoniaTests.KadmosWorldBalance]

lean_lib kadmosWorldAudit where
  roots := #[`HarmoniaTests.AuditPolicy, `HarmoniaTests.KadmosWorldAxiomAudit]

lean_lib kadmosWorldAuditRejection where
  roots := #[`HarmoniaTests.KadmosWorldRejection.Unused,
    `HarmoniaTests.KadmosWorldRejection.Unsafe, `HarmoniaTests.KadmosWorldAuditRejection]

lean_lib kadmosBridgeSyntaxTest where
  roots := #[`HarmoniaTests.KadmosBridgeSyntax]

lean_lib kadmosBridgeCertificateTest where
  roots := #[`HarmoniaTests.KadmosBridgeCertificate]

lean_lib kadmosBridgeFixturesTest where
  roots := #[`HarmoniaTests.KadmosBridgeFixtures]

lean_lib kadmosBridgeAudit where
  roots := #[`HarmoniaTests.AuditPolicy, `HarmoniaTests.KadmosBridgeAxiomAudit]

lean_lib kadmosBridgeAuditRejection where
  roots := #[`HarmoniaTests.KadmosBridgeRejection.Unused,
    `HarmoniaTests.KadmosBridgeRejection.Unsafe, `HarmoniaTests.KadmosBridgeAuditRejection]
