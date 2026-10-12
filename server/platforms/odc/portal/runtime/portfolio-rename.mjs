import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fingerprint,isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const PORTFOLIO_RENAME='portfolio-api-v2:patch:/portfolios/{portfolioKey}';
export const PORTFOLIOS='portfolio-api-v2:get:/portfolios';
const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Portfolio rename requires an exact current portfolio, name-only body and approved before/after state. Nothing was sent.');
export function portfolioRenamePlan({inventory,portfolioKey,name}){
 const rows=inventory?.data?.results,page=inventory?.data?.page;
 if(!inventory?.ok||!Array.isArray(rows)||page?.totalResults!==rows.length||page.offset!==0
  ||!isUuid(portfolioKey)||typeof name!=='string'||!name.trim()||name.length>50
  ||rows.some(row=>!isUuid(row.key)||typeof row.name!=='string')||new Set(rows.map(row=>row.key)).size!==rows.length)reject();
 const matches=rows.filter(row=>row.key===portfolioKey);if(matches.length!==1)reject();
 const current=matches[0];if(current.name===name||rows.some(row=>row.key!==portfolioKey&&row.name.toLowerCase()===name.toLowerCase()))reject();
 const before=structuredClone(current),after={...structuredClone(current),name};
 const plan={schema:'ssam-portfolio-rename/1',operationId:PORTFOLIO_RENAME,path:{portfolioKey},body:{name},before,after,
  expectedConfigurationSha256:fingerprint(before),resultConfigurationSha256:fingerprint(after),restore:{path:{portfolioKey},body:{name:current.name},expectedConfigurationSha256:fingerprint(after)}};
 return {ok:true,...plan,planSha256:fingerprint(plan),sent:false,liveVerified:false};
}
export async function portfolioRenameApproval({file,words,host,operationId,input,read}){
 if(operationId!==PORTFOLIO_RENAME||input.query||!input.path||Object.keys(input.path).length!==1
  ||!input.body||Object.keys(input.body).length!==1||!Object.hasOwn(input.body,'name'))reject();
 const plan=portfolioRenamePlan({inventory:await read(PORTFOLIOS),portfolioKey:input.path.portfolioKey,name:input.body.name});
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[plan.before.name],constraints:{
  portfolioKey:input.path.portfolioKey,expectedConfigurationSha256:plan.expectedConfigurationSha256,
  bodySha256:fingerprint(input.body),resultConfigurationSha256:plan.resultConfigurationSha256}});
 if(!approval)reject();return {approval,expected:plan.after,before:plan.before};
}
export function portfolioRenameObservation(expected,result){
 const rows=result?.data?.results,page=result?.data?.page;
 const complete=result?.ok===true&&Array.isArray(rows)&&page?.offset===0&&page.totalResults===rows.length;
 const matching=complete?rows.filter(row=>row.key===expected?.key):[];
 return {verified:Boolean(expected&&matching.length===1&&fingerprint(matching[0])===fingerprint(expected)),operationId:PORTFOLIOS,portfolioKey:expected?.key??null,complete};
}
