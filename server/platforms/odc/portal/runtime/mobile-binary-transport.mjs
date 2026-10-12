import {fail} from './errors.mjs';

// Observed native controller: the feature flag chooses BinaryToBase64 or
// FileUpload_Wrapper. RequiresDecoding is a separate Text-setting rule; the
// flag never changes it for BinaryUrl settings.
export function mobileBinaryTransport(stages,{environmentKey,portfolioKey}){
 const rows=stages?.data?.EnvironmentsApplicationVersion?.List;
 const matches=Array.isArray(rows)?rows.filter(x=>x.Environment?.Key===environmentKey):[];
 if(stages?.ok!==true||matches.length!==1||matches[0].Environment.PortfolioKey!==portfolioKey
  ||matches[0].Environment.Status!=='Ready'||typeof stages.data.EnableNAOSBASE64Patch!=='boolean')
  fail('MOBILE_BASELINE_UNVERIFIED','The exact ready native stage, portfolio and binary transport flag must be observed.');
 const base64=stages.data.EnableNAOSBASE64Patch;
 return {mode:base64?'base64':'signed-upload',requiresDecoding:false,
  nativeAction:base64?'ActionBinaryToBase64':'ActionFileUpload_Wrapper',
  executionSupported:true,base64Enabled:base64};
}
