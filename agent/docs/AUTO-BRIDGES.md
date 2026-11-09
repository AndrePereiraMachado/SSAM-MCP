# Automatic bridges: amendment 1

The Node agent and native core announce `capabilities.bridgeOffer` and accept
`compatible.<lane>.bridgeOffer`. The original package fields, including
`pack.odcBridge` and `pack.o11Hook`, always describe the actual bundled package.
Downloaded bridges are reported separately as a persistent `bridges` array:
`{lane, studioVersion, protocol, sequence, status, reason}`.

## Signed identity and storage

Every manifest has a positive safe-integer `sequence`, increasing for each
`{lane, studioVersion}`. The agent keeps installed and rejected high-water marks
in `private/bridge-state.json`, outside `bridges/`. Cleaning downloaded binaries
does not reset replay protection. An unsigned or invalidly signed sequence never
changes this state. A lower sequence or protocol is refused; a larger sequence
can replace a broken build with the same protocol.

Artifacts use immutable sequence directories under
`bridges/<lane>/<studioVersion>/<protocol>/<sequence>/`. Installation verifies
Ed25519, all sizes/SHA-256 values, then Authenticode for the DLL/EXE entries whose
signer class is `microsoft`, before an atomic directory rename. Previous sequences
stay available for fallback.

Since agent 0.3.17 / native 0.4.14 (app 0.2.8) the owner's files carry no
Authenticode signature: the Windows app is never Authenticode-signed (owner
decision, November 2026). An owner file is trusted because the manifest that names
its size and SHA-256 verifies against the pinned Ed25519 key. The manifest field
`authenticodeThumbprint` is ignored (it grants nothing and blocks nothing). The
only anchor is the Ed25519 SPKI key. The native core gets it from the build input
`-p:SsamTrustPublicKey=<base64 SPKI>` (generated `BridgeTrust.Anchor.g.cs`; an
environment variable of that name is refused); `scripts/build-native.mjs
--trust-public-key <public-key.pem>` and `scripts/build.mjs --trust-public-key
<public-key.pem>` pass it and verify the compiled executable. A source build has an
empty anchor: the feature is off, the hello says `bridgeOffer: false` and every
offer is refused. No server value, setting or runtime environment variable can
replace the anchor. Tests inject ephemeral keys only through test constructors.
The Node agent's `agent/lib/bridge-trust.mjs` keeps an empty key (the app runs the
native core).

## Selection and attachment

The bundled bridge wins whenever its Studio and runtime match. Package build
metadata and runtime/dependency configuration establish compatibility; legacy
layouts retain their .NET 8 runtime. The target Studio runtime comes from its
runtime configuration. An unknown runtime never authorizes a downloaded bridge.

An ODC artifact includes `client/ODC3.Bridge.Client.dll` and its dependencies,
plus `bridge/ODC3.Bridge.<protocol>.dll`. Windows attachment always uses this
downloaded client with this bridge, never the bundled client from another
protocol. The generic `ODC3.Bridge.dll` filename is also recognized by the macOS
attach code.

Downloaded O11 artifacts use protocol `d1`: `hook/Anvil.RuntimeHook.Agent.dll`,
`bridge/Anvil.Bridge.dll` and dependencies. The bundled package remains `dev` or
its original release ABI. A downloaded hook is never advertised as release h1.
The O11 hash handshake and existing process, port and pending-attach guards remain.

Verification is cached by signed digest and the file inventory's sizes and
modification times and file IDs. The selection cache is only an optimization:
an in-place overwrite can preserve size, mtime and file id. The security
guarantee is full verification of the locked copy at attach, not this cache.
Changed metadata invalidates the cache. A pipe operation only
checks the active protocol for that Studio process; it never runs Authenticode.
Every actual attach copies the artifact into a unique `private/bridge-loads/`
directory, locks the copy against write/delete sharing, and fully verifies that
copy before use. O11's generated process-bound configuration is included in this
locked copy. Both its hook and `bridgePath` refer to the protected snapshot.
Snapshots remain locked while the agent may use them, including lazy loads.

The native core holds read handles without write/delete sharing. Node uses the
bundled native core's `bridge-lock` helper, with readiness acknowledged only
after every file is open. A missing helper fails closed for downloaded attachment.
Authenticode now uses WinVerifyTrust and its provider signer chain in process.
Node calls the native `authenticode --file <file> --signer microsoft`
command; the owner class is refused before any check. No PowerShell or environment-derived verifier path is involved.
Every executable manifest entry requires a signer class. Owner entrypoints
cannot be labeled Microsoft. Microsoft dependencies require the exact subject
organization, the code-signing EKU and a pinned SHA-256 root fingerprint, in
addition to successful Authenticode verification. Both build sources and the
compiled native executable must report matching anchors at release time.
`build.mjs --native <executable> --trust-public-key <public-key.pem>`
(`--bridge-public-key` is an alias) compares the key digest with the compiled
executable. The native `trust-anchors` command reports only the public SPKI digest
and the Microsoft root pins.

The Microsoft root pin was obtained offline from the provider chains of the
three Microsoft DLLs beside the real v100 client used in qualification. These
dependencies are never resigned. A different signer, including Json.NET's
.NET Foundation signer, requires an explicit contract decision.

## Failure, channel and platform behavior

Only a load that was attempted and definitively failed because of the bridge
quarantines that identity. Port contention, locks, concurrent requests, pending
guards, reused-bridge handshakes and data-root binding errors never quarantine.
Quarantine is scoped to the Studio PID/start time. A restarted Studio or a newer
sequence is eligible again. Existing guards still prohibit an unsafe second
injection into a process where a hook may already be loaded.

Installation records survive agent and Studio restarts. Ending a Studio instance
changes active or failed telemetry back to installed; it never erases a verified
installation. A repeated offer repairs missing installation telemetry and
reconnects only if that telemetry changed. Hello reports contain at
most 16 entries, newest first, retaining each lane/version's current record.
Reasons are machine-readable uppercase codes; a bundled fallback is recorded
on the failed identity, never as sequence zero. Only authenticated manifests with
definitive signer or trust-anchor refusals produce persistent refused records.
Transient preconditions, interrupted transfers and invalid signatures never
replace installation or active-instance telemetry.
Local notifications can explain the refusal but never include absolute paths.

Snapshots are reused for the same artifact and Studio instance; an already
active ODC identity is not injected again. Concurrent ODC attaches are serialized.
Failures before load release handles and remove their snapshot. Once a load may
have started, errors from binding, authentication, ui_alive or an unconfirmed
attach preserve the entire copy and its lock until the instance exits.
A complete process snapshot is required for cleanup; unavailable or partial
enumeration is never interpreted as an empty list. Cleanup exceptions do not
block hello, and a failed deletion keeps its index for retry. An unreadable state
file disables maintenance without being overwritten.

Instance lifetime comparisons normalize Process.StartTime and CIM timestamps to
microseconds, while the hook request retains its exact timestamp. Node performs
one cached native enumeration covering both Studios. Sweeps run only for leases
or active state (plus startup recovery), at five seconds with leases and thirty
seconds without them. Stopping the agent releases locks but keeps copies that
may still be mapped, for cleanup after the Studio exits.

Downloads run in the
background while the channel opens immediately. Successful installation or a
confirmed bridge failure requests reconnection to report the new state.

This build disables remote offers on macOS and explains why in
`capabilities.bridgeOfferReason`. Bundled macOS ODC/O11 behavior stays available.
Re-enabling remote offers requires a packaged and qualified verifier; merely
assuming `tools/osslsigncode` exists is insufficient.

## Qualification

Use a short test TEMP, such as `C:\t\va-tmp`. Serialize all dotnet builds/tests
and inspect other dotnet processes first. The production-client test compiles
the real client source, changing only its protocol and its pinned test-host path;
it loads a v100 startup-hook fixture into a private ODCStudio test process. It
never attaches to the installed Studio. Run both Node and native regression suites
and compare named results against the release baseline before promotion.

The real-client regression also supplies an invalid DLL. DiagnosticsClient's
UnsupportedCommandException/ServerErrorException from ApplyStartupHook identify
a bridge failure; timeouts and pre-command errors do not quarantine an artifact.
The client emits no structured failure flags, so those are never inferred from
its JSON output.

Residual same-user risk: denying writes to existing snapshot files does not deny
creation of new files in their directory. The O11 hook's Anvil/Esprima resolver
therefore needs a future hash-bound configuration and dependency check before
LoadFromAssemblyPath. A two-distinct-instance quarantine is only a proposal;
current behavior still retries the newest failed identity after Studio restart.

## Authenticode trust on target machines

Since 0.4.14-native this applies only to the Microsoft-signed dependencies; the owner files are verified by the Ed25519 manifest. The text below describes the former owner-certificate model and still holds for the Microsoft chain.

The owner's Authenticode certificate must chain to a CA root already trusted on every target machine. Verification is offline and uses the local certificate cache; it does not download missing roots or intermediate certificates. Missing roots, incomplete chains, expiration without a valid timestamp, and unavailable revocation evidence produce a local `VERIFY_FAILED` warning and are retried on the next hello. They do not suppress the offered identity on the server.

Release qualification must include a clean Windows VM with the real owner certificate and the intended root/intermediate certificate deployment. Confirm both a successful update with the trusted chain and a recoverable warning before the root is installed. A timestamped signature remains valid after the signing certificate expires when WinVerifyTrust accepts its timestamp.
