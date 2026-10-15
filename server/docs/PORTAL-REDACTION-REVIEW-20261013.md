# Portal redaction review correction — 2026-10-13

Local branch: `fix/portal-redaction`. Parent: `664fa878`. No push or live Portal calls.
The correction is one new commit; no rewrite or squash. No C# bridge changes.

## Design

Remote tenant projections use key-aware `redact()` after validation. Raw transport bodies
remain available to scope, paging and readback validators. The final boundary uses value-only
`redactValues()`. Seven exclusions are declared in `agent-projection-policy.mjs` and tested exactly.
All credential registries join the process union. OAuth client secrets and tokens join it too.
Reset retires active values for the process lifetime. Diagnostics contain counts and cookie names only.
Unknown broker cookies are private; explicitly public routing cookies must pass shape validation.
Language and consent cookies are excluded. Encoded `nr2*` cookies also register decoded `crf`.
Free text is masked before truncation; the boundary removes credential prefix suffixes of 8+ characters.

## Regression evidence

| Finding | Test | 664fa878 | Corrected tree |
|---|---|---|---|
| A1 | Facade A2A plan to actual approval, fingerprint and plan hash | Fails | Passes |
| M1 | Joined/resumed Portal and API Client reads | Fails (4 cases) | Passes |
| M2 | Broker cookies echoed in logs; C# cookie policy agreement | Fails | Passes |
| M3 | 512/2048/8192 cuts, long SpanName, boundary prefix fallback | Fails | Passes |
| M4 | Concurrent successful/failed login; page-2 recoverRead | Fails (3 cases) | Passes |
| M5 | All facade/standalone tools, 163 operation contracts and state metadata | Fails | Passes |

All 17 tests in the three new regression files fail by assertion on 664fa878 and pass now.
The additional M2 bridge agreement test also fails on 664fa878 and passes now (10/10 bridge tests).
A1/M5 also pass on 6b5f9636. Prior nine regressions remain passing with the requested policy
expectations updated (process union, retired generation and exact exclusions).

## Suites

| Version | Portal | Facade: 38 files |
|---|---|---|
| 6b5f9636 (prior recorded run) | 1004 pass, 0 fail | 347 pass, 6 fail, 73 skipped |
| 664fa878 | 1013 pass, 0 fail (re-executed via git-show loader) | 347 pass, 6 fail, 73 skipped (prior recorded run) |
| Corrected tree | 1031 pass, 0 fail | 347 pass, 6 fail, 73 skipped |

The six discovery failure names match both prior TAP files exactly. Current failures explain
that the O11 kernel CLI is not built. `.ssam-workspace.json` is present for MCP import tests.
Suite and assertion outcomes are recorded here; temporary TAP logs were removed after verification.
Comparison loaders used only in-memory `git show` sources and were removed. No large exports or writes to proof/server trees.

## Server integration map

Target branch: `servidor/fase4-24`; read-only verified ref: `a415531d2591bdc0c80400fc7d20b179f9653ed3`.
Integrate both 664fa878 and this follow-up together. The union below is relative to 6b5f9636,
so it includes required files introduced by the earlier correction. No files were copied.

| Relative source/destination path | Target branch |
|---|---|
| `platforms/odc/facade/debug-odc-background-instance.mjs` | Exists; integrate |
| `platforms/odc/facade/debug-odc-native-background-run.mjs` | Exists; integrate |
| `platforms/odc/facade/odc-access.mjs` | Exists; integrate |
| `platforms/odc/facade/tests/debug-odc-background-instance.test.mjs` | Exists; integrate |
| `platforms/odc/facade/tests/debug-odc-portal-session.test.mjs` | Exists; integrate |
| `platforms/odc/facade/tests/sc-portal-regressions.test.mjs` | Exists; integrate |
| `platforms/odc/portal/README.md` | Exists; integrate |
| `platforms/odc/portal/runtime/access.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/agent-projection-policy.mjs` | New; add |
| `platforms/odc/portal/runtime/agent-projection.mjs` | New; add |
| `platforms/odc/portal/runtime/auth.mjs` | Exists; integrate |
| `platforms/odc/portal/runtime/bridge.mjs` | Exists; integrate |
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
| `platforms/odc/portal/tests/agent-contract-regression.test.mjs` | New; add |
| `platforms/odc/portal/tests/bridge-agreement.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/log-text.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/odc3-context.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/portal-redaction.test.mjs` | New; add |
| `platforms/odc/portal/tests/portal-session-redaction.test.mjs` | New; add |
| `platforms/odc/portal/tests/redaction-before-truncation.test.mjs` | New; add |
| `platforms/odc/portal/tests/security.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/studio-portal.test.mjs` | Exists; integrate |
| `platforms/odc/portal/tests/trace-result.test.mjs` | Exists; integrate |

## Remaining work

L1 remains open: decoded/lowercase-percent/HTML/JSON/base64 variants, 8–15 character
whole-word masking, Portal password registration and exposing registry summary through login/status.
This task retains the requested 16-character minimum. No live proof was run. With the owner,
record cookie names only, confirm at least one session cookie, and count occurrences of active
and retired credential values in output without printing values. No claim is made about live
pagination causes or tenant content. Server integration is a later action.
