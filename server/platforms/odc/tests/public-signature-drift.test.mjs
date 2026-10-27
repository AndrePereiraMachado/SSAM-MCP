// Drift: the ODC bridge reads public signatures with its own copy, PublicSignatureReader (global namespace), instead of
// compiling the kernel's Anvil.Core.OdcPublicSignature, so ODC3.Bridge.v<N>.dll carries no type of the kernel namespace
// (docs/O11-BRIDGE-FINA.md 6.5). The class bodies stay equal, normalized only for namespace, class name, visibility and
// whitespace. The same holds for the merge order's rule (MergeOrderCopy.cs, a copy of the kernel's MergeOrder.cs).
// a11-b: the customers run ODC bridge v97 (f912cb7e), whose two copies PublicSignatureReader.cs and SecurityWarningsCopy.cs are
// pinned to the kernel files it was built with (fixtures/bridge-v97/*.cs.txt, the blobs of f912cb7e and a10 5dc9ec51); the
// kernel moved on and the drift is accepted, each change named below with why it gives no wrong answer to a v97 bridge:
//   - OdcPublicSignature.cs, c38c53e0: + ReferenceServiceAPIMethod => "service-action". v97 lists every element it listed
//     before, with the same kind, name and key, and the kernel's importer validates each selected element against its own
//     read (a superset); a Service Action reference needs a newer bridge (v97 answers it as before: the element is missing).
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
const copyFile = path.join(bridge, 'PublicSignatureReader.cs');
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

test('PublicSignatureReader (ODC bridge v97) is OdcPublicSignature (the kernel v97 was built with) with only namespace, name and visibility changed', () => {
  const kernel = parts(fs.readFileSync(v97KernelFile, 'utf8'), 'OdcPublicSignature');
  const copy = parts(fs.readFileSync(copyFile, 'utf8'), 'PublicSignatureReader');
  assert.equal(kernel.namespace, 'Anvil.Core');
  assert.equal(kernel.visibility, 'public');
  assert.equal(copy.namespace, null, 'the copy is in the global namespace, like the rest of the bridge');
  assert.equal(copy.visibility, 'internal');
  assert.deepEqual(copy.usings, kernel.usings);
  assert.ok(kernel.body.includes('public static Catalog Read(byte[] bytes)'));
  assert.equal(copy.body, kernel.body);
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
  assert.ok(compiled.includes('PublicSignatureReader.cs'));
  assert.ok(compiled.includes('MergeOrderCopy.cs'));
  assert.ok(compiled.includes('SecurityWarningsCopy.cs'));
  // kernel/query-test is not the kernel: the native query test runtime (namespace SSAM.QueryTesting, no kernel type) that
  // runs inside the Studio; the agent pack's IP scan still reads the built DLL for every kernel name.
  // The 24th release (bridge v96) links PrivateHttpContext.cs of the O11 bridge folder: the private Portal transport's pipe
  // record, namespace Ssam.PrivateTransport, no kernel type either; a file shared by the two bridges (SHARED.md of the
  // agent box). Any other file under kernel/ stays out.
  const SHARED_TRANSPORT = '../../../../kernel/src/Anvil.Bridge/PrivateHttpContext.cs';
  assert.deepEqual(compiled.filter(file => /(^|\/)kernel\//.test(file) && !/(^|\/)kernel\/query-test\//.test(file) && file !== SHARED_TRANSPORT), [], 'no kernel source is linked into the bridge');
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
test('accepted drift since v97: OdcPublicSignature gains only the Service Action kind', () => {
  const now = parts(fs.readFileSync(kernelFile, 'utf8'), 'OdcPublicSignature');
  const then = parts(fs.readFileSync(v97KernelFile, 'utf8'), 'OdcPublicSignature');
  const added = ' "ReferenceServiceAPIMethod" => "service-action",';
  assert.ok(now.body.includes(added));
  assert.equal(now.body.replace(added, ''), then.body);
  assert.deepEqual(now.usings, then.usings);
});

test('accepted drift since v97: SecurityWarnings is the T12 list, which the server applies after a v97 merge', () => {
  const code = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n').replace(/\s+/g, ' ').trim();
  const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
  assert.equal(sha(code(path.join(v97, 'SecurityWarnings.cs.txt'))), V97_SECURITY, 'the v97 fixture is the file the bridge copied');
  assert.equal(sha(code(path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'SecurityWarnings.cs'))), T12_SECURITY,
    'SecurityWarnings.cs changed after T12: judge it against bridge v97 (facade/security-after-merge.mjs) and update this pin');
});