# Unicode public-action laboratory transport

`csharp_unicode_text_lab.py` prepares an additive REST transport for the unchanged
`tests/csharp/Utf16TextRules.cs.txt` (SHA256
`933d61367b61eec0ad77321eb7c433af26c743c6d8d7e30df5e80f5c8d9c369f`).
Its five independent oracle files are read from `tests/csharp/oracles/Utf16TextRules` and
validated against fixed hashes. The harness does not compile or rerun the CLR oracle.

The HTTP battery is **46 original cases + 8 discriminants**. The eight isolated-surrogate
cases are frozen alongside the evidence but never converted to HTTP requests or counted
as HTTP successes. Exact strings are compared without Unicode normalization.

## Offline preparation and binding

From the repository root, using an available Python 3 runtime:

```powershell
python -B scripts/probes/highcode/csharp_unicode_text_lab.py prepare --work .local/data-logic-translator/unicode-text-lab
python -B scripts/probes/highcode/csharp_unicode_text_lab.py build --work .local/data-logic-translator/unicode-text-lab --contract <compiler-contract.json> --mapping <compiler-source-map.json> --source-hash <compiler-source-hash.txt> --source-bundle <delivered-source-bundle.json> --source-delivery <source-delivery-result.json>
python -B scripts/probes/highcode/csharp_unicode_text_lab.py check --work .local/data-logic-translator/unicode-text-lab
```

`prepare` copies the existing immutable bytes, writes `methods.json` and `oracle.freeze.json`,
and stops. `build` requires a successful source delivery to the fixed personal target, with
matching source-bundle receipt hashes, task/module identities and exact source content. It
also requires the compiler's source hash; if `--source-hash` is omitted, it reads
`source-hash.txt` next to the contract. The digest is checked against the complete delivered
C# bundle, including normalized filenames, not only against the Unicode source file.

Only exact SourceMap symbols `Utf16TextRules.Measure(string?)` and
`Utf16TextRules.Describe(string?)` select native action names. Both targets must be public
server actions with the original parameter/return mapping. Internal implementations cannot
substitute for those public calls. Null inputs require the compiler's actual
`{ HasValue: Boolean, Value: Text }` carrier; carrier names are not guessed.

Build outputs:

- `transport.json`: two REST endpoints, their request/response structures, and calls to the
  existing `LabAuthenticate` followed by the original public action. It creates no business
  server/service action and copies no business body.
- `bindings.json`, `requests.json`, `targets.json`, `bound-contract.json`, `bound-source-map.json`.
- `binding-proof.json`: hashes of source bundle, source receipt, compiler artifacts, oracle
  freeze, harness/helper source and generated transport files.
- `publication-template.json`: deliberately incomplete; it cannot pass the execution gate.

The existing personal module must already contain REST service `CSharpLab` and server action
`LabAuthenticate(LabKey)`. This harness does not create, replace or weaken them. New routes are
`/rest/CSharpLab/UnicodeTextMeasure` and `/rest/CSharpLab/UnicodeTextDescribe`. Each response
sets `Completed=True` only after the public action returns, then returns its result. This
marker prevents an empty/error envelope from masquerading as the default integer result zero.
Source exceptions remain failed HTTP cases; the frozen Unicode corpus expects no exceptions.

No command in this harness delivers, publishes, installs dependencies, loads the Studio or
changes an existing receipt. The parent delivery workflow owns those actions and their gates.

## Publication envelope

After delivering the generated transport, capture a **fresh registered snapshot after both
deliveries**, then publish those snapshot bytes and retain the raw terminal confirmation.
Copy the template to a new file and complete it using those real artifacts:

```json
{
  "schema": "unicode-text-publication-v1",
  "bindingProof": {"path": ".../binding-proof.json", "sha256": "..."},
  "sourceDelivery": {"path": ".../source/result.json", "sha256": "..."},
  "sourceTaskId": "...",
  "transportDelivery": {"path": ".../transport/result.json", "sha256": "..."},
  "transportTaskId": "...",
  "snapshotReceipt": {"path": ".../snapshot-for-publish.json", "sha256": "..."},
  "snapshotSha256": "lowercase SHA256 of the registered OML",
  "confirmation": {"path": ".../confirmed-publish.json", "sha256": "..."},
  "VersionId": 1234
}
```

`VersionId` above is illustrative and must equal the real raw confirmation. The raw file must
contain `Completed: true`, `HasErrors: false`, and a positive integer `VersionId`; template
flags cannot override it. Identity comes from the successful source/transport receipts and
the registered snapshot's environment/name/module key, all of which must agree with
`personal-2qqw9srv.outsystemscloud.com` / `ZZHighCodeLab_CS`.

The gate checks the actual snapshot OML hash, snapshot ID, both task IDs and receipt hashes.
Local snapshot JSON/OML modification times must be after both receipts' timezone-qualified
`updatedAt` timestamps; the confirmation file must be later than the snapshot. Preserve these
artifacts in place. These checks detect stale/mixed local evidence; timestamps are not signed
server attestation. The envelope must be recorded by the publishing workflow for the snapshot
it actually submitted. The harness does not independently query the server's current version.

## Explicit execution and comparison

Only after those gates and authorization to execute the laboratory HTTP battery:

```powershell
python -B scripts/probes/highcode/csharp_unicode_text_lab.py run --work .local/data-logic-translator/unicode-text-lab --transport-delivery <transport-result.json> --publication <completed-publication-envelope.json> --secrets <private-secrets.json>
```

The private file supplies a printable `key` string for the existing LabKey header. Never pass
the value on the command line. The target host/module are fixed, redirects are refused, and
the first request uses a fresh invalid key. Failure to observe `LabAccessDenied`/the existing
guard's rejection stops execution before any real case. There are **55 requests total**:
one guard control followed by all 54 original/discriminant requests, without automatic retries.

Each run gets a separate `runs/<time>-<random>/` directory. An explicit archive allowlist
preserves the source/bundle/map/receipts/publication and harness bytes; the secrets file is
never copied, even if it is located in the work directory. Reflected key strings are redacted
from wire logs, and exception messages from the HTTP client are not logged. Status, raw
sanitized responses, comparisons, summary, published version, snapshot identity and hashes
are retained. An unexpected HTTP/protocol response is a failed case, never an expected result.

Offline comparison of already collected public responses is also available:

```powershell
python -B scripts/probes/highcode/csharp_unicode_text_lab.py compare --work .local/data-logic-translator/unicode-text-lab --responses <responses.json>
python -B -m unittest discover -s tests -p test_csharp_unicode_text_lab.py -v
```

`compare` requires exactly the 54 IDs. Default-valued O11 fields may be omitted only within
a response with `Completed=True`; scalar types and nullable carriers are still checked.
Passing offline mocks validates the harness, not delivery, publication, source execution on
the server or transport of the eight isolated-surrogate cases.
