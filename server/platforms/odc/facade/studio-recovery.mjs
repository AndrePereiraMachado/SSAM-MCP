// Pure recovery continuations shared by the Studio client and delivery projection.
import { isErrorReportTitle, cleanStall } from './bridge-stall.mjs';
export function stallRecovery(raw, continuation) {
  const next=continuation ? [continuation] : [];
  if(!raw) return next;
  // CX14 R2: a question or why never carries what the person typed in the dialog.
  const stall=cleanStall(raw);
  if(stall.verdict==='studio-gone' || stall.verdict==='bridge-gone') return [{tool:'ssam_connect',arguments:{lane:'o11'},why:'reconecte ao Studio antes de reconciliar a operação; nada será reenviado'},...next];
  if(!stall.blockedBy) return next; // positive observation cleared the old blocker; never ask to close it again
  const blocked=stall.blockedBy??{};
  const buttons=Array.isArray(blocked.buttons)?blocked.buttons:[];
  const closable=isErrorReportTitle(blocked.title) || blocked.kind==='UnexpectedError' || blocked.closable===true
    || (buttons.length>0 && buttons.every(b=>/^(ok|close|fechar)$/i.test(String(b).trim())));
  if(closable && blocked.title) return [{tool:'o11_studio',arguments:{command:'dismiss-dialog',args:{title:blocked.title}},why:'feche o diálogo que parou a operação; depois reconcilie o resultado'},...next];
  const question=blocked.question ?? [blocked.title,...(Array.isArray(blocked.texts)?blocked.texts:[])].filter(Boolean).join(' | ');
  return [{tool:'o11_studio',arguments:{command:'wait',args:{condition:'no-dialogs'}},question:question || 'Leia e responda ao diálogo aberto no Studio.',why:question ? `A pessoa precisa responder ao diálogo no Studio: ${question}` : 'leia e responda ao diálogo no Studio antes de reconciliar a operação'},...next];
}
