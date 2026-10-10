// A cold publisher is selected explicitly; this module never builds, starts a worker or publishes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workspaceRoot } from './workspace.mjs';

export const O11_PUBLISHER_SELECTION_SCHEMA = 'ssam-debug-o11-publisher-selection/1';
export const O11_PUBLISHER_QUALIFICATION_SCHEMA = 'ssam-debug-o11-publisher-qualification/1';
export const O11_PUBLISHER_VERIFY_SCHEMA = 'ssam-debug-o11-publisher-native-verify/1';
const SHA = /^[a-f0-9]{64}$/, CAPABILITY = 'publish-oml';
const sourceExtensions = new Set(['.cs', '.csproj', '.props', '.targets']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = files => sha(Buffer.from(JSON.stringify(files)));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const slash = value => value.split(path.sep).join('/');
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (base, file) => { const relative = path.relative(base, file); return relative !== '' && relative !== '..' &&
  !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function real(file, kind) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('debug_o11_publisher_invalid_path');
  try {
    const stat = fs.lstatSync(file), resolved = fs.realpathSync(file);
    if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) fail('debug_o11_publisher_invalid_path');
    return resolved;
  } catch (error) {
    if (error.code?.startsWith('debug_o11_publisher_')) throw error;
    fail('debug_o11_publisher_file_unavailable');
  }
}

function localFile(root, file, { buildInput = false } = {}) {
  const bases = [path.join(root, '.local'), ...(buildInput ? [path.join(root, 'kernel', '.local')] : [])];
  if (!bases.some(base => within(base, path.resolve(file)))) fail('debug_o11_publisher_invalid_path');
  const resolved = real(file, 'file');
  if (!bases.some(base => { try { return within(real(base, 'directory'), resolved); } catch { return false; } }))
    fail('debug_o11_publisher_invalid_path');
  return resolved;
}

function bytes(file, maximum = 256 * 1024 * 1024) {
  try {
    if (fs.statSync(file).size > maximum) fail('debug_o11_publisher_file_too_large');
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code?.startsWith('debug_o11_publisher_')) throw error;
    fail('debug_o11_publisher_file_unavailable');
  }
}

function json(file) {
  try { return JSON.parse(bytes(file, 2 * 1024 * 1024).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code?.startsWith('debug_o11_publisher_')) throw error;
    fail('debug_o11_publisher_invalid_manifest');
  }
}

function walk(directory, accept, files = [], maximum = 10000, excludeBuildDirectories = true) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (excludeBuildDirectories && ['bin', 'obj'].includes(entry.name.toLowerCase())) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('debug_o11_publisher_invalid_path');
    if (entry.isDirectory()) walk(file, accept, files, maximum, excludeBuildDirectories);
    else if (entry.isFile() && accept(file)) files.push(file);
    else if (!entry.isFile()) fail('debug_o11_publisher_invalid_path');
    if (files.length > maximum) fail('debug_o11_publisher_inventory_too_large');
  }
  return files;
}

function sourceFingerprint(root) {
  const sourceRoot = real(path.join(root, 'kernel', 'src'), 'directory');
  const files = walk(sourceRoot, file => sourceExtensions.has(path.extname(file).toLowerCase()));
  for (const base of [root, path.join(root, 'kernel')]) for (const name of ['Directory.Build.props', 'Directory.Build.targets']) {
    const file = path.join(base, name); if (fs.existsSync(file)) files.push(real(file, 'file'));
  }
  // This JSON is compiled into both model adapters, so changing it changes the publisher too.
  const vocabulary = path.join(sourceRoot, 'Anvil.Core', 'Kernel', 'ScreenVocabulary.json');
  if (fs.existsSync(vocabulary)) files.push(real(vocabulary, 'file'));
  if (!files.some(file => equalPath(file, path.join(sourceRoot, 'Anvil.Cli', 'Anvil.Cli.csproj'))) ||
      !files.some(file => equalPath(file, path.join(sourceRoot, 'Anvil.Core', 'Anvil.Core.csproj'))))
    fail('debug_o11_publisher_source_unavailable');
  const records = [...new Set(files)].map(file => {
    const resolved = real(file, 'file');
    if (!within(root, resolved)) fail('debug_o11_publisher_invalid_path');
    return { path: slash(path.relative(root, resolved)), sha256: sha(bytes(resolved)) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { schema: 'ssam-debug-o11-publisher-sources/1', sha256: digest(records), files: records };
}

function studioReferences(text) {
  return [...text.matchAll(/<HintPath\s*>\s*\$\(SSDir\)[\\/]([^<>]+)\s*<\/HintPath>/gi)].map(match => {
    const name = match[1].trim();
    if (!/^[A-Za-z0-9_.-]+\.dll$/.test(name)) fail('debug_o11_publisher_sdk_contract_unsupported');
    return name;
  });
}

/** Packagers use the same source/SDK calculation as selection. It only reads public build inputs. */
export async function fingerprintO11Publisher(studioDir, { root = workspaceRoot, pinnedBuildInputs = [] } = {}) {
  root = real(path.resolve(root), 'directory');
  const studioDirectory = real(studioDir, 'directory');
  if (!Array.isArray(pinnedBuildInputs) || pinnedBuildInputs.length > 16) fail('debug_o11_publisher_invalid_build_inputs');
  const inputs = [...pinnedBuildInputs];
  const compatibility = path.join(root, 'kernel', '.local', 'runtime-connect', 'native-sdk-compat.targets');
  if (fs.existsSync(compatibility)) inputs.push(compatibility);
  const paths = [...new Set(inputs.map(file => localFile(root, file, { buildInput: true })))].sort();
  const pinned = paths.map(file => {
    if (!['.props', '.targets'].includes(path.extname(file).toLowerCase())) fail('debug_o11_publisher_invalid_build_inputs');
    return { path: file, sha256: sha(bytes(file, 2 * 1024 * 1024)) };
  });
  const names = new Set(studioReferences(bytes(path.join(root, 'kernel', 'src', 'Anvil.Core', 'Anvil.Core.csproj')).toString('utf8')));
  for (const file of paths) for (const name of studioReferences(bytes(file, 2 * 1024 * 1024).toString('utf8'))) names.add(name);
  if (names.size === 0) fail('debug_o11_publisher_sdk_contract_unsupported');
  if (fs.existsSync(path.join(studioDirectory, 'ServiceStudio.exe'))) names.add('ServiceStudio.exe');
  const sdkFiles = [...names].sort().map(name => {
    const file = real(path.join(studioDirectory, name), 'file');
    if (!within(studioDirectory, file)) fail('debug_o11_publisher_sdk_mismatch');
    return { path: name, sha256: sha(bytes(file)) };
  });
  return { studioDirectory, sourceFingerprint: sourceFingerprint(root),
    nativeSdk: { schema: 'ssam-debug-o11-publisher-sdk/1', sha256: digest(sdkFiles), files: sdkFiles },
    pinnedBuildInputs: pinned, buildInputsSha256: digest(pinned) };
}

/** Complete isolated package inventory: replacing a dependency also invalidates selection. */
export async function fingerprintO11PublisherPackage(assemblyPath, { root = workspaceRoot } = {}) {
  root = real(path.resolve(root), 'directory');
  const assembly = localFile(root, assemblyPath), directory = path.dirname(assembly);
  if (path.basename(assembly) !== 'anvil.dll' || !within(path.join(root, '.local', 'debugger'), assembly))
    fail('debug_o11_publisher_invalid_path');
  const files = walk(directory, () => true, [], 5000, false).map(file => {
    const resolved = localFile(root, file);
    if (!within(directory, resolved)) fail('debug_o11_publisher_invalid_path');
    return { path: slash(path.relative(directory, resolved)), sha256: sha(bytes(resolved)) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const required of ['anvil.dll', 'Anvil.Core.dll', 'anvil.deps.json', 'anvil.runtimeconfig.json'])
    if (!files.some(file => file.path === required)) fail('debug_o11_publisher_package_incomplete');
  if (files.some(file => /(^|\/)(OutSystems\.|ServiceStudio\.).*\.dll$/i.test(file.path)))
    fail('debug_o11_publisher_copied_sdk');
  return { assemblyPath: assembly, assemblySha256: files.find(file => file.path === 'anvil.dll').sha256,
    packageFiles: files, packageSha256: digest(files) };
}

function same(actual, expected, code) { if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code); }
function pinnedReceipt(root, record, maximum = 8 * 1024 * 1024) {
  if (!record || !SHA.test(record.sha256 ?? '')) fail('debug_o11_publisher_qualification_missing');
  const file = localFile(root, record.path);
  const content = bytes(file, maximum);
  if (sha(content) !== record.sha256) fail('debug_o11_publisher_receipt_changed');
  return content;
}

function testReceipt(root, record) {
  if (!['protocol', 'node'].includes(record?.kind) || !Number.isSafeInteger(record.passed) || record.passed < 1 ||
      record.total !== record.passed) fail('debug_o11_publisher_tests_not_passed');
  const text = pinnedReceipt(root, record).toString('utf8');
  if (record.kind === 'protocol' && record.format === 'trx') {
    const counter = text.match(/<Counters\s+([^>]+)\/?\s*>/);
    const attributes = Object.fromEntries([...String(counter?.[1] ?? '').matchAll(/([A-Za-z]+)="(\d+)"/g)].map(match => [match[1], Number(match[2])]));
    if (attributes.total !== record.total || attributes.passed !== record.passed || attributes.executed !== record.total ||
        !/PublishOmlProtocolTests/.test(text) || !/outcome="Completed"/.test(text) ||
        Object.entries(attributes).some(([key, value]) => !['total', 'executed', 'passed', 'completed'].includes(key) && value !== 0))
      fail('debug_o11_publisher_tests_not_passed');
  } else if (record.kind === 'node' && record.format === 'tap') {
    const field = name => Number(text.match(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'm'))?.[1] ?? NaN);
    if (field('tests') !== record.total || field('pass') !== record.passed ||
        ['fail', 'cancelled', 'skipped', 'todo'].some(name => field(name) !== 0)) fail('debug_o11_publisher_tests_not_passed');
  } else fail('debug_o11_publisher_tests_not_passed');
}

/** Return only the selected DLL; absence, changed inputs or missing qualification always refuse. */
export async function selectedO11Publisher(studioDir, { root = workspaceRoot, selectionPath } = {}) {
  try {
    root = real(path.resolve(root), 'directory');
    const selected = localFile(root, selectionPath ?? path.join(root, '.local', 'debugger', 'o11-publisher-selection.json'));
    const selection = json(selected);
    if (selection.schema !== O11_PUBLISHER_SELECTION_SCHEMA || selection.capability !== CAPABILITY ||
        !Array.isArray(selection.pinnedBuildInputs) || !SHA.test(selection.assemblySha256 ?? ''))
      fail('debug_o11_publisher_invalid_manifest');
    const inputs = await fingerprintO11Publisher(studioDir, { root, pinnedBuildInputs: selection.pinnedBuildInputs.map(file => file.path) });
    if (!equalPath(inputs.studioDirectory, selection.studioDirectory ?? '')) fail('debug_o11_publisher_sdk_mismatch');
    same(inputs.sourceFingerprint, selection.sourceFingerprint, 'debug_o11_publisher_source_changed');
    same(inputs.nativeSdk, selection.nativeSdk, 'debug_o11_publisher_sdk_mismatch');
    same(inputs.pinnedBuildInputs, selection.pinnedBuildInputs, 'debug_o11_publisher_build_inputs_changed');
    const bundle = await fingerprintO11PublisherPackage(selection.assemblyPath, { root });
    if (bundle.assemblySha256 !== selection.assemblySha256) fail('debug_o11_publisher_assembly_changed');
    same(bundle.packageFiles, selection.packageFiles, 'debug_o11_publisher_package_changed');
    if (bundle.packageSha256 !== selection.packageSha256) fail('debug_o11_publisher_package_changed');
    if (bundle.packageFiles.some(file => inputs.nativeSdk.files.some(sdk => path.basename(file.path) === sdk.path)))
      fail('debug_o11_publisher_copied_sdk');
    const binding = { capability: CAPABILITY, assemblySha256: bundle.assemblySha256,
      studioDirectory: inputs.studioDirectory, sourceSha256: inputs.sourceFingerprint.sha256,
      nativeSdkSha256: inputs.nativeSdk.sha256, buildInputsSha256: inputs.buildInputsSha256, packageSha256: bundle.packageSha256 };
    const qualified = JSON.parse(pinnedReceipt(root, selection.qualification).toString('utf8').replace(/^\uFEFF/, ''));
    if (qualified.schema !== O11_PUBLISHER_QUALIFICATION_SCHEMA) fail('debug_o11_publisher_qualification_missing');
    for (const [key, value] of Object.entries(binding)) same(qualified[key], value, 'debug_o11_publisher_qualification_mismatch');
    if (!Array.isArray(qualified.tests) || qualified.tests.length < 2 || qualified.tests.length > 16 ||
        !qualified.tests.some(test => test.kind === 'protocol') || !qualified.tests.some(test => test.kind === 'node'))
      fail('debug_o11_publisher_tests_not_passed');
    for (const receipt of qualified.tests) testReceipt(root, receipt);
    const verified = JSON.parse(pinnedReceipt(root, qualified.nativeVerify).toString('utf8').replace(/^\uFEFF/, ''));
    if (verified.schema !== O11_PUBLISHER_VERIFY_SCHEMA || verified.runtime !== 'o11' || verified.accepted !== true || verified.isValid !== true)
      fail('debug_o11_publisher_native_verify_missing');
    for (const [key, value] of Object.entries(binding)) same(verified[key], value, 'debug_o11_publisher_qualification_mismatch');
    if (path.extname(verified.candidate?.path ?? '').toLowerCase() !== '.oml') fail('debug_o11_publisher_native_verify_missing');
    pinnedReceipt(root, verified.candidate, 256 * 1024 * 1024);
    // No mutation may be hidden by a receipt validated earlier in this gate.
    same(await fingerprintO11Publisher(studioDir, { root, pinnedBuildInputs: inputs.pinnedBuildInputs.map(file => file.path) }),
      inputs, 'debug_o11_publisher_inputs_changed');
    same(await fingerprintO11PublisherPackage(bundle.assemblyPath, { root }), bundle, 'debug_o11_publisher_package_changed');
    return bundle.assemblyPath;
  } catch (error) {
    if (error.code?.startsWith('debug_o11_publisher_')) throw error;
    fail('debug_o11_publisher_selection_unavailable');
  }
}
