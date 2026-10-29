import KadmosFormal.Protocols.ProtocolBridge

namespace Harmonia.Applications.Kadmos.Protocols.Tests
open Harmonia Harmonia.VerifiedProtocols Harmonia.Distributed Harmonia.VerifiedProtocols.QuorumLease
set_option maxRecDepth 4096
set_option maxHeartbeats 1000000

def validRes : Result 1 1 := ⟨balanceState 70, ⟨.accepted, none⟩⟩
def forgedRes : Result 1 1 := ⟨balanceState (-30), ⟨.accepted, none⟩⟩

theorem balance_debit30_accepted :
    GatekeeperAccepted balanceWorld (balanceState 100) (debit 30) validRes :=
  ⟨debit_accept 100 30 (by decide) (by decide) (by decide) (by decide), rfl⟩

theorem balance_debit130_rejected :
    GatekeeperRejected balanceWorld (balanceState 50) (debit 130)
      ⟨balanceState 50, ⟨.rejected (.bounds 0), none⟩⟩ (.bounds 0) :=
  ⟨debit_insufficient 50 130 (by decide) (by decide) (by decide) (by decide), rfl⟩

theorem forged_negative_not_good : ¬ Good balanceWorld forgedRes.state := by
  intro h
  have hb : checkBounds balanceWorld (balanceState (-30)) = none :=
    ite_eq_left (fun j => good_bounds h j)
  rw [balance_negative_bounds (-30) (by decide)] at hb
  cases hb

-- Exercise each branch of the computable equality instances in kernel proofs.
example : (⟨0, Fin.elim0⟩ : Harmonia.Applications.Kadmos.State 1 0) = ⟨0, Fin.elim0⟩ := by decide
example : (⟨0, fun _ => 7⟩ : Harmonia.Applications.Kadmos.State 2 2) ≠ ⟨1, fun _ => 7⟩ := by decide
example : (⟨0, fun i => if i = 0 then 7 else 8⟩ : Harmonia.Applications.Kadmos.State 1 2) ≠
    ⟨0, fun _ => 7⟩ := by decide
example : validRes ≠ forgedRes := by decide
example : validRes ≠ ⟨balanceState 70, ⟨.rejected (.bounds 0), none⟩⟩ := by decide

def cluster3 : Config Nat := ⟨[0, 1, 2], by decide⟩
def node0 : Member cluster3 := ⟨0, by decide⟩
def node1 : Member cluster3 := ⟨1, by decide⟩
def node2 : Member cluster3 := ⟨2, by decide⟩

theorem singleton_not_quorum : ¬ IsQuorum cluster3 1 [node2] := by unfold IsQuorum; decide

abbrev S := Distributed.State (Member cluster3) (LeaseDurable cluster3 (Result 1 1))
  (LeaseVolatile cluster3 (Result 1 1)) Nat (LeaseMsg cluster3 (Result 1 1))
abbrev A := Label (Member cluster3) Nat (LeaseMsg cluster3 (Result 1 1)) (LeaseCmd cluster3 (Result 1 1)) Empty

def protocol := quorumLeaseProtocol (Val := Result 1 1) cluster3 1

def start : S := ⟨fun _ => ⟨⟨fun _ => none, fun _ => none⟩, ⟨fun _ => []⟩, .running⟩, [], 0⟩

def grantOut : List (Outgoing (Member cluster3) Nat (LeaseMsg cluster3 (Result 1 1))) :=
  [⟨node0, 1, .voteGrant 1 node0⟩]
def grant (actor : Member cluster3) (tid : Nat) : Transmission (Member cluster3) Nat (LeaseMsg cluster3 (Result 1 1)) :=
  ⟨tid, ⟨actor, node0, 1, .voteGrant 1 node0⟩⟩
def castLabel (actor : Member cluster3) : A := .process actor (.local (.castVote 1 node0)) grantOut

def castState (s : S) (actor : Member cluster3) : S :=
  ⟨setNode s.nodes actor
    ⟨{ (s.nodes actor).durable with
        votedFor := fun e => if e = 1 then some node0 else (s.nodes actor).durable.votedFor e },
      (s.nodes actor).volatile, .running⟩,
    s.pending ++ allocate actor s.next grantOut, s.next + 1⟩

def grantState (s : S) (sender : Member cluster3)
    (rest : List (Transmission (Member cluster3) Nat (LeaseMsg cluster3 (Result 1 1)))) : S :=
  ⟨setNode s.nodes node0
    ⟨(s.nodes node0).durable,
      ⟨fun e => if e = 1 then
        (if sender ∈ (s.nodes node0).volatile.collectedVotes 1 then
          (s.nodes node0).volatile.collectedVotes 1 else sender :: (s.nodes node0).volatile.collectedVotes 1)
        else (s.nodes node0).volatile.collectedVotes e⟩, .running⟩,
    rest, s.next⟩

def crashState (s : S) : S :=
  ⟨setNode s.nodes node2 ⟨(s.nodes node2).durable, ⟨fun _ => []⟩, .crashed⟩, s.pending, s.next⟩
def recoverState (s : S) : S :=
  ⟨setNode s.nodes node2 ⟨(s.nodes node2).durable, ⟨fun _ => []⟩, .running⟩, s.pending, s.next⟩

def commitOut : List (Outgoing (Member cluster3) Nat (LeaseMsg cluster3 (Result 1 1))) :=
  [⟨node1, 1, .fencedCommit 1 node0 validRes⟩]
def commitLabel : A := .process node0 (.local (.acquireAndCommit 1 validRes [node1])) commitOut
def commitState (s : S) : S :=
  ⟨setNode s.nodes node0
    ⟨{ (s.nodes node0).durable with
        committed := fun e => if e = 1 then some (node0, validRes) else (s.nodes node0).durable.committed e },
      (s.nodes node0).volatile, .running⟩,
    s.pending ++ allocate node0 s.next commitOut, s.next + 1⟩
def commitMessage (tid : Nat) : Transmission (Member cluster3) Nat (LeaseMsg cluster3 (Result 1 1)) :=
  ⟨tid, ⟨node0, node1, 1, .fencedCommit 1 node0 validRes⟩⟩
def followerState (s : S) : S :=
  ⟨setNode s.nodes node1
    ⟨{ (s.nodes node1).durable with
        committed := fun e => if e = 1 then some (node0, validRes) else (s.nodes node1).durable.committed e },
      (s.nodes node1).volatile, .running⟩, [], s.next⟩

def voted0 := castState start node0
def voted1 := castState voted0 node1
def delivered0 := grantState voted1 node0 [grant node1 1]
def delivered1 := grantState delivered0 node1 []
def crashed := crashState delivered1
def recovered := recoverState crashed
def committed := commitState recovered
def final := followerState committed

theorem initial (fp : FaultProfile) : (Distributed.system cluster3 protocol fp).init start :=
  ⟨rfl, rfl, fun _ => ⟨rfl, rfl, rfl, rfl⟩⟩

theorem cast0_step (fp : FaultProfile) : Step cluster3 protocol fp start (castLabel node0) voted0 :=
  .process rfl (.castVote rfl) (.refl _)
theorem cast1_step (fp : FaultProfile) : Step cluster3 protocol fp voted0 (castLabel node1) voted1 :=
  .process rfl (.castVote rfl) (.refl _)
theorem grant0_step (fp : FaultProfile) : Step cluster3 protocol fp voted1 (.deliver (grant node0 0) []) delivered0 :=
  .deliver rfl (.refl _) (.voteGrant rfl) (.refl _)
theorem grant1_step (fp : FaultProfile) : Step cluster3 protocol fp delivered0 (.deliver (grant node1 1) []) delivered1 :=
  .deliver rfl (.refl _) (.voteGrant rfl) (.refl _)
theorem crash_step : Step cluster3 protocol .crashRecovery delivered1 (.crash node2) crashed :=
  .crash rfl rfl
theorem recover_step : Step cluster3 protocol .crashRecovery crashed (.recover node2) recovered :=
  .recover rfl rfl
theorem commit_step (fp : FaultProfile) : Step cluster3 protocol fp recovered commitLabel committed :=
  .process rfl (.acquireAndCommit (by unfold IsQuorum; decide) rfl) (.refl _)
theorem follower_step (fp : FaultProfile) : Step cluster3 protocol fp committed (.deliver (commitMessage 2) []) final :=
  .deliver rfl (.refl _) (.fencedCommit rfl rfl) (.refl _)

def crashRecoveryLabels : List (A × A) :=
  [(castLabel node0, castLabel node0), (castLabel node1, castLabel node1),
   (.deliver (grant node0 0) [], .deliver (grant node0 0) []),
   (.deliver (grant node1 1) [], .deliver (grant node1 1) []),
   (.crash node2, .crash node2), (.recover node2, .recover node2),
   (commitLabel, commitLabel), (.deliver (commitMessage 2) [], .deliver (commitMessage 2) [])]

theorem balance_lease_commit_trace : Foundation.Execution (Distributed.system cluster3 protocol .crashRecovery)
    start crashRecoveryLabels final :=
  .cons ⟨cast0_step _, rfl⟩ (.cons ⟨cast1_step _, rfl⟩
    (.cons ⟨grant0_step _, rfl⟩ (.cons ⟨grant1_step _, rfl⟩
      (.cons ⟨crash_step, rfl⟩ (.cons ⟨recover_step, rfl⟩
        (.cons ⟨commit_step _, rfl⟩ (.cons ⟨follower_step _, rfl⟩ .nil)))))))

theorem crashRecovery_reachable : Foundation.Reachable (Distributed.system cluster3 protocol .crashRecovery) final :=
  Foundation.execution_reachable (initial _) balance_lease_commit_trace

theorem crashRecovery_commits :
    (final.nodes node0).durable.committed 1 = some (node0, validRes) ∧
    (final.nodes node1).durable.committed 1 = some (node0, validRes) := by decide

theorem cluster3_cases (m : Member cluster3) : m = node0 ∨ m = node1 ∨ m = node2 := by
  rcases m with ⟨m, hm⟩
  simp [cluster3] at hm
  rcases hm with h | h | h <;> subst m
  · exact Or.inl rfl
  · exact Or.inr (Or.inl rfl)
  · exact Or.inr (Or.inr rfl)

theorem lease_alignment : LeaseLeaderCommitsAccepted cluster3 balanceWorld final := by
  intro leader e res hc
  rcases cluster3_cases leader with rfl | rfl | rfl <;>
    by_cases he : e = 1 <;>
    simp [final, followerState, committed, commitState, recovered, recoverState,
      crashed, crashState, delivered1, delivered0, grantState, voted1, voted0,
      castState, start, setNode, node0, node1, node2, he] at hc
  all_goals
    subst res
    exact ⟨balanceState 100, debit 30, balance_debit30_accepted⟩

theorem balance_lease_committed_good :
    node0 = node0 ∧ validRes = validRes ∧
    Good balanceWorld (balanceState 70) ∧ Good balanceWorld (balanceState 70) :=
  kadmos_lease_fenced_agreement_and_good cluster3 1 .crashRecovery balanceWorld
    crashRecovery_reachable lease_alignment crashRecovery_commits.1 crashRecovery_commits.2

namespace Atomic
open TwoPhaseCommit
abbrev S := TwoPCState cluster3
abbrev A := TwoPCLabel cluster3
def protocol := twoPCProtocol cluster3 node0
def start : S := ⟨fun _ => ⟨⟨fun _ => none,fun _ => none,fun _ => none⟩,⟨fun _ => []⟩,.running⟩,[],0⟩
def applyLocal (s : S) (actor : Member cluster3) (d : TwoPCDurable cluster3)
    (v : TwoPCVolatile cluster3) (outs : List (Outgoing (Member cluster3) Nat (TwoPCMsg cluster3))) : S :=
  ⟨setNode s.nodes actor ⟨d,v,.running⟩,s.pending ++ allocate actor s.next outs,s.next + outs.length⟩
def receive (s : S) (actor : Member cluster3) (d : TwoPCDurable cluster3)
    (v : TwoPCVolatile cluster3) (rest : List (Transmission (Member cluster3) Nat (TwoPCMsg cluster3)))
    (outs : List (Outgoing (Member cluster3) Nat (TwoPCMsg cluster3))) : S :=
  ⟨setNode s.nodes actor ⟨d,v,.running⟩,rest ++ allocate actor s.next outs,s.next + outs.length⟩
def voteOut (yes : Bool) : List (Outgoing (Member cluster3) Nat (TwoPCMsg cluster3)) :=
  [⟨node0,1,if yes then .voteYes 1 else .voteNo 1⟩]
def vote (s : S) (actor : Member cluster3) (yes : Bool) : S :=
  applyLocal s actor
    { (s.nodes actor).durable with
      voted := fun k => if k = 1 then some yes else (s.nodes actor).durable.voted k,
      outcome := if yes then (s.nodes actor).durable.outcome else
        fun k => if k = 1 then some false else (s.nodes actor).durable.outcome k }
    (s.nodes actor).volatile (voteOut yes)
def voteMsg (actor : Member cluster3) (id : Nat) (yes : Bool) : Transmission (Member cluster3) Nat (TwoPCMsg cluster3) :=
  ⟨id,actor,node0,1,if yes then .voteYes 1 else .voteNo 1⟩
def collect (s : S) (sender : Member cluster3) (rest : List (Transmission (Member cluster3) Nat (TwoPCMsg cluster3))) : S :=
  receive s node0 (s.nodes node0).durable
    ⟨fun k => if k = 1 then
      (if sender ∈ (s.nodes node0).volatile.yesVoters 1 then (s.nodes node0).volatile.yesVoters 1
       else sender :: (s.nodes node0).volatile.yesVoters 1) else (s.nodes node0).volatile.yesVoters k⟩ rest []
def decideOut (b : Bool) (peers : List (Member cluster3)) : List (Outgoing (Member cluster3) Nat (TwoPCMsg cluster3)) :=
  peers.map fun peer => ⟨peer,1,.decide 1 b⟩
def decideDurable (s : S) (b : Bool) : TwoPCDurable cluster3 :=
  { (s.nodes node0).durable with
    coordDecision := fun k => if k = 1 then some b else (s.nodes node0).durable.coordDecision k,
    outcome := fun k => if k = 1 then some b else (s.nodes node0).durable.outcome k }
def decideMsg (actor : Member cluster3) (id : Nat) (b : Bool) : Transmission (Member cluster3) Nat (TwoPCMsg cluster3) :=
  ⟨id,node0,actor,1,.decide 1 b⟩
def follower (s : S) (actor : Member cluster3) (b : Bool) (rest : List (Transmission (Member cluster3) Nat (TwoPCMsg cluster3))) : S :=
  receive s actor { (s.nodes actor).durable with
    outcome := fun k => if k = 1 then some b else (s.nodes actor).durable.outcome k }
    (s.nodes actor).volatile rest []
def voted0 := vote start node0 true
def voted1 := vote voted0 node1 true
def voted2 := vote voted1 node2 true
def collected0 := collect voted2 node0 [voteMsg node1 1 true,voteMsg node2 2 true]
def collected1 := collect collected0 node1 [voteMsg node2 2 true]
def collected2 := collect collected1 node2 []
def crashed : S := ⟨setNode collected2.nodes node2
  ⟨(collected2.nodes node2).durable,⟨fun _ => []⟩,.crashed⟩,collected2.pending,collected2.next⟩
def recovered : S := ⟨setNode crashed.nodes node2
  ⟨(crashed.nodes node2).durable,⟨fun _ => []⟩,.running⟩,crashed.pending,crashed.next⟩
def committed := applyLocal recovered node0 (decideDurable recovered true)
  (recovered.nodes node0).volatile (decideOut true [node1,node2])
def final := follower committed node1 true [decideMsg node2 4 true]
theorem initial (fp : FaultProfile) : (Distributed.system cluster3 protocol fp).init start :=
  ⟨rfl,rfl,fun _ => ⟨rfl,rfl,rfl,rfl,rfl⟩⟩
theorem vote0_step : Step cluster3 protocol .crashRecovery start (.process node0 (.local (.castVoteYes 1)) (voteOut true)) voted0 :=
  .process rfl (.castVoteYes rfl rfl) (.refl _)
theorem vote1_step : Step cluster3 protocol .crashRecovery voted0 (.process node1 (.local (.castVoteYes 1)) (voteOut true)) voted1 :=
  .process rfl (.castVoteYes rfl rfl) (.refl _)
theorem vote2_step : Step cluster3 protocol .crashRecovery voted1 (.process node2 (.local (.castVoteYes 1)) (voteOut true)) voted2 :=
  .process rfl (.castVoteYes rfl rfl) (.refl _)
theorem collect0_step : Step cluster3 protocol .crashRecovery voted2 (.deliver (voteMsg node0 0 true) []) collected0 :=
  .deliver rfl (.refl _) (.recvVoteYes rfl) (.refl _)
theorem collect1_step : Step cluster3 protocol .crashRecovery collected0 (.deliver (voteMsg node1 1 true) []) collected1 :=
  .deliver rfl (.refl _) (.recvVoteYes rfl) (.refl _)
theorem collect2_step : Step cluster3 protocol .crashRecovery collected1 (.deliver (voteMsg node2 2 true) []) collected2 :=
  .deliver rfl (.refl _) (.recvVoteYes rfl) (.refl _)
theorem crash_step : Step cluster3 protocol .crashRecovery collected2 (.crash node2) crashed :=
  .crash rfl rfl
theorem recover_step : Step cluster3 protocol .crashRecovery crashed (.recover node2) recovered :=
  .recover rfl rfl
theorem commit_step : Step cluster3 protocol .crashRecovery recovered (.process node0 (.local (.coordCommit 1 [node1,node2])) (decideOut true [node1,node2])) committed :=
  .process rfl (.coordCommit rfl (by unfold IsAllMembers; decide) rfl rfl) (.refl _)
theorem follower_step : Step cluster3 protocol .crashRecovery committed (.deliver (decideMsg node1 3 true) []) final :=
  .deliver rfl (.refl _) (.recvDecide rfl rfl) (.refl _)
def twoPC_commit_traceLabels : List (A × A) :=
  [(.process node0 (.local (.castVoteYes 1)) (voteOut true),.process node0 (.local (.castVoteYes 1)) (voteOut true)),
   (.process node1 (.local (.castVoteYes 1)) (voteOut true),.process node1 (.local (.castVoteYes 1)) (voteOut true)),
   (.process node2 (.local (.castVoteYes 1)) (voteOut true),.process node2 (.local (.castVoteYes 1)) (voteOut true)),
   (.deliver (voteMsg node0 0 true) [],.deliver (voteMsg node0 0 true) []),
   (.deliver (voteMsg node1 1 true) [],.deliver (voteMsg node1 1 true) []),
   (.deliver (voteMsg node2 2 true) [],.deliver (voteMsg node2 2 true) []),
   (.crash node2,.crash node2),
   (.recover node2,.recover node2),
   (.process node0 (.local (.coordCommit 1 [node1,node2])) (decideOut true [node1,node2]),.process node0 (.local (.coordCommit 1 [node1,node2])) (decideOut true [node1,node2])),
   (.deliver (decideMsg node1 3 true) [],.deliver (decideMsg node1 3 true) [])]
theorem balance_twoPC_commit_trace : Foundation.Execution (Distributed.system cluster3 protocol .crashRecovery) start twoPC_commit_traceLabels final :=
  .cons ⟨vote0_step,rfl⟩ (.cons ⟨vote1_step,rfl⟩ (.cons ⟨vote2_step,rfl⟩ (.cons ⟨collect0_step,rfl⟩ (.cons ⟨collect1_step,rfl⟩ (.cons ⟨collect2_step,rfl⟩ (.cons ⟨crash_step,rfl⟩ (.cons ⟨recover_step,rfl⟩ (.cons ⟨commit_step,rfl⟩ (.cons ⟨follower_step,rfl⟩ (.nil))))))))))
theorem twoPC_commit_outcomes : (final.nodes node0).durable.outcome 1 = some true ∧
    (final.nodes node1).durable.outcome 1 = some true := by decide

def noVoted := vote start node1 false
def aborted := receive noVoted node0 (decideDurable noVoted false) (noVoted.nodes node0).volatile
  [] (decideOut false cluster3.members.attach)
def abortFinal := follower aborted node2 false [decideMsg node0 1 false,decideMsg node1 2 false]
theorem no_step : Step cluster3 protocol .reliable start (.process node1 (.local (.castVoteNo 1)) (voteOut false)) noVoted :=
  .process rfl (.castVoteNo (by decide) rfl rfl) (.refl _)
theorem abort_step : Step cluster3 protocol .reliable noVoted (.deliver (voteMsg node1 0 false) (decideOut false cluster3.members.attach)) aborted :=
  .deliver rfl (.refl _) (.recvVoteNo rfl rfl rfl) (.refl _)
theorem abort_follower_step : Step cluster3 protocol .reliable aborted (.deliver (decideMsg node2 3 false) []) abortFinal :=
  .deliver rfl (Take.middle [decideMsg node0 1 false,decideMsg node1 2 false] [] _) (.recvDecide rfl rfl) (.refl _)
def twoPC_abort_traceLabels : List (A × A) :=
  [(.process node1 (.local (.castVoteNo 1)) (voteOut false),.process node1 (.local (.castVoteNo 1)) (voteOut false)),
   (.deliver (voteMsg node1 0 false) (decideOut false cluster3.members.attach),.deliver (voteMsg node1 0 false) (decideOut false cluster3.members.attach)),
   (.deliver (decideMsg node2 3 false) [],.deliver (decideMsg node2 3 false) [])]
theorem balance_twoPC_abort_trace : Foundation.Execution (Distributed.system cluster3 protocol .reliable) start twoPC_abort_traceLabels abortFinal :=
  .cons ⟨no_step,rfl⟩ (.cons ⟨abort_step,rfl⟩ (.cons ⟨abort_follower_step,rfl⟩ (.nil)))
theorem twoPC_abort_outcomes : (abortFinal.nodes node0).durable.outcome 1 = some false ∧
    (abortFinal.nodes node1).durable.outcome 1 = some false ∧
    (abortFinal.nodes node2).durable.outcome 1 = some false := by decide

theorem partial_not_unanimous : ¬ IsAllMembers cluster3 [node0,node1] := by unfold IsAllMembers; decide

def partialState : S := ⟨fun _ => ⟨⟨fun _ => none,fun _ => none,fun _ => none⟩,
  ⟨fun _ => [node0,node1]⟩,.running⟩,[],0⟩
theorem twoPC_partial_cannot_commit (fp : FaultProfile) (outs) (t : S) :
    ¬ Step cluster3 protocol fp partialState (.process node0 (.local (.coordCommit 1 [node1,node2])) outs) t := by
  intro hs
  cases hs with
  | process _ reaction _ =>
    cases reaction with
    | coordCommit _ quorum _ _ => exact partial_not_unanimous quorum

theorem twoPC_coord_cannot_castVoteNo (fp : FaultProfile) (s t : S) (outs) :
    ¬ Step cluster3 protocol fp s (.process node0 (.local (.castVoteNo 1)) outs) t := by
  intro hs
  cases hs with
  | process _ reaction _ =>
    cases reaction with
    | castVoteNo ha _ _ => exact ha rfl
def evalAt (_ : Member cluster3) (_ : Nat) :
    Harmonia.Applications.Kadmos.State 1 1 × Request 1 := (balanceState 100, debit 30)

theorem votes_aligned : TwoPCVotesGatekeeperAligned cluster3 balanceWorld evalAt final := by
  intro m tx hv
  exact congrArg (fun res => res.observation.verdict) balance_debit30_accepted.1

theorem balance_twoPC_all_good : ∀ m : Member cluster3,
    (final.nodes m).durable.voted 1 = some true ∧ Good balanceWorld (balanceState 70) := by
  have hr := Foundation.execution_reachable (initial .crashRecovery) balance_twoPC_commit_trace
  have hg := kadmos_twoPC_commit_all_participants_good cluster3 node0 .crashRecovery
    balanceWorld evalAt hr votes_aligned twoPC_commit_outcomes.1
  intro m
  have hm := hg m
  change (final.nodes m).durable.voted 1 = some true ∧
    Good balanceWorld (interpret balanceWorld (balanceState 100) (debit 30)).state at hm
  rw [balance_debit30_accepted.1] at hm
  exact hm

theorem balance_twoPC_abort_frame :
    (interpret balanceWorld (balanceState 50) (debit 130)).state = balanceState 50 ∧
    (interpret balanceWorld (balanceState 50) (debit 130)).observation.directive = none := by
  have hf := gatekeeperRejected_frame balance_debit130_rejected
  rw [balance_debit130_rejected.1]
  exact hf

end Atomic

namespace Byzantine
open BFTQuorumCommit

def cluster4 : Config Nat := ⟨[0,1,2,3],by decide⟩
def bnode0 : Member cluster4 := ⟨0,by decide⟩
def bnode1 : Member cluster4 := ⟨1,by decide⟩
def bnode2 : Member cluster4 := ⟨2,by decide⟩
def bnode3 : Member cluster4 := ⟨3,by decide⟩
def faulty : List (Member cluster4) := [bnode3]
theorem fault_bound : FaultyBounded cluster4 1 faulty := by unfold FaultyBounded; decide
abbrev S := BFTState cluster4 (Result 1 1)
abbrev A := BFTLabel cluster4 (Result 1 1)
def protocol := bftCommitProtocol (Val := Result 1 1) cluster4 1 faulty
def start : S := ⟨fun _ => ⟨⟨fun _ => none,fun _ => none⟩,⟨fun _ _ => []⟩,.running⟩,[],0⟩
def applyLocal (s : S) (actor : Member cluster4) (d : BFTDurable cluster4 (Result 1 1))
    (v : BFTVolatile cluster4 (Result 1 1)) (outs : List (Outgoing (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1)))) : S :=
  ⟨setNode s.nodes actor ⟨d,v,.running⟩,s.pending ++ allocate actor s.next outs,s.next + outs.length⟩
def receive (s : S) (actor : Member cluster4) (d : BFTDurable cluster4 (Result 1 1))
    (v : BFTVolatile cluster4 (Result 1 1)) (rest : List (Transmission (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1))))
    (outs : List (Outgoing (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1)))) : S :=
  ⟨setNode s.nodes actor ⟨d,v,.running⟩,rest ++ allocate actor s.next outs,s.next + outs.length⟩
def voteOut (proposer : Member cluster4) (val : Result 1 1) : List (Outgoing (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1))) :=
  [⟨proposer,1,.vote 1 proposer val⟩]
def voteMsg (sender proposer : Member cluster4) (val : Result 1 1) (id : Nat) : Transmission (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1)) :=
  ⟨id,sender,proposer,1,.vote 1 proposer val⟩
def equivocate (s : S) (proposer : Member cluster4) (val : Result 1 1) : S :=
  applyLocal s bnode3 (s.nodes bnode3).durable (s.nodes bnode3).volatile (voteOut proposer val)
def vote (s : S) (actor : Member cluster4) : S :=
  applyLocal s actor { (s.nodes actor).durable with
    votedFor := fun k => if k = 1 then some (bnode0,validRes) else (s.nodes actor).durable.votedFor k }
    (s.nodes actor).volatile (voteOut bnode0 validRes)
def collect (s : S) (sender : Member cluster4)
    (rest : List (Transmission (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1)))) : S :=
  receive s bnode0 (s.nodes bnode0).durable
    ⟨fun k val => if k = 1 ∧ val = validRes then
      (if sender ∈ (s.nodes bnode0).volatile.tally 1 validRes then (s.nodes bnode0).volatile.tally 1 validRes
       else sender :: (s.nodes bnode0).volatile.tally 1 validRes) else (s.nodes bnode0).volatile.tally k val⟩ rest []
def bad0 := equivocate start bnode0 validRes
def bad1 := equivocate bad0 bnode1 forgedRes
def voted0 := vote bad1 bnode0
def voted1 := vote voted0 bnode1
def collected3 := collect voted1 bnode3 [voteMsg bnode3 bnode1 forgedRes 1,voteMsg bnode0 bnode0 validRes 2,voteMsg bnode1 bnode0 validRes 3]
def collected1 := collect collected3 bnode1 [voteMsg bnode3 bnode1 forgedRes 1,voteMsg bnode0 bnode0 validRes 2]
def collected0 := collect collected1 bnode0 [voteMsg bnode3 bnode1 forgedRes 1]
def commitOut : List (Outgoing (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1))) := [⟨bnode1,1,.commitQC 1 bnode0 validRes⟩]
def commitMsg : Transmission (Member cluster4) Nat (BFTMsg cluster4 (Result 1 1)) := ⟨4,bnode0,bnode1,1,.commitQC 1 bnode0 validRes⟩
def committed := applyLocal collected0 bnode0
  { (collected0.nodes bnode0).durable with
    committed := fun k => if k = 1 then some (bnode0,validRes) else (collected0.nodes bnode0).durable.committed k }
  (collected0.nodes bnode0).volatile commitOut
def final := receive committed bnode1
  { (committed.nodes bnode1).durable with
    committed := fun k => if k = 1 then some (bnode0,validRes) else (committed.nodes bnode1).durable.committed k }
  (committed.nodes bnode1).volatile [voteMsg bnode3 bnode1 forgedRes 1] []
theorem initial : (Distributed.system cluster4 protocol .omission).init start :=
  ⟨rfl,rfl,fun _ => ⟨rfl,rfl,rfl,rfl⟩⟩
theorem bad0_step : Step cluster4 protocol .omission start (.process bnode3 (.local (.byzantineEquivocate 1 bnode0 validRes)) (voteOut bnode0 validRes)) bad0 :=
  .process rfl (.byzantineEquivocate (by decide)) (.refl _)
theorem bad1_step : Step cluster4 protocol .omission bad0 (.process bnode3 (.local (.byzantineEquivocate 1 bnode1 forgedRes)) (voteOut bnode1 forgedRes)) bad1 :=
  .process rfl (.byzantineEquivocate (by decide)) (.refl _)
theorem vote0_step : Step cluster4 protocol .omission bad1 (.process bnode0 (.local (.castHonestVote 1 bnode0 validRes)) (voteOut bnode0 validRes)) voted0 :=
  .process rfl (.castHonestVote rfl) (.refl _)
theorem vote1_step : Step cluster4 protocol .omission voted0 (.process bnode1 (.local (.castHonestVote 1 bnode0 validRes)) (voteOut bnode0 validRes)) voted1 :=
  .process rfl (.castHonestVote rfl) (.refl _)
theorem collect3_step : Step cluster4 protocol .omission voted1 (.deliver (voteMsg bnode3 bnode0 validRes 0) []) collected3 :=
  .deliver rfl (.refl _) (.recvVote rfl) (.refl _)
theorem collect1_step : Step cluster4 protocol .omission collected3 (.deliver (voteMsg bnode1 bnode0 validRes 3) []) collected1 :=
  .deliver rfl (Take.middle [voteMsg bnode3 bnode1 forgedRes 1,voteMsg bnode0 bnode0 validRes 2] [] _) (.recvVote rfl) (.refl _)
theorem collect0_step : Step cluster4 protocol .omission collected1 (.deliver (voteMsg bnode0 bnode0 validRes 2) []) collected0 :=
  .deliver rfl (Take.middle [voteMsg bnode3 bnode1 forgedRes 1] [] _) (.recvVote rfl) (.refl _)
theorem commit_step : Step cluster4 protocol .omission collected0 (.process bnode0 (.local (.formQCAndCommit 1 validRes [bnode1])) commitOut) committed :=
  .process rfl (.formQCAndCommit (by unfold IsBFTQuorum; decide) rfl) (.refl _)
theorem follower_step : Step cluster4 protocol .omission committed (.deliver commitMsg []) final :=
  .deliver rfl (Take.middle [voteMsg bnode3 bnode1 forgedRes 1] [] _) (.recvCommitQC rfl rfl) (.refl _)
def bft_equivocation_labels : List (A × A) :=
  [(.process bnode3 (.local (.byzantineEquivocate 1 bnode0 validRes)) (voteOut bnode0 validRes),.process bnode3 (.local (.byzantineEquivocate 1 bnode0 validRes)) (voteOut bnode0 validRes)),
   (.process bnode3 (.local (.byzantineEquivocate 1 bnode1 forgedRes)) (voteOut bnode1 forgedRes),.process bnode3 (.local (.byzantineEquivocate 1 bnode1 forgedRes)) (voteOut bnode1 forgedRes)),
   (.process bnode0 (.local (.castHonestVote 1 bnode0 validRes)) (voteOut bnode0 validRes),.process bnode0 (.local (.castHonestVote 1 bnode0 validRes)) (voteOut bnode0 validRes)),
   (.process bnode1 (.local (.castHonestVote 1 bnode0 validRes)) (voteOut bnode0 validRes),.process bnode1 (.local (.castHonestVote 1 bnode0 validRes)) (voteOut bnode0 validRes)),
   (.deliver (voteMsg bnode3 bnode0 validRes 0) [],.deliver (voteMsg bnode3 bnode0 validRes 0) []),
   (.deliver (voteMsg bnode1 bnode0 validRes 3) [],.deliver (voteMsg bnode1 bnode0 validRes 3) []),
   (.deliver (voteMsg bnode0 bnode0 validRes 2) [],.deliver (voteMsg bnode0 bnode0 validRes 2) []),
   (.process bnode0 (.local (.formQCAndCommit 1 validRes [bnode1])) commitOut,.process bnode0 (.local (.formQCAndCommit 1 validRes [bnode1])) commitOut),
   (.deliver commitMsg [],.deliver commitMsg [])]
theorem balance_bft_equivocation_trace : Foundation.Execution (Distributed.system cluster4 protocol .omission) start bft_equivocation_labels final :=
  .cons ⟨bad0_step,rfl⟩ (.cons ⟨bad1_step,rfl⟩ (.cons ⟨vote0_step,rfl⟩ (.cons ⟨vote1_step,rfl⟩ (.cons ⟨collect3_step,rfl⟩ (.cons ⟨collect1_step,rfl⟩ (.cons ⟨collect0_step,rfl⟩ (.cons ⟨commit_step,rfl⟩ (.cons ⟨follower_step,rfl⟩ (.nil)))))))))
theorem bft_equivocation_commits :
    (final.nodes bnode0).durable.committed 1 = some (bnode0,validRes) ∧
    (final.nodes bnode1).durable.committed 1 = some (bnode0,validRes) := by decide

theorem bft_equivocation_reachable : Foundation.Reachable (Distributed.system cluster4 protocol .omission) final :=
  Foundation.execution_reachable initial balance_bft_equivocation_trace

theorem bft_honest_cannot_equivocate (fp : FaultProfile) (s t : S) (outs) :
    ¬ Step cluster4 protocol fp s (.process bnode0 (.local (.byzantineEquivocate 1 bnode1 forgedRes)) outs) t := by
  intro hs
  cases hs with
  | process _ reaction _ =>
    cases reaction with
    | byzantineEquivocate hf => exact (by decide : bnode0 ∉ faulty) hf

theorem subquorum : ¬ IsBFTQuorum cluster4 1 [bnode0,bnode1] := by unfold IsBFTQuorum; decide
def partialState : S := ⟨fun _ => ⟨⟨fun _ => none,fun _ => none⟩,
  ⟨fun _ _ => [bnode0,bnode1]⟩,.running⟩,[],0⟩
theorem bft_subquorum_cannot_commit (fp : FaultProfile) (outs) (t : S) :
    ¬ Step cluster4 protocol fp partialState (.process bnode0 (.local (.formQCAndCommit 1 validRes [bnode1])) outs) t := by
  intro hs
  cases hs with
  | process _ reaction _ =>
    cases reaction with
    | formQCAndCommit quorum _ => exact subquorum quorum

/-- A distinct collector is refused even for a hypothetical quorum-sized tally. -/
theorem bft_forged_proposer_refusal_of_inv (s t : S) (hi : BFTCommitInv cluster4 1 faulty s)
    (cert : BFTCertified cluster4 1 faulty s 1 bnode0 validRes) (fp : FaultProfile) (outs) :
    ¬ Step cluster4 protocol fp s (.process bnode1 (.local (.formQCAndCommit 1 forgedRes [bnode2])) outs) t := by
  intro hs
  cases hs with
  | process _ reaction _ =>
    cases reaction with
    | formQCAndCommit quorum _ =>
      obtain ⟨_,Q,hq,hv⟩ := cert
      have he := bft_quorum_candidates_unique fault_bound quorum hq
        (hi.tally_honest_valid bnode1 1 forgedRes) hv
      exact (by decide : bnode1 ≠ bnode0) he.1

theorem committed_reachable : Foundation.Reachable (Distributed.system cluster4 protocol .omission) committed :=
  Foundation.execution_reachable initial
    (.cons ⟨bad0_step,rfl⟩ (.cons ⟨bad1_step,rfl⟩ (.cons ⟨vote0_step,rfl⟩
      (.cons ⟨vote1_step,rfl⟩ (.cons ⟨collect3_step,rfl⟩ (.cons ⟨collect1_step,rfl⟩
        (.cons ⟨collect0_step,rfl⟩ (.cons ⟨commit_step,rfl⟩ .nil))))))))

theorem balance_bft_forged_negative_refused (t : S) (outs) :
    (committed.nodes bnode1).durable.committed 1 = none ∧
    ¬ Step cluster4 protocol .omission committed
      (.process bnode1 (.local (.formQCAndCommit 1 forgedRes [bnode2])) outs) t := by
  constructor
  · rfl
  · intro hs
    cases hs with
    | process _ reaction _ =>
      cases reaction with
      | formQCAndCommit quorum _ =>
        exact (by unfold IsBFTQuorum; decide :
          ¬ IsBFTQuorum cluster4 1 ((committed.nodes bnode1).volatile.tally 1 forgedRes)) quorum

theorem balance_bft_forged_refused_by_intersection (t : S) (outs) :
    ¬ Step cluster4 protocol .omission committed
      (.process bnode1 (.local (.formQCAndCommit 1 forgedRes [bnode2])) outs) t := by
  have hi := reachable_bftCommitInv cluster4 1 faulty .omission committed_reachable
  exact bft_forged_proposer_refusal_of_inv committed t hi
    (hi.qc_has_quorum.2 bnode0 1 bnode0 validRes rfl) .omission outs
theorem cluster4_cases (m : Member cluster4) :
    m = bnode0 ∨ m = bnode1 ∨ m = bnode2 ∨ m = bnode3 := by
  rcases m with ⟨m, hm⟩
  simp [cluster4] at hm
  rcases hm with h | h | h | h <;> subst m
  · exact Or.inl rfl
  · exact Or.inr (Or.inl rfl)
  · exact Or.inr (Or.inr (Or.inl rfl))
  · exact Or.inr (Or.inr (Or.inr rfl))

theorem honest_votes_aligned : BFTHonestVotesGatekeeperAligned cluster4 balanceWorld faulty final := by
  intro voter leader e res honest hv
  rcases cluster4_cases voter with rfl | rfl | rfl | rfl <;>
    by_cases he : e = 1 <;>
    simp [final, committed, applyLocal, receive, collected0, collected1, collected3,
      collect, voted1, voted0, vote, bad1, bad0, equivocate, start, setNode,
      bnode0, bnode1, bnode2, bnode3, he] at hv
  all_goals
    rcases hv with ⟨_, rfl⟩
    exact ⟨balanceState 100, debit 30, balance_debit30_accepted⟩

theorem balance_bft_committed_good :
    bnode0 = bnode0 ∧ validRes = validRes ∧
    Good balanceWorld (balanceState 70) ∧ Good balanceWorld (balanceState 70) :=
  kadmos_bft_commit_safety_and_good cluster4 1 faulty fault_bound .omission balanceWorld
    bft_equivocation_reachable honest_votes_aligned
    bft_equivocation_commits.1 bft_equivocation_commits.2

end Byzantine

end Harmonia.Applications.Kadmos.Protocols.Tests
