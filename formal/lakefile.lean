import Lake
open Lake DSL

package "kadmos-formal" where
  version := v!"0.2.0"

require harmonia from git
  "https://github.com/substratum-labs/harmonia" @ "v0.3.0"

@[default_target]
lean_lib «KadmosFormal» where
  roots := #[`KadmosFormal, `KadmosFormal.Bridge.Syntax,
    `KadmosFormal.Bridge.Certificate, `KadmosFormal.Bridge.Fixtures,
    `KadmosFormal.Protocols.ProtocolBridge]

lean_lib kadmosWorldTest where
  roots := #[`HarmoniaTests.KadmosWorldIR, `HarmoniaTests.KadmosWorldInterpreter, `HarmoniaTests.KadmosWorldBalance]

lean_lib kadmosWorldAudit where
  roots := #[`HarmoniaTests.KadmosAuditPolicy, `HarmoniaTests.KadmosWorldAxiomAudit]

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
  roots := #[`HarmoniaTests.KadmosAuditPolicy, `HarmoniaTests.KadmosBridgeAxiomAudit]

lean_lib kadmosBridgeAuditRejection where
  roots := #[`HarmoniaTests.KadmosBridgeRejection.Unused,
    `HarmoniaTests.KadmosBridgeRejection.Unsafe, `HarmoniaTests.KadmosBridgeAuditRejection]

lean_lib kadmosProtocolsTest where
  roots := #[`HarmoniaTests.KadmosProtocolsTest]

lean_lib kadmosProtocolsAudit where
  roots := #[`HarmoniaTests.KadmosAuditPolicy, `HarmoniaTests.KadmosProtocolsAxiomAudit]

lean_lib kadmosProtocolsAuditRejection where
  roots := #[`HarmoniaTests.KadmosProtocolsRejection.Unused,
    `HarmoniaTests.KadmosProtocolsRejection.Unsafe, `HarmoniaTests.KadmosProtocolsAuditRejection]
