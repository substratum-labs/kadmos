import KadmosFormal.Balance
import Harmonia.VerifiedProtocols

namespace Harmonia.Applications.Kadmos.Protocols
open Harmonia

/-- Computable, choice-free decision procedure for pointwise equality on `Fin v → Int`. -/
def decContextEq : {v : Nat} → (c₁ c₂ : Fin v → Int) → Decidable (∀ j : Fin v, c₁ j = c₂ j)
  | 0, _, _ => isTrue (fun j => Fin.elim0 j)
  | v + 1, c₁, c₂ =>
    match inferInstanceAs (Decidable (c₁ 0 = c₂ 0)),
          decContextEq (fun i : Fin v => c₁ i.succ) (fun i : Fin v => c₂ i.succ) with
    | isTrue h0, isTrue hs =>
      isTrue (fun j => Fin.cases h0 hs j)
    | isFalse h0, _ =>
      isFalse (fun hall => h0 (hall 0))
    | _, isFalse hs =>
      isFalse (fun hall => hs (fun i => hall i.succ))

instance instDecidableEqState {p v : Nat} : DecidableEq (State p v) := fun s₁ s₂ =>
  match inferInstanceAs (Decidable (s₁.phase = s₂.phase)),
        decContextEq s₁.context s₂.context with
  | isTrue hp, isTrue hc =>
    isTrue (by
      cases s₁; cases s₂
      simp only [State.mk.injEq] at hp hc ⊢
      exact ⟨hp, funext hc⟩)
  | isFalse hp, _ =>
    isFalse (fun heq => hp (congrArg State.phase heq))
  | _, isFalse hc =>
    isFalse (fun heq => hc (fun j => congrFun (congrArg State.context heq) j))

instance instDecidableEqResult {p v : Nat} : DecidableEq (Result p v) := fun r₁ r₂ =>
  match inferInstanceAs (Decidable (r₁.state = r₂.state)),
        inferInstanceAs (Decidable (r₁.observation = r₂.observation)) with
  | isTrue hs, isTrue ho =>
    isTrue (by cases r₁; cases r₂; cases hs; cases ho; rfl)
  | isFalse hs, _ =>
    isFalse (fun heq => hs (congrArg Result.state heq))
  | _, isFalse ho =>
    isFalse (fun heq => ho (congrArg Result.observation heq))

variable {N : Type} [DecidableEq N]
variable {p v reqFields actCount : Nat}

/-- A Kadmos transition result `res` is certified by `World w` if it is produced by
    `interpret w pre req` with an `.accepted` verdict. -/
def GatekeeperAccepted (w : World p v reqFields actCount) (pre : State p v)
    (req : Request reqFields) (res : Result p v) : Prop :=
  interpret w pre req = res ∧ res.observation.verdict = .accepted

theorem gatekeeperAccepted_good {w : World p v reqFields actCount}
    {pre : State p v} {req : Request reqFields} {res : Result p v}
    (h : GatekeeperAccepted w pre req res) : Good w res.state := by
  rcases h with ⟨rfl, hv⟩
  exact accepted_good hv

/-- A rejected Kadmos transition preserves the pre-state and emits no directive. -/
def GatekeeperRejected (w : World p v reqFields actCount) (pre : State p v)
    (req : Request reqFields) (res : Result p v) (reason : RejectReason) : Prop :=
  interpret w pre req = res ∧ res.observation.verdict = .rejected reason

theorem gatekeeperRejected_frame {w : World p v reqFields actCount}
    {pre : State p v} {req : Request reqFields} {res : Result p v} {reason : RejectReason}
    (h : GatekeeperRejected w pre req res reason) :
    res.state = pre ∧ res.observation.directive = none := by
  rcases h with ⟨rfl, hv⟩
  exact rejection_frame hv

/-- Every leader that durably commits `(leader, res)` in epoch `e` certified `res`
    through the Kadmos gatekeeper `w`. -/
def LeaseLeaderCommitsAccepted (c : Distributed.Config N)
    (w : World p v reqFields actCount)
    (s : VerifiedProtocols.QuorumLease.LeaseState c (Result p v)) : Prop :=
  ∀ (leader : Distributed.Member c) (e : Nat) (res : Result p v),
    (s.nodes leader).durable.committed e = some (leader, res) →
      ∃ pre req, GatekeeperAccepted w pre req res

theorem kadmos_lease_mutual_exclusion (c : Distributed.Config N) (f : Nat)
    (fp : Distributed.FaultProfile)
    {s : VerifiedProtocols.QuorumLease.LeaseState c (Result p v)}
    {e : Nat} {m₁ m₂ : Distributed.Member c}
    (hr : Foundation.Reachable (VerifiedProtocols.QuorumLease.sys c f fp) s)
    (h₁ : VerifiedProtocols.QuorumLease.HasQuorumLease c f s e m₁)
    (h₂ : VerifiedProtocols.QuorumLease.HasQuorumLease c f s e m₂) :
    m₁ = m₂ :=
  VerifiedProtocols.QuorumLease.quorum_lease_mutual_exclusion c f fp hr h₁ h₂

omit [DecidableEq N] in
/-- Using `reachable_leaseInv`, any durable commit `(leader, res)` at any node `n` implies
    `Certified c f s e leader res`, which establishes `(s.nodes leader).durable.committed e = some (leader, res)`
    and hence `Good w res.state` via `LeaseLeaderCommitsAccepted`. -/
theorem kadmos_lease_certified_good (c : Distributed.Config N) (f : Nat)
    (w : World p v reqFields actCount)
    {s : VerifiedProtocols.QuorumLease.LeaseState c (Result p v)}
    {e : Nat} {leader : Distributed.Member c} {res : Result p v}
    (halign : LeaseLeaderCommitsAccepted c w s)
    (hcert : VerifiedProtocols.QuorumLease.Certified c f s e leader res) :
    Good w res.state := by
  obtain ⟨pre, req, hacc⟩ := halign leader e res hcert.1
  exact gatekeeperAccepted_good hacc

theorem kadmos_lease_fenced_agreement_and_good (c : Distributed.Config N) (f : Nat)
    (fp : Distributed.FaultProfile) (w : World p v reqFields actCount)
    {s : VerifiedProtocols.QuorumLease.LeaseState c (Result p v)}
    {e : Nat} {n₁ n₂ leader₁ leader₂ : Distributed.Member c} {res₁ res₂ : Result p v}
    (hr : Foundation.Reachable (VerifiedProtocols.QuorumLease.sys c f fp) s)
    (halign : LeaseLeaderCommitsAccepted c w s)
    (h₁ : (s.nodes n₁).durable.committed e = some (leader₁, res₁))
    (h₂ : (s.nodes n₂).durable.committed e = some (leader₂, res₂)) :
    leader₁ = leader₂ ∧ res₁ = res₂ ∧ Good w res₁.state ∧ Good w res₂.state := by
  have hinv := VerifiedProtocols.QuorumLease.reachable_leaseInv c f fp hr
  have hsafety := VerifiedProtocols.QuorumLease.fenced_commit_safety_of_inv hinv h₁ h₂
  have hg₁ := kadmos_lease_certified_good c f w halign
    (hinv.leader_commit_has_quorum.2 n₁ e leader₁ res₁ h₁)
  have hg₂ := kadmos_lease_certified_good c f w halign
    (hinv.leader_commit_has_quorum.2 n₂ e leader₂ res₂ h₂)
  exact ⟨hsafety.1, hsafety.2, hg₁, hg₂⟩

theorem kadmos_lease_refines_spec (c : Distributed.Config N) (f : Nat)
    (fp : Distributed.FaultProfile) :
    Foundation.ForwardSimulation
      (VerifiedProtocols.QuorumLease.sys (Val := Result p v) c f fp)
      (VerifiedProtocols.QuorumLease.sequentialLeaseSpec c (Result p v))
      (VerifiedProtocols.QuorumLease.LeaseSimRel c f)
      VerifiedProtocols.QuorumLease.obsMap :=
  VerifiedProtocols.QuorumLease.quorum_lease_refines_spec c f fp

/-- Every participant that durably votes `true` for `tx` had its local Kadmos gatekeeper
    accept `(evalAt m tx)`. -/
def TwoPCVotesGatekeeperAligned (c : Distributed.Config N)
    (w : World p v reqFields actCount)
    (evalAt : Distributed.Member c → Nat → State p v × Request reqFields)
    (s : VerifiedProtocols.TwoPhaseCommit.TwoPCState c) : Prop :=
  ∀ (m : Distributed.Member c) (tx : Nat),
    (s.nodes m).durable.voted tx = some true →
      (interpret w (evalAt m tx).1 (evalAt m tx).2).observation.verdict = .accepted

theorem kadmos_twoPC_atomic_agreement (c : Distributed.Config N) (coord : Distributed.Member c)
    (fp : Distributed.FaultProfile)
    {s : VerifiedProtocols.TwoPhaseCommit.TwoPCState c}
    (hr : Foundation.Reachable (VerifiedProtocols.TwoPhaseCommit.sys c coord fp) s)
    {n₁ n₂ : Distributed.Member c} {tx : Nat} {b₁ b₂ : Bool}
    (h₁ : (s.nodes n₁).durable.outcome tx = some b₁)
    (h₂ : (s.nodes n₂).durable.outcome tx = some b₂) : b₁ = b₂ :=
  VerifiedProtocols.TwoPhaseCommit.twoPC_atomic_agreement c coord fp hr h₁ h₂

/-- When any node `n` records `outcome tx = some true`, `twoPC_commit_validity` guarantees
    that every participant `m : Member c` durably voted `true`, and `TwoPCVotesGatekeeperAligned`
    plus `accepted_good` guarantees that every participant's local post-state satisfies `Good w`. -/
theorem kadmos_twoPC_commit_all_participants_good (c : Distributed.Config N)
    (coord : Distributed.Member c) (fp : Distributed.FaultProfile)
    (w : World p v reqFields actCount)
    (evalAt : Distributed.Member c → Nat → State p v × Request reqFields)
    {s : VerifiedProtocols.TwoPhaseCommit.TwoPCState c}
    (hr : Foundation.Reachable (VerifiedProtocols.TwoPhaseCommit.sys c coord fp) s)
    (halign : TwoPCVotesGatekeeperAligned c w evalAt s)
    {n : Distributed.Member c} {tx : Nat}
    (hcommit : (s.nodes n).durable.outcome tx = some true) :
    ∀ m : Distributed.Member c,
      (s.nodes m).durable.voted tx = some true ∧
      Good w (interpret w (evalAt m tx).1 (evalAt m tx).2).state := by
  intro m
  have hv := VerifiedProtocols.TwoPhaseCommit.twoPC_commit_validity c coord fp hr hcommit m
  exact ⟨hv, accepted_good (halign m tx hv)⟩

theorem kadmos_twoPC_prepared_no_abort_without_coord (c : Distributed.Config N)
    (coord : Distributed.Member c) (fp : Distributed.FaultProfile)
    {s : VerifiedProtocols.TwoPhaseCommit.TwoPCState c}
    (hr : Foundation.Reachable (VerifiedProtocols.TwoPhaseCommit.sys c coord fp) s)
    {n : Distributed.Member c} {tx : Nat}
    (hv : (s.nodes n).durable.voted tx = some true)
    (ho : (s.nodes n).durable.outcome tx = some false) :
    (s.nodes coord).durable.coordDecision tx = some false :=
  VerifiedProtocols.TwoPhaseCommit.twoPC_prepared_no_abort_without_coord c coord fp hr hv ho

theorem kadmos_twoPC_refines_spec (c : Distributed.Config N) (coord : Distributed.Member c)
    (fp : Distributed.FaultProfile) :
    Foundation.ForwardSimulation
      (VerifiedProtocols.TwoPhaseCommit.sys c coord fp)
      VerifiedProtocols.TwoPhaseCommit.sequentialTwoPCSpec
      (VerifiedProtocols.TwoPhaseCommit.TwoPCSimRel c coord)
      VerifiedProtocols.TwoPhaseCommit.obsMap :=
  VerifiedProtocols.TwoPhaseCommit.twoPC_refines_spec c coord fp

/-- Every honest voter that durably votes for `(leader, res)` in view `e` verified that `res`
    was accepted by the Kadmos gatekeeper `w`. -/
def BFTHonestVotesGatekeeperAligned (c : Distributed.Config N)
    (w : World p v reqFields actCount)
    (faulty : List (Distributed.Member c))
    (s : VerifiedProtocols.BFTQuorumCommit.BFTState c (Result p v)) : Prop :=
  ∀ (voter leader : Distributed.Member c) (e : Nat) (res : Result p v),
    voter ∉ faulty →
    (s.nodes voter).durable.votedFor e = some (leader, res) →
      ∃ pre req, GatekeeperAccepted w pre req res

theorem kadmos_bft_qc_unique
    {c : Distributed.Config N} {f e : Nat} {faulty : List (Distributed.Member c)}
    {s : VerifiedProtocols.BFTQuorumCommit.BFTState c (Result p v)}
    {leader₁ leader₂ : Distributed.Member c} {res₁ res₂ : Result p v}
    (hf : VerifiedProtocols.BFTQuorumCommit.FaultyBounded c f faulty)
    (h₁ : VerifiedProtocols.BFTQuorumCommit.BFTCertified c f faulty s e leader₁ res₁)
    (h₂ : VerifiedProtocols.BFTQuorumCommit.BFTCertified c f faulty s e leader₂ res₂) :
    leader₁ = leader₂ ∧ res₁ = res₂ :=
  VerifiedProtocols.BFTQuorumCommit.bft_qc_unique hf h₁ h₂

/-- Any BFT-certified proposal in a cluster with `FaultyBounded c f faulty` and
    `BFTHonestVotesGatekeeperAligned c w faulty s` has at least one honest voter in its quorum
    (via `bft_quorum_honest_voter c f faulty Q Q hQ hQ hf`), guaranteeing that the certified
    `res.state` satisfies `Good w` even if up to `f` Byzantine voters in the quorum equivocated! -/
theorem kadmos_bft_certified_good
    {c : Distributed.Config N} {f e : Nat} {faulty : List (Distributed.Member c)}
    {w : World p v reqFields actCount}
    {s : VerifiedProtocols.BFTQuorumCommit.BFTState c (Result p v)}
    {leader : Distributed.Member c} {res : Result p v}
    (hf : VerifiedProtocols.BFTQuorumCommit.FaultyBounded c f faulty)
    (halign : BFTHonestVotesGatekeeperAligned c w faulty s)
    (hcert : VerifiedProtocols.BFTQuorumCommit.BFTCertified c f faulty s e leader res) :
    Good w res.state := by
  obtain ⟨_, Q, hQ, hv⟩ := hcert
  obtain ⟨voter, hm, _, honest⟩ :=
    VerifiedProtocols.BFTQuorumCommit.bft_quorum_honest_voter c f faulty Q Q hQ hQ hf
  obtain ⟨pre, req, hacc⟩ := halign voter leader e res honest (hv voter hm honest)
  exact gatekeeperAccepted_good hacc

theorem kadmos_bft_commit_safety_and_good
    (c : Distributed.Config N) (f : Nat) (faulty : List (Distributed.Member c))
    (hf : VerifiedProtocols.BFTQuorumCommit.FaultyBounded c f faulty)
    (fp : Distributed.FaultProfile) (w : World p v reqFields actCount)
    {s : VerifiedProtocols.BFTQuorumCommit.BFTState c (Result p v)}
    {e : Nat} {n₁ n₂ leader₁ leader₂ : Distributed.Member c} {res₁ res₂ : Result p v}
    (hr : Foundation.Reachable (VerifiedProtocols.BFTQuorumCommit.sys c f faulty fp) s)
    (halign : BFTHonestVotesGatekeeperAligned c w faulty s)
    (h₁ : (s.nodes n₁).durable.committed e = some (leader₁, res₁))
    (h₂ : (s.nodes n₂).durable.committed e = some (leader₂, res₂)) :
    leader₁ = leader₂ ∧ res₁ = res₂ ∧ Good w res₁.state ∧ Good w res₂.state := by
  have hinv := VerifiedProtocols.BFTQuorumCommit.reachable_bftCommitInv c f faulty fp hr
  have hc₁ := hinv.qc_has_quorum.2 n₁ e leader₁ res₁ h₁
  have hc₂ := hinv.qc_has_quorum.2 n₂ e leader₂ res₂ h₂
  have huniq := kadmos_bft_qc_unique hf hc₁ hc₂
  exact ⟨huniq.1, huniq.2,
    kadmos_bft_certified_good hf halign hc₁,
    kadmos_bft_certified_good hf halign hc₂⟩

theorem kadmos_bft_refines_spec (c : Distributed.Config N) (f : Nat)
    (faulty : List (Distributed.Member c))
    (hf : VerifiedProtocols.BFTQuorumCommit.FaultyBounded c f faulty)
    (fp : Distributed.FaultProfile) :
    Foundation.ForwardSimulation
      (Distributed.system c (VerifiedProtocols.BFTQuorumCommit.bftCommitProtocol (Val := Result p v) c f faulty) fp)
      (VerifiedProtocols.BFTQuorumCommit.sequentialBFTSpec c (Result p v))
      (VerifiedProtocols.BFTQuorumCommit.BFTSimRel c f faulty)
      VerifiedProtocols.BFTQuorumCommit.obsMap :=
  VerifiedProtocols.BFTQuorumCommit.bft_commit_refines_spec c f faulty hf fp

end Harmonia.Applications.Kadmos.Protocols
