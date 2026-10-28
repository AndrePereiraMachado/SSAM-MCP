# Automatic Studio bridges

Both the Node agent and the native core understand `compatible.<lane>.bridgeOffer`
in a successful hello response. `capabilities.bridgeOffer: true` advertises this capability.
The original package identity is retained; effective protocol fields in `pack` and
the additional `bridges` object describe the installed bridge. `bridgeUpdate`
reports installation, refusal or fallback without exposing local artifact paths.

## Trust and storage

The owner must set the Ed25519 SPKI PEM public key and the 40-character SHA-1
Authenticode certificate thumbprint in BOTH `agent/lib/bridge-trust.mjs` and
`native/Ssam.Agent/BridgeTrust.cs` before building. Empty constants fail closed.
No environment variable, local settings file, offer, downloaded certificate or
network response can override the production anchors. Test constructors inject
ephemeral keys and fake certificate verification only in test harnesses.

Prefer a JSON string in `bridgeOffer.manifest`, preserving the exact signed UTF-8
bytes, and a base64 string in `bridgeOffer.signature`. Object manifests are also
accepted using compact JSON serialization; the server must sign precisely those
bytes. A string avoids differences in escaping and property order across runtimes.

Downloads use the authenticated server origin at
`GET /agent/bridges/<lane>/<studioVersion>/<protocol>/<sha256>` with the same bearer
token as hello. Redirects are refused. Files have signed size limits and bounded
download deadlines. Verification order is Ed25519, every file's size/SHA-256,
then valid embedded Authenticode for every DLL/EXE from the pinned signer.

An installation is renamed from a sibling staging directory into
`<data>/bridges/<lane>/<studioVersion>/<protocol>/` only after verification. The
signed manifest remains there. Existing identities cannot be overwritten, and
older protocols cannot be installed. Failed load digests live in `failed.json`;
the original signed directories remain as the high-water record and rollback
source. A corrupt cached manifest fails closed for that Studio version, rather
than forgetting the high-water mark. Never prune these directories blindly.

Every selection rechecks the manifest, hashes, signatures, links and file list.
Unlisted dependencies, traversal, alternate data streams, reserved device paths
and ambiguous entrypoints are refused. The agent never compiles a bridge.

## Artifact layout and runtime

The ODC artifact contains exactly one entrypoint named `ODC3.Bridge.vNNN.dll`
or `ODC3.Bridge.dll`, plus its dependencies. Relative subdirectories are allowed.
The existing package helper performs the Windows attach; macOS retains its native
diagnostic IPC attach. The selected manifest runtime must exactly match the target
Studio's runtimeconfig (`net8.0`, `net10.0`, etc.). An unknown runtime never selects
a downloaded bridge. Bundled selection stays as before when no download matches.

O11 accepts the watcher's h1 artifact with `hook/Anvil.RuntimeHook.Agent.dll` and
`bridge/Anvil.Bridge.dll`, plus dependencies. All bytes are verified before the
hook is copied into its per-process exchange folder; the copied hook hash is
checked again. The handshake must return the signed manifest's exact bridge hash.

The existing h1 release layout is also supported. Its artifact must
include `studio/o11/hook/Anvil.Hook.h1.dll`,
`studio/o11/bridge/b1/Anvil.Bridge.dll`, dependencies, `release.json` and
`release.sig.jws`. The existing hook still checks its own release signature and
coverage; Ed25519/Authenticode do not bypass it. Future hook ABIs need agent support
and are refused with a reason. The bundled connector remains the diagnostic helper.

macOS downloads apply only to ODC. The installer must bundle a trusted executable
`tools/osslsigncode` and `tools/osslsigncode-ca.pem`. Native staging preserves these
two files only when the source pack already lists and hashes them. It runs `verify
-in <file> -CAfile <bundled CA store> -require-leaf-hash sha1:<pinned fingerprint>` with signature and chain verification
enabled. A missing verifier or invalid trust store refuses the download. Existing
macOS bundle discovery, exact-build checks for bundled bridges and attach guards
remain in place. O11 downloads are not enabled on macOS.

## Fallback and visibility

The highest verified matching version wins. A failed load excludes its signed
digest and reports fallback on the next hello. A known pre-attach failure can try
the previous verified version immediately. An attach that may already have run is
never repeated in that Studio process: restart the Studio before the rollback is
loaded. Existing O11 pending receipts and identity checks remain authoritative.

The app reads `<data>/private/bridge-update.json` on its normal refresh and renders
the installation or refusal reason as a status message. Example:
`Updated the odc bridge for ODC Studio 1.7.30`.

## Local verification

Use the Node runtime documented for this checkout. Run Node tests with TEMP/TMP
pointing inside the approved test directory. Do not build release packages, sign
artifacts or publish as part of this work. Before each native build or test,
inspect running dotnet processes and obey the owner's machine-wide serialization.

Build `tests/bridge-updates-harness/BridgeUpdates.Tests.csproj -c Release` once,
then run `node --test --test-concurrency=1 tests/native/bridge-updates.test.mjs`.
The test harness accepts ephemeral test keys over stdin and contacts only its
loopback fake server. It is not packaged and no production CLI flag enables it.
Existing native suites and `tests/native-protocol` must also pass before release.
