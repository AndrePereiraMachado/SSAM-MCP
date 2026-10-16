// Pure O11 call-stall policy. Only positive evidence counts; a slow/refused protocol probe says nothing.
export const constants = Object.freeze({probeMs:2000, probeTimeoutMs:5000, errorReportProbes:2, dialogProbes:8, goneProbes:2, maxTexts:20});
export const watchedVerbs = Object.freeze(['merge_from_oml','refresh_references','publish','open_module','close_module','snapshot_module','get_errors','integration_import']);
export const preProbeVerbs = Object.freeze(['merge_from_oml','refresh_references','publish','open_module','close_module']);
export const errorReportAutoVerbs = Object.freeze(['merge_from_oml','refresh_references','publish']);
export const errorReportAutoCapability = 'dialogs:error_report_auto';
export const errorReportTitles = Object.freeze(['Unexpected Error','Unexpected error','Erro inesperado']);
export const PROBE_MS=constants.probeMs, PROBE_TIMEOUT_MS=constants.probeTimeoutMs, ERROR_REPORT_PROBES=constants.errorReportProbes, DIALOG_PROBES=constants.dialogProbes, GONE_PROBES=constants.goneProbes, MAX_TEXTS=constants.maxTexts;
export const WATCHED_VERBS=watchedVerbs, PRE_PROBE_VERBS=preProbeVerbs, ERROR_REPORT_AUTO_VERBS=errorReportAutoVerbs, ERROR_REPORT_AUTO_CAPABILITY=errorReportAutoCapability, ERROR_REPORT_TITLES=errorReportTitles;
const PROGRESS_WORDS = ['opening', 'loading', 'downloading', 'uploading', 'please wait', 'connecting', 'checking', 'publishing', 'preparing'];
export function classifyWindow(title, texts = []) {
  const all = [title ?? '', ...texts].join(' | '); const lower = all.toLowerCase();
  const hasButton = all.includes('[Button]');
  if (!hasButton && String(title ?? '').trim().toLowerCase() === 'progress') return 'Progress';
  if (!hasButton && (PROGRESS_WORDS.some(w => lower.includes(w)) || all.includes('%'))) return 'Progress';
  if (String(title ?? '').trim().toLowerCase() === 'unexpected error') return 'UnexpectedError';
  if (lower.includes('discard') && lower.includes('open')) return 'Recovery';
  if (lower.includes('dependencies') || lower.includes('references') || lower.includes('[button] apply')) return 'ManageDependencies';
  if (['[button] ok', '[button] cancel', '[button] yes'].some(b => lower.includes(b))) return 'MessageBox';
  return 'Modal';
}
export const isErrorReportTitle = title => errorReportTitles.some(t=>t.toLowerCase()===String(title??'').trim().toLowerCase());
// CX14 R2: what the person typed in a Studio dialog (the bridge's "[TextBox] value (watermark)" text, e.g. the password of
// a sign-in) never leaves this client: dropped before any classification, verdict, question, answer or lock file, by the
// same rule as dialogsFromWindows (and BridgeStallRule.WithoutTypedText in the kernel).
export const isTypedText = text => String(text ?? '').startsWith('[TextBox]');
export const withoutTypedText = texts => (Array.isArray(texts) ? texts : []).filter(t => !isTypedText(t));
// A stall record without typed text (one built by another client, or a receipt written before R2): texts and buttons
// filtered, the question rebuilt from the title and the remaining texts.
export function cleanStall(stall) {
  if (!stall || typeof stall !== 'object' || !stall.blockedBy || typeof stall.blockedBy !== 'object') return stall;
  const {texts, buttons, question, ...rest} = stall.blockedBy;
  const kept = Array.isArray(texts) ? withoutTypedText(texts) : null;
  const asked = question == null ? undefined : kept ? [rest.title, ...kept].filter(Boolean).join(' | ')
    : String(question).includes('[TextBox]') ? String(rest.title ?? '') : question;
  return {...stall, blockedBy: {...rest, ...(kept ? {texts: kept} : {}), ...(Array.isArray(buttons) ? {buttons: withoutTypedText(buttons)} : {}), ...(asked !== undefined ? {question: asked} : {})}};
}
function countingWindows(windows) {
  if (!Array.isArray(windows) || windows.some(w=>!w || typeof w!=='object' || Array.isArray(w) || typeof w.type!=='string' || (w.title!==undefined && w.title!==null && typeof w.title!=='string') || (w.isVisible!==undefined && w.isVisible!==null && typeof w.isVisible!=='boolean') || (w.isModal!==undefined && w.isModal!==null && typeof w.isModal!=='boolean') || (w.texts!==undefined && w.texts!==null && (!Array.isArray(w.texts)||w.texts.some(t=>typeof t!=='string'))))) return null;
  return windows.filter(w=>w.isVisible!==false && (w.isModal===true || String(w.type??'').includes('DialogWindow')))
    .map(w=>{const shown=withoutTypedText(w.texts);return {...w,...(Array.isArray(w.texts)?{texts:shown}:{}),kind:classifyWindow(w.title,shown)}}).filter(w=>w.kind!=='Progress');
}
const identity = w => `${w.type??''}|${w.title??''}`;
// CX14 R5: the window that blocks the Studio now, from one `windows` read, by the rule of the verdict: the previous
// blocker while it is still shown, else an error report, else the first window that counts ({title, type, kind}). null:
// no window counts (the blocker went away). undefined: the read is unreadable, never evidence either way.
export function currentBlocker(windows, previous = null) {
  const counting = countingWindows(windows);
  if (counting === null) return undefined;
  const chosen = (previous?.title != null ? counting.find(w => (w.title ?? '') === previous.title) : null)
    ?? counting.find(w => isErrorReportTitle(w.title)) ?? counting[0] ?? null;
  return chosen ? {title: chosen.title ?? '', type: chosen.type, kind: isErrorReportTitle(chosen.title) ? 'UnexpectedError' : chosen.kind} : null;
}
export class BridgeStallRule {
  constructor(method,{probeMs=PROBE_MS,timeoutMs}={}) {
    this.method=method; this.probeMs=probeMs;
    this.enabled=probeMs>0 && watchedVerbs.includes(method) && (timeoutMs===undefined || timeoutMs>probeMs);
    this.needsPreProbe=this.enabled && preProbeVerbs.includes(method);
    this.before=new Set(); this.seen=new Map(); this.bridgeGone=0; this.studioGone=0; this.studio={};
  }
  begin(before=[],{capabilities=[],pid,startedUtc}={}) {
    this.studio={...(pid!==undefined?{pid}:{}),...(startedUtc?{startedUtc}:{})};
    this.seen.clear(); this.bridgeGone=0; this.studioGone=0;
    const windows=countingWindows(before)??[]; this.before=new Set(windows.map(identity));
    if(!this.needsPreProbe) return null;
    const error=windows.find(w=>isErrorReportTitle(w.title));
    if(error && !(errorReportAutoVerbs.includes(this.method) && capabilities.includes(errorReportAutoCapability))) return this.result('dialog-before',0,error,0);
    return null;
  }
  result(verdict,afterMs,window,seenMs) {
    return {verdict,method:this.method,...(window?{blockedBy:{title:window.title??'',type:window.type??'',kind:isErrorReportTitle(window.title)?'UnexpectedError':window.kind,seenMs,...(!isErrorReportTitle(window.title)?{texts:withoutTypedText(window.texts),buttons:withoutTypedText(window.texts).filter(t=>t.startsWith('[Button] ')).map(t=>t.slice(9).trim()).filter(t=>t && t!=='Viewbox'),question:[window.title,...withoutTypedText(window.texts)].filter(Boolean).join(' | ')}:{})}}:{}),afterMs,studio:{...this.studio}};
  }
  observe(probe={}) {
    if(!this.enabled) return null;
    const afterMs=probe.afterMs??0;
    if(probe.studioAlive===false || (this.studio.startedUtc && typeof probe.startedUtc==='string' && probe.startedUtc.length>0 && probe.startedUtc!==this.studio.startedUtc)) {
      if(++this.studioGone>=GONE_PROBES) return this.result('studio-gone',afterMs);
    } else if(probe.studioAlive===true || (this.studio.startedUtc && probe.startedUtc===this.studio.startedUtc)) this.studioGone=0;
    if(probe.connectionRefused===true) {
      if(++this.bridgeGone>=GONE_PROBES) return this.result('bridge-gone',afterMs);
      return null;
    }
    const windows=probe.success===false ? null : countingWindows(probe.windows);
    if(windows===null) return null;
    this.bridgeGone=0;
    const active=new Set();
    for(const w of windows) {
      const id=identity(w); active.add(id);
      if(!isErrorReportTitle(w.title) && this.before.has(id)) continue;
      const prior=this.seen.get(id); const entry={count:(prior?.count??0)+1,first:prior?.first??afterMs}; this.seen.set(id,entry);
      if(entry.count >= (isErrorReportTitle(w.title)?ERROR_REPORT_PROBES:DIALOG_PROBES)) return this.result('dialog',afterMs,w,afterMs-entry.first);
    }
    for(const id of this.seen.keys()) if(!active.has(id)) this.seen.delete(id);
    return null;
  }
}
