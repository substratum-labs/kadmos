"""Hostile inventory, source, policy, import, and output mutations for protocol audits."""

import shutil
import tempfile
import unittest
from pathlib import Path

import check_kadmos_protocols_audit as audit


class KadmosProtocolsAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        names = ["lakefile.lean", "HarmoniaTests/KadmosAuditPolicy.lean",
                 "HarmoniaTests/KadmosProtocolsAxiomAudit.lean", "HarmoniaTests/KadmosProtocolsAuditRejection.lean",
                 "HarmoniaTests/KadmosProtocolsRejection/Unused.lean", "HarmoniaTests/KadmosProtocolsRejection/Unsafe.lean"]
        for name in names:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(audit.ROOT / name, target)
        self.write("KadmosFormal/Protocols/ProtocolBridge.lean", "import KadmosFormal.Balance\n")
        self.write("KadmosFormal/Balance.lean", "import Init\n")
        self.write("HarmoniaTests/KadmosProtocolsTest.lean", "import KadmosFormal.Protocols.ProtocolBridge\n")

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def mutate(self, name, old, new):
        path = self.root / name
        source = path.read_text()
        self.assertIn(old, source)
        path.write_text(source.replace(old, new, 1))

    def test_baseline(self):
        audit.check_static(self.root)

    def test_unmanifested_protocol_module(self):
        self.write("KadmosFormal/Protocols/Nested/Hidden.lean", "import Init\n")
        with self.assertRaisesRegex(ValueError, "manifest mismatch"):
            audit.check_static(self.root)

    def test_unmanifested_nested_probe(self):
        self.write("HarmoniaTests/KadmosProtocols/Hidden.lean", "import Init\n")
        with self.assertRaisesRegex(ValueError, "manifest mismatch"):
            audit.check_static(self.root)

    def test_duplicate_manifest_entry(self):
        self.mutate("HarmoniaTests/KadmosAuditPolicy.lean", "`HarmoniaTests.KadmosProtocolsTest,",
                    "`HarmoniaTests.KadmosProtocolsTest, `HarmoniaTests.KadmosProtocolsTest,")
        with self.assertRaisesRegex(ValueError, "duplicate manifest entry"):
            audit.check_static(self.root)

    def test_malformed_manifest_entry(self):
        self.mutate("HarmoniaTests/KadmosAuditPolicy.lean", "`HarmoniaTests.KadmosProtocolsTest,",
                    "`HarmoniaTests.KadmosProtocolsTest, badToken,")
        with self.assertRaisesRegex(ValueError, "malformed manifest entry"):
            audit.check_static(self.root)

    def test_fixture_imported_by_certified_test(self):
        self.write("HarmoniaTests/KadmosProtocolsTest.lean",
                   "import KadmosFormal.Protocols.ProtocolBridge\nimport HarmoniaTests.KadmosProtocolsRejection\n")
        with self.assertRaisesRegex(ValueError, "counterexample fixture imported"):
            audit.check_static(self.root)

    def test_unknown_project_import(self):
        self.write("Harmonia/Unknown.lean", "import Init\n")
        self.write("HarmoniaTests/KadmosProtocolsTest.lean",
                   "import KadmosFormal.Protocols.ProtocolBridge\nimport Harmonia.Unknown\n")
        with self.assertRaisesRegex(ValueError, "unknown certified import"):
            audit.check_static(self.root)

    def test_unknown_test_import(self):
        self.write("HarmoniaTests/Unknown.lean", "import Init\n")
        self.write("HarmoniaTests/KadmosProtocolsTest.lean",
                   "import KadmosFormal.Protocols.ProtocolBridge HarmoniaTests.Unknown\n")
        with self.assertRaisesRegex(ValueError, "unknown certified import"):
            audit.check_static(self.root)

    def test_unknown_external_import(self):
        self.write("HarmoniaTests/KadmosProtocolsTest.lean",
                   "import KadmosFormal.Protocols.ProtocolBridge Lean\n")
        with self.assertRaisesRegex(ValueError, "unknown certified import"):
            audit.check_static(self.root)

    def test_transitive_unknown_import(self):
        self.write("Harmonia/Core/Hidden.lean", "import Harmonia.Unknown\n")
        self.write("HarmoniaTests/KadmosProtocolsTest.lean",
                   "import KadmosFormal.Protocols.ProtocolBridge Harmonia.Core.Hidden\n")
        with self.assertRaisesRegex(ValueError, "unknown certified import"):
            audit.check_static(self.root)

    def test_forbidden_tokens(self):
        path = self.root / "KadmosFormal/Protocols/ProtocolBridge.lean"
        baseline = path.read_text()
        for token in ("sorry", "admit", "sorryAx", "axiom", "native_decide", "unsafe", "Classical.choice"):
            with self.subTest(token=token):
                path.write_text(baseline + "\n" + token + "\n")
                with self.assertRaisesRegex(ValueError, "forbidden certified source token"):
                    audit.check_static(self.root)
        path.write_text(baseline + '\n/- sorry /- axiom -/ Classical.choice -/\n-- unsafe\n')
        audit.check_static(self.root)

    def test_duplicate_target(self):
        path = self.root / "lakefile.lean"
        path.write_text(path.read_text() + "\nlean_lib kadmosProtocolsTest where\n  roots := #[`HarmoniaTests.KadmosProtocolsTest]\n")
        with self.assertRaisesRegex(ValueError, "duplicate Lake target"):
            audit.check_static(self.root)

    def test_rejection_in_certified_roots(self):
        self.mutate("lakefile.lean", "roots := #[`HarmoniaTests.KadmosProtocolsTest]",
                    "roots := #[`HarmoniaTests.KadmosProtocolsTest, `HarmoniaTests.KadmosProtocolsRejection]")
        with self.assertRaisesRegex(ValueError, "incorrect roots"):
            audit.check_static(self.root)

    def test_uncovered_manifest_module(self):
        self.write("HarmoniaTests/KadmosProtocols/Extra.lean", "import Init\n")
        self.mutate("HarmoniaTests/KadmosAuditPolicy.lean", "`HarmoniaTests.KadmosProtocolsTest,",
                    "`HarmoniaTests.KadmosProtocolsTest, `HarmoniaTests.KadmosProtocols.Extra,")
        with self.assertRaisesRegex(ValueError, "uncovered certified"):
            audit.check_static(self.root)

    def test_missing_audit_invocation(self):
        self.mutate("HarmoniaTests/KadmosProtocolsAxiomAudit.lean", "#audit_kadmos_protocols", "-- removed")
        with self.assertRaisesRegex(ValueError, "missing kadmos protocols audit invocation"):
            audit.check_static(self.root)

    def test_weakened_policy(self):
        self.mutate("HarmoniaTests/KadmosAuditPolicy.lean", '"KADMOS PROTOCOLS AUDIT PASS" false',
                    '"KADMOS PROTOCOLS AUDIT PASS" true')
        with self.assertRaisesRegex(ValueError, "modified kadmos protocols audit command"):
            audit.check_static(self.root)

    def test_weakened_selector(self):
        self.mutate("HarmoniaTests/KadmosAuditPolicy.lean",
                    "kadmosProtocolsSourceModules.contains (sourceModule env n)", "false")
        with self.assertRaisesRegex(ValueError, "modified kadmos protocols declaration selector"):
            audit.check_static(self.root)

    def test_missing_product(self):
        (self.root / "KadmosFormal/Protocols/ProtocolBridge.lean").unlink()
        with self.assertRaisesRegex(ValueError, "missing certified"):
            audit.check_static(self.root)

    def test_missing_rejection_fixture(self):
        (self.root / "HarmoniaTests/KadmosProtocolsRejection/Unused.lean").unlink()
        with self.assertRaisesRegex(ValueError, "rejection disk mismatch"):
            audit.check_static(self.root)

    def test_unregistered_rejection_fixture(self):
        self.write("HarmoniaTests/KadmosProtocolsRejection/Hidden.lean", "axiom hidden : Nat\n")
        with self.assertRaisesRegex(ValueError, "rejection disk mismatch"):
            audit.check_static(self.root)

    def test_rejection_driver_imported(self):
        self.write("HarmoniaTests/KadmosProtocolsTest.lean",
                   "import KadmosFormal.Protocols.ProtocolBridge HarmoniaTests.KadmosProtocolsAuditRejection\n")
        with self.assertRaisesRegex(ValueError, "counterexample fixture imported"):
            audit.check_static(self.root)

    def test_manifest_suffix(self):
        self.mutate("HarmoniaTests/KadmosAuditPolicy.lean",
                    "`HarmoniaTests.KadmosProtocolsAxiomAudit]",
                    "`HarmoniaTests.KadmosProtocolsAxiomAudit] ++ #[`Hidden]")
        with self.assertRaisesRegex(ValueError, "nonliteral"):
            audit.check_static(self.root)

    def test_output_whitelist(self):
        valid = ("KADMOS PROTOCOLS AUDIT PASS: 3 theorems; 4 declarations; "
                 "observed axioms [propext, Quot.sound]; whitelist [propext, Quot.sound]")
        self.assertEqual(audit.audit_summary(valid), valid)
        for hostile in (valid.replace("[propext, Quot.sound];", "[Classical.choice];"),
                        "warning: unexpected\n" + valid, valid + "\nerror: unexpected",
                        valid.replace("whitelist [propext, Quot.sound]", "whitelist []")):
            with self.subTest(output=hostile), self.assertRaises(ValueError):
                audit.audit_summary(hostile)


if __name__ == "__main__":
    unittest.main()
