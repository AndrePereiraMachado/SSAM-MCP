# Portal redaction review 2 — 2026-10-14

Branch: `fix/portal-redaction`. Starting commit: `834f7542`.
K1 commit: `c3b51480`; C6 commit: `22eb0b19`. C1/C2 are the following commit.
Author: Andre Machado <andre_c_machado@hotmail.com>. No rewrite, squash, push,
live Portal request, C# bridge change or write to proof/server trees.

## Implementation

C2 compiles a versioned Aho-Corasick matcher once for the process set and for typed
registries. Raw and encodeURIComponent patterns keep the existing global longest-value
priority and leftmost occurrence order. Terminal failure links, lazy shorter-candidate
lookup and sparse rank buckets avoid inherited-output explosions and per-string scans
or empty-array allocation for every retained value. No full-value list, encoding or
credential sorting is rebuilt for each text field.

The process source itself has a FIFO ceiling of 4,096 values, not just its matcher.
A registry keeps up to 128 active and 128 retired values. Duplicate observations do
not rejuvenate old values. Eviction invalidates cached snapshots and matchers. Reset
retires current values, clears cookie names and short-value counts, and preserves
recent credentials in the process window. Explicit broker/OAuth disposal removes live
registration; FinalizationRegistry also removes abandoned weak handles. Timer observers,
debugRun and debug-runtime release sessions in their actual cleanup paths. The process
summary counts the union of live active values, so shared credentials remain active
until their last live owner retires them. Diagnostics reveal only counts and names.

Only actually truncated fields receive a private WeakMap mark. Marks survive remote
redaction clones and are consumed by the value-only final boundary. Partial credential
prefixes in complete typed text are preserved (C3). Remote transport bodies and identity,
scope, paging and write confirmation remain validated before redaction. All seven local
boundary exclusions and the 16-character minimum remain unchanged.

C1 makes the facade planner resolve discoveryOperationUuid from a confirmed discovery
receipt in both URL and JSON modes. It validates receipt identity/hash, optional tenant,
connection name, stage and base URL without network calls. URL mode without discovery
returns A2A_DISCOVERY_REQUIRED; a copied card differing from the raw receipt returns
A2A_DISCOVERY_CARD_MISMATCH. JSON approval also binds the discovered raw card. The plan
still bypasses the agent boundary. Tool schema, description, discover catalog guidance
and README now explain receipt-backed planning without copying displayed card text.

K1 uses os.tmpdir(). A temporary test copy replaced the old path with a nonexistent
folder: 834f7542 gave ENOENT (2 pass/1 fail), corrected copy passed 3/3 without that folder.
C6 replaced the 42 invalid Latin-1 bytes with UTF-8, with no BOM and final normal line
endings. All changed text files decode as UTF-8 without BOM.

## Finding evidence

| Finding | Test | 834f7542 | Corrected tree |
|---|---|---|---|
| C2 | Real 1,000-span trace: N=108 and N=1,008, <1 second execution and event-loop gap | Fails duration; N=1,008 hard timeout | Passes |
| C2 | 8 MiB text, 1,000 registered values, both redactors <2 seconds | Fails both duration guards | Passes |
| C2 | 1,000 login, Set-Cookie, broker release and OAuth cycles | Grows to 21,001 process values | Stays at 4,096 |
| C2 | Oldest eviction, matcher invalidation and broker disposal | Fails assertions | Passes |
| C2/C3 | Complete typed strings sharing credential prefixes | Fails assertion | Passes |
| C1 | Real facade/access/journal discovery → receipt plan → approval → native test, URL and JSON | Ten new cases fail; receipt-plan input unsupported | Ten cases pass |
| K1 | Test copy with old scratch destination replaced by nonexistent directory | ENOENT | Passes with os.tmpdir() |
| C6 | Strict UTF-8 decoding | 42 invalid bytes | Valid UTF-8, no BOM |

C2 has 13 tests, including positive controls for unchanged longest-first output, raw/encoded
replacement, versioned caching and overlap behavior. N=0 and positive equivalence controls
also pass in the old code; they are not claimed as old-version failures. New nested-pattern
stress coverage protects the matcher against the implementation issue caught during this
work. A1/M1–M5, all nine earlier regressions and all ten bridge-agreement cases pass.
Reproducers e1–e4 and e6 were re-executed read-only against this worktree: no logged credential
leak. e6 included the actual 29-second timeout followed by an identical resumed call.

## Timings

Identical 973,644-byte synthetic trace shape, 1,000 spans, real PortalReadAdapter.execute.
Baseline was loaded from git show 834f7542 in isolated workers, without a tree copy.
The baseline N=1,008 worker was terminated at 100 seconds on this host; the review's
81.9-second result is a separate earlier measurement. No finished baseline gap is claimed.

| Registered values | Baseline elapsed | Corrected elapsed | Corrected largest loop gap |
|---|---|---|---|
| 0 | 131.7 ms | 70.5 ms | 70.7 ms |
| 108 | 11,488.8 ms | 115.2 ms | 115.4 ms |
| 1008 | >100,000 ms (worker stopped) | 257.0 ms | 257.1 ms |

8 MiB and 1,000 process values: redactValues 5,085.5 → 490.5 ms;
redact 3,661.7 → 364.7 ms. Outputs contain no sampled credential.
Nested overlapping values on 1 MiB repetitive text: 100 patterns 496.8 ms;
1,000 patterns 659.8 ms, 59.3 MiB heap.
Both match the former longest-first output exactly. The isolated stress worker has a
256 MiB heap ceiling and five-second hard stop. Timing guards include matcher compilation.

## Suites

| Suite | 834f7542 (reviewed baseline) | Corrected tree |
|---|---|---|
| Complete Portal, including bridge agreement | 1,031 pass, 0 fail | 1,054 pass, 0 fail |
| Facade: same 38 files | 347 pass, 6 fail, 73 skipped | 347 pass, 6 fail, 73 skipped |

The Portal final run used --test-concurrency=1 to avoid CPU contention in duration guards.
The facade failure names match rev2/claims/facade-834f7542.tap exactly: all six are preexisting
O11 kernel CLI discovery failures. The workspace marker required by MCP import is present.
JSON catalog validity, UTF-8 checks, syntax/targeted lifecycle checks and git diff --check pass.
Temporary logs, loaders, copied tests and commit-message scratch files are removed after
recording the outcomes here. No tests depend on C:/t/portal-redact.

## Server integration map

Read-only verified target: servidor/fase4-24, ref `a415531d2591bdc0c80400fc7d20b179f9653ed3`.
No file was copied. Integrate the complete correction series starting at 664fa878, including
834f7542, the K1/C6 commits and the final C1/C2 follow-up. The cumulative path map is relative
to 6b5f9636 and includes earlier dependencies; it is not a claim of merge compatibility.

| Relative source/destination path | Target branch |
|---|---|
| `docs/PORTAL-REDACTION-REVIEW-20261013.md` | New; add |
| `docs/PORTAL-REDACTION-REVIEW2-20261014.md` | New; add |
| `platforms/odc/facade/catalog/tools.json` | Exists; integrate |
| `platforms/odc/facade/debug-odc-background-instance.mjs` | Exists; integrate |
| `platforms/odc/facade/debug-odc-native-background-run.mjs` | Exists; integrate |
| `platforms/odc/facade/debug-odc-portal.mjs` | Exists; integrate |
| `platforms/odc/facade/debug-run.mjs` | Exists; integrate |
| `platforms/odc/facade/debug-runtime.mjs` | Exists; integrate |
| `platforms/odc/facade/odc-access.mjs` | Exists; integrate |
| `platforms/odc/facade/tests/debug-odc-background-instance.test.mjs` | Exists; integrate |
| `platforms/odc/facade/tests/debug-odc-portal-session.test.mjs` | Exists; integrate |
| `platforms/odc/facade/tests/sc-portal-regressions.test.mjs` | Exists; integrate |
| `platforms/odc/portal/README.md` | Exists; integrate |
| `platforms/odc/portal/runtime/a2a-connection-approval.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/access.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/agent-projection-policy.mjs` | New; add |
| `platforms/odc/portal/runtime/agent-projection.mjs` | New; add |
| `platforms/odc/portal/runtime/auth.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/bridge.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/credential-matcher.mjs` | New; add |
| `platforms/odc/portal/runtime/credential-registry.mjs` | New; add |
| `platforms/odc/portal/runtime/errors.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/odc3-context.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/odc3-host.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/pagination-diagnostic.mjs` | New; add |
| `platforms/odc/portal/runtime/portal-read.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/portal-routes.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/projection-context.mjs` | New; add |
| `platforms/odc/portal/runtime/server.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/studio-portal.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/trace-metadata-result.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/trace-result.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/a2a-discovery-plan-regression.test.mjs` | New; add |
| `platforms/odc/portal/tests/agent-contract-regression.test.mjs` | New; add |
| `platforms/odc/portal/tests/bridge-agreement.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/fixtures/redaction-performance-worker.mjs` | New; add |
| `platforms/odc/portal/tests/log-text.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/odc3-context.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/portal-redaction.test.mjs` | New; add |
| `platforms/odc/portal/tests/portal-session-redaction.test.mjs` | New; add |
| `platforms/odc/portal/tests/redaction-before-truncation.test.mjs` | New; add |
| `platforms/odc/portal/tests/redaction-performance.test.mjs` | New; add |
| `platforms/odc/portal/tests/security.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/studio-portal.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/trace-result.test.mjs` | Exists; integrate |

## Remaining work

L1 from review 1 remains open: additional decoded/lowercase-percent/HTML/JSON/base64 forms,
8–15-character whole-word masking, Portal password registration and public login/status
exposure of registry summaries. This task retains the requested 16-character minimum.

Review-2 C3, C5, C6 and K1 were addressed. Other review-2 low findings remain outside this
correction: V1–V11, C4 (except the already documented overlap/longest-first behavior). They
cover split-line and encoded forms, username/password, language/consent shape/origin guards,
short fragments in typed fields, host-shaped cookie values, headless Studio base64 handling,
thrown-error projection, Studio/debugger tokens, key/numeric/generated-marker edge cases,
additional URL/Bearer forms and unrestricted extra card fields. Their realism/verification
status remains that of REVISAO-2.md; no new live evidence is claimed.

The finite FIFO window deliberately permits oldest-value eviction, as requested instead
of a TTL. Reads remain protected while their credentials are retained; it is not an
indefinite or refresh-token-expiry guarantee. No live proof or server integration ran.
With the owner, record cookie names only, count active and retired values after each login,
and measure a large trace after several logins. Never print credentials or automate login.
