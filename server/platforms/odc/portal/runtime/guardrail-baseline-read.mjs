import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';

// GetGuardrail consumes the native stage and feature data actions. Supplying
// only CurrentStage makes the current v5 screen take an invalid legacy branch.
export async function guardrailBaselineInput(raw,read){
 const s=raw.screenVariables,portfolio=s?.portfolioid??s?.ActivePortfolioKey,stageKey=s?.stageid??s?.CurrentStage?.Key;
 if(!isUuid(portfolio)||!isUuid(stageKey)||Object.keys(raw.inputParameters??{}).length||Object.keys(raw.clientVariables??{}).length
  ||s.ActivePortfolioKey!==undefined&&s.ActivePortfolioKey!==portfolio
  ||s.CurrentStage?.Key!==undefined&&s.CurrentStage.Key!==stageKey
  ||s.CurrentStage?.PortfolioKey!==undefined&&s.CurrentStage.PortfolioKey!==portfolio)
  fail('INPUT_INVALID','The exact portfolio and stage UUIDs are required for an administrative baseline read.');
 const screenVariables={portfolioid:portfolio,_portfolioidInDataFetchStatus:1,ActivePortfolioKey:portfolio,stageid:stageKey,_stageidInDataFetchStatus:1};
 const stages=await read('guardrails.stages',{screenVariables});
 const rows=stages?.data?.Stages?.List,match=Array.isArray(rows)?rows.filter(x=>x?.Stage?.Key===stageKey):[];
 if(match.length!==1||match[0].OptionsItems?.IsDisabled!==false||match[0].Stage.PortfolioKey!==portfolio
  ||match[0].Stage.Status!=='Ready'||typeof match[0].Stage.Name!=='string'||!match[0].Stage.Name)
  fail('GUARDRAIL_BASELINE_UNVERIFIED','The exact accessible native stage must be available before reading its baseline.');
 const features=await read('guardrails.features',{screenVariables});
 if(!features?.data||['HasBetaProgramEnded','IsV2Enabled','IsV5Enabled'].some(k=>typeof features.data[k]!=='boolean')||features.data.IsV5Enabled!==true)
  fail('GUARDRAIL_BASELINE_UNVERIFIED','The current v5 feature prerequisites must be read before the baseline.');
 return {...raw,screenVariables:{...screenVariables,CurrentStage:match[0].Stage,GetStages:stages.data,GetFeatureToggles:features.data}};
}
