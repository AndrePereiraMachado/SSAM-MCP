import { createHash } from 'node:crypto';
import { authorizationContext } from '../../facade/authorization-context.mjs';
import { fail } from './errors.mjs';
import {validateAssetIcon} from './asset-icon.mjs';

export const ASSET_CREATE = 'asset-repository-api-v1:post:/assets';
export async function assetCreationApproval({file,words,host,operationId,input,read,readTemplate}) {
  const body=input.body, detail=body?.assetCreationDetails;
  const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Approval must cover this exact new asset and request body. Nothing was sent.');
  if(operationId!==ASSET_CREATE || !body || !detail || input.path || input.query
    || Object.keys(body).some(k=>!['assetCreationDetails','tag','releaseNotes','commitMessage'].includes(k))
    || Object.keys(detail).some(k=>!['assetName','assetType','description','templateKey','iconBase64'].includes(k))
    || (detail.templateKey!=null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(detail.templateKey))
    || !/^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(detail.assetName??'')
    || !['WebApplication','MobileApplication','LowCodeLibrary','MobileLibrary','Agent','Workflow'].includes(detail.assetType)) bad();
  if(detail.iconBase64!=null)validateAssetIcon(detail.iconBase64);
  const approval=authorizationContext(file,words,{lane:'odc',host,operation:ASSET_CREATE,targets:[detail.assetName],
    constraints:{bodySha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')}});
  if(!approval)bad();
  if(detail.templateKey!=null){
    const template=await readTemplate?.(detail.templateKey);
    if(template?.ok!==true || template.data?.assetKey?.toLowerCase()!==detail.templateKey.toLowerCase()
      || template.data.assetType!==detail.assetType || template.data.templateType!=='ApplicationTemplate')
      fail('ASSET_TEMPLATE_UNAVAILABLE','The selected application template identity and type could not be verified; nothing was sent.');
  }
  const seen=await read({nameContains:detail.assetName,limit:1000,offset:0});
  if(seen?.ok!==true || !Array.isArray(seen.data?.results) || !Number.isInteger(seen.data?.page?.totalResults)
    || seen.data.page.totalResults!==seen.data.results.length)
    fail('ASSET_INVENTORY_UNAVAILABLE','Complete asset inventory was not available; nothing was sent.');
  if(seen.data.results.some(a=>typeof a.name!=='string' || a.name.toLowerCase()===detail.assetName.toLowerCase()))
    fail('ASSET_ALREADY_EXISTS','An asset with this name already exists or its identity is ambiguous; nothing was sent.');
  return approval;
}
