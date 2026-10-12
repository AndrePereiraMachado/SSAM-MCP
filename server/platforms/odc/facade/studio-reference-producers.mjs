import * as z from 'zod/v4';

export function registerStudioReferenceProducers(server, { studio, wrap, readOnly, pidSchema }) {
  server.registerTool('studio_reference_producers', {
    title: 'List producers available to an ODC consumer session',
    description: 'Read public producer names and keys through ReferencesService.ListReferenceable in the named open consumer session. An empty result does not prove tenant-wide absence. Does not acquire signatures, change dependencies, merge or publish. Native before/after hashes verify the consumer stayed unchanged. Follow with studio_reference_snapshot for an exact producer, or reference ops in studio_deliver.',
    inputSchema: z.object({ module: z.string().trim().min(1), pid: pidSchema }).strict(),
    annotations: readOnly,
  }, wrap(({ module, pid }) => studio(['reference-producers', module], pid)));
}
