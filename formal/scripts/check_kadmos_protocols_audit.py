#!/usr/bin/env python3
"""Audit the certified protocol inventory, import boundary, and kernel dependencies."""

import argparse
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
from check_kadmos_world_audit import module_name, parse_imports, scrub, name_array as parse_names, literal_end

def name_array(body, label):
    try: return parse_names(body)
    except ValueError as exc: raise ValueError(f"{exc}: {label}") from exc

ROOT = Path(__file__).resolve().parents[1]
CERTIFIED = {"KadmosFormal.Protocols.ProtocolBridge", "HarmoniaTests.KadmosProtocolsTest", "HarmoniaTests.KadmosProtocolsAxiomAudit"}
REJECTION_DIR = "HarmoniaTests.KadmosProtocolsRejection"
REJECTION_ROOT = "HarmoniaTests.KadmosProtocolsAuditRejection"
REJECTION = REJECTION_DIR
POLICY = "HarmoniaTests.KadmosAuditPolicy"
ROOTS = {
    "kadmosProtocolsTest": {"HarmoniaTests.KadmosProtocolsTest"},
    "kadmosProtocolsAudit": {POLICY, "HarmoniaTests.KadmosProtocolsAxiomAudit"},
    "kadmosProtocolsAuditRejection": {REJECTION_DIR + ".Unused", REJECTION_DIR + ".Unsafe", REJECTION_ROOT},
}
FORBIDDEN = re.compile(r"\b(sorry|admit|sorryAx|axiom|native_decide|unsafe|Classical\.choice)\b")


def certified_closure(root: Path, initial: str, inventory: set[str]) -> set[str]:
    """Walk source imports, checking external names too; AuditPolicy is trusted tooling."""
    seen, work = set(), [initial]
    while work:
        module = work.pop()
        if module in seen:
            continue
        if module == REJECTION_ROOT or module == REJECTION_DIR or module.startswith(REJECTION_DIR + "."):
            raise ValueError("counterexample fixture imported by certified target")
        allowed = (module in inventory | {POLICY, "Init", "KadmosFormal", "KadmosFormal.World", "KadmosFormal.Interpreter", "KadmosFormal.System", "KadmosFormal.Balance", "Harmonia.VerifiedProtocols", "Harmonia.VerifiedProtocols.QuorumLease", "Harmonia.VerifiedProtocols.TwoPhaseCommit", "Harmonia.VerifiedProtocols.BFTQuorumCommit", "Harmonia.Distributed",
                                          "Harmonia.Theorems.Quorum"} or
                   module.startswith(("Init.", "Harmonia.Core.", "Harmonia.Distributed.")))
        if not allowed:
            raise ValueError(f"unknown certified import: {module}")
        seen.add(module)
        if module == "Init" or module.startswith("Init."):
            continue
        path = root / (module.replace(".", "/") + ".lean")
        if not path.is_file() and module.startswith("Harmonia."):
            path = root / ".lake/packages/harmonia" / (module.replace(".", "/") + ".lean")
        if not path.is_file():
            raise ValueError(f"missing project import {module}")
        # AuditPolicy imports Lean metaprogramming infrastructure, not protocol semantics.
        if module != POLICY:
            work.extend(parse_imports(path.read_text()))
    return seen


def check_static(root: Path) -> None:
    root = root.resolve()
    lakefile = scrub((root / "lakefile.lean").read_text())
    for target, expected in ROOTS.items():
        blocks = re.findall(rf"(?ms)^lean_lib {target} where\s*\n(.*?)(?=^@|^lean_lib |^lean_exe |\Z)", lakefile)
        if len(blocks) != 1:
            raise ValueError(f"missing or duplicate Lake target: {target}")
        match = re.fullmatch(r"\s*roots\s*:=\s*#\[(.*?)\]\s*", blocks[0], re.S)
        if not match:
            raise ValueError(f"malformed Lake target: {target}")
        actual = name_array(match.group(1), f"{target} roots")
        if actual != expected:
            raise ValueError(f"incorrect roots for {target}: {sorted(actual)}")

    product = set((root / "KadmosFormal/Protocols").rglob("*.lean"))
    probes = {path for path in (root / "HarmoniaTests").rglob("*.lean")
              if path.relative_to(root / "HarmoniaTests").parts[0].startswith("KadmosProtocols")}
    inventory = {module_name(root, path) for path in product | probes}
    inventory = {n for n in inventory if n != REJECTION_ROOT and not n.startswith(REJECTION_DIR + ".")}
    traps = {module_name(root, p) for p in (root / "HarmoniaTests/KadmosProtocolsRejection").rglob("*.lean")}
    if traps != ROOTS["kadmosProtocolsAuditRejection"] - {REJECTION_ROOT}:
        raise ValueError("rejection disk mismatch")
    if not CERTIFIED <= inventory:
        raise ValueError(f"missing certified kadmos protocols modules: {sorted(CERTIFIED - inventory)}")
    for module in inventory:
        source = (root / (module.replace(".", "/") + ".lean")).read_text()
        token = FORBIDDEN.search(scrub(source))
        if token:
            raise ValueError(f"forbidden certified source token {token.group(1)} in {module}")

    policy_source = (root / "HarmoniaTests/KadmosAuditPolicy.lean").read_text()
    policy = scrub(policy_source)
    matches = re.findall(r"\bdef\s+kadmosProtocolsSourceModules\s*:\s*Array\s+Name\s*:=\s*#\[(.*?)\]", policy, re.S)
    if len(matches) != 1:
        raise ValueError("missing or duplicate kadmos protocols axiom audit source manifest")
    match = re.search(r"\bdef\s+kadmosProtocolsSourceModules\s*:\s*Array\s+Name\s*:=\s*#\[(.*?)\]", policy, re.S)
    literal_end(policy, match.end(), "protocols manifest")
    manifest = name_array(matches[0], "kadmos protocols manifest")
    if manifest != inventory:
        raise ValueError(f"kadmos protocols manifest mismatch: missing={sorted(inventory - manifest)}, extra={sorted(manifest - inventory)}")
    selector = re.findall(r"\bdef\s+kadmosProtocolsDeclaration\s*\(env\s*:\s*Environment\)\s*\(n\s*:\s*Name\)\s*:\s*Bool\s*:=\s*(.*?)(?=\n\s*def auditSelected)", policy, re.S)
    if len(selector) != 1 or " ".join(selector[0].split()) != "kadmosProtocolsSourceModules.contains (sourceModule env n)":
        raise ValueError("modified kadmos protocols declaration selector")
    # Strings matter here: the live gate requires this exact summary and choice ban.
    command = re.findall(r'elab "#audit_kadmos_protocols"\s*:\s*command\s*=>\s*do\s*(.*?)(?=\Z)', policy_source, re.S)
    expected = ('let env ← getEnv HarmoniaAudit.auditSelected '
                '(HarmoniaAudit.kadmosProtocolsDeclaration env) "kadmos protocols" '
                'true "KADMOS PROTOCOLS AUDIT PASS" false')
    if len(command) != 1 or " ".join(command[0].split()) != expected:
        raise ValueError("modified kadmos protocols audit command")

    closure = certified_closure(root, "HarmoniaTests.KadmosProtocolsAxiomAudit", inventory)
    certified_closure(root, "HarmoniaTests.KadmosProtocolsTest", inventory)
    if not inventory <= closure:
        raise ValueError(f"uncovered certified kadmos protocols modules: {sorted(inventory - closure)}")
    audit_source = scrub((root / "HarmoniaTests/KadmosProtocolsAxiomAudit.lean").read_text())
    if not re.search(r"(?m)^#audit_kadmos_protocols\s*$", audit_source):
        raise ValueError("missing kadmos protocols audit invocation")
    if not (root / (REJECTION_ROOT.replace(".", "/") + ".lean")).is_file():
        raise ValueError("missing kadmos protocols rejection fixture")


def audit_summary(output: str) -> str:
    match = re.search(r"KADMOS PROTOCOLS AUDIT PASS:.*?observed axioms \[(.*?)\]; whitelist \[propext, Quot.sound\]", output, re.S)
    if not match or "sorryAx" in output or re.search(r"\b(?:warning|error):", output):
        raise ValueError(f"missing or tainted kadmos protocols audit summary:\n{output}")
    observed = {part.strip() for part in match.group(1).split(",") if part.strip()}
    if not observed <= {"propext", "Quot.sound"}:
        raise ValueError(f"unexpected kadmos protocols axiom dependencies: {sorted(observed)}")
    return match.group().replace("\n", " ")


def check() -> str:
    check_static(ROOT)
    result = subprocess.run(["lake", "build", *ROOTS], cwd=ROOT, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    output = result.stdout
    if result.returncode or re.search(r"\b(?:warning|error):", output):
        raise ValueError(f"Lake build failed or emitted diagnostics:\n{output}")
    if "KADMOS PROTOCOLS AUDIT PASS:" not in output:
        result = subprocess.run(["lake", "env", "lean", "--setup", ".lake/build/ir/HarmoniaTests/KadmosProtocolsAxiomAudit.setup.json", "HarmoniaTests/KadmosProtocolsAxiomAudit.lean"],
                                cwd=ROOT, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, check=False)
        output = result.stdout
        if result.returncode:
            raise ValueError(f"kadmos protocols axiom audit failed:\n{output}")
    return f"KADMOS PROTOCOLS CHECK PASS: {audit_summary(output)}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        import test_kadmos_protocols_audit
        suite = unittest.defaultTestLoader.loadTestsFromModule(test_kadmos_protocols_audit)
        ok = unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
        raise SystemExit(0 if ok else 1)
    try:
        print(check())
    except (OSError, ValueError) as exc:
        print(f"KADMOS PROTOCOLS CHECK REJECTED: {exc}", file=sys.stderr)
        raise SystemExit(1)
