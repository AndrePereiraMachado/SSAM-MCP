// The environment reads of o11_extension through the connected Service Studio (contract I2 of
// docs/INTEGRACOES-GITSSAM.md): the Studio's own login (SSO included), never a credential file and never a prompt.
// - soap (ServiceStudio.asmx): ListExtensions, ListEspaces, DownloadExtension, GetConsumers;
// - integration-studio (IntegrationStudio.asmx, READ ONLY in the bridge): Handshake, GenerateSourceCodeStubs,
//   GetSourceCodeDependencies, UploadNeeded.
// Nothing here writes: the publication and the delete go through runServiceCenter (contract I1). Only exports that already
// exist are used (Resolver of auth.mjs, locateStudioBridge, field and items of studio-api.mjs).
import { Resolver, studioRunning } from './auth.mjs';
import { locateStudioBridge } from './bridge.mjs';
import { field, items } from './studio-api.mjs';
import { hostName } from './http.mjs';

export const SURFACE = 'integration-studio';
// The bridge manifest capability of the surface (written in Dispatch.cs by the restsoap lane, contract I3).
export const CAPABILITY = 'sc_api:integration-studio';
export const OPERATIONS = Object.freeze(['Handshake', 'GenerateSourceCodeStubs', 'GetSourceCodeDependencies', 'UploadNeeded']);

// A row of ListExtensions/ListEspaces: name, key, active version, id (the projection keeps the .NET member names).
export const row = r => ({ name: field(r, 'Name'), key: field(r, 'Key', 'SS_Key', 'ESpaceKey', 'ModuleKey', 'ExtensionKey'),
  versionId: field(r, 'Version_Id', 'VersionId', 'ExtensionVersionId'), id: field(r, 'Id', 'Extension_Id', 'ExtensionId', 'Espace_Id') });

// The reads of one environment. deps: locate (a bridge or null), root, env, running. Throws AuthRequired (with its
// continuation) when no signed-in Studio serves the host; never opens a prompt.
export async function studioReads(host, { locate, root, env, running } = {}) {
  host = hostName(host);
  const resolver = new Resolver(host, { session: 'studio', prompt: 'never', locate: locate ?? (() => locateStudioBridge({ root, env })),
    present: async () => false, running: running ?? (() => studioRunning()), opener: null });
  const auth = await resolver.resolve('api');
  const bridge = auth.bridge;
  const call = async (surface, operation, args) => (await bridge.api(host, surface, operation, args)).result ?? null;
  return {
    host, auth, bridge,
    capabilities: async () => bridge.capabilities(),
    extensions: async () => items(await call('soap', 'ListExtensions', {})).map(row),
    modules: async () => items(await call('soap', 'ListEspaces', {})).map(row),
    download: (extensionKey, versionId, outFile) => call('soap', 'DownloadExtension', { extensionKey, versionId, outFile }),
    consumers: (producerKey, elementKey = '') => call('soap', 'GetConsumers', { producerESpaceKey: producerKey, referenceableElementKey: elementKey }),
    handshake: (version, lastUpgradeVersion) => call(SURFACE, 'Handshake', { version, lastUpgradeVersion }),
    stubs: (file, outFile) => call(SURFACE, 'GenerateSourceCodeStubs', { file, outFile }),
    dependencies: outFile => call(SURFACE, 'GetSourceCodeDependencies', { outFile }),
    uploadNeeded: (extensionKey, extensionHash) => call(SURFACE, 'UploadNeeded', { extensionKey, extensionHash }),
  };
}
