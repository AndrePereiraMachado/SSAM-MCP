# ABI3 exception graph codec — frozen SDK candidate, 2026-09-08

Scope: caller-side data transport in Anvil.Authoring only. No source execution, executable AST,
arbitrary assembly loading, native/Studio tests, publication or controller activation is claimed.
The compiler/Core integration is a separate reviewed change. ABI2 metadata and calls stay at version 2 by default.

## Explicit negotiation and metadata

The generated controller/caller opts in with `new ReferenceGraphBinding(schema, sourceAssembly, maxSupportedVersion: 3)`.
This is infrastructure negotiation; the LLM's application source receives no extra switch or binding syntax.
The normal constructor accepts only ABI2. A caller supporting version 3 still accepts unchanged ABI2 metadata.

ABI3 metadata has exactly `id`, `version`, `inputs`, `results`, `definitions`, `exceptionArena`:

```json
{
  "id": "anvil.csharp.reference-graph",
  "version": 3,
  "exceptionArena": "Exceptions",
  "inputs": [{ "name": "Arg_error", "sourceName": "error", "shape": {
    "kind": "exception", "type": { "kind": "exception", "name": "System.Exception" }
  }}],
  "results": [{ "kind": "exception", "type": { "kind": "exception", "name": "System.Exception" }}],
  "definitions": []
}
```

`exception` type descriptors are also permitted inside exact List/array type descriptors.
The shape's declared type must be one of the fourteen exact BCL types below; runtime cells must be assignable
to that declared type. `System.Exception` admits all supported concrete types. There is one reserved
`Exceptions` arena, never a user definition or a reflected exception-storage definition.

## Native parameters/results

Request: `AvGraphAbiIn: 3`, `AvGraphIn`, and every declared input. Response: exactly `AvGraphAbiOut: 3`,
`AvGraphOut`, `AvCompletion`, and `AvResult` iff the signature has a result. The ABI handshake uses distinct
generated native input/output names because native action variables share one namespace. It is not an implicit
HTTP header. These generated names are reserved against source inputs. The future generated callee must validate the ABI
and entire input before executing the translated business body. The SDK validates response negotiation
and the complete reply before caller writeback. `AvErrors` is forbidden in ABI3.

`AvCompletion` has exactly integer `Kind` and `ExceptionRef`. Kind 0/1 requires ExceptionRef 0;
Kind 2 requires a positive valid Exceptions index. On failure `AvResult`, when required by the fixed native
signature, is the canonical native default. It is validated but is not a business return or a reachability root.

Exceptions use `{ "Index": n }` handles like the other arenas; index zero is null. They participate in the
same object-identity table. All originals remain roots, including detached inputs; successful results and
the failed completion's exception handle are additional roots. InnerRef is another exception edge.
Unreachable new identities are invalid. Reconciliation finishes before the exact resolved exception is thrown.

## Typed exception arena cell

All thirteen fields are required and no unknown fields are accepted:

```json
{
  "TypeName": "System.ArgumentOutOfRangeException",
  "Message": "outside (Parameter 'size')\r\nActual value was 9.",
  "ParamName": "size", "HasParamName": true,
  "InnerRef": 0, "HasHResult": true, "HResult": -2146233086,
  "HasActualValue": true, "ActualValueType": "System.Int32",
  "ActualValueInteger": 9, "ActualValueLong": 0,
  "ActualValueText": "", "ActualValueBoolean": false
}
```

Message is the complete observed BCL Message, not raw constructor input. It may be empty and is never JSON null.
ParamName absent means HasParamName false and empty ParamName; empty-but-present remains distinct.
HasHResult must be true. ActualValue is absent iff HasActualValue is false, its type tag is empty, and all slots
are default. Present tags are exactly System.Int32, System.Int64, System.String, System.Boolean and select
their corresponding slot; inactive slots must be default. Exact integer width, false and empty text are retained.
No arbitrary ActualValue objects or their ToString methods are evaluated. Existing text/nullable shapes in ABI3
also require canonical defaults in inactive payloads. This tightening is not applied to ABI2.

Exact runtime types: System.Exception, System.SystemException, System.ApplicationException,
System.ArgumentException, System.ArgumentNullException, System.ArgumentOutOfRangeException,
System.InvalidOperationException, System.NullReferenceException, System.IndexOutOfRangeException,
System.OverflowException, System.DivideByZeroException, System.NotSupportedException,
System.InvalidCastException, System.FormatException.

## Construction and limits

Input exceptions retain their CLR instance and must return the identical captured payload; concurrent payload
changes also fail. New instances use only fixed public constructors for the allowed BCL types. The codec computes
the runtime's Argument* suffix using an empty base message, removes exactly one matching suffix, constructs the
new instance and verifies its complete observed payload. Message text containing an earlier identical suffix is
preserved. A peer with different runtime/culture formatting must provide a constructible observed payload or the
reply fails; this codec does not normalize or silently change a Message.

All handles, typed fields, declared types, reachability and input payloads are validated before any caller mutation.
All new exceptions are constructed before object/list/array writeback. Forward inner references and shared inner
objects work. The traversal is iterative. Inner cycles are rejected because supported public constructors cannot
produce them; ordinary source object cycles containing exception references remain supported.

The public constructors cannot preserve arbitrary new HResults or ArgumentNull/ArgumentOutOfRange payloads
combining a non-null ParamName/ActualValue with InnerException. Such replies are rejected. Exception Data,
HelpLink, Source and stack metadata are not transported; existing input instances keep their local values.
Source/custom exception constructors, fields, getters and virtual dispatch remain an explicit unsupported gap.
No private exception runtime fields are read or written.

SDK tests use independently authored peer messages and assertions; the culture oracle invokes ordinary CLR
BCL constructors independently. Passing these tests is not proof of native entry validation, C# lowering,
transaction rollback or published execution.
