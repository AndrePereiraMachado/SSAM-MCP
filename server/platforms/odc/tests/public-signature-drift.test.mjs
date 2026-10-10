// Drift: the ODC bridge reads public signatures with its own copy, PublicSignatureReader (global namespace), instead of
// compiling the kernel's Anvil.Core.OdcPublicSignature, so ODC3.Bridge.v<N>.dll carries no type of the kernel namespace
// (docs/O11-BRIDGE-FINA.md 6.5). The class bodies stay equal, normalized only for namespace, class name, visibility and
// whitespace. The same holds for the merge order's rule (MergeOrderCopy.cs, a copy of the kernel's MergeOrder.cs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const odc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(odc, '..', '..');
const bridge = path.join(odc, 'studio', 'bridge');
const kernelFile = path.join(repo, 'kernel', 'src', 'Anvil.Core.Odc', 'Adapters.ODC', 'OdcPublicSignature.cs');
const copyFile = path.join(bridge, 'PublicSignatureReader.cs');

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

test('PublicSignatureReader (ODC bridge) is OdcPublicSignature (kernel) with only namespace, name and visibility changed', () => {
  const kernel = parts(fs.readFileSync(kernelFile, 'utf8'), 'OdcPublicSignature');
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
  assert.deepEqual(compiled.filter(file => /(^|\/)kernel\//.test(file) && !/(^|\/)kernel\/query-test\//.test(file)), [], 'no kernel source is linked into the bridge');
  for (const file of fs.readdirSync(path.join(repo, 'kernel', 'query-test')).filter(f => f.endsWith('.cs')))
    assert.doesNotMatch(fs.readFileSync(path.join(repo, 'kernel', 'query-test', file), 'utf8'), /Anvil\.|Ssam\.Runtime|Ssam\.Lic/, file + ' names no kernel namespace');
  const commands = fs.readFileSync(path.join(bridge, 'ReferenceCommands.cs'), 'utf8');
  assert.match(commands, /PublicSignatureReader\.Read\(info\.SignatureBinary!\)/);
  assert.doesNotMatch(commands, /Anvil\.Core/);
});

// G-2 (C16, atritos 3): MergeDiagnostics.BlocksAfterMerge reads the kernel's list of security warnings. The bridge compiles
// SecurityWarningsCopy.cs, the kernel's SecurityWarnings.cs with only the namespace dropped and the class internal, so the
// bridge DLL carries no kernel type; Bridge.Tests compiles the same copy.
test('SecurityWarningsCopy (ODC bridge) is SecurityWarnings (kernel) with only the namespace and the visibility changed', () => {
  const code = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');
  const kernel = code(path.join(repo, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'SecurityWarnings.cs'));
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