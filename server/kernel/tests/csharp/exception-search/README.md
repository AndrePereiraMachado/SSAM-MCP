# Independent CLR exception search/unwind corpus

These six ordinary C# scenarios were authored without reading Anvil implementation,
implementation tests, generators, prior receipts, or session history. The only
existing repository file consulted was `tests/Anvil.CSharp.Tests/Anvil.CSharp.Tests.csproj`,
to reuse the installed test framework versions. This is semantic source authoring,
not a blind test of the public SSAM workflow.

`expected.cases.json` was authored before compiling or executing any corpus source.
`freeze.cases.json` records the source and expectation SHA-256 values, frozen at
2026-09-08T04:23:19.7307664Z. The test verifies those hashes before execution. No
source or expectation was changed after the freeze, and no authoring fixes were
needed after the first run.

| Scenario | Discriminating CLR observation |
|---|---|
| Caller filter / callee finally | Filter observes state 0; callee finally changes it to 1 before catch. |
| Captured caller scalar | Filter changes the shared scalar from 10 to 17; callee finally observes 17 and changes it to 117; catch observes 117. |
| Replacement thrown by finally | The external filter first sees the original object and state 0, then runs again for the replacement object and state 1. |
| Throwing filter helper | Helper cleanup runs, preserving state 11; the filter acts false; fallback sees the original object; body cleanup produces state 111. |
| Reassigned catch variable / bare rethrow | The catch local refers to the replacement, but bare `throw;` escapes with the originally caught object. |
| Recursive activations | Filters inspect depths 0, 1, 2 before cleanup; depth 2 catches; cleanup order is 0, 1, 2, 3, with distinct per-activation scalar values. |

Identity labels come from `ReferenceEquals` against the actual exception objects,
not exception messages or types. `finalException` means the object escaping the
scenario into its observation boundary; `no-return` means that the scenario's
normal return path was not reached. Event order, outcome, identity, and final state
are compared independently.

`ExceptionSearchSourceTests.cs` compiles the seven `.cs.txt` files (six cases and a
shared console driver) with the installed SDK's Roslyn compiler, executes the DLL
on the real CLR, and compares its JSON output with the frozen expectations. The
generated project uses `UseAppHost=false` and a portable PDB. These scenarios make
no source-location assertions, so no PDB source-position comparison is claimed.

The first run used an isolated test project under `.local/exception-search-source-tests`,
containing only the new test file and the same three test packages/versions already
declared by the existing test project. It did not reference or compile Anvil source.
No existing package declarations or dependencies were changed.

```powershell
dotnet test .local/exception-search-source-tests/ExceptionSearchSourceTests.csproj -p:UseAppHost=false --logger 'console;verbosity=detailed' --logger 'trx;LogFileName=first-run.trx' --results-directory .local/exception-search-source-tests/first-run
```

First run: **6 passed, 0 failed**, SDK 10.0.301, observed test host .NET 8.0.18,
reported test duration 3.8052 seconds. `first-run.cases.json` records the hashes and
artifact paths. Build and execution outputs stay in this task's `.local` directories.

This proves only the source CLR outcomes. It does not prove C# translation,
native action graphs, ModelHost behavior, SS4/SS5, Studio merge, publication, or
server execution. No native/ModelHost/Studio/live calls were made. The existing
12-case exception-control-flow corpus was not read or changed.
