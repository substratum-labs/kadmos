/- Build-time audit tooling for Kadmos World IR and Bridge formal models. -/
import Lean
open Lean Elab Command

namespace HarmoniaAudit

def allowed (n : Name) : Bool :=
  n == ``propext || n == ``Quot.sound || n == ``Classical.choice

def checkDeclaration (n : Name) (allowChoice : Bool := true) :
    CommandElabM (Array Name) := do
  unless (← getEnv).contains n do
    throwError "axiom audit declaration does not exist: {n}"
  let axioms ← collectAxioms n
  for ax in axioms do
    unless allowed ax && (allowChoice || ax != ``Classical.choice) do
      throwError "axiom audit rejected {n}: {ax}"
  return axioms

def theoremNames (env : Environment) (select : Name → Bool) : Array Name :=
  (env.constants.toList.filterMap fun (n, info) =>
    match info with
    | .thmInfo _ => if select n then some n else none
    | _ => none).toArray.qsort (fun a b => a.toString < b.toString)

def sourceModule (env : Environment) (n : Name) : Name :=
  match env.getModuleIdxFor? n with
  | some idx => env.header.moduleNames[idx.toNat]!
  | none => env.mainModule

def kadmosWorldSourceModules : Array Name := #[
  `KadmosFormal, `KadmosFormal.World,
  `KadmosFormal.Interpreter, `KadmosFormal.System,
  `KadmosFormal.Balance, `KadmosFormal.Bridge.Syntax,
  `KadmosFormal.Bridge.Certificate,
  `KadmosFormal.Bridge.Fixtures,
  `HarmoniaTests.KadmosWorldIR,
  `HarmoniaTests.KadmosWorldInterpreter, `HarmoniaTests.KadmosWorldBalance,
  `HarmoniaTests.KadmosWorldAxiomAudit]

def kadmosWorldDeclaration (env : Environment) (n : Name) : Bool :=
  !(n.toString.startsWith "Harmonia.Applications.Kadmos.Protocols.") &&
  !((`KadmosFormal.Protocols).isPrefixOf (sourceModule env n)) &&
  ((`Harmonia.Applications.Kadmos).isPrefixOf n ||
   (`KadmosFormal).isPrefixOf (sourceModule env n) ||
   kadmosWorldSourceModules.contains (sourceModule env n))

def kadmosBridgeSourceModules : Array Name := #[
  `KadmosFormal.Bridge.Syntax,
  `KadmosFormal.Bridge.Certificate,
  `KadmosFormal.Bridge.Fixtures,
  `HarmoniaTests.KadmosBridgeSyntax,
  `HarmoniaTests.KadmosBridgeCertificate,
  `HarmoniaTests.KadmosBridgeFixtures,
  `HarmoniaTests.KadmosBridgeAxiomAudit]

def kadmosBridgeDeclaration (env : Environment) (n : Name) : Bool :=
  (`Harmonia.Applications.Kadmos.Bridge).isPrefixOf n ||
  (`KadmosFormal.Bridge).isPrefixOf (sourceModule env n) ||
  kadmosBridgeSourceModules.contains (sourceModule env n)

def kadmosProtocolsSourceModules : Array Name := #[
  `KadmosFormal.Protocols.ProtocolBridge,
  `HarmoniaTests.KadmosProtocolsTest,
  `HarmoniaTests.KadmosProtocolsAxiomAudit]

def kadmosProtocolsDeclaration (env : Environment) (n : Name) : Bool :=
  kadmosProtocolsSourceModules.contains (sourceModule env n)

def auditSelected (select : Name → Bool) (label : String) (allObserved : Bool := false)
    (summaryPrefix : String := "KADMOS AUDIT PASS")
    (allowChoice : Bool := true) : CommandElabM Unit := do
  let env ← getEnv
  let declarations := env.constants.toList.toArray.qsort (fun a b => a.1.toString < b.1.toString)
  for (n, info) in declarations do
    if select n then
      match info with
      | .axiomInfo _ =>
        let range ← findDeclarationRanges? n
        unless info.isUnsafe && range.isNone do discard <| checkDeclaration n allowChoice
      | _ => pure ()
  let names := theoremNames env select
  if names.isEmpty then throwError "axiom audit found no {label} theorems"
  let mut observed : Array Name := #[]
  let mut count : Nat := 0
  for (n, info) in declarations do
    if select n && !info.isUnsafe then
      let axioms ← collectAxioms n
      for ax in axioms do
        unless allowed ax && (allowChoice || ax != ``Classical.choice) do
          throwError "axiom audit rejected {n}: {ax}"
      count := count + 1
      if allObserved then
        for ax in axioms do
          if !observed.contains ax then observed := observed.push ax
  for n in names do
    let axioms ← checkDeclaration n allowChoice
    for ax in axioms do
      if !observed.contains ax then observed := observed.push ax
    logInfo m!"{n}: {axioms}"
  let whitelist := if allowChoice then
    "[propext, Quot.sound, Classical.choice]" else "[propext, Quot.sound]"
  if allObserved then
    logInfo m!"{summaryPrefix}: {names.size} theorems; {count} declarations; observed axioms {observed}; whitelist {whitelist}"
  else
    logInfo m!"AUDIT PASS: {names.size} theorems; observed axioms {observed}; whitelist {whitelist}"

end HarmoniaAudit

elab "#audit_declaration " n:ident : command => do
  discard <| HarmoniaAudit.checkDeclaration n.getId

elab "#audit_namespace " n:ident : command => do
  let env ← getEnv
  let names := HarmoniaAudit.theoremNames env (n.getId.isPrefixOf ·)
  if names.isEmpty then throwError "axiom audit found no theorems in {n.getId}"
  for name in names do discard <| HarmoniaAudit.checkDeclaration name

elab "#audit_module " n:ident : command => do
  let env ← getEnv
  HarmoniaAudit.auditSelected (fun name => HarmoniaAudit.sourceModule env name == n.getId) "source module" true

elab "#audit_kadmos_world" : command => do
  let env ← getEnv
  HarmoniaAudit.auditSelected (HarmoniaAudit.kadmosWorldDeclaration env) "kadmos world" true
    "KADMOS WORLD AUDIT PASS"

elab "#audit_kadmos_bridge" : command => do
  let env ← getEnv
  HarmoniaAudit.auditSelected (HarmoniaAudit.kadmosBridgeDeclaration env) "kadmos bridge" true
    "KADMOS BRIDGE AUDIT PASS"

elab "#audit_kadmos_protocols" : command => do
  let env ← getEnv
  HarmoniaAudit.auditSelected (HarmoniaAudit.kadmosProtocolsDeclaration env) "kadmos protocols" true
    "KADMOS PROTOCOLS AUDIT PASS" false
