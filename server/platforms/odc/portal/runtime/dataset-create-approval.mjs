import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
export const DATASET_CREATE='agents.datasetCreate';
export const datasetInputHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=['Name','Description','AgenticAppId','ServiceActionId','Content','SetupAppId','SetupServiceActionId','TeardownAppId','TeardownServiceActionId','PortfolioKey','AssetType'];
export async function datasetCreateApproval({file,words,host,raw,readAsset,readApps}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Dataset creation requires an exact authorized body and an observed eligible application. Nothing was sent.');
 const p=raw.inputParameters,d=p?.Dataset;
 if(!file||!p||Object.keys(p).sort().join(',')!=='AdditionalApps,Dataset,OverrideBaseURL'||p.OverrideBaseURL!==''
   ||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length
   ||!d||Object.keys(d).sort().join(',')!==[...fields].sort().join(',')||fields.some(k=>typeof d[k]!=='string')
   ||!d.Name.trim()||!isUuid(d.AgenticAppId)||!isUuid(d.PortfolioKey)
   ||!p.AdditionalApps||Object.keys(p.AdditionalApps).join(',')!=='List'||!Array.isArray(p.AdditionalApps.List)||p.AdditionalApps.List.length)bad();
 // Setup/teardown have their own execution implications and need a separately
 // reviewed contract; this fixture creation path does not silently bind them.
 if(['SetupAppId','SetupServiceActionId','TeardownAppId','TeardownServiceActionId'].some(k=>d[k]!==''))bad();
 // The native ValidateTestCases action rejects malformed JSON and empty cases.
 // This envelope check does not replace validation against the action schema.
 let content;
 try { content=JSON.parse(d.Content); } catch { bad(); }
 const cases=Array.isArray(content)?content:content?.testCases;
 if(!Array.isArray(cases)||cases.length===0)bad();
 const asset=await readAsset(d.AgenticAppId);
 if(asset?.ok!==true||asset.data?.assetKey!==d.AgenticAppId||asset.data.portfolioKey!==d.PortfolioKey
   ||!asset.data.assetType||!asset.data.name||!asset.data.modelDigest)bad();
 // Dataset_Form.SaveDataset sends a null text identifier for ordinary apps;
 // the payload discriminator is not the repository asset type.
 if(asset.data.assetType!=='AgentDefinition' && (d.AssetType!==''||!d.ServiceActionId.trim()))bad();
 if(asset.data.assetType==='AgentDefinition' && !['','AgentDefinition'].includes(d.AssetType))bad();
 if(!d.Content.trim())bad();
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:DATASET_CREATE,targets:[d.Name,asset.data.name],
   constraints:{inputSha256:datasetInputHash(p),applicationKey:d.AgenticAppId,modelDigest:asset.data.modelDigest,portfolioKey:d.PortfolioKey}});
 if(!approved)bad();
 const eligible=await readApps(d.PortfolioKey);
 const matches=eligible?.ok===true&&Array.isArray(eligible.data?.AgenticApps?.List)
   ?eligible.data.AgenticApps.List.filter(a=>a.Key===d.AgenticAppId):[];
 // The current selector represents a published legacy Agent with an empty
 // discriminator. Preserve exact repository identity; do not treat a blank
 // selector type as a wildcard for arbitrary asset types.
 const typeMatches=matches.length===1 && (matches[0].AssetType===asset.data.assetType
   ||(asset.data.assetType==='Agent' && matches[0].AssetType===''));
 if(matches.length!==1||matches[0].Name!==asset.data.name||matches[0].ModelDigest!==asset.data.modelDigest||!typeMatches)
   fail('DATASET_APPLICATION_UNVERIFIED','The dataset application was not returned with the expected identity and revision by the eligible-applications reader. Nothing was sent.');
 return approved;
}
