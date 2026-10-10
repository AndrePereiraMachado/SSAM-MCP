import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { selectedO11Publisher, fingerprintO11Publisher, fingerprintO11PublisherPackage,
  O11_PUBLISHER_SELECTION_SCHEMA, O11_PUBLISHER_QUALIFICATION_SCHEMA, O11_PUBLISHER_VERIFY_SCHEMA } from '../debug-o11-publisher.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
const save = (file, value) => write(file, JSON.stringify(value, null, 2));
const pinned = file => ({ path: file, sha256: hash(fs.readFileSync(file)) });
const refusal = code => error => error.code === code && error.message === code;

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-publisher-'));
  const studioDir = path.join(root, 'installed-studio'), proof = path.join(root, '.local', 'debugger', 'proofs', 'publisher-fixture');
  const cli = path.join(proof, 'cli'), assemblyPath = path.join(cli, 'anvil.dll');
  const coreProject = path.join(root, 'kernel', 'src', 'Anvil.Core', 'Anvil.Core.csproj');
  write(coreProject, '<Project><Reference Include="OutSystems.Communication"><HintPath>$(SSDir)\\OutSystems.Communication.dll</HintPath></Reference></Project>');
  write(path.join(root, 'kernel', 'src', 'Anvil.Cli', 'Anvil.Cli.csproj'), '<Project/>');
  write(path.join(root, 'kernel', 'src', 'Anvil.Cli', 'PublishOmlCommand.cs'), 'original source');
  write(path.join(root, 'kernel', 'Directory.Build.props'), '<Project/>');
  write(path.join(root, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'ScreenVocabulary.json'), '{"native":true}');
  write(path.join(studioDir, 'OutSystems.Communication.dll'), 'native SDK fixture');
  write(path.join(studioDir, 'System.Diagnostics.DiagnosticSource.dll'), 'compat SDK fixture');
  write(path.join(studioDir, 'ServiceStudio.exe'), 'native executable fixture');
  const compatibility = write(path.join(root, 'kernel', '.local', 'runtime-connect', 'native-sdk-compat.targets'),
    '<Project><Reference><HintPath>$(SSDir)\\System.Diagnostics.DiagnosticSource.dll</HintPath></Reference></Project>');
  for (const [file, content] of Object.entries({ 'anvil.dll': 'dedicated new publisher', 'Anvil.Core.dll': 'new publisher dependency',
    'anvil.deps.json': '{"runtimeTarget":{}}', 'anvil.runtimeconfig.json': '{"runtimeOptions":{}}' })) write(path.join(cli, file), content);
  const inputs = await fingerprintO11Publisher(studioDir, { root, pinnedBuildInputs: [compatibility] });
  const bundle = await fingerprintO11PublisherPackage(assemblyPath, { root });
  const binding = { capability: 'publish-oml', assemblySha256: bundle.assemblySha256, studioDirectory: inputs.studioDirectory,
    sourceSha256: inputs.sourceFingerprint.sha256, nativeSdkSha256: inputs.nativeSdk.sha256,
    buildInputsSha256: inputs.buildInputsSha256, packageSha256: bundle.packageSha256 };
  const protocolPath = write(path.join(proof, 'protocol-tests.trx'),
    '<TestRun><UnitTestResult testName="Anvil.Tests.PublishOmlProtocolTests.Exact_binding" outcome="Passed"/>' +
    '<ResultSummary outcome="Completed"><Counters total="2" executed="2" passed="2" failed="0" error="0" timeout="0" ' +
    'aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" completed="2" inProgress="0" pending="0"/></ResultSummary></TestRun>');
  const nodePath = write(path.join(proof, 'node-tests.tap'),
    'TAP version 13\nok 1 - scoped protocol\nok 2 - private payload\n1..2\n# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n');
  const candidatePath = write(path.join(proof, 'candidate.oml'), 'synthetic candidate verified by mock');
  const verifyPath = path.join(proof, 'native-verify.json');
  const verify = { schema: O11_PUBLISHER_VERIFY_SCHEMA, ...binding, runtime: 'o11', accepted: true, isValid: true,
    candidate: pinned(candidatePath) };
  save(verifyPath, verify);
  const qualificationPath = path.join(proof, 'qualification.json');
  const qualification = { schema: O11_PUBLISHER_QUALIFICATION_SCHEMA, ...binding,
    tests: [{ ...pinned(protocolPath), kind: 'protocol', format: 'trx', passed: 2, total: 2 },
      { ...pinned(nodePath), kind: 'node', format: 'tap', passed: 2, total: 2 }], nativeVerify: pinned(verifyPath) };
  save(qualificationPath, qualification);
  const selectionPath = path.join(root, '.local', 'debugger', 'o11-publisher-selection.json');
  const selection = { schema: O11_PUBLISHER_SELECTION_SCHEMA, capability: 'publish-oml', ...inputs, ...bundle,
    qualification: pinned(qualificationPath) };
  save(selectionPath, selection);
  return { root, studioDir, proof, cli, assemblyPath, inputs, bundle, compatibility, protocolPath, nodePath,
    candidatePath, verifyPath, verify, qualificationPath, qualification, selectionPath, selection,
    select: options => selectedO11Publisher(studioDir, { root, ...options }),
    refreshQualification() { save(qualificationPath, qualification); selection.qualification = pinned(qualificationPath); save(selectionPath, selection); },
    refreshVerify() { save(verifyPath, verify); qualification.nativeVerify = pinned(verifyPath); this.refreshQualification(); },
    close() { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('explicit qualified cold package returns only its absolute DLL; default selection and test override share gates', async () => {
  const f = await fixture(); try {
    assert.equal(await f.select(), fs.realpathSync(f.assemblyPath));
    assert.equal(await f.select({ selectionPath: f.selectionPath }), fs.realpathSync(f.assemblyPath));
    assert.ok(f.inputs.nativeSdk.files.some(file => file.path === 'System.Diagnostics.DiagnosticSource.dll'));
    assert.ok(f.inputs.sourceFingerprint.files.some(file => file.path === 'kernel/Directory.Build.props'));
    assert.equal(f.inputs.pinnedBuildInputs.length, 1);
  } finally { f.close(); }
});

test('missing selection refuses even when an older CLI exists and has the newest timestamp', async () => {
  const f = await fixture(); try {
    fs.unlinkSync(f.selectionPath);
    write(path.join(f.root, '.local', 'cli', 'anvil.dll'), 'old operational package');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_file_unavailable'));
  } finally { f.close(); }
});

test('source fingerprint includes new source, Directory.Build and embedded vocabulary, and excludes bin/obj', async () => {
  const f = await fixture(); try {
    write(path.join(f.root, 'kernel', 'src', 'Anvil.Cli', 'obj', 'generated.cs'), 'unqualified generated output');
    write(path.join(f.root, 'kernel', 'src', 'Anvil.Core', 'bin', 'Generated.cs'), 'unqualified generated output');
    assert.equal(await f.select(), fs.realpathSync(f.assemblyPath));
    write(path.join(f.root, 'kernel', 'src', 'Anvil.Cli', 'FreshCommand.cs'), 'new source');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_source_changed'));
    fs.unlinkSync(path.join(f.root, 'kernel', 'src', 'Anvil.Cli', 'FreshCommand.cs'));
    write(path.join(f.root, 'kernel', 'Directory.Build.targets'), '<Project>changed build</Project>');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_source_changed'));
    fs.unlinkSync(path.join(f.root, 'kernel', 'Directory.Build.targets'));
    write(path.join(f.root, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'ScreenVocabulary.json'), '{}');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_source_changed'));
  } finally { f.close(); }
});

test('SDK bytes and selected installation must match the qualified build', async () => {
  const f = await fixture(); try {
    write(path.join(f.studioDir, 'OutSystems.Communication.dll'), 'SDK changed');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_sdk_mismatch'));
    const other = path.join(f.root, 'other-studio'); fs.cpSync(f.studioDir, other, { recursive: true });
    await assert.rejects(selectedO11Publisher(other, { root: f.root }), refusal('debug_o11_publisher_sdk_mismatch'));
  } finally { f.close(); }
});

test('compatibility targets cannot be omitted or changed, and their SDK references are pinned', async () => {
  const f = await fixture(); try {
    f.selection.pinnedBuildInputs = []; save(f.selectionPath, f.selection);
    await assert.rejects(f.select(), refusal('debug_o11_publisher_build_inputs_changed'));
    f.selection.pinnedBuildInputs = f.inputs.pinnedBuildInputs; save(f.selectionPath, f.selection);
    write(f.compatibility, fs.readFileSync(f.compatibility, 'utf8') + '<!-- changed -->');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_build_inputs_changed'));
    write(f.compatibility, '<Project><Reference><HintPath>$(SSDir)\\System.Diagnostics.DiagnosticSource.dll</HintPath></Reference></Project>');
    write(path.join(f.studioDir, 'System.Diagnostics.DiagnosticSource.dll'), 'extra SDK changed');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_sdk_mismatch'));
  } finally { f.close(); }
});

test('assembly and complete dependency inventory are immutable, including unexpected files in bin', async () => {
  const f = await fixture(); try {
    write(f.assemblyPath, 'tampered publisher');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_assembly_changed'));
    write(f.assemblyPath, 'dedicated new publisher');
    write(path.join(f.cli, 'Anvil.Core.dll'), 'tampered dependency');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_package_changed'));
    write(path.join(f.cli, 'Anvil.Core.dll'), 'new publisher dependency');
    write(path.join(f.cli, 'bin', 'unexpected.dll'), 'unverified dependency');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_package_changed'));
  } finally { f.close(); }
});

test('qualification hash, package binding, native Verify and candidate hashes all fail closed', async () => {
  const f = await fixture(); try {
    write(f.qualificationPath, '{}');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_receipt_changed'));
    f.qualification.assemblySha256 = 'a'.repeat(64); f.refreshQualification();
    await assert.rejects(f.select(), refusal('debug_o11_publisher_qualification_mismatch'));
    f.qualification.assemblySha256 = f.bundle.assemblySha256; f.refreshQualification();
    f.verify.isValid = false; f.refreshVerify();
    await assert.rejects(f.select(), refusal('debug_o11_publisher_native_verify_missing'));
    f.verify.isValid = true; f.refreshVerify();
    write(f.candidatePath, 'candidate changed after Verify');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_receipt_changed'));
  } finally { f.close(); }
});

test('a qualification summary cannot hide failed protocol or Node test results', async () => {
  const f = await fixture(); try {
    write(f.protocolPath, fs.readFileSync(f.protocolPath, 'utf8').replace('failed="0"', 'failed="1"'));
    f.qualification.tests[0] = { ...f.qualification.tests[0], ...pinned(f.protocolPath) }; f.refreshQualification();
    await assert.rejects(f.select(), refusal('debug_o11_publisher_tests_not_passed'));
    write(f.protocolPath, fs.readFileSync(f.protocolPath, 'utf8').replace('failed="1"', 'failed="0"'));
    f.qualification.tests[0] = { ...f.qualification.tests[0], ...pinned(f.protocolPath) }; f.refreshQualification();
    write(f.nodePath, fs.readFileSync(f.nodePath, 'utf8').replace('# fail 0', '# fail 1'));
    f.qualification.tests[1] = { ...f.qualification.tests[1], ...pinned(f.nodePath) }; f.refreshQualification();
    await assert.rejects(f.select(), refusal('debug_o11_publisher_tests_not_passed'));
  } finally { f.close(); }
});

test('publisher and qualification cannot escape the ignored root, and normal operational CLI is ineligible', async () => {
  const f = await fixture(); try {
    f.selection.assemblyPath = write(path.join(f.root, 'unselected', 'anvil.dll'), 'dedicated new publisher'); save(f.selectionPath, f.selection);
    await assert.rejects(f.select(), refusal('debug_o11_publisher_invalid_path'));
    f.selection.assemblyPath = write(path.join(f.root, '.local', 'cli', 'anvil.dll'), 'dedicated new publisher'); save(f.selectionPath, f.selection);
    await assert.rejects(f.select(), refusal('debug_o11_publisher_invalid_path'));
    f.selection.assemblyPath = f.assemblyPath;
    f.selection.qualification = { ...f.selection.qualification, path: write(path.join(f.root, 'qualification.json'), '{}') }; save(f.selectionPath, f.selection);
    await assert.rejects(f.select(), refusal('debug_o11_publisher_invalid_path'));
  } finally { f.close(); }
});

test('manifest must be dedicated publish-oml and cannot declare another successful capability', async () => {
  const f = await fixture(); try {
    f.selection.capability = 'inventory'; save(f.selectionPath, f.selection);
    await assert.rejects(f.select(), refusal('debug_o11_publisher_invalid_manifest'));
    f.selection.capability = 'publish-oml'; f.selection.schema = 1; save(f.selectionPath, f.selection);
    await assert.rejects(f.select(), refusal('debug_o11_publisher_invalid_manifest'));
  } finally { f.close(); }
});

test('SDK copies and junctions in a cold package are refused', async () => {
  const f = await fixture(); try {
    write(path.join(f.cli, 'OutSystems.Communication.dll'), 'SDK copied into package');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_copied_sdk'));
    fs.unlinkSync(path.join(f.cli, 'OutSystems.Communication.dll'));
    const outside = path.join(f.root, 'outside-package'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.cli, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.select(), refusal('debug_o11_publisher_invalid_path'));
  } finally { f.close(); }
});
