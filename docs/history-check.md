# A valid ledger is not the whole history

[한국어](history-check.ko.md) · [Main lab](../README.md)

This optional experiment asks whether the responses a client observed can be explained by a legal order of reservations and lookups. The final ledger can balance while an intermediate response is impossible: a reservation succeeds, then a later lookup says it does not exist.

The original seven scenarios are unchanged. This experiment adds a separate history recorder and checker, using synthetic commands, actual HTTP, two owned Node processes and one shared local SQLite file. It does not implement replicated storage or an external payment system.

## Run and inspect

Use a checkout containing this experiment: `experiment/observed-history`, or a pinned commit from that branch. These commands assume the **repository root** as the working directory. The earlier `main` revision `46c889e` does not include the history commands.

```sh
pnpm install --frozen-lockfile
pnpm history
pnpm history:check reports/<history-run-id>/seed-104729.json
pnpm history:check reports/<history-run-id>/seed-104729-stale-control.json
```

`history` runs three fixed seeds with 13 operations each. Open `report.txt` in the printed output directory to read the bilingual result; `pnpm report` still serves the original seven-scenario report. The new ignored `reports/history-*` directory also contains complete `evidence.json`, standalone original traces and any generated synthetic controls. A control is generated only when its baseline prerequisites are met; missing observations remain unsuccessful and may leave no control file. The command does not replace the original report, update the portfolio hub, or run the full test suite. `history:check` reads a raw trace without starting servers. Its exit codes are 0 for a witness, 1 for a counterexample, 2 for inconclusive, 3 for invalid evidence and 64 for incorrect CLI usage. A counterexample is the expected result when checking a stale control.

From another directory, use `pnpm --dir /absolute/path/to/intent-recovery-lab history:check reports/<history-run-id>/seed-104729.json`; the script runs at that repository root. Alternatively, `node /absolute/path/to/intent-recovery-lab/scripts/check-history.ts /absolute/path/to/trace.json` accepts an absolute trace path. With direct `node`, a relative trace path is resolved from your current working directory. `run-history.ts` always writes reports under its own repository, regardless of the caller's directory.

Each report records the source manifest before and after execution, Git state and runtime versions. These are local provenance observations, not signatures or execution attestation. Edits reverted between the two snapshots are not detected. A seed repeats input choices and dispatch order, not OS scheduling or generated receipt values.

## The useful counterexample

1. An actual POST returns a confirmed reservation.
2. A later actual GET returns that retained outcome.
3. The derived control replaces only that GET response with `404 unseen`.
4. The final ledger and all other recorded events stay unchanged.

The original history must have a legal witness. The control must be exhaustively rejected, while the unchanged ledger still passes the existing ledger checks. This demonstrates why final-state validation and temporal observation checks answer different questions. The mutated response is a checker sensitivity control, **not a defect observed in the server**.

## A small sequential specification

The model starts with 12 places and no retained intents. It is separately written in [spec.ts](../scripts/history/spec.ts), with no store or application-validator imports.

- A new key confirms and consumes quantity if enough capacity remains; otherwise it retains a rejection.
- An existing key with the same command returns its original decision and receipt.
- An existing key with a changed command conflicts without changing state.
- A lookup returns the retained outcome or `unseen`.
- The final snapshot must match the entire retained map, receipts, effects and remaining capacity.

All keys compete for one capacity object. Checking keys independently would be unsound. Receipt values are opaque identities: the model binds observed values and requires stability and uniqueness, rather than predicting UUIDs. The model searches order using invocation/response observations, not server-reported `journalSequence`. Full response metadata must still match retained ledger records; the existing independent ledger checker separately checks journal decisions, hashes and conservation.

This is a documented projection of the reservation API, not a verification of every SQL statement or internal metadata convention. SQLite supplies the single-writer storage boundary; the application determines command identity, retained decisions and API observations.

## A timeout is not an operation return

The parent records a numbered event immediately before each `fetch`, then another after reading the full response or stopping its wait. One controller event order determines precedence; rounded timestamps and clocks in separate processes do not.

A transport-unknown write, including the API's outcome-unknown 503, can remain pending after the local wait ends. The search may include a legal effect or omit a pending operation that is not needed to explain the observed state. It does not infer rollback from a transport error or from a configured fault label.

For example, `POST → timeout → GET unseen → GET confirmed` is legal if the pending reservation takes effect between the two lookups. Conversely, a write invoked **after** a completed lookup cannot explain that earlier read, even if the write later becomes transport-unknown. Predecessor constraints apply to pending operations too. Each attempt has its own identity; a retry does not create a fictitious completion for the preceding attempt.

After every caller has stopped waiting, the controller asks both writers to stop accepting work. Each worker awaits the actual server's `close()`, which drains accepted handlers, and sends an acknowledgement bound to the run, process instance, target and PID. The parent requires both acknowledgements and normal process exits before a fresh reader obtains the final ledger. This fence closes the experiment; a sleep or settled fetch promises alone would not. Failure to establish it never counts as pass. Forced process termination is cleanup, not a substitute drain acknowledgement.

## What each result means

| Result         | Meaning                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Witness        | At least one legal explanation exists for this finite recorded semantic history. Every returned witness is replayed by a separate verifier.                             |
| Counterexample | The bounded search exhausted all eligible orders without a witness, or an observed response/ledger violated its contract.                                               |
| Inconclusive   | The search budget, supported size or closing observation was insufficient. This is not success or a demonstrated consistency defect.                                    |
| Invalid        | Evidence identities, event ordering or required structure cannot support analysis. An actually recorded malformed server response is a protocol counterexample instead. |

The semantic checker may accept a trivial valid history. The **experiment** additionally requires both writers, measured overlap across writers, a same-key retry, a changed-command conflict, capacity rejection, two unknown writes, the early unseen lookup, retained outcomes for the unknown writes and a known read for the control. Missing coverage makes the run unsuccessful. Coverage and the semantic verdict remain separate fields.

The search accepts at most 16 operations and two unknown writes. Default limits are 100,000 visited states and two seconds of search. Budget exhaustion remains inconclusive; it is never converted to a pass. The checker memoizes complete semantic states plus processed operations. It does not partition the shared capacity or use a first-found rejection as a universal failure. A witness is one possible order, not the actual commit order or attribution of an effect to a particular overlapping retry.

## Checking the checker

[Focused fixtures](../tests/history-check.test.ts) cover the legitimate late commit, stale read, future pending write, either legal winner of overlapping changed commands, same-key ambiguity, impossible early capacity rejection, receipt drift, evidence tampering and budget exhaustion. A deliberately simple permutation oracle uses a separately written sequential definition for hand-sized fixtures; it does not import the search or production specification. The separate witness verifier rejects omitted known operations, duplicate steps and precedence violations. [The I/O test](../tests/history-io.test.ts) exercises the two real processes and the stale-read mutation.

The witness verifier checks order and coverage independently of the search, using the same sequential specification. Only the tiny permutation oracle has a separately implemented model. This distinction matters: replay alone would not detect a rule that both search and replay share incorrectly.

This bounded implementation is new code with its own possible defects. It is not a substitute for established linearizability tooling or a proof of correctness. The experiment does not establish liveness, performance, power-loss safety, all schedules, exactly-once network delivery or atomic external effects. Overlapping HTTP intervals do not imply simultaneous SQL execution. No employer code or private production data is included.

## References

The approach follows sequential specifications and real-time precedence from [Herlihy and Wing](https://cs.brown.edu/~mph/HerlihyW90/p463-herlihy.pdf). Pending operations must also obey invocation bounds; the amendment in [Sela, Herlihy and Petrank](https://arxiv.org/html/2105.06737v2) makes that subtle restriction explicit.

[Porcupine](https://github.com/anishathalye/porcupine) is established executable-model checking software, not the implementation used here. [Jepsen's test-design discussion](https://jepsen.io/analyses/tendermint-0-10-2) explains why more indeterminate operations enlarge possible explanations and weaken anomaly detection. [SQLite's isolation documentation](https://www.sqlite.org/isolation.html) describes the single-writer boundary used by this lab.
