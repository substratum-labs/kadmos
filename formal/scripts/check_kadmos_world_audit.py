#!/usr/bin/env python3
"""Exact application inventory and directional certified-root isolation."""
import argparse
import re
import subprocess
import sys
import unittest
from pathlib import Path
sys.dont_write_bytecode = True
import functools
CERTIFIED_TARGETS = ('kadmosWorldTest', 'kadmosWorldAudit')
REJECTION_TARGETS = ('kadmosWorldAuditRejection',)
MANDATORY = {'KadmosFormal', 'KadmosFormal.World',
    'KadmosFormal.Interpreter', 'KadmosFormal.System',
    'KadmosFormal.Balance', 'KadmosFormal.Bridge.Syntax',
    'KadmosFormal.Bridge.Certificate', 'KadmosFormal.Bridge.Fixtures', 'HarmoniaTests.KadmosWorldIR',
    'HarmoniaTests.KadmosWorldInterpreter', 'HarmoniaTests.KadmosWorldBalance',
    'HarmoniaTests.KadmosWorldAxiomAudit'}
FOUNDATION = {'Harmonia.Core.TransitionSystem', 'Harmonia.Core.Execution',
              'Harmonia.Core.Invariant', 'Harmonia.Core.Refinement'}

class AuditInventoryError(ValueError):
    pass

MODULE = re.compile(r'[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*\Z')
BOUNDARIES = {'import', 'prelude', 'namespace', 'end', 'open', 'def', 'abbrev',
              'theorem', 'lemma', 'axiom', 'structure', 'inductive', 'universe',
              'variable', 'section', 'set_option', 'instance', 'example', 'private',
              'protected', 'noncomputable', 'unsafe', 'elab', 'syntax', 'macro'}
ADVERSARIAL = set()

def scrub(source):
    """Blank nested Lean comments and string literals while preserving newlines."""
    out, i, depth = [], 0, 0
    while i < len(source):
        if depth:
            if source.startswith('/-', i):
                depth += 1; out.extend('  '); i += 2
            elif source.startswith('-/', i):
                depth -= 1; out.extend('  '); i += 2
            else:
                out.append('\n' if source[i] == '\n' else ' '); i += 1
        elif source.startswith('/-', i):
            depth = 1; out.extend('  '); i += 2
        elif source.startswith('--', i):
            stop = source.find('\n', i)
            if stop == -1: stop = len(source)
            out.extend(' ' * (stop - i)); i = stop
        elif source.startswith("'\"'", i):
            # Lean's quote character literal is not the start of a string.
            out.extend('   '); i += 3
        elif source[i] == '"':
            out.append(' '); i += 1
            closed = False
            while i < len(source):
                ch = source[i]; out.append('\n' if ch == '\n' else ' '); i += 1
                if ch == '\\' and i < len(source):
                    out.append(' '); i += 1
                elif ch == '"':
                    closed = True; break
            if not closed: raise AuditInventoryError('unterminated Lean string')
        else:
            out.append(source[i]); i += 1
    if depth: raise AuditInventoryError('unterminated Lean comment')
    return ''.join(out)

def parse_imports(source):
    tokens = re.findall(r'[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*|[^\s]', scrub(source))
    result, i = [], 0
    if tokens[:1] == ['prelude']: i = 1
    while i < len(tokens) and tokens[i] == 'import':
        i += 1
        begin = i
        while i < len(tokens) and MODULE.fullmatch(tokens[i]) and tokens[i] not in BOUNDARIES:
            result.append(tokens[i]); i += 1
        if begin == i: raise AuditInventoryError('empty import declaration')
    return result

def parse_manifest(source):
    clean = scrub(source)
    match = re.search(r'\bdef\s+sourceModules\s*:\s*Array\s+Name\s*:=\s*#\[(.*?)\]', clean, re.S)
    if not match: raise AuditInventoryError('missing or malformed source manifest')
    body = match.group(1)
    names = re.findall(r'`([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*)', body)
    residue = re.sub(r'`[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*', '', body)
    if re.sub(r'[\s,]', '', residue): raise AuditInventoryError('malformed manifest entry')
    if len(names) != len(set(names)): raise AuditInventoryError('duplicate manifest entry')
    return set(names)

def module_path(root, name):
    return root / (name.replace('.', '/') + '.lean')

def module_name(root, path):
    return '.'.join(path.relative_to(root).with_suffix('').parts)

def adversarial(name):
    return 'Rejection' in name

@functools.lru_cache(maxsize=1)
def lean_prefix():
    proc = subprocess.run(['lean', '--print-prefix'], capture_output=True, text=True, check=True)
    return Path(proc.stdout.strip())

def import_closure(root, initial):
    seen, work = set(), [initial]
    while work:
        name = work.pop()
        if name in seen: continue
        if name in FOUNDATION or name.startswith(('Harmonia.VerifiedProtocols', 'Harmonia.Distributed.')) or name in {'Harmonia.Distributed', 'Harmonia.Theorems.Quorum'}:
            path = module_path(root / '.lake/packages/harmonia', name)
            if not path.is_file(): raise AuditInventoryError(f'missing project import {name}')
            seen.add(name)
            # Harmonia is a separately pinned and audited dependency.
            continue
        path = module_path(root, name)
        if not path.is_file():
            if name.startswith(('KadmosFormal', 'HarmoniaTests', 'Harmonia')):
                raise AuditInventoryError(f'missing project import {name}')
            external = lean_prefix() / 'lib/lean' / (name.replace('.', '/') + '.olean')
            if not external.is_file(): raise AuditInventoryError(f'missing external import {name}')
            continue
        seen.add(name)
        work.extend(parse_imports(path.read_text()))
    return seen

def trap(name):
    return adversarial(name) or name == 'HarmoniaTests.KadmosWorldAuditRejection' or name.startswith('HarmoniaTests.KadmosWorldRejection.')

def name_array(body):
    # Reuse the existing strict lexical array parser without altering its policy.
    return parse_manifest('def sourceModules : Array Name := #[' + body + ']')

def literal_end(clean, end, label):
    # A literal array must be the entire declaration RHS, not a prefix of ++/push.
    tail = clean[end:]
    boundary = re.search(r'(?m)^(?:def|abbrev|theorem|lemma|instance|elab|namespace|end|lean_lib|lean_exe|package|import)\b', tail)
    suffix = tail[:boundary.start()] if boundary else tail
    if suffix.strip():
        raise AuditInventoryError(f'nonliteral {label} array suffix')

def application_manifest(source):
    match = re.search(r'\bdef\s+kadmosWorldSourceModules\s*:\s*Array\s+Name\s*:=\s*#\[(.*?)\]', scrub(source), re.S)
    if not match:
        raise AuditInventoryError('missing or malformed Kadmos manifest')
    literal_end(scrub(source), match.end(), "Kadmos manifest")
    return name_array(match.group(1))

def target_roots(source, target):
    clean = scrub(source)
    matches = list(re.finditer(r'\blean_lib\s+' + re.escape(target) + r'\s+where\s+roots\s*:=\s*#\[(.*?)\]', clean, re.S))
    if len(matches) != 1:
        raise AuditInventoryError(f'missing or malformed target roots: {target}')
    literal_end(clean, matches[0].end(), target)
    roots = name_array(matches[0].group(1))
    if not roots:
        raise AuditInventoryError(f'empty target roots: {target}')
    return roots

def root_closure(root, names):
    result = set()
    for name in names:
        result |= import_closure(root, name)
    return result

def check(root):
    root = Path(root).resolve()
    product = {root / 'KadmosFormal.lean'} | {p for p in (root / 'KadmosFormal').rglob('*.lean')
        if p.relative_to(root / 'KadmosFormal').parts[0] != 'Protocols'}
    probes = {p for p in (root / 'HarmoniaTests').rglob('*.lean')
              if p.relative_to(root / 'HarmoniaTests').parts[0].startswith('KadmosWorld')}
    for p in product:
        name = module_name(root, p)
        if name != 'KadmosFormal' and not name.startswith('KadmosFormal.'):
            raise AuditInventoryError(f'unknown application source: {name}')
    inventory = {module_name(root, p) for p in product | probes if not trap(module_name(root, p))}
    if not MANDATORY <= inventory:
        raise AuditInventoryError(f'missing required application source: {sorted(MANDATORY-inventory)}')
    manifest = application_manifest(module_path(root, 'HarmoniaTests.KadmosAuditPolicy').read_text())
    if manifest != inventory:
        raise AuditInventoryError(f'Kadmos manifest mismatch: missing={sorted(inventory-manifest)}, extra={sorted(manifest-inventory)}')
    closure = import_closure(root, 'HarmoniaTests.KadmosWorldAxiomAudit')
    if inventory - closure:
        raise AuditInventoryError(f'unimported certified application source: {sorted(inventory-closure)}')
    unexpected = closure - inventory - FOUNDATION - {'HarmoniaTests.KadmosAuditPolicy'}
    if unexpected:
        raise AuditInventoryError(f'unknown certified application import: {sorted(unexpected)}')
    lake = (root / 'lakefile.lean').read_text()
    for target in CERTIFIED_TARGETS:
        modules = root_closure(root, target_roots(lake, target))
        traps = sorted(n for n in modules if trap(n))
        if traps:
            raise AuditInventoryError(f'{target} adversarial closure: {traps}')
        unaudited = modules - closure
        if unaudited:
            raise AuditInventoryError(f'unaudited certified root in {target}: {sorted(unaudited)}')
    for target in REJECTION_TARGETS:
        # Directional: its own traps/shared tooling are allowed; certified roots above
        # must never reach them. Validate that even isolated roots resolve completely.
        modules = root_closure(root, target_roots(lake, target))
        for name in modules:
            if trap(name):
                own = name == 'HarmoniaTests.KadmosWorldAuditRejection' or name.startswith('HarmoniaTests.KadmosWorldRejection.')
                if not own:
                    raise AuditInventoryError(f'{target} foreign adversarial root: {name}')
    for name in inventory:
        source = module_path(root, name).read_text()
        bad = re.search(r'\b(sorry|admit|sorryAx|axiom|native_decide)\b', scrub(source))
        if bad:
            raise AuditInventoryError(f'forbidden certified source token {bad.group(1)} in {name}')
    for p in product:
        for name in import_closure(root, module_name(root, p)):
            if name not in FOUNDATION and name not in inventory:
                raise AuditInventoryError(f'forbidden product import: {name}')
            if name.startswith('HarmoniaTests.'):
                raise AuditInventoryError(f'forbidden product test/audit import: {name}')
        for name in parse_imports(p.read_text()):
            if name != 'Init' and not name.startswith('Init.') and name not in FOUNDATION and not name.startswith('KadmosFormal'):
                raise AuditInventoryError(f'forbidden product dependency: {name}')
    return {'certified_application_modules': len(inventory), 'application_closure': len(closure),
            'certified_targets': len(CERTIFIED_TARGETS), 'isolated_targets': len(REJECTION_TARGETS)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        import test_kadmos_world_audit
        suite = unittest.defaultTestLoader.loadTestsFromModule(test_kadmos_world_audit)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    try:
        result = check(args.root)
    except (AuditInventoryError, OSError, subprocess.SubprocessError) as exc:
        print(f'KADMOS INVENTORY REJECTED: {exc}', file=sys.stderr)
        return 1
    print(f'KADMOS INVENTORY PASS: {result}')
    return 0

if __name__ == '__main__':
    sys.modules['check_kadmos_world_audit'] = sys.modules[__name__]
    raise SystemExit(main())
