// A native sentinel is absence, never a real execution date. Keep the native
// response alongside this projection; an idle timer alone proves no success.
function timestamp(value) {
  if(typeof value!=='string' || /^(?:0001|1900)-01-01T00:00:00(?:\.0+)?(?:Z)?$/.test(value))return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!m||!Number.isFinite(Date.parse(value)))return null;
  const [year,month,day,hour,minute,second]=m.slice(1).map(Number),leap=year%4===0&&(year%100!==0||year%400===0);
  if(year<1||month<1||month>12||day<1||day>[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]||hour>23||minute>59||second>59)return null;
  return value;
}
export function timerRunState(data){
  const r=data?.TimerRunInformation;
  const known=typeof r?.isRunning==='boolean'&&typeof r?.isPendingRun==='boolean';
  const state=!known?'unknown':r.isRunning?'running':r.isPendingRun?'pending':'idle';
  const lastStartedAt=timestamp(r?.lastRunStartedOn),lastFinished=timestamp(r?.lastRunFinishedOn);
  const ordered=lastStartedAt&&lastFinished&&Date.parse(lastFinished)>=Date.parse(lastStartedAt);
  return {state,currentStartedAt:timestamp(r?.currentStartedOn),lastStartedAt,
    lastFinishedAt:ordered?lastFinished:null,nextScheduledAt:timestamp(r?.nextRunStartsOn),
    duration:{value:typeof r?.lastRunDuration==='number'&&Number.isFinite(r.lastRunDuration)&&r.lastRunDuration>=0?r.lastRunDuration:null,unit:null,source:'native'},
    completionVerified:false,successVerified:false,
    limitations:[...(!known?['native_state_unavailable']:[]),...(!ordered?['native_finish_timestamp_unavailable']:[]),'idle_does_not_prove_completion','duration_unit_not_declared']};
}
