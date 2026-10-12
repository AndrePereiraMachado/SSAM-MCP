export function guardrailPolicies(){return {List:['PiiRegexConfig','DeniedTopic','WordFilter','PromptAttack','PII','ContentFilter'].map(Id=>({Id,IsActive:false,AllowPolicyChange:true,
 Actions:{List:['Block','Detect'].map(Id=>({Id,Order:0,ReadOnly:false}))},SelectedAction:'Block',HasActiveAdminPolicy:false,
 WordsConfig:{List:[],EmptyListItem:{Text:'',Action:'',IsAdmin:false}},TopicsConfig:{List:[],EmptyListItem:{Name:'',Definition:'',Examples:{List:[]},Type:'',IsAdmin:false}},RegexesConfig:{List:[]}}))};}
export function wordGuardrail(policies,action='Block'){const p=structuredClone(policies),word=p.List.find(x=>x.Id==='WordFilter');word.IsActive=true;word.SelectedAction=action;word.WordsConfig={List:[{Text:'SSAMGUARDPROOFWORD',Action:action,IsAdmin:false}]};return p;}
