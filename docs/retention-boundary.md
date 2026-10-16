# The key survived. Its deduplication record did not.

[한국어](retention-boundary.ko.md) · [Main lab](../README.md)

A stable key prevents duplication only while the effect owner remembers it. This extension gives two owners separate SQLite journals and connects them through real HTTP. The downstream owner can commit an effect, lose its acknowledgement, then prune the key's retained response. A later `absent` lookup cannot distinguish that history from a request that never committed.

The main reservation server still retains its intent history indefinitely. This is a separate, bounded fixture, not a retention change to the application or a provider integration.

## Run the five cases

From the repository root, with the main lab's Node/pnpm requirements:

```sh
pnpm install --frozen-lockfile
pnpm retention
```

Open the printed `reports/retention-*/report.txt` for the bilingual result, or `evidence.json` for HTTP observations, both journals, attempt identities, audit results and source provenance. There is no additional UI. The command starts its own loopback processes, audits after they stop, then removes their temporary databases. Reports contain JSON/text only; no database files or local filesystem paths are exported. Run `node --test tests/retention.test.mjs` for the focused integration checks; `pnpm retention` does not run the complete test suite.

| Case                                                | Downstream effects / local grants | What the fixture checks                                                                           |
| --------------------------------------------------- | --------------------------------: | ------------------------------------------------------------------------------------------------- |
| Two lost acknowledgements; retained positive lookup |                             1 / 1 | An in-window POST replays the receipt; an unpruned lookup can recover it after minimum retention. |
| Same-key retry after pruning                        |                             2 / 1 | A valid local record can coexist with a repeated remote effect.                                   |
| Refuse after cutoff; first request committed        |                             1 / 0 | The intent stays unresolved and no new POST is dispatched.                                        |
| Refuse after cutoff; first request did not commit   |                             0 / 0 | Exactly the same local HTTP responses and database tables can hide a different remote history.    |
| Eligible local send, late downstream arrival        |                             2 / 1 | A local cutoff cannot revoke an already dispatched request.                                       |

These are the expected outcomes checked against each actual run. **“Expected results established” includes two duplicate-effect counterexamples.** The report separately marks `remoteEffectAtMostOnce: false` for those cases.

## A refusal policy is not a remote deadline

The local owner persists the key, command, first-dispatch time and fixed contract before sending. Its retry cutoff is first dispatch + 1,000 retention units − 100 assumed budget units. After the cutoff, an absent lookup leaves `needs-reconciliation`; it does not reset the key or grant permission to retry. A positive matching receipt can still resolve the intent. Restart begins with unknown clock trust; unresolved POSTs are refused, and the persisted clock floor rejects rollback.

The fifth case exposes the remaining timing assumption:

```mermaid
sequenceDiagram
    participant L as Local owner
    participant R as HTTP relay
    participant D as Downstream owner
    L->>D: First POST, logical time 10000
    D->>D: Commit effect; retain key until at least 11000
    D--xL: Acknowledgement lost
    L->>R: Same-key retry at 10020, before cutoff 10900
    Note over R: Hold the actual request
    Note over L,D: Parent advances both fixture clocks to 12000
    D->>D: Prune expired dedup record; retain historical effect
    R->>D: Deliver the unchanged retry
    D->>D: No retained key: commit a second effect
    D-->>L: New receipt; local grant is recorded once
```

The relay preserves the body, key and attempt identity. Its gate determines the schedule; the logical clock difference is not measured network delay. The configured margin assumes a timing budget that this experiment does not establish. Under unbounded transit, even a locally eligible retry may arrive after pruning. A status lookup is never an atomic precondition for the next POST.

## What was implemented and independently checked

[`worker.mjs`](../scripts/retention/worker.mjs) contains the two fixture roles. The downstream transaction couples each synthetic effect with its retained response; only the response entry is pruned. The local transaction couples its accepted receipt and grant. There is no transaction spanning owners. The worker requires its parent IPC channel; clocks, pruning and socket-loss faults are parent controls, not public HTTP administration endpoints.

[`check.mjs`](../scripts/retention/check.mjs) imports no worker validators. It reconstructs retained state in journal order, rejects premature pruning, and binds each local grant to the exact positive outcome of its correlated attempt. A merely existing historical receipt is insufficient. [`sensitivity.mjs`](../scripts/retention/sensitivity.mjs) checks an unchanged copied baseline and five invalid journal variants, including wrong receipts and pruning before expiry. The runner also checks that the two ambiguous cases have identical complete local tables and response bodies without renaming identities.

The auditor can read downstream history after shutdown; the retry policy cannot. Therefore the auditor's knowledge must not be presented as an available reconciliation API. `needs-reconciliation` is an unresolved state, not an implemented operator workflow, refund or proof of non-execution.

## Boundaries and references

This model uses a **minimum** retention duration from downstream acceptance/commit. Expiry makes pruning eligible; it does not make a still-retained receipt invalid. Parent-injected clocks have equal rates and zero offset. They do not establish clock trust, a production network bound, multi-coordinator exclusion or general safe retries. The single local owner serializes attempts for one intent. No liveness, payment atomicity, power-loss durability, provider behavior or global exactly-once claim is made.

Source manifests use the main lab's `sourceEvidence()` before and after execution, with Git state and Node/SQLite versions. They are observations, not execution attestation; edit-and-restore or a hostile host can evade them. Journal replay trusts instrumentation completeness and authenticity and is not a general distributed-history checker. Read-only lookup absence remains uncertainty about historical execution.

- [Stripe API v1 idempotency](https://docs.stripe.com/api/idempotent_requests) documents that reuse after pruning creates a new request and describes a minimum 24-hour retention. This fixture's 1,000 logical units are unrelated to that duration; it does not implement Stripe's response semantics or API v2.
- [PayPal idempotency](https://developer.paypal.com/api/rest/reference/idempotency/) ties safe retry guidance to how long the specific API stores an ID. It does not supply a universal retention contract.
- [Node SQLite](https://nodejs.org/api/sqlite.html) supplies synchronous database operations. Neither fixture awaits network work inside a transaction.

All data and failure schedules are original synthetic examples. The existing [local security boundary](../SECURITY.md) applies; the extension is not an external booking API or an authentication system.
