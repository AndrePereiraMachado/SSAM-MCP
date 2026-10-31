// Drift: the ODC bridge and the kernel read public signatures with one file, kernel/src/Anvil.Core.Odc/Adapters.ODC/
// PublicSignatureReader.cs: the kernel compiles it (OdcPublicSignature) and the bridge links it. Its copy was fixed at v97 and knew no
// service action: 20 published ones were called "not published" at the gate of 2026-10-30 (v98 and v101 carry that copy). The file has
// the global namespace and no kernel type, so ODC3.Bridge.v<N>.dll carries no type of the kernel namespace (docs/O11-BRIDGE-FINA.md
// 6.5). The merge order's rule stays a copy (MergeOrderCopy.cs, of the kernel's MergeOrder.cs), kept equal below.
// a11-b: the customers run ODC bridge v97 (f912cb7e), whose copy SecurityWarningsCopy.cs is pinned to the kernel file it was built
// with (fixtures/bridge-v97/*.cs.txt, the blobs of f912cb7e and a10 5dc9ec51); the kernel moved on and the drift is accepted, each
// change named below with why it gives no wrong answer to a v97 bridge:
//   - The signature reader: whatever bridge wrote a capture, its elements are read from its bytes (NativeReferenceSnapshot.Read with
//     OdcPublicSignature; facade readSignatureKernel), so the list of a bridge from before the one reader changes no answer.
//   - SecurityWarnings.cs, 700a5c1f + 0a21afba (T12): the list grew. v97's is a subset, so it refuses nothing the kernel
//     accepts; a T12 message it accepted after a merge is refused by the server (facade/security-after-merge.mjs,
//     facade/tests/security-after-merge.test.mjs, merge-reconcile.mjs mergeState: the verdict lives in the merge evidence).
import '../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// sha256 (first 16 hex) of the normalized code, comments dropped: the v97 one (blob c3eb65f4) and the T12 one (blob 8cd59353).
const V97_SECURITY = '674490293711fbd7';
const T12_SECURITY = '196f282ca8fdca93';

const odc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(odc, '..', '..');
const bridge = path.join(odc, 'studio', 'bridge');
const kernelFile = path.join(repo, 'kernel', 'src', 'Anvil.Core.Odc', 'Adapters.ODC', 'OdcPublicSignature.cs');
const readerFile = path.join(repo, 'kernel', 'src', 'Anvil.Core.Odc', 'Adapters.ODC', 'PublicSignatureReader.cs');
const v97 = path.join(odc, 'tests', 'fixtures', 'bridge-v97');
const v97KernelFile = path.join(v97, 'OdcPublicSignature.cs.txt');

// {usings, namespace, declaration, body} of the one top-level class of a C# file; comments are dropped.
function parts(text, name) {
  const code = text.replace(/^﻿/, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
  const declaration = new RegExp('^(public|internal) static class ' + name + '\\s*$', 'm').exec(code);
  assert.ok(declaration, name + ' is declared as a static class');
  const open = code.indexOf('{', declaration.index);
  const close = code.lastIndexOf('}');
  return {
    usings: [...code.matchAll(/^using [^;]+;/gm)].map(m => m[0]).sort(),
    namespace: /^namespace ([\w.]+)\s*;/m.exec(code)?.[1] ?? null,
    visibility: declaration[1],
    body: code.slice(open, close + 1).replace(/\s+/g, ' ').trim(),
  };
}

test('one signature reader: no copy in the bridge, the kernel and the bridge compile the same file, which holds no kernel name', () => {
  assert.ok(!fs.existsSync(path.join(bridge, 'PublicSignatureReader.cs')), 'no copy in the bridge folder');
  const reader = parts(fs.readFileSync(readerFile, 'utf8'), 'PublicSignatureReader');
  assert.equal(reader.namespace, null, 'the global namespace, like the rest of the bridge');
  assert.equal(reader.visibility, 'internal');
  assert.ok(reader.body.includes('public static Catalog Read(byte[] bytes)'));
  assert.doesNotMatch(fs.readFileSync(readerFile, 'utf8').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n'), /Anvil\.|Ssam\.Runtime|Ssam\.Lic/, 'no kernel name in what the bridge links');
  const kernel = fs.readFileSync(kernelFile, 'utf8');
  assert.match(kernel, /PublicSignatureReader\.Read\(bytes\)/, 'the kernel reads through it');
  assert.doesNotMatch(kernel, /GetSignatureReader/, 'the kernel has no second reader');
});

// Every family the kernel knows by its tag, whatever the reader does with it: the kinds it binds have a row with the kernel's kind
// (the ODC "block" is the mobile block family); the rest reach Others by name. Nothing a signature holds is dropped.
test('the reader knows the kernel\'s tags, and a tag without a row is named in Others, never dropped', () => {
  const families = [...fs.readFileSync(path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'NativeReferenceKinds.cs'), 'utf8').matchAll(/new Family\("([^"]+)", "([^"]+)"/g)].map(m => ({ kind: m[1], tag: m[2] }));
  assert.equal(families.length, 18);
  const code = fs.readFileSync(readerFile, 'utf8');
  const rows = Object.fromEntries([...code.matchAll(/"([A-Za-z.]+)" => "([a-z-]+)",/g)].map(m => [m[1], m[2]]));
  assert.equal(rows.ReferenceServiceAPIMethod, 'service-action', 'the kind v97 to v101 did not know');
  for (const [tag, kind] of Object.entries(rows)) {
    const family = families.find(f => f.tag === tag);
    assert.ok(family, tag + ' is a tag of the kernel');
    assert.equal(kind === 'block' ? 'mobile-block' : kind, family.kind, tag);
  }
  assert.match(code, /else others\.Add\(new Other\(item\.Name\.LocalName, name, key\)\)/, 'what has no row is named');
  assert.match(fs.readFileSync(path.join(bridge, 'StartupHook.cs'), 'utf8'), /Capabilities = \{[^}]*"reference-snapshot:every-kind"/, 'the bridge that links the reader says so');
  // The kinds the kernel's envelope and the facade take from a signature are the reader's rows.
  const snapshot = fs.readFileSync(path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'NativeReferenceSnapshot.cs'), 'utf8');
  const kinds = /OdcPublicKinds = \[([^\]]+)\]/.exec(snapshot)[1].replace('OdcBlockKind', '"block"').match(/"[^"]+"/g).map(s => s.slice(1, -1));
  assert.deepEqual([...kinds].sort(), [...new Set(Object.values(rows))].sort());
});

// The merge order's rule (bridge v37): the bridge compiles MergeOrderCopy.cs, the kernel's MergeOrder.cs with only the
// namespace dropped and the two declarations internal; engine/NativeMergeOrder.cs names the types without a namespace.
test('MergeOrderCopy (ODC bridge) is MergeOrder (kernel) with only the namespace and the declarations visibility changed', () => {
  const code = file => fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
  const kernel = code(path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'MergeOrder.cs'));
  const copy = code(path.join(bridge, 'MergeOrderCopy.cs'));
  const usings = text => [...text.matchAll(/^using [^;]+;/gm)].map(m => m[0]).sort();
  assert.match(kernel, /^namespace Anvil\.Core;$/m);
  assert.doesNotMatch(copy, /^namespace /m, 'the copy is in the global namespace, like the rest of the bridge');
  assert.doesNotMatch(copy, /Anvil\.Core/);
  assert.deepEqual(usings(copy), usings(kernel));
  const normalized = text => text.replace(/^namespace Anvil\.Core;$/m, '')
    .replace('public sealed record DeferredDefault(', 'internal sealed record DeferredDefault(')
    .replace(/^public static class MergeOrder\s*$/m, 'internal static class MergeOrder').replace(/\s+/g, ' ').trim();
  assert.match(copy, /^internal sealed record DeferredDefault\(/m);
  assert.match(copy, /^internal static class MergeOrder\s*$/m);
  assert.equal(normalized(copy), normalized(kernel));
  const engine = fs.readFileSync(path.join(odc, 'studio', 'engine', 'NativeMergeOrder.cs'), 'utf8');
  assert.doesNotMatch(engine, /^using Anvil\./m, 'NativeMergeOrder.cs compiles in the bridge, which has no kernel namespace');
  assert.doesNotMatch(fs.readFileSync(path.join(bridge, 'StartupHook.cs'), 'utf8'), /^using Anvil\./m);
});

test('the ODC bridge compiles the copy and no file of the kernel; ReferenceCommands calls the copy', () => {
  const project = fs.readFileSync(path.join(bridge, 'Bridge.csproj'), 'utf8');
  const compiled = [...project.matchAll(/<Compile Include="([^"]+)"/g)].map(m => m[1].replaceAll('\\', '/'));
  const READER = '../../../../kernel/src/Anvil.Core.Odc/Adapters.ODC/PublicSignatureReader.cs';
  assert.ok(compiled.includes(READER), 'the bridge links the one reader');
  assert.ok(compiled.includes('MergeOrderCopy.cs'));
  assert.ok(compiled.includes('SecurityWarningsCopy.cs'));
  // kernel/query-test is not the kernel: the native query test runtime (namespace SSAM.QueryTesting, no kernel type) that
  // runs inside the Studio; the agent pack's IP scan still reads the built DLL for every kernel name.
  // The 24th release (bridge v96) links PrivateHttpContext.cs of the O11 bridge folder: the private Portal transport's pipe
  // record, namespace Ssam.PrivateTransport, no kernel type either; a file shared by the two bridges (SHARED.md of the
  // agent box). Any other file under kernel/ stays out.
  const SHARED_TRANSPORT = '../../../../kernel/src/Anvil.Bridge/PrivateHttpContext.cs';
  assert.deepEqual(compiled.filter(file => /(^|\/)kernel\//.test(file) && !/(^|\/)kernel\/query-test\//.test(file) && file !== SHARED_TRANSPORT && file !== READER), [], 'no other kernel source is linked into the bridge');
  for (const file of fs.readdirSync(path.join(repo, 'kernel', 'query-test')).filter(f => f.endsWith('.cs')))
    assert.doesNotMatch(fs.readFileSync(path.join(repo, 'kernel', 'query-test', file), 'utf8'), /Anvil\.|Ssam\.Runtime|Ssam\.Lic/, file + ' names no kernel namespace');
  if (compiled.includes(SHARED_TRANSPORT)) {
    const transport = fs.readFileSync(path.join(bridge, ...SHARED_TRANSPORT.split('/')), 'utf8');
    assert.match(transport, /^namespace Ssam\.PrivateTransport;\r?$/m, 'the shared transport file keeps its own namespace');
    assert.doesNotMatch(transport, /Anvil\.|Ssam\.Runtime|Ssam\.Lic/, 'PrivateHttpContext.cs names no kernel namespace');
  }
  const commands = fs.readFileSync(path.join(bridge, 'ReferenceCommands.cs'), 'utf8');
  assert.match(commands, /PublicSignatureReader\.Read\(info\.SignatureBinary!\)/);
  assert.doesNotMatch(commands, /Anvil\.Core/);
});

// G-2 (C16, atritos 3): MergeDiagnostics.BlocksAfterMerge reads the kernel's list of security warnings. The bridge compiles
// SecurityWarningsCopy.cs, the kernel's SecurityWarnings.cs with only the namespace dropped and the class internal, so the
// bridge DLL carries no kernel type; Bridge.Tests compiles the same copy.
test('SecurityWarningsCopy (ODC bridge v97) is SecurityWarnings (the kernel v97 was built with) with only the namespace and the visibility changed', () => {
  const code = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
  const kernel = code(path.join(v97, 'SecurityWarnings.cs.txt'));
  const copy = code(path.join(bridge, 'SecurityWarningsCopy.cs'));
  assert.match(kernel, /^namespace Anvil\.Core;$/m);
  assert.doesNotMatch(copy, /^namespace /m);
  assert.doesNotMatch(copy, /Anvil\.Core/);
  assert.match(copy, /^internal static class SecurityWarnings\s*$/m);
  const normalized = text => text.replace(/^namespace Anvil\.Core;$/m, '').replace(/^public static class SecurityWarnings\s*$/m, 'internal static class SecurityWarnings').replace(/\s+/g, ' ').trim();
  assert.equal(normalized(copy), normalized(kernel));
  assert.doesNotMatch(fs.readFileSync(path.join(bridge, 'MergeDiagnostics.cs'), 'utf8'), /Anvil\.Core/);
  const tests = fs.readFileSync(path.join(bridge, 'tests', 'Bridge.Tests.csproj'), 'utf8');
  assert.match(tests, /SecurityWarningsCopy\.cs/);
  assert.doesNotMatch(tests, /Anvil\.Core[\\/]Kernel[\\/]SecurityWarnings\.cs/);
});

// The accepted drift between the kernel v97 was built with and today's kernel, exactly: a new change of either file fails
// here until it is judged against the v97 bridge (and the bridge is rebuilt, or the change accepted here with its reason).
test('a v97 bridge gives no wrong answer: the one reader keeps every row of v97, and a capture is read from its bytes on both sides of the server', () => {
  const rowsOf = file => [...fs.readFileSync(file, 'utf8').matchAll(/"([A-Za-z.]+)" => "([a-z-]+)",/g)].map(m => m[1] + '=' + m[2]);
  const then = rowsOf(v97KernelFile), now = rowsOf(readerFile);
  for (const row of then) assert.ok(now.includes(row), row + ' stays');
  assert.deepEqual(now.filter(r => !then.includes(r)), ['ReferenceServiceAPIMethod=service-action'], 'a new row is judged against the old bridges here');
  assert.match(fs.readFileSync(kernelFile, 'utf8'), /NativeReferenceSnapshot\.ElementsOfSignature = /, 'the kernel reads a capture from its bytes');
  assert.match(fs.readFileSync(path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'NativeReferenceSnapshot.cs'), 'utf8'), /snapshot=FromItsBytes\(snapshot\);/);
  assert.match(fs.readFileSync(path.join(odc, 'facade', 'kernel-delivery.mjs'), 'utf8'), /await readSignatureKernel\(capture, deps\)/, 'the facade judges what a list lacks on the bytes');
});

test('accepted drift since v97: SecurityWarnings is the T12 list, which the server applies after a v97 merge', () => {
  const code = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n').replace(/\s+/g, ' ').trim();
  const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
  assert.equal(sha(code(path.join(v97, 'SecurityWarnings.cs.txt'))), V97_SECURITY, 'the v97 fixture is the file the bridge copied');
  assert.equal(sha(code(path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'SecurityWarnings.cs'))), T12_SECURITY,
    'SecurityWarnings.cs changed after T12: judge it against bridge v97 (facade/security-after-merge.mjs) and update this pin');
});