# Intent / Recovery

**The response disappeared. The reservation didn’t.**

[한국어](README.ko.md) · [Design decisions](docs/design.md) · [Security boundary](SECURITY.md)

A browser can lose the response after the server has reserved a place. Offering a fresh booking then risks creating a second reservation, even though the first request appeared to fail.

This personal lab implements a fictional reservation service with a React UI, an HTTP server and SQLite. The client saves the reservation key and command before sending; the server commits the outcome, reservation and capacity change together. Retries and reloads reuse the reservation key. A separate request sequence prevents late responses from replacing newer state.

When no response arrives, the UI keeps the result **unknown**. Recovery requires retaining the outcome, which costs storage; the user may also have to wait for a definitive answer.

## See the difference

| After an uncertain request outcome      | Observable result                                         |
| --------------------------------------- | --------------------------------------------------------- |
| Retry the same command with a fresh key | Two reservations. The server sees two legitimate intents. |
| Retry with the original key and command | One reservation. The original receipt is recovered.       |
| Stop waiting, then observe `404 unseen` | Still uncertain. An earlier request can commit later.     |

The first two rows lose the response after commit. The third stops waiting before the original request commits. These are executed counterexamples, not prewritten success animations. The first row is an intentionally incomplete client policy; the interactive client preserves the original intent.

**A balanced ledger is not enough.** A separate [bounded history checker](docs/history-check.md) searches for an execution order that explains the recorded responses, including writes whose callers stopped waiting. Deliberately changing one later lookup to `404 unseen` leaves the final ledger intact but makes the observed history impossible. This is a checker test, not a recorded server defect. A matching order explains that recording; it does not reveal the actual commit order or prove every schedule.

## Run locally

Requires **Node 24.15–24.x** and **pnpm 11.25.0**. Tested on Windows x64 with Node 24.15.0 / SQLite 3.51.3 and Node 24.19.0 / SQLite 3.53.3. Node’s built-in SQLite API is used; no database service or credentials are needed.

```sh
pnpm install --frozen-lockfile
```

**Explore recovery in the browser:**

```sh
pnpm demo
```

Open the printed loopback URL. Prepare a reservation and send it with the default **drop after commit** fault. The browser remains uncertain while the journal shows one reservation. Recover the result, switch languages, reload, or open the recovery link in another tab.

**Run and inspect the evidence:**

```sh
pnpm experiment  # seven recovery, crash and ledger scenarios
pnpm report      # view their latest generated report

pnpm history     # three seeds, 13 API operations per recorded history
pnpm history:report reports/<printed-history-run-id>
```

Run these commands from the repository root. Each experiment uses fresh databases and cleans up its child processes. The ignored `reports/` directory holds raw evidence and source digests; the history viewer distinguishes actual observations from the deliberately changed lookup. A seed reproduces input choices and dispatch order, not OS scheduling. Reports record local provenance, not cryptographic execution attestation.

Run `pnpm verify` separately for tests, strict type checking and the production client build.

A separate [retention-boundary extension](docs/retention-boundary.md), run with `pnpm retention`, asks what happens when a downstream owner forgets the key. Two independent journals expose why an absent lookup cannot rule out an earlier effect—and why a retry sent before a local cutoff can still arrive after remote pruning. It does not change the main server's retention or add another UI.

## What is worth reviewing

- **Two identities with different lifetimes.** The request sequence belongs to one client controller; the reservation key survives reloads.
- **Uncertainty is a real state.** Transport errors, timeouts, local aborts and a point-in-time “unseen” lookup never become a business rejection. An app-return hint can trigger a lookup; it cannot mint a receipt.
- **One atomic boundary.** The intent outcome, reservation effect and capacity update commit together. A different command under the same key conflicts. A capacity rejection is retained too.
- **Evidence is tested as well.** An independently authored checker reconstructs capacity decisions in journal order. Mutation probes verify that mismatched response identities, unjustified rejections and stale checkpoint files cannot quietly produce green reports.

## Core implementation

| File                                                       | Decision to inspect                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`src/client/model.ts`](src/client/model.ts)               | Persist before send; uncertainty; response correlation; late-response handling               |
| [`src/client/App.tsx`](src/client/App.tsx)                 | Preserve state across language changes and same-intent navigation; conditional focus handoff |
| [`src/client/feedback.ts`](src/client/feedback.ts)         | Prevent old clipboard completions from updating a later screen                               |
| [`src/server/store.ts`](src/server/store.ts)               | Serialized writer admission; coupled records; immutable outcomes                             |
| [`scripts/experiments.ts`](scripts/experiments.ts)         | Fresh-key counterexample; late commit; process death; two server processes                   |
| [`scripts/check-ledger.ts`](scripts/check-ledger.ts)       | Independent effect, capacity and decision-history checks                                     |
| [`scripts/history/checker.ts`](scripts/history/checker.ts) | Bounded order search with shared capacity and unknown writes                                 |
| [`scripts/history/replay.ts`](scripts/history/replay.ts)   | Witness coverage and precedence checks using the same sequential model                       |

## Claim and limits

**Within one SQLite transaction boundary and retained intent history, one intent creates at most one reservation effect.** The observed process-crash experiments recover the expected pre- or post-commit state.

This does not deduplicate different keys describing the same human intention. It does not provide exactly-once network delivery, atomic external payments, distributed availability, authentication, fairness, or proof over every possible concurrent history. The crash harness terminates a real child process; it does not inject power loss or arbitrary disk corruption. Configured delays are fixtures, not performance results.

This is an original personal lab with fictional data. It contains no employer code, internal architecture, customer records, or claims of employer production impact. The patterns build on [AWS’s idempotent API guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/), [Stripe’s documented idempotency behavior](https://docs.stripe.com/api/idempotent_requests), and [SQLite’s atomic commit model](https://sqlite.org/atomiccommit.html); the lab is not affiliated with those projects.
