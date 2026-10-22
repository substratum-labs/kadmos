# Repository contract preflight receipt

## Current measured receipt — F4 owner verification, 2026-10-21

Owner build/typecheck and full `pnpm run verify`: **772/772**, no failures/skips/
cancellations, including the existing packed NodeNext consumer. Relevant HTTP,
journal, replay, SCRIPTED and contract checks: **75/75**. Finite order-World fuzz:
30 runs, no divergence; package and public SCRIPTED demo passed. Four bounded
corrections cover documented verbs, verifier environment/functional classification,
reconstruction undo, and exact host-command replay binding. Compiling RED reproduced
the behavior faults before correction; the original 767 baseline remains green.

Actual installed-backend A20 ran engine **bf1bbc47f1566064b58e4b22ba6865614c4e0f10**,
Codex CLI **0.163.0**, on macOS with Node26. Two of the original three attempts were
used. Attempt1 backend exited0, independent requirement-law exited1 and routed
WORLD_CHANGE_REQUIRED. After explicit chat approval “同意。”, actual `approve-world`
and `continue` retained the installed descriptor; attempt2 backend exited0 and
requirement-law/typecheck/functional checks all exited0. Fresh independent complete
readback delivered revision
`r-83ecdc64a5fd02b2f995733156a1574d5f2e42ee9d7d8aa0822d2080423a01b9`.
Independent HTTP ledger recorded `a20-payment`, committed, count1. CLI/server exited0;
sampled tracked process closure left no remaining members. A20 is real two-attempt
execution; the separate public SCRIPTED repair still uses three iterations.

Exact approval: proposal `order-cap-50000-v1`, proposal digest
`sha256:83ecdc64a5fd02b2f995733156a1574d5f2e42ee9d7d8aa0822d2080423a01b9`,
patch digest `sha256:87b9cf97bcf26aec027ec604bb978f64f99bac1ef2284b8442dda6b7c6770450`,
base `r0` World `sha256:13cbb953c1cd720256eb59f7972e981ed43b7f8e0321488970f12511ae06634e`.
Original trusted decision timestamp: **2026-10-21T22:52:05.703Z**. The successor
marks receipt `epic55-a20-live/a1` stale and reruns every check; old evidence is
historical, never approval for the new binding.

Original start **2026-10-21T21:43:41.686Z**, deadline **23:13:41.686Z**;
maxAttempts3, attempt1200000ms, verifier300000ms, overall5400000ms, killGrace2000ms.
Approval renewed neither deadline nor attempts; attempt1 remained unchanged.
Backend argv: `exec --json --color never --sandbox workspace-write --cd
/private/tmp/epic55-a20-live/host/artifacts-workspace -`, executable
`/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js`. Instructions use stdin;
operator model/auth/default configuration is inherited, with no model override.
The host CLI invokes `node bin/kadmos.js repo continue --input <host-input.json>`.

The initial launcher's supplementary raw-wire policy readback had an ordering
mismatch; canonical readControl-derived policy later verified the same paused
checkpoint without another model call. A first continuation launcher stopped
before server/model/ONCE because its gate included committed coordination ledgers
as frozen business inputs; its corrected successor consumed no extra attempt.
Both diagnostics and original exits are preserved. Earlier failed smoke/root3/3
unknown and successful R3 observations remain separate history.

F4 verified local regressions and fresh-read compatibility with those original live
artifacts; **this F4 head did not run the installed backend**. Actual business World
approval is recorded; final assembled physical review and whole-Epic Yong acceptance
remain pending. Later sections below preserve dated historical checkpoints.

Qualification is bounded to the measured local macOS setup. Linux/Windows live CLI
qualification is pending; portable argv tests are not platform qualification.
One successor/default finite budget, one scoped host operation, exclusive checker
ownership, trusted same-user filesystem and sampled process lineage are explicit
limits. Missing evidence/power-loss outcomes can remain unknown. No universal
exactly-once theorem, arbitrary network-effect census or hostile OS isolation claim.


Current owner checkpoint (2026-10-21, F2): repository loop and Task E commands are
implemented; D/E physical review receipts remain scoped to their frozen commits.
F1 owner full suite was 750/750; F2 adds runtime host-journal and SCRIPTED repair
checks. Current final measured verification belongs to the F2 receipt below.
Live A20, exact human business World approval and assembled F physical review
remain pending. No whole-Epic acceptance is claimed.

Historical checkpoints below are retained as dated evidence, not current status.
The original K-02 compiler/checker and existing `run` remain unchanged.

Measured host: macOS 27.0.1 arm64, Node 26.0.0, Codex CLI 0.163.0.
An installed read-only CLI invocation emitted JSONL, reported the requested cwd
and exposed turn usage. Invalid cwd and restricted-parent initialization returned
noninteractive failures. A detached-group host probe stopped a CLI waiting on
stdin plus a heartbeat descendant. Live tool-execution cancellation and other
platforms remain unqualified.

Reproduce from the repository root:

```sh
pnpm run build
node --test dist/tests/test_repository_contracts.test.js
node --test dist/tests/test_coding_backend.test.js dist/tests/test_repository_loop.test.js dist/tests/test_world_revision.test.js dist/tests/test_repository_demo.test.js
```

Historical B checkpoint (2026-10-20): the contract gate passed 5 tests. The behavioral command
then ran 40 tests: 39 intentionally failed assertions against pending implementations;
one conservative ambiguous-routing case passed. D2a now implements bounded fixed-World
loop/feedback; current measured counts and exact remaining failures are archived in
the coordination D2a evidence packet. CLI/live, E and F remain pending. No tests are skipped. A20 remains
an unexecuted live gate. The unchanged legacy baseline is 268 passing tests,
with packed NodeNext consumer and strict typecheck passing separately. The full
suite is intentionally RED. Each future implementation phase must replace its
pending seam and earn the corresponding behavioral assertions.

The host-owned fixture qualifies literal argv/stdin handling, a real installed
TypeScript diagnostic, and a separate actuator process's refusal, commit/drop,
same-ID deduplication and restart query. Those fixture checks do not substitute
for the missing controller/backend behavior. Finite tests do not establish
universal correctness, isolation or crash durability.

Historical Task C checkpoint (2026-10-20): the argv backend and workspace implementation are now present.
Focused A01–A04 plus lifecycle/workspace regressions pass; D–F behavior remains
intentionally RED. A single Codex 0.163.0 smoke actually edited the disposable
file (41→42) and exited 0. Its child-group escape conservatively produced
`launch_failed` / `treeStopped: unknown`; this is failed qualification evidence,
not a delivered task or an A20 substitute. No auth/quota block was reported.

### Historical C-Q qualification clarification (subsequently physically accepted)

For the existing single trusted operator, non-adversarial local profile,
`treeStopped: true` means sampled tracked-lineage closure, not universal process
containment. A PGID departure alone is not unresolved work: it may qualify only
when a later successful inventory observes that PID absent, before supervisor
cleanup, while its last observed chain reaches an ancestor still present and rooted in the
launched process. Missing intermediate links must all be tracked departures also
observed absent in that inventory; nested tools may close in the same sample. Every observed departure must meet that condition. Reparenting,
a departure surviving to cleanup (even if killed), inventory failure/malformed
inventory, or remaining tracked members yields unknown. Cancellation and timeout
remain failures regardless of closure. Missing lifecycle writes throw rather
than returning a candidate. Full timestamped inventories, natural closures and
lineage-loss flags are retained beside stdout. Sampling cannot detect an
unobserved rapid double-fork/escape; no adversarial containment is claimed.
The literal argv, stdin, inherited operator configuration and finite limits are
unchanged. The original C failed smoke remains failed qualification evidence.
This bounded clarification of B's tracked-tree wording requires physical Grok
review before D; it grants no software delivery, World approval or A20 result.


## F2 owner verification — 2026-10-21

Final signed build/typecheck and `pnpm run verify`: **767/767**
passing, zero failures/skips/cancellations. This includes all 750 F1 baseline tests
and 17 added F2 tests, plus the existing packed NodeNext consumer gate. Relevant
HTTP/journal/SCRIPTED/A17–A19/contract checks: 70/70.
Finite order-World differential fuzz: 30 runs, no divergence; package build/pack
and diff hygiene passed. These are owner observations on the frozen technical
files, not independent reviewer acceptance. The final source commit records these
files and this documentation-only measured receipt.

Actual compiling RED retained: five runtime-journal assertions; a second actual
effect after unknown; deliberately faulty Fabric's independent guard assertion;
frozen subprocess cwd. GREEN proves blocked delivery with effect retained after
otherwise passing or functionally failing checks, no second backend/actuation,
fresh-process restart/readback, exact SCRIPTED archive approval fencing, journal
corruption/alias/late-census refusal, and separate known commit/refusal/reconciliation.
The SCRIPTED example records three multi-file iterations with independent guard
and HTTP retry diagnostics before final acceptance. Negative fixture effects are
scoped separately. No installed-backend invocation or business World approval was
performed by F2. Task E commands are implemented. E Minor2 remains safely deferred;
live A20, assembled physical Grok review, Yong acceptance and cognitive delivery
remain pending.

## F5 platform CI qualification boundary

The default live target remains macOS; the frozen A20 installed Codex run used
engine bf1bbc4. Linux CI exercises the real POSIX fixture supervisor, not an
installed Codex backend. Linux installed-backend delivery remains unqualified.
Windows does not support process-tree qualification: the backend refuses before
launch, with no candidate or delivery. Its CI suite runs every legacy test plus
repository contracts and portable argv/stdin/snapshot boundary checks, including
the actual unsupported-platform no-launch check. POSIX runtime qualification
files are listed as NOT_EXECUTED / unqualified on Windows and never counted PASS.
macOS/Linux run every test, with no skips or expected failures.

F4 local 772/772 did not establish remote matrix success: run39691008888 failed.
F5 corrects PGID0 inventory validation (positive PID still required; malformed
rows still poison qualification), adds explicit Windows test selection and gives
finite verifier fixtures startup headroom while preserving deadline assertions.
At F5 source check-in, local macOS Node26 verification passed 780/780.
Configured matrix scope is 780 cases per macOS/Linux job and 276 per Windows
job (268 unchanged legacy + five contracts + three portable boundary cases).
Remote counts and qualification require the exact-head terminal PR checks;
this check-in does not assert remote success. No new
Windows supervision, model installation, runtime authority or A20 rerun.

The first F5 matrix at bbb42a1 confirmed actual Linux PGID0 rows and reduced
Linux failures from213–216 to1–2; Windows275 passed on the synthetic merge. Residual actual failures
identified a noncanonical /bin/echo test fixture and finite strict-timeout /
split-seam readiness budgets. The follow-up canonicalizes that frozen fixture
path and gives only those fixtures3000ms; production limits and assertions
stay unchanged. Remote qualification still requires terminal exact-head CI.

CI now checks out the exact PR source head. The earlier synthetic merge had
picked up a concurrent main cleanup removing one legacy assertion, yielding
779 POSIX /275 Windows cases. Exact-head qualification preserves all original
source assertions:780 POSIX /276 Windows, with separately executed packed
NodeNext consumer checks. No branch/main merge or legacy-test edit is made.
