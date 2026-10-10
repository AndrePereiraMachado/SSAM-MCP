# Public reference boundary: classification and open acceptance cases

2026-09-07. This change inventories source signatures; it does not implement public object/list
transport, alter `Managed` selection, replace the legacy DTO contract, or certify C# equivalence.
There is no separate DTO-by-value opt-in in the current authoring API. Unmarked class/record shapes
remain legacy transport structures; describing their C# identity does not silently reinterpret that API.

`ReferenceBoundary.Analyze` uses symbols and `SourceMember.Of`, independently of method bodies.
`ReferenceModel.Boundary` retains that inventory beside the existing effect-selected execution ABI.
Roots cover transported inputs and the result together; injected `IDataSession` inputs are excluded.
The symbol catalog closes arrays, lists, nullable values and source members, with a visited set for
cycles. Private and `NotMapped` state participates: the public DTO subset is not complete runtime state.
`Id<Entity>` does not introduce an object root merely because its generic argument names an entity.

`RequiresIdentityCodec` identifies object/list/array identities. `CanBeNull` describes runtime
reference null independently of annotations. Text has its own category and requires presence handling;
this inventory does not claim string interning/identity support. `Value` is a category, not a claim that
every framework scalar has a native codec. The inventory neither creates layouts nor initializes state.

## Exact integration points for the graph boundary

1. Resolve the public contract distinction first. A C# identity-preserving entry must use the graph
   protocol; an intentional DTO projection needs an explicit, separately described contract. Neither
   record syntax nor lack of mutation proves that value transport preserves C# semantics.
2. In `ReferenceModel`, seed the existing call-component analysis from the classified graph signatures
   as well as effects once their codec plan exists. Reuse the existing `Runtime`/`ReferenceLayout`
   registry, which registers layouts before members, and `SourceMember.Of` for state. The new catalog
   is a symbol inventory; it must not become a second, divergent object-layout implementation.
3. Extend `ReferenceBoundary` with a validated plan and typed graph schema. Validate every reachable
   state type, then emit reservation and fill phases with one identity map across all arguments.
   Zero handles represent null; empty arrays/lists have nonzero identity. Hydration never executes
   constructors or initializers. Unsupported state must receive a source diagnostic, never default data.
4. In `MethodCompiler`, validate that plan before body lowering, independently of `Managed`. Replace
   the current inline AVCS310 condition with codec-plan diagnostics at the relevant root/member.
   Simply moving today's broad rejection out of `Managed` would break the legacy API without adding
   the requested semantics; this change deliberately does not do that.
5. Have `LogicModel` declare protocol/helper signatures before bodies and map source, implementation
   and protocol separately. Replace the applicable `ReferenceModel.Entry` with GraphIn/GraphOut plus
   Completion. Export imported cells even after detachment, preserve input IDs and return graph state
   on throw; business exceptions must not be raised before those outputs are available.
6. Review `DataModel.Emit` reachability/public visibility for the planned protocol, including transitively
   reachable optional/temporal wrappers. Do not expose frames or export a competing legacy DTO as if it
   were the same API. No reachability changes are included in this classification change.
7. Generate the high-code adapter: hydrate all roots jointly, retain caller identities, apply final
   mutations before interpreting Completion, and distinguish parameter rebinding from object mutation.
   Native manual consumers need the documented protocol. Cross-domain exception filters still require
   the suspension/continuation work described in ADR-020; a data codec cannot recover CLR unwind order.
8. Replace the acceptance harness's direct legacy transport with calls through that real public
   protocol and generated adapter, retaining its identity/null/alias/state assertions. Prove the same
   contract after Verify/save/reload and published execution; a frontend probe is not that proof.

## Reproduction

All commands run from the repository root and write only this frontend run's artifacts. The first
restore may need access to the installed NuGet configuration/cache; no Studio or worker is involved.

```powershell
dotnet test tests/Anvil.CSharp.Tests/Anvil.CSharp.Tests.csproj --artifacts-path .local/data-logic-translator/public-reference-boundary-classification/artifacts --filter FullyQualifiedName~ReferenceBoundaryClassificationTests --logger 'trx;LogFileName=classification.trx' --results-directory .local/data-logic-translator/public-reference-boundary-classification/results

dotnet test tests/Anvil.CSharp.Tests/Anvil.CSharp.Tests.csproj --no-restore --artifacts-path .local/data-logic-translator/public-reference-boundary-classification/artifacts --logger 'trx;LogFileName=frontend-green.trx' --results-directory .local/data-logic-translator/public-reference-boundary-classification/results

$env:ANVIL_RUN_REFERENCE_BOUNDARY_GAPS = '1'
dotnet test tests/Anvil.CSharp.Tests/Anvil.CSharp.Tests.csproj --no-restore --artifacts-path .local/data-logic-translator/public-reference-boundary-classification/artifacts --filter Category=ReferenceBoundaryCapabilityGap --logger 'trx;LogFileName=capability-gaps-red.trx' --results-directory .local/data-logic-translator/public-reference-boundary-classification/results
Remove-Item Env:ANVIL_RUN_REFERENCE_BOUNDARY_GAPS
```

Observed: **20/20 classification tests**; complete frontend suite **361 passed, 6 explicitly skipped**,
zero build warnings after fixes. The opt-in run executed all six capability cases and **failed all six**:

| Case | CLR oracle | Existing frontend transport/probe |
| --- | --- | --- |
| Object Echo | Returns the input identity | Copies the object |
| List Echo | Returns the input list identity | Copies the list |
| Shared members | Both fields refer to the same leaf | Fields become separate copies |
| Non-annotated null | `value == null` is true for null | Compiles to false |
| Self-cycle shape | Echo retains the cyclic input | Recursive native record defaults are not finite |
| Mutate then throw | Caller sees the mutation after the exception | Compilation refuses the public signature with AVCS310 |

These are open acceptance cases with unchanged semantic assertions, not expected-failure tests counted
as support. Their CLR side executes the source only in tests. The direct native-logic probe has value-copy
boundaries and no public graph adapter. In the null case it can carry CLR null to expose constant folding;
that does not establish a native wire encoding. In the cycle case it fails even for a finite input of the
recursive shape, before a cyclic graph can be supplied. Raw outcomes are retained in the separate TRX files.
