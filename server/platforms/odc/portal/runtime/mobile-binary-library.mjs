import {isUuid} from './write-journal.mjs';import {fail} from './errors.mjs';import {recorded} from './written-approval.mjs';
const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','A binary library setting requires the exact owned library, consumer, revision and matching creation grants. Nothing was sent.');
export function binarySettingGroup(current,scope){
 if(!scope.libraryKey){
  if(scope.libraryOriginOperationUuid!==undefined||scope.libraryRevision!==undefined)bad();
  return {settings:current?.settings};
 }
 if(!isUuid(scope.libraryKey)||!isUuid(scope.libraryOriginOperationUuid)||!Number.isSafeInteger(scope.libraryRevision)||scope.libraryRevision<1)bad();
 const rows=current?.libraries?.filter(x=>x.key===scope.libraryKey);
 if(rows?.length!==1||rows[0].revision!==scope.libraryRevision||!Array.isArray(rows[0].settings))bad();
 return rows[0];
}
export function binarySetting(current,scope){
 const rows=binarySettingGroup(current,scope).settings?.filter(x=>x.key===scope.settingKey);
 if(rows?.length!==1)bad();return rows[0];
}
// R2-I round 2: strict (the default; a call with a context file, or a read of content an approval file bound) keeps today's
// rule: both creations carry the same conversation and words. With the written words alone (strict:false), app and library are two confirmed own creations of this tenant
// recorded by SSAM (recorded()), with the same asset, portfolio and revision checks; the words name both (the targets).
export async function ownedBinaryLibrary({scope,origin,host,lookup,read,strict=true}){
 if(!scope.libraryKey)return null;
 if(!isUuid(scope.libraryKey)||scope.libraryKey===scope.applicationKey||!isUuid(scope.libraryOriginOperationUuid)||scope.libraryOriginOperationUuid===scope.originOperationUuid)bad();
 const library=lookup(scope.libraryOriginOperationUuid),grant=origin?.authorization,other=library?.authorization;
 if(origin?.state!=='confirmed'||library?.state!=='confirmed'||library.identity?.tenant!==host
  ||library.identity.operationId!=='asset-repository-api-v1:post:/assets'||library.response?.assetKey!==scope.libraryKey
  ||(strict?(!grant?.source||!other?.source||grant.source.threadId!==other.source.threadId||grant.source.messageId!==other.source.messageId
   ||!/^[a-f0-9]{64}$/.test(grant.wordsSha256??'')||grant.wordsSha256!==other.wordsSha256):(!recorded(origin)||!recorded(library))))bad();
 const asset=await read('asset-repository-api-v1:get:/assets/{assetKey}',{assetKey:scope.libraryKey});
 if(!asset.ok||asset.data?.assetKey!==scope.libraryKey||asset.data.assetType!=='MobileLibrary'||asset.data.portfolioKey!==scope.portfolioKey||typeof asset.data.name!=='string'||!asset.data.name)bad();
 return asset.data;
}
export function binaryNativeLibraryMatches(info,scope){
 return scope.libraryKey?info?.IsFromLibrary===true&&info.LibraryInfo?.Key===scope.libraryKey&&info.LibraryInfo.Revision===scope.libraryRevision:info?.IsFromLibrary===false;
}
export function binaryLibraryConstraints(scope){
 return scope.libraryKey?{libraryKey:scope.libraryKey,libraryRevision:scope.libraryRevision,libraryOriginOperationUuid:scope.libraryOriginOperationUuid}:{};
}
