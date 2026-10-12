const ASSET='asset-repository-api-v1:get:/assets/{assetKey}';
const ENVIRONMENTS='portfolio-api-v2:get:/environments';
const CONSUMERS='dependency-management-api-v1:get:/assets/{assetKey}/consumers';
export async function readAssetConsumers(assetKey,read){
 const unavailable=()=>({ok:false,code:'DEPENDENCY_CHECK_UNAVAILABLE',message:'The asset identity or complete consumer scope could not be verified; nothing was reserved or deleted.'});
 try{
  const asset=await read(ASSET,{path:{assetKey}});
  if(!asset?.ok||typeof asset.data?.name!=='string'||!asset.data.name.trim())return unavailable();
  const environments=await read(ENVIRONMENTS,{}),stages=environments?.data?.results;
  if(!environments?.ok||!Array.isArray(stages)||!stages.length||stages.length>20)return unavailable();
  const keys=stages.map(s=>s?.key);
  if(keys.some(key=>typeof key!=='string'||!key)||new Set(keys).size!==keys.length)return unavailable();
  const found=new Map();
  // Keep the default publishing scope as well as every explicit environment.
  for(const environmentKey of [null,...keys]){
   const result=await read(CONSUMERS,{path:{assetKey},query:{allowMultipleVersions:true,...(environmentKey?{environmentKey}:{})}});
   if(!result?.ok||!Array.isArray(result.data?.results))return unavailable();
   for(const row of result.data.results){
    if(typeof row?.key!=='string'||!row.key||typeof row.name!=='string'||!row.name.trim()||row.key===assetKey)return unavailable();
    // Historical revisions can retain an older name after a rename. Preserve
    // every observed name for review instead of rejecting valid history or
    // collapsing distinct consumers that happen to share a name.
    const identity=JSON.stringify([row.key,row.name]);
    if(!found.has(identity))found.set(identity,{name:row.name,key:row.key,type:row.type??null,revision:row.revision??null});
   }
  }
  return {ok:true,name:asset.data.name,consumers:[...found.values()],checkedEnvironments:keys,includesPublishingDefault:true};
 }catch{return unavailable();}
}
