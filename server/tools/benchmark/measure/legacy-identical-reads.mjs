// Source: raciocinio/scripts/10-acao-e-repeticao.js; sha256: 7b8fc00531ba021e71686633561a6b002627498efa1ee88cd1e7ccd5bcff679a.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function identicalReads(d) {
const cat=n=>{
 if(/^(ssam_code|o11_deliver|o11_publish|studio_deliver|ssam_job|o11_job|propose|continue|studio_merge|studio_publish|applyModelApiCode|omlMerge|apply_patch|Write|Edit|studio_data_insert|studio_data_update|o11_service_center_write)$/.test(n))return "escrita";
 if(/^(spawn_agent|send_message|followup_task|Agent|Task)$/.test(n))return "delegacao";
 if(/^(ssam_reference|ssam_discover|odc_describe_operation|odc_search_operations|odc_describe_capability|studio_manifest|ssam_friction)$/.test(n))return "consulta-contrato";
 if(/^(ssam_map|o11_inspect|studio_inspect|ssam_evidence|studio_snapshot|getServerAction|getDataModel|getActionNames|getValidationMessages|listApps|o11_data|studio_data|o11_dependencies|studio_consumers|studio_reference_snapshot)$/.test(n))return "consulta-modulo";
 if(/^(ToolSearch|load_workspace_dependencies)$/.test(n))return "carregar-ferramentas";
 if(/^(o11_studio|o11_environment|ssam_connect|ssam_doctor|studio_attach|studio_open|studio_status|ssam_app_url|createSessionToken|omlReset|o11_service_center_session|o11_service_center_read|ssam_preview|studio_build|studio_check_base|ssam_debug.*)$/.test(n))return "studio-ambiente";
 if(/^(wait|ssam_task|studio_wait|request_user_input_async|AskUserQuestion|SendMessage)$/.test(n))return "esperar-perguntar-responder";
 if(/^(exec_command|Read|Grep|Glob|PowerShell|Bash|js|view_image|exec|TodoWrite|spawn_task)$/.test(n))return "arquivos-shell";
 if(/navigate|computer|javascript_tool|browser|preview|read_page|find|get_page_text|read_network|read_console|resize_window|tabs_/.test(n))return "navegador";
 return "outro:"+n;};
const PRI=["escrita","delegacao","consulta-contrato","consulta-modulo","studio-ambiente","carregar-ferramentas","arquivos-shell","navegador","esperar-perguntar-responder"];
const agg={};let tot=0,totOut=0;
for(const r of d.responses){const names=r.names.split(",").filter(Boolean);const cats=[...new Set(names.map(cat))];
 let c=cats.length?(PRI.find(p=>cats.includes(p))||cats[0]):"so-texto";r.cat=c;
 const a=agg[c]??={n:0,reas:0,out:0,vis:0};a.n++;a.reas+=r.reas;a.out+=r.out;a.vis+=r.vis;tot+=r.reas;totOut+=r.out;}

const READC=new Set(["consulta-contrato","consulta-modulo","arquivos-shell","studio-ambiente"]);
let reads=0,dups=0,dupReas=0,dupResp=0;const byTool={};
const seen=new Map();
for(const r of d.responses){const key=r.req||"?";if(!seen.has(key))seen.set(key,new Set());const S=seen.get(key);
 const sigs=(r.sigs||[]).filter(s=>READC.has(cat(s.split("(")[0])));if(!sigs.length)continue;
 let allDup=true;for(const s of sigs){reads++;const norm=s.replace(/\s+/g," ").slice(0,200);if(S.has(norm)){dups++;const t=s.split("(")[0];byTool[t]=(byTool[t]||0)+1}else{allDup=false;S.add(norm)}}
 if(allDup){dupResp++;dupReas+=r.reas}}

return {reads,dups,dupReas,dupResp,byTool,agg}; }
