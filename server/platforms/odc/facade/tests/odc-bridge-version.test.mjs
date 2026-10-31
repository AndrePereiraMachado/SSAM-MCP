// The ODC bridge is told apart by its version name alone: a loaded DLL is never replaced (Bridge.csproj), the pipe is
// ODC3-Bridge-<version>-<pid>, and the server (kernel.json odcBridge), the agent (pack.json odcBridge) and the attach
// client compare that name, never the bytes. So a change in the bridge code still needs a new version
// (docs/CONEXAO-ODC-ASSINADA.md): the same name with other bytes is a second bridge nobody can tell from the first.
// This test holds that rule for the whole family: every source that compiles into the bridge (Bridge.csproj and each of
// its Compile items, links outside the folder included) and into its attach client (client/Client.csproj and its .cs
// files) must be, byte for byte with LF line ends, the one recorded below for the version the three version marks
// declare (StartupHook.cs Version, Bridge.csproj AssemblyName, client/Program.cs Version). A change without a new version
// fails here, naming every file that differs, in one answer. A new version records its own hashes (the sha256 of each
// file with CRLF turned into LF, as SHARED.md computes them). v97: computed from git show 3c2c73e:<path>. v100 (2026-10-27): the v97 code built for the net10 ODC Studios (1.7.30 on);
// only the three version marks changed (Bridge.csproj also names its runtime, OdcBridgeRuntime net10.0; the client attaches
// v97 to a net8 Studio and v100 to a net10 one, by the Studio's own runtimeconfig.json).
// v98 (the agent box): the data root of the packaged agent (AgentDataRoot.cs, the agent-root command), kept as the record of the agent's bridge.
// v101 (2026-10-30): v100 plus that data root, because the agent sends agent-root to every bridge from v98 on (agent/lib/kinds.mjs hasDataRootProtocol).
// The agent box guards its own v98 with a copy of this test (tests/odc-bridge-version.test.mjs); the family test below is of this box.
// v102 (2026-10-30): the same files as v101, built for the net8 ODC Studios.
// v101 again (2026-10-30, before anything carried it): the command server that survives a lost client (BridgeServe.cs,
// BridgeDeadlines.cs and the one table of deadlines, facade/bridge-deadlines.json). No package, server or Studio ever had the first
// v101, so the name stays and its hashes are recorded again; once a release carries a name, its hashes never change.
import './fixtures/isolated-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const BRIDGE = 'platforms/odc/studio/bridge';

// A name that was built and must not come back with other bytes. v100: the v97 code for the net10 ODC Studios, without the
// agent's data root; the agent refuses to work with it (ODC_DATA_ROOT_FAILED). It was never offered to an agent, and no kernel of a release that carries v101 accepts it.
const RETIRED = Object.freeze({ v100: 'no agent-root' });

const RECORDED = {
  v97: {
    'kernel/query-test/NativeQueryTest.cs': '89e2889b8a6c05380124c98239a1b4bb16eed266f031466444b76e06b4f39177',
    'kernel/query-test/QueryTestContract.cs': 'a778e457aba47971224e4a48e1a7c2ea69541a3bd8dc246527cb147218bdf7f3',
    'kernel/query-test/QueryTestOutput.cs': 'a9bb3f539accf807984d6798355ae648642568d43950b2ec01ff51784568eebf',
    'kernel/query-test/QueryTestRunner.cs': 'b9f96ac09f1aeb20493843df77a6ff6f4a59d26e485de0f603922fcfd464844c',
    'kernel/src/Anvil.Bridge/PrivateHttpContext.cs': '73785bbd6483074d865848ef9bc4f13423aabc7d371d8931e2936ffe85fdbca8',
    'platforms/odc/studio/bridge/AppCreationCommands.cs': '416c95f5bf1a86476109aa07d4950d12c05c72450a6d860a9dec4924b1341ccf',
    'platforms/odc/studio/bridge/Bridge.csproj': '3b228be57045a7a2777b9a0a2baf371c5e77c01ef119ff5ce8d4f0ed203a80ed',
    'platforms/odc/studio/bridge/DataCommands.cs': '2c8eb954b4b1d1ccace550179399a4418f43fee308f3014fe1490a30f4196aa6',
    'platforms/odc/studio/bridge/MergeDiagnostics.cs': '8a1d4b6206278e146729c6a3515d0962d0db6b64156dc9cee313dd9adf3b8573',
    'platforms/odc/studio/bridge/MergeOrderCopy.cs': '4e7a187554154662f5ffcecf401904eb4b59ef656192f7fa57afc73b13a4d2d9',
    'platforms/odc/studio/bridge/PortalApiClientCleanup.cs': '8e16426f6382149808da6cf169ab9d3e3e3bfc516b8a055467e0a6532728fd48',
    'platforms/odc/studio/bridge/PortalApiClientSecret.cs': '2bf23662976750d82ee96ca742cfd8efb3c7ea5428e5af8c2050208243f8d959',
    'platforms/odc/studio/bridge/PortalCommands.cs': '242b2e5a79eb00a78e49da9dee2b0dc42511ca3484422f7cac3a63fc7c6656c5',
    'platforms/odc/studio/bridge/PortalCore.cs': '8ad3ed73d9d362d55cd5266fc63742fbb8b395ae4296e4662286399965b4697a',
    'platforms/odc/studio/bridge/PortalKnowledgeDownload.cs': '198d3aff0965210d288e5ca17d3f19335a49856311a060813ceeecf25ceeedba',
    'platforms/odc/studio/bridge/PortalMobileDownload.cs': '14f22439e5addfb29f90292ed5c8a25a0f45ce1edd8576097a0bb73f2708fb7c',
    'platforms/odc/studio/bridge/PortalMobileUpload.cs': 'c94e420a777d52017cfa963c1f8170213d7e045f472b7d5b388a8aa72955e695',
    'platforms/odc/studio/bridge/PortalPrivateHttp.cs': '71d15be9b8394ddbd87ad084f264a2fdcefb157ef57021ca42caf54bc49c89a2',
    'platforms/odc/studio/bridge/PortalUpload.cs': '945c40b566a21546ecf36b2a0029d357f465ef8b74e5008b28acb79cfcd55736',
    'platforms/odc/studio/bridge/PortalVault.cs': 'e8780ab773dab88a75b48737b7aa29047d29aa7394206662400b4a4c652ecf7c',
    'platforms/odc/studio/bridge/PublicSignatureReader.cs': '2caccb3e657b84f750af2a1ba2723509b2775c9a4ffbd79f431fba100d6a1567',
    'platforms/odc/studio/bridge/PublishLogCommands.cs': '3f2b097bb4837e7f0a3e19a9534f5adb9dec6ec61129b9106133037bf96c8c56',
    'platforms/odc/studio/bridge/PublishLogCore.cs': '33b820a24c909f5528e3aaa50d5ac7410ae3721d3e0f819d3c4dd586cf9db730',
    'platforms/odc/studio/bridge/QueryTestCommands.cs': '97be6ecf1e5f05c2c047b03852cab69c632e580d187d6e3186932d080fd2906d',
    'platforms/odc/studio/bridge/ReferenceCommands.cs': '615e55dec013036b12270e55ec8eea2a723cce753eb367cd232884b65adf9db0',
    'platforms/odc/studio/bridge/SecurityWarningsCopy.cs': '9994c72f57a32b74fd8ca92299198e44dea11efed1023d5526f72eeb5307b698',
    'platforms/odc/studio/bridge/StartupHook.cs': '3c90b44f10511f06b9f369ff4b2499fa54b57a030563a4d2e582a3337a748b0b',
    'platforms/odc/studio/bridge/TemplateCache.cs': 'a57ef89f222983393d3249c75d543e6a2fc06aef456340a63272d8f127b3f20c',
    'platforms/odc/studio/bridge/client/Client.csproj': 'a5b9c2d9640b4df751a052075cd5b2bf9b568b7b2e00f72b160acb9ebdc953f2',
    'platforms/odc/studio/bridge/client/Program.cs': '371ac5aff49a07d71b307252b6305165f9bf258c678e9ffdc20e7e5190482f87',
    'platforms/odc/studio/engine/NativeMergeOrder.cs': '3ec32ca130504f0375a12704b58123e88539fc0472dd8174945430ac10c7e127',
    'platforms/odc/studio/engine/NativeMergeVerification.cs': 'b7b797836070709672c57d3bdeb0ebed8571e06c4dfba172b9a5a0ab7ce4aede',
    'platforms/odc/studio/shared/Journal.cs': 'e0cc116aec478a3092b9e31c04f470b6d5a47f7af72974234a3d7fa93586185e',
    'platforms/odc/studio/shared/Manifest.cs': 'bcc45f95c3b541739dad91211be17df8d2dfe1f59398ed579d5672f095b3788b',
  },
  v98: {
    'kernel/query-test/NativeQueryTest.cs': '89e2889b8a6c05380124c98239a1b4bb16eed266f031466444b76e06b4f39177',
    'kernel/query-test/QueryTestContract.cs': 'a778e457aba47971224e4a48e1a7c2ea69541a3bd8dc246527cb147218bdf7f3',
    'kernel/query-test/QueryTestOutput.cs': 'a9bb3f539accf807984d6798355ae648642568d43950b2ec01ff51784568eebf',
    'kernel/query-test/QueryTestRunner.cs': 'b9f96ac09f1aeb20493843df77a6ff6f4a59d26e485de0f603922fcfd464844c',
    'kernel/src/Anvil.Bridge/PrivateHttpContext.cs': '73785bbd6483074d865848ef9bc4f13423aabc7d371d8931e2936ffe85fdbca8',
    'platforms/odc/studio/bridge/AgentDataRoot.cs': 'dad2cf57b23e27c6dd49070fe38268cab5670bf5d7aba8404899c2ddf9c1e68e',
    'platforms/odc/studio/bridge/AppCreationCommands.cs': '416c95f5bf1a86476109aa07d4950d12c05c72450a6d860a9dec4924b1341ccf',
    'platforms/odc/studio/bridge/Bridge.csproj': 'c47d07d4360f820a7e66dffc3a4e5d42ce467026638d5263cb5d6a771bde2ace',
    'platforms/odc/studio/bridge/DataCommands.cs': '2c8eb954b4b1d1ccace550179399a4418f43fee308f3014fe1490a30f4196aa6',
    'platforms/odc/studio/bridge/MergeDiagnostics.cs': '8a1d4b6206278e146729c6a3515d0962d0db6b64156dc9cee313dd9adf3b8573',
    'platforms/odc/studio/bridge/MergeOrderCopy.cs': '4e7a187554154662f5ffcecf401904eb4b59ef656192f7fa57afc73b13a4d2d9',
    'platforms/odc/studio/bridge/PortalApiClientCleanup.cs': '8e16426f6382149808da6cf169ab9d3e3e3bfc516b8a055467e0a6532728fd48',
    'platforms/odc/studio/bridge/PortalApiClientSecret.cs': '2bf23662976750d82ee96ca742cfd8efb3c7ea5428e5af8c2050208243f8d959',
    'platforms/odc/studio/bridge/PortalCommands.cs': '242b2e5a79eb00a78e49da9dee2b0dc42511ca3484422f7cac3a63fc7c6656c5',
    'platforms/odc/studio/bridge/PortalCore.cs': '8ad3ed73d9d362d55cd5266fc63742fbb8b395ae4296e4662286399965b4697a',
    'platforms/odc/studio/bridge/PortalKnowledgeDownload.cs': '198d3aff0965210d288e5ca17d3f19335a49856311a060813ceeecf25ceeedba',
    'platforms/odc/studio/bridge/PortalMobileDownload.cs': '14f22439e5addfb29f90292ed5c8a25a0f45ce1edd8576097a0bb73f2708fb7c',
    'platforms/odc/studio/bridge/PortalMobileUpload.cs': 'c94e420a777d52017cfa963c1f8170213d7e045f472b7d5b388a8aa72955e695',
    'platforms/odc/studio/bridge/PortalPrivateHttp.cs': '71d15be9b8394ddbd87ad084f264a2fdcefb157ef57021ca42caf54bc49c89a2',
    'platforms/odc/studio/bridge/PortalUpload.cs': '945c40b566a21546ecf36b2a0029d357f465ef8b74e5008b28acb79cfcd55736',
    'platforms/odc/studio/bridge/PortalVault.cs': 'e8780ab773dab88a75b48737b7aa29047d29aa7394206662400b4a4c652ecf7c',
    'platforms/odc/studio/bridge/PublicSignatureReader.cs': '2caccb3e657b84f750af2a1ba2723509b2775c9a4ffbd79f431fba100d6a1567',
    'platforms/odc/studio/bridge/PublishLogCommands.cs': '3f2b097bb4837e7f0a3e19a9534f5adb9dec6ec61129b9106133037bf96c8c56',
    'platforms/odc/studio/bridge/PublishLogCore.cs': '33b820a24c909f5528e3aaa50d5ac7410ae3721d3e0f819d3c4dd586cf9db730',
    'platforms/odc/studio/bridge/QueryTestCommands.cs': '97be6ecf1e5f05c2c047b03852cab69c632e580d187d6e3186932d080fd2906d',
    'platforms/odc/studio/bridge/ReferenceCommands.cs': '615e55dec013036b12270e55ec8eea2a723cce753eb367cd232884b65adf9db0',
    'platforms/odc/studio/bridge/SecurityWarningsCopy.cs': '9994c72f57a32b74fd8ca92299198e44dea11efed1023d5526f72eeb5307b698',
    'platforms/odc/studio/bridge/StartupHook.cs': 'b64bd090619c9c16b15f039c6c9e50888a8062ed957693393b8810264245d8f5',
    'platforms/odc/studio/bridge/TemplateCache.cs': 'a57ef89f222983393d3249c75d543e6a2fc06aef456340a63272d8f127b3f20c',
    'platforms/odc/studio/bridge/client/Client.csproj': 'a5b9c2d9640b4df751a052075cd5b2bf9b568b7b2e00f72b160acb9ebdc953f2',
    'platforms/odc/studio/bridge/client/Program.cs': 'e07fb297d38e00b8beb41b3b961c33a3a2d3bee21eea17e13d902b4632f81606',
    'platforms/odc/studio/engine/NativeMergeOrder.cs': '3ec32ca130504f0375a12704b58123e88539fc0472dd8174945430ac10c7e127',
    'platforms/odc/studio/engine/NativeMergeVerification.cs': 'b7b797836070709672c57d3bdeb0ebed8571e06c4dfba172b9a5a0ab7ce4aede',
    'platforms/odc/studio/shared/Journal.cs': 'e0cc116aec478a3092b9e31c04f470b6d5a47f7af72974234a3d7fa93586185e',
    'platforms/odc/studio/shared/Manifest.cs': 'bcc45f95c3b541739dad91211be17df8d2dfe1f59398ed579d5672f095b3788b',
  },
  v101: {
    'kernel/query-test/NativeQueryTest.cs': '89e2889b8a6c05380124c98239a1b4bb16eed266f031466444b76e06b4f39177',
    'kernel/query-test/QueryTestContract.cs': 'a778e457aba47971224e4a48e1a7c2ea69541a3bd8dc246527cb147218bdf7f3',
    'kernel/query-test/QueryTestOutput.cs': 'a9bb3f539accf807984d6798355ae648642568d43950b2ec01ff51784568eebf',
    'kernel/query-test/QueryTestRunner.cs': 'b9f96ac09f1aeb20493843df77a6ff6f4a59d26e485de0f603922fcfd464844c',
    'kernel/src/Anvil.Bridge/PrivateHttpContext.cs': '73785bbd6483074d865848ef9bc4f13423aabc7d371d8931e2936ffe85fdbca8',
    'platforms/odc/facade/bridge-deadlines.json': 'a8b59d634cf1d2d126dd21604ff48e3f2d19523e47cf01a9fc3a6e48b9c9d6d2',
    'platforms/odc/studio/bridge/AgentDataRoot.cs': 'dad2cf57b23e27c6dd49070fe38268cab5670bf5d7aba8404899c2ddf9c1e68e',
    'platforms/odc/studio/bridge/AppCreationCommands.cs': '416c95f5bf1a86476109aa07d4950d12c05c72450a6d860a9dec4924b1341ccf',
    'platforms/odc/studio/bridge/Bridge.csproj': 'd72de010ae2aea3f709f6041cda0cec8cc54b00dbcbc858c1c307af4253e4ea8',
    'platforms/odc/studio/bridge/BridgeDeadlines.cs': 'dba4c72414278e7c08dbe6f8d1bba969048e4896a5e095c9488788bc086c6126',
    'platforms/odc/studio/bridge/BridgeServe.cs': '955d7c3b15ad9cbee3b54d488304e6968530171d4811f8e5d294f0eb34f8fe32',
    'platforms/odc/studio/bridge/DataCommands.cs': '2c8eb954b4b1d1ccace550179399a4418f43fee308f3014fe1490a30f4196aa6',
    'platforms/odc/studio/bridge/MergeDiagnostics.cs': '8a1d4b6206278e146729c6a3515d0962d0db6b64156dc9cee313dd9adf3b8573',
    'platforms/odc/studio/bridge/MergeOrderCopy.cs': '4e7a187554154662f5ffcecf401904eb4b59ef656192f7fa57afc73b13a4d2d9',
    'platforms/odc/studio/bridge/PortalApiClientCleanup.cs': '8e16426f6382149808da6cf169ab9d3e3e3bfc516b8a055467e0a6532728fd48',
    'platforms/odc/studio/bridge/PortalApiClientSecret.cs': '2bf23662976750d82ee96ca742cfd8efb3c7ea5428e5af8c2050208243f8d959',
    'platforms/odc/studio/bridge/PortalCommands.cs': '242b2e5a79eb00a78e49da9dee2b0dc42511ca3484422f7cac3a63fc7c6656c5',
    'platforms/odc/studio/bridge/PortalCore.cs': '8ad3ed73d9d362d55cd5266fc63742fbb8b395ae4296e4662286399965b4697a',
    'platforms/odc/studio/bridge/PortalKnowledgeDownload.cs': '198d3aff0965210d288e5ca17d3f19335a49856311a060813ceeecf25ceeedba',
    'platforms/odc/studio/bridge/PortalMobileDownload.cs': '14f22439e5addfb29f90292ed5c8a25a0f45ce1edd8576097a0bb73f2708fb7c',
    'platforms/odc/studio/bridge/PortalMobileUpload.cs': 'c94e420a777d52017cfa963c1f8170213d7e045f472b7d5b388a8aa72955e695',
    'platforms/odc/studio/bridge/PortalPrivateHttp.cs': '71d15be9b8394ddbd87ad084f264a2fdcefb157ef57021ca42caf54bc49c89a2',
    'platforms/odc/studio/bridge/PortalUpload.cs': '945c40b566a21546ecf36b2a0029d357f465ef8b74e5008b28acb79cfcd55736',
    'platforms/odc/studio/bridge/PortalVault.cs': 'e8780ab773dab88a75b48737b7aa29047d29aa7394206662400b4a4c652ecf7c',
    'kernel/src/Anvil.Core.Odc/Adapters.ODC/PublicSignatureReader.cs': '0896ab08fd3de902f6731b3100ee995a9cbb8d7e3ee8549e808690f38bff849e',
    'platforms/odc/studio/bridge/PublishLogCommands.cs': '3f2b097bb4837e7f0a3e19a9534f5adb9dec6ec61129b9106133037bf96c8c56',
    'platforms/odc/studio/bridge/PublishLogCore.cs': '33b820a24c909f5528e3aaa50d5ac7410ae3721d3e0f819d3c4dd586cf9db730',
    'platforms/odc/studio/bridge/QueryTestCommands.cs': '0aafe20f964fea6c0dc7e9ee0599b1b5828dc6d1451eaf26175383be9a286c36',
    'platforms/odc/studio/bridge/ReferenceCommands.cs': 'a254f69279bec866d457cf6c3f30f5389b4154bc6c14ebceb93f6c059aef9e75',
    'platforms/odc/studio/bridge/SecurityWarningsCopy.cs': '9994c72f57a32b74fd8ca92299198e44dea11efed1023d5526f72eeb5307b698',
    'platforms/odc/studio/bridge/StartupHook.cs': '8f178ffbff09f19c6149e2edb19e7a0039d5fc671a8ca46fc55a630cf52d1191',
    'platforms/odc/studio/bridge/TemplateCache.cs': 'a57ef89f222983393d3249c75d543e6a2fc06aef456340a63272d8f127b3f20c',
    'platforms/odc/studio/bridge/client/Client.csproj': '9fc76085a82277606b476ec5e838f314af4012e8b9d9f96077306381b37bf1aa',
    'platforms/odc/studio/bridge/client/Program.cs': '70374c1e1c5d5df96a7d146c02a5ca283c0b88639e8c567ae56962d3c3b12954',
    'platforms/odc/studio/engine/NativeMergeOrder.cs': '3ec32ca130504f0375a12704b58123e88539fc0472dd8174945430ac10c7e127',
    'platforms/odc/studio/engine/NativeMergeVerification.cs': 'b7b797836070709672c57d3bdeb0ebed8571e06c4dfba172b9a5a0ab7ce4aede',
    'platforms/odc/studio/shared/Journal.cs': 'e0cc116aec478a3092b9e31c04f470b6d5a47f7af72974234a3d7fa93586185e',
    'platforms/odc/studio/shared/Manifest.cs': '420a0ff9f4909387424afaba8aa329685de83973e5f3303e576dbfa270119523',
  },
};

// v102: the same sources as v101 for the net8 ODC Studios (1.7.28, 1.7.29). The name comes from the runtime it is built for, so one
// set of files is two names, and each name is still one set of bytes.
RECORDED.v102 = RECORDED.v101;

const lf = file => crypto.createHash('sha256')
  .update(Buffer.from(fs.readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex');
const rel = file => path.relative(BOX, file).split(path.sep).join('/');

// The files a project builds in: its Compile and EmbeddedResource items, a glob only as <folder>/*.cs, and with default items
// also every .cs under the project folder but bin, obj and tests.
function compiled(project) {
  const text = fs.readFileSync(project, 'utf8');
  const folder = path.dirname(project);
  const listed = [...text.matchAll(/<(?:Compile|EmbeddedResource)\s+Include="([^"]+)"/g)].flatMap(([, include]) => {
    const source = path.resolve(folder, include.replaceAll('\\', '/'));
    if (!source.includes('*')) return [source];
    if (path.basename(source) !== '*.cs' || path.dirname(source).includes('*')) throw new Error('a Compile glob this test does not read: ' + include);
    return fs.readdirSync(path.dirname(source)).filter(n => n.endsWith('.cs')).sort().map(n => path.join(path.dirname(source), n));
  });
  if (/<EnableDefaultCompileItems>\s*false\s*<\/EnableDefaultCompileItems>/i.test(text)) return listed;
  const found = [...listed];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['bin', 'obj', 'tests'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.cs')) found.push(full);
    }
  };
  walk(folder);
  return found.sort();
}

function sources() {
  const bridge = path.join(BOX, BRIDGE, 'Bridge.csproj');
  const client = path.join(BOX, BRIDGE, 'client', 'Client.csproj');
  return [...new Set([bridge, ...compiled(bridge), client, ...compiled(client)].map(rel))].sort();
}

function versions() {
  const read = (file, pattern) => pattern.exec(fs.readFileSync(path.join(BOX, BRIDGE, file), 'utf8'))?.[1] ?? null;
  return {
    'StartupHook.cs': read('StartupHook.cs', /public\s+const\s+string\s+Version\s*=\s*"(v\d+)"/),
    'Bridge.csproj': read('Bridge.csproj', /<AssemblyName>ODC3\.Bridge\.(v\d+)<\/AssemblyName>/),
    'client/Program.cs': read('client/Program.cs', /const\s+string\s+Version\s*=\s*"(v\d+)"/),
  };
}

test('the three version marks of the ODC bridge name one version', () => {
  const marks = versions();
  assert.equal(new Set(Object.values(marks)).size, 1, 'the version marks differ: ' + JSON.stringify(marks));
  assert.ok(Object.values(marks)[0], 'no version mark found: ' + JSON.stringify(marks));
});

test('v101 and v102 are one source: the runtime it is built for names it, in the DLL, the pipe and the client', () => {
  const read = file => fs.readFileSync(path.join(BOX, BRIDGE, file), 'utf8');
  assert.match(read('Bridge.csproj'), /<AssemblyName Condition="'\$\(TargetFramework\)' == 'net8\.0'">ODC3\.Bridge\.v102<\/AssemblyName>/);
  assert.match(read('Bridge.csproj'), /<OdcBridgeRuntime Condition="'\$\(TargetFramework\)' == 'net8\.0'">net8\.0<\/OdcBridgeRuntime>/);
  assert.match(codeOf(path.join(BOX, BRIDGE, 'StartupHook.cs')), /#if NET10_0_OR_GREATER\s+public const string Version = "v101";\s+#else\s+public const string Version = "v102";\s+#endif/);
  assert.match(read('client/Program.cs'), /const string EarlierVersion = "v102";/, 'the client attaches v102 to a net8 Studio');
  assert.ok(fromDataRoot('v102') && Object.hasOwn(RECORDED.v102, AGENT_DATA_ROOT), 'v102 implements agent-root');
});

test('the ODC bridge sources are the ones recorded for the version they declare (a code change needs a new version)', () => {
  const version = versions()['StartupHook.cs'];
  const recorded = RECORDED[version];
  assert.ok(recorded, `no hashes recorded for the ODC bridge ${version}: record the sha256 (LF) of every source in RECORDED of this test`);
  const now = sources();
  const problems = [];
  for (const file of now) {
    if (!fs.existsSync(path.join(BOX, file))) { problems.push(`${file}: compiled but missing`); continue; }
    if (!Object.hasOwn(recorded, file)) problems.push(`${file}: compiled into the bridge but not recorded for ${version}`);
    else if (lf(path.join(BOX, file)) !== recorded[file]) problems.push(`${file}: changed since ${version} was recorded`);
  }
  for (const file of Object.keys(recorded)) if (!now.includes(file)) problems.push(`${file}: recorded for ${version} but no longer compiled`);
  assert.deepEqual(problems, [], `the ODC bridge code changed and it is still ${version}. Revert the change, or raise the version in `
    + 'StartupHook.cs, Bridge.csproj and client/Program.cs of both boxes (and kernel.json of the server) and record its hashes here:\n'
    + problems.join('\n'));
});

// The agent speaks the data-root protocol to every bridge from v98 on (agent/lib/kinds.mjs hasDataRootProtocol): before any
// command it sends agent-root, and a bridge that does not answer fails every call with ODC_DATA_ROOT_FAILED. So no bridge from
// v98 on may be declared, recorded or served without it.
const DATA_ROOT_FROM = 98;
const AGENT_DATA_ROOT = BRIDGE + '/AgentDataRoot.cs';
const fromDataRoot = version => /^v\d+$/.test(version ?? '') && Number(version.slice(1)) >= DATA_ROOT_FROM;

// The C# without its comments: a word in a comment is not code. Strings stay, the protocol's words are strings.
function codeOf(file) {
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s.startsWith('//', i)) { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (s.startsWith('/*', i)) { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2; continue; }
    if (s[i] === '"') {
      const verbatim = s[i - 1] === '@' || (s[i - 1] === '$' && s[i - 2] === '@') || (s[i - 1] === '@' && s[i - 2] === '$');
      let j = i + 1;
      while (j < s.length) {
        if (verbatim && s[j] === '"' && s[j + 1] === '"') { j += 2; continue; }
        if (!verbatim && s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') break;
        j++;
      }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (s[i] === "'" && (s[i + 2] === "'" || (s[i + 1] === '\\' && s[i + 3] === "'"))) { const n = s[i + 1] === '\\' ? 4 : 3; out += s.slice(i, i + n); i += n; continue; }
    out += s[i++];
  }
  return out;
}

// What the agent requires of the answer (agent/lib/kinds.mjs bindOdcRoot): ok, protocol 1 and the same folder, and no command before it.
function dataRootProblems(version) {
  const problems = [], hook = codeOf(path.join(BOX, BRIDGE, 'StartupHook.cs'));
  const answer = /if\s*\(\s*command\s*==\s*"agent-root"\s*\)/.exec(hook);
  if (!answer) problems.push(version + ': StartupHook.cs does not answer agent-root');
  const gate = hook.indexOf('DataRoot.Use()'), dispatch = hook.indexOf('Dispatch(command');
  if (gate < 0) problems.push(version + ': no DataRoot.Use() gate before the commands');
  if (dispatch < 0) problems.push(version + ': the dispatch of the commands was not found');
  if (answer && gate >= 0 && !(answer.index < gate)) problems.push(version + ': the gate comes before the agent-root answer');
  if (gate >= 0 && dispatch >= 0 && !(gate < dispatch)) problems.push(version + ': a command can run before the gate');
  if (answer && gate > answer.index) {
    const branch = hook.slice(answer.index, gate);
    if (!/DataRoot\.Bind\s*\(/.test(branch)) problems.push(version + ': the agent-root answer does not bind the folder');
    if (!/\bprotocol\s*=\s*1\b/.test(branch)) problems.push(version + ': the agent-root answer is not protocol 1');
    if (!/\b(?:continue\s*;|return\b)/.test(branch)) problems.push(version + ': the agent-root answer falls through to the commands');
  }
  if (!hook.includes('"agent-root:1"')) problems.push(version + ': StartupHook.cs does not advertise agent-root:1');
  if (!sources().includes(AGENT_DATA_ROOT)) problems.push(version + ': AgentDataRoot.cs is not compiled into the bridge');
  else if (!/AGENT_ROOT_REQUIRED/.test(codeOf(path.join(BOX, AGENT_DATA_ROOT)))) problems.push(version + ': AgentDataRoot.Use() does not refuse an unbound bridge');
  // A static initializer runs when the assembly loads, before the binding: a path it builds stays on the installed copy.
  const reads = /\b(Root|Snapshots|Log|DataDir|PortalDir|DataRoot\.Value)\b/;
  for (const rel of sources().filter(file => file.endsWith('.cs'))) {
    const code = codeOf(path.join(BOX, rel));
    for (const m of code.matchAll(/\bstatic\s+(?:readonly\s+)?[^;{}()=]*?\b(\w+)\s*(?:\{\s*get;[^}]*\}\s*)?=(?![=>])\s*([^;]*);/g))
      if (reads.test(m[2]) && !m[2].includes('=>')) problems.push(rel + ': the static ' + m[1] + ' reads a path of the data root before the binding');
  }
  return problems;
}

test('every ODC bridge from v98 on that this box declares or records implements agent-root', () => {
  const declared = versions()['StartupHook.cs'];
  const problems = [];
  if (Object.hasOwn(RETIRED, declared)) problems.push(declared + ' is retired (' + RETIRED[declared] + ') and is declared again');
  if (fromDataRoot(declared)) problems.push(...dataRootProblems(declared));
  for (const [version, table] of Object.entries(RECORDED))
    if (fromDataRoot(version) && !Object.hasOwn(table, AGENT_DATA_ROOT)) problems.push(version + ': recorded without AgentDataRoot.cs');
  assert.deepEqual(problems, []);
});

// The window of the server box (the line has no deploy folder): a kernel may only name or accept a bridge recorded with agent-root.
const WINDOW = path.join(BOX, 'deploy', 'coolify', 'r1-kernels.json');
test('every ODC bridge from v98 on that a kernel of the window names or accepts is recorded with agent-root', { skip: !fs.existsSync(WINDOW) }, () => {
  const problems = [];
  for (const [name, kernel] of Object.entries(JSON.parse(fs.readFileSync(WINDOW, 'utf8'))))
    for (const version of [kernel.odcBridge, ...(kernel.odcBridgeAccepted ?? [])])
      if (fromDataRoot(version) && !Object.hasOwn(RECORDED[version] ?? {}, AGENT_DATA_ROOT)) problems.push(name + ': ' + version);
  assert.deepEqual(problems, []);
});
