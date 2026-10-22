# HTML page function policy regression (2026-10-21)

The G5 regression is a test-policy mismatch, not a lost function check. `JobRunner.CheckAgainstBase` still reads page expressions through `HtmlExpander.Expressions`, groups an unknown function once per operation, and offers a rename at every expression pointer. Literal labels, titles, date formats, JavaScript and quoted text are not native expression calls.

`ff99b12f33b430cc3c0b616ef6eaf2d7dbf3a5b5` intentionally introduced automatic application of certain corrections. `583daa514d903ad04df9db5da116551db7a86e20` added the `autoPatch:false` opt-out. The candidate integrated that feature at `7c1570d255138fe5e7110783ed2ca04d592ab804`, whose commit message records the owner decision and integration review. The public `autoPatch` schema in `platforms/odc/facade/o11-cycle.mjs` describes false as offering verified repairs without applying them automatically.

The original G5 test, introduced by `806779c9`, was unchanged when this feature arrived. It submitted an expected-valid job without opting out, then expected an exception. For the reviewed `Lower -> ToLower` rename, the correct default result is now an accepted candidate, an applied-patch receipt and a separate corrected job; the input file remains unchanged.

The regression tests distinguish these contracts:

- With `autoPatch:false`, both Lower and Upper yield one FUNCTION_UNKNOWN problem, containing every text, visibility, class and style expression patch. Applying the complete patch produces a candidate accepted by native Verify.
- With the default policy or explicit `autoPatch:true`, a certain rename completes and discloses one correction and the complete corrected job. Literal text and the page's declared script call remain unchanged.
- A function without a certain rename is still refused by default and no output module is saved.
- The existing expression inventory checks variable defaults, source filters/sorts/arguments and navigation/call/block arguments, and excludes literal labels, titles, date formats and JavaScript. The G6 tests cover native Dropdown value/label expressions separately.

No production policy is reverted. Validation artifacts and the per-name baseline comparison are recorded in the task's external RESULTADO.md.