# Production client regression

`prepare.mjs` generates isolated projects under `C:/t/vigia-auto/round2-e2e`.
It reads the production ODC client from this checkout and changes only its
protocol constant and pinned executable path. The private test host is named
`ODCStudio.exe`; no installed Studio is used.

Run the preparation with Node, then build `host`, `v98`, `v100`, `bridge`,
`native-base`, and `native-head`, one dotnet build at a time. Inspect running
dotnet processes before each build. `native-base` requires an immutable export
of reviewed commit `f4b301e` in `C:/t/vigia-auto/round2-base`.

With `TEMP` and `TMP` set to `C:/t/va-tmp`, set `SSAM_CLIENT_E2E=1` and run
`node --test --test-concurrency=1 agent/tests/native/bridge-client-e2e.test.mjs`
from the repository root. The test generates ephemeral Ed25519 keys, serves the
artifact from a fake authenticated hub, installs it, reconnects, and uses the
real client to load the startup hook and bind the data root. Authenticode is
stubbed; no production signing certificate is used.

Set `SSAM_REVIEW_BASE=C:/t/vigia-auto/round2-base` to run the same assertions
against the reviewed implementation. Both Node and native cases must fail there
because that implementation invokes the bundled v98 client for a v100 bridge.
