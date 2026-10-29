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
Ed25519, all sizes/SHA-256 values, then Authenticode for every DLL/EXE, before an
atomic directory rename. Previous sequences stay available for fallback.

The build pins the SPKI PEM public key and certificate SHA-1 thumbprint in both
`agent/lib/bridge-trust.mjs` and `native/Ssam.Agent/BridgeTrust.cs`. The application
build refuses empty, invalid or differing anchors. No server value, setting or
environment variable can replace these constants. Tests inject ephemeral keys
only through test constructors.

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
modification times. Changed files invalidate the cache. A pipe operation only
checks the active protocol for that Studio process; it never runs Authenticode.
Every actual attach copies the artifact into a unique `private/bridge-loads/`
directory, locks the copy against write/delete sharing, and fully verifies that
copy before use. O11's generated process-bound configuration is included in this
locked copy. Both its hook and `bridgePath` refer to the protected snapshot.
Snapshots remain locked while the agent may use them, including lazy loads.

The native core holds read handles without write/delete sharing. Node uses the
bundled native core's `bridge-lock` helper, with readiness acknowledged only
after every file is open. A missing helper fails closed for downloaded attachment.
The Windows directory comes from the native `windows-directory` OS API command,
and Authenticode imports the Security module by its full system path with a
sanitized module search path. `SystemRoot` and `PSModulePath` are not trust inputs.

## Failure, channel and platform behavior

Only a load that was attempted and definitively failed because of the bridge
quarantines that identity. Port contention, locks, concurrent requests, pending
guards, reused-bridge handshakes and data-root binding errors never quarantine.
Quarantine is scoped to the Studio PID/start time. A restarted Studio or a newer
sequence is eligible again. Existing guards still prohibit an unsafe second
injection into a process where a hook may already be loaded.

Failed and fallback records survive agent restarts. Downloads run in the
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
