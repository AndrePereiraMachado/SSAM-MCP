# Ordering and input forms

The facade recognizes references only in calls, types, owners, sources,
conditions, sort expressions, navigation destinations and block instances.
A dotted expression consumes its root, not an attribute name. Child parameters
and widgets are not module declarations.

The established DDL, block, document, ops, logic and drop-only priorities break
ties. Explicit dependencies take priority. Writes to existing names retain input
order. A modifier of a name created by the job follows that creator; two creators, drops/recreates and renames/recreates
retain their conflict order. Strongly connected components keep input order internally; components still follow their
dependencies and ranks. An unrelated cycle or barrier never freezes the job.
The kernel planner owns declaration shells and validation. Qualified screen
actions write their own name and consume their screen; they do not write it.

DDL splitting observes top-level statement terminators. A same-line -- @key
comment stays with its statement (including the last static record); comments
never become standalone fragments. Split specs preserve basedOn on every
fragment, including drops and timers. Drops in mixed DDL
are always split into drop-only parts after consumer rewrites; creations retain
the data-first rank. Facts and ranks are memoized per part, and SCC condensation
discovers SCCs with explicit DFS frames and no recursive calls, then
uses an indegree-driven Kahn traversal with stable ranked ready bitmaps. Static
entity records remain part of their declaration even when named Create, Type, Timer or Drop.
Timer declarations may be separated from their data declarations when needed;
mutually referencing entities remain together. Unchanged multi-op parts retain
their identity, change description and ordering metadata.

Before delivering a code job or a direct O11 job containing several deletes, the facade reads native
usages with one module capture/index read, then resolves all targets in memory.
Both target and path are accepted. Consumers precede providers across unrelated
mutations; writes and renames sharing a name remain barriers. Nondelete operations keep
their relative order, and only a moved delete produces the delete-order note.
Missing/incomplete usage evidence retains the original order and reports why.

DDL element selectors accept names, keys, arrays and CSV, preserving source order
and deduplicating selected blocks. Missing names are corrected independently while
found names remain selected. An exact element named Data, Entities or All wins
over the whole-section alias. HTML name is an alias of screen. Kind filters accept
strings, alternatives and arrays. A uses query takes one element; CSV is refused
without claiming that it was accepted.

Reference queries accept function arrays and treat multiword example/component
names as searches. Evidence filters over string rows apply any field name to the
whole line, including the field in each alternative. A bare term is a substring search; !term excludes it. The evidence
text field is normalized to a contains filter before schema validation.

Corrections repair the requested call, never placeholders or grammar/discovery
guidance. Guidance remains in continuation; missing code is never invented. DDL edits over a prior job
infer element=ddl. Owned action suffixes resolve against the pinned reading.
Inline dryRun returns a corrected o11_data request with preview:true. That call
uses the native --check --no-write-fields path and reports written:0; it never
sends a write. File loads retain their existing dryRun form. Batch items carrying preview are
refused with INPUT_INVALID and no corrected call. The shared tool classification
still needs the top-level preview read rule from the speed integration. Other unsupported
file options give guidance without a fake corrected call.

The discover projection is restored verbatim to the integration base. The core
is also checked against its 34,057-byte base size, without raising any ceiling.
The listing ceilings remain 34,097 bytes for the hosted core and 261,330 bytes
overall. Shorter reviewed descriptions pay for the additional input schemas;
no ceiling or answer-size/context-budget policy is increased.
