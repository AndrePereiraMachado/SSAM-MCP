// Pure recovery continuations shared by the Studio client and delivery projection.
import { isErrorReportTitle, cleanStall } from './bridge-stall.mjs';
export function stallRecovery(raw, continuation) {
  const next=continuation ? [continuation] : [];
  if(!raw) return next;
  // CX14 R2: a question or why never carries what the person typed in the dialog.
  const stall=cleanStall(raw);
  if(stall.verdict==='studio-gone' || stall.verdict==='bridge-gone') return [{tool:'ssam_connect',arguments:{lane:'o11'},why:'reconnect to the Studio before reconciling the operation; nothing will be sent again'},...next];
  if(!stall.blockedBy) return next; // positive observation cleared the old blocker; never ask to close it again
  const blocked=stall.blockedBy??{};
  const buttons=Array.isArray(blocked.buttons)?blocked.buttons:[];
  const closable=isErrorReportTitle(blocked.title) || blocked.kind==='UnexpectedError' || blocked.closable===true
    || (buttons.length>0 && buttons.every(b=>/^(ok|close|fechar)$/i.test(String(b).trim())));
  if(closable && blocked.title) return [{tool:'o11_studio',arguments:{command:'dismiss-dialog',args:{title:blocked.title}},why:'close the dialog that stopped the operation; then reconcile the result'},...next];
  const question=blocked.question ?? [blocked.title,...(Array.isArray(blocked.texts)?blocked.texts:[])].filter(Boolean).join(' | ');
  return [{tool:'o11_studio',arguments:{command:'wait',args:{condition:'no-dialogs'}},question:question || 'Read and answer the dialog open in the Studio.',why:question ? `The person has to answer the dialog in the Studio: ${question}` : 'read and answer the dialog in the Studio before reconciling the operation'},...next];
}
