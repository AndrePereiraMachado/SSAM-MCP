# IReadOnlyList<T> as a concrete collection view

This implementation extends reference graph ABI4 with a readonly-list
shape. It is integrated; the combined personal-lab version 5043 passed 18 HTTP
cases, including List<byte>/byte[] views. ABI2 and ABI3 remain closed. The existing temporal descriptors, fields,
validation and negotiation in ABI4 are unchanged. This does not activate the
staged graph profile as the default compiler entry.

The independent review also required equivalent element graph shapes for the
two backing arenas, including identity width and inline member storage. Type
equality alone is insufficient. The corrected SDK passed 52 focused tests;
the old implementation failed 11 of those rejection cases. Original evidence
is preserved in `.local/data-logic-translator/readonly-list-schema-review`.

An `IReadOnlyList<T>` value is a non-owning native structure `{ Kind, Index }`:

| Kind | Index | Meaning |
| --- | --- | --- |
| 0 | 0 | Null |
| 1 | Positive | Existing identity in the exact `List<T>` arena |
| 2 | Positive | Existing identity in the exact `T[]` arena |

The view has no arena. Converting a concrete collection to a view retains its
existing index, and converting it back retains its concrete type. Two views and
a concrete argument can name the same object. The graph import/export queue and
identity maps continue to operate on the concrete arenas. No wrapper or copied
collection is used to satisfy the source interface. Read snapshots in generated
logic have the same role as other arena cell reads and do not allocate identity.

The portable shape is
`{"kind":"readonly-list","listArena":"...","arrayArena":"..."}`.
Both concrete definitions are required, even if a particular invocation uses
only one. Nested collection type descriptors use
`{"kind":"readonly-list","element":<type descriptor>}`. The SDK resolves this
to the exact closed `IReadOnlyList<T>` interface and checks that both backing
definitions represent exactly `List<T>` and `T[]` with the same element type.

Only those exact runtime types are accepted. Custom implementations, derived
List types, and covariant element conversions are rejected explicitly. The SDK
checks runtime types before transport; source conversions with unsupported
element/runtime types produce a source diagnostic. A cast from a view to the
wrong represented concrete kind throws `InvalidCastException`, including the
CLR type names in its observable message. An `as` cast returns null instead.
Null casts preserve null. Unknown tags, noncanonical nulls, fractional handles
and indices outside the selected concrete arena are rejected by the entry
before business execution.

`Count` and indexing read the concrete arena selected by Kind. Receiver identity
is captured before index argument effects, and the cell is read afterwards.
`foreach` captures one collection identity. List iteration checks that object's
version on each MoveNext, while array iteration observes later element writes
without a List version check. Ordinary source evaluation, exception completion,
mutation reconciliation and invocation-local identity rules remain in force.
The concrete type closure is reserved before traversing elements, including
cycles such as `IReadOnlyList<Node>` where `Node.Children` points to that list.

The isolated validation is 31 new SDK tests and 24 compiler/CLR/SDK/probe tests.
The full frontend passed 1,029 tests with six pre-existing skips. Coverage
includes both concrete runtime types, two views plus their concrete argument,
back-casts, catch-visible cast messages, recursive references, nested views,
exact temporal elements, shared native list storage, effects before dereference,
and malformed handles rejected before data effects. These are not native O11
Verify, merge, or server execution proofs. Byte arrays are deliberately left to
the separate byte-array codec integration; this candidate was frozen against
the temporal root baseline before that integration.

The original automatic-profile `IReadOnlyList<int>` echo now compiles with its
unchanged source hash
`5039b653de0a4db84db38650aa46fb4270d2acf15c1f751379a2ba542fa91b51`.
Two original ordinal GroupBy examples still fail with AVCS310 at
`Report.cs(8,60)`. They return `List<Summary>`, not an interface. Their internal
`QueryNativeValues.QueryListType` buffer is marked `NativeBuffer`, and
`QueryNativePlan.NativeGroupedQuery` attempts to coerce it directly to the
managed result arena. The sources and initial failure receipt are preserved;
two explicit diagnostic tests record this separate gap. They are not counted
as successful grouped-query materialization.
