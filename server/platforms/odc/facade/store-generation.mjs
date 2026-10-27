// The folder of the module index store's files (SSAM_MODULE_INDEX_ROOT/<generation>/<lane>/...), the kernel's
// ModuleIndexStore.Generation: the store version and the extractors of the index (ModuleIndex.Extractor) and of the flow
// reading (ModuleFlow.Extractor). Two releases that share one index root with other extractors keep their own folders and
// never read or overwrite each other's files.
import { FLOW_EXTRACTOR } from './module-flow.mjs';

export const INDEX_EXTRACTOR = 2;
export const STORE_GENERATION = 'v1-i' + INDEX_EXTRACTOR + 'f' + FLOW_EXTRACTOR;
