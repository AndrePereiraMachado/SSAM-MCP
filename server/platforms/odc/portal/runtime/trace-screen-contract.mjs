import { fail } from './errors.mjs';
import { createTraceScreenDefaults } from './trace-screen-defaults.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const dependencyData = (result, diagnosticStage) => {
  if (!record(result?.data) || result.exception || result.error || result.data.ExceptionMessage) {
    fail('PORTAL_CONTRACT_CHANGED', 'Trace dependency did not return its expected successful data envelope.', { diagnosticStage });
  }
  return result.data;
};

/** Mirror the public trace page's data dependencies, without invoking its UI or mutations.
 * An incomplete summary is only internal input to the block. It is never projected
 * as an identified trace: the public result still validates every returned TraceId.
 */
export async function readTraceScreenservice(action, request) {
  const invoke = (...args) => {
    if (request.signal?.aborted) fail('PORTAL_TIMEOUT', 'Trace context read was cancelled.');
    return action(...args);
  };
  const isSummary = request.operationId === 'monitoring.traceSummary';
  const stageKey = isSummary ? request.screenVariables?.stageid : request.screenVariables?.StageKey;
  const traceId = isSummary ? request.screenVariables?.id : request.screenVariables?.TraceKey;
  if (!text(stageKey) || !text(traceId)) fail('INPUT_INVALID', 'Trace reads require an explicit stage and trace.');
  const { screen, block, clientVariables } = createTraceScreenDefaults();
  Object.assign(screen, { id: traceId, stageid: stageKey });
  // StageId is a native UI filter. UserId remains its native empty filter; neither
  // variable supplies or substitutes the authenticated Portal/app identity.
  clientVariables.StageId = stageKey;
  const call = name => invoke('monitoring', 'traces.trace', `monitoring/traces/trace/DataAction${name}`,
    {}, screen, request.signal, clientVariables, 'traces.trace');
  const stage = dependencyData(await call('GetStage'), 'trace-stage');
  if (stage.FoundStage !== true || !record(stage.Environment) || stage.Environment.Key !== stageKey
    || !text(stage.Environment.PortfolioKey) || typeof stage.Environment.Name !== 'string' || typeof stage.Environment.Purpose !== 'string') {
    fail('PORTAL_CONTRACT_CHANGED', 'Trace stage dependency did not confirm the exact requested environment.', { diagnosticStage: 'trace-stage' });
  }
  screen.ActivePortfolioKey = stage.Environment.PortfolioKey;
  let summaryResponse;
  if (isSummary) {
    summaryResponse = await call('GetTraceById');
    const data = dependencyData(summaryResponse, 'trace-summary');
    if (data.NotFound === true || data.Trace?.Id !== '') return summaryResponse;
  }
  const settings = dependencyData(await call('GetSettings'), 'trace-settings');
  if (typeof settings.MaxSupportedSpans !== 'string' || !/^\d{1,19}$/.test(settings.MaxSupportedSpans)
    || BigInt(settings.MaxSupportedSpans) <= 0n || BigInt(settings.MaxSupportedSpans) > 9223372036854775807n
    || !Number.isInteger(settings.MaxSpansExpandDegreeLevel) || settings.MaxSpansExpandDegreeLevel < 0
    || settings.MaxSpansExpandDegreeLevel > 2147483647 || typeof settings.IsTraceDuratiomFilterEnabled !== 'boolean') {
    fail('PORTAL_CONTRACT_CHANGED', 'Trace settings dependency returned invalid native input types.', { diagnosticStage: 'trace-settings' });
  }
  const summary = dependencyData(summaryResponse ?? await call('GetTraceById'), 'trace-summary');
  if (summary.NotFound === true) fail('PORTAL_TRACE_NOT_FOUND', 'The requested trace is not available; logs can exist before a trace is indexed.', { diagnosticStage: 'trace-summary' });
  if (summary.NotFound !== false || !record(summary.Trace) || !timestamp(summary.Trace.StartTime)
    || typeof summary.Trace.Id !== 'string' || (summary.Trace.Id !== '' && summary.Trace.Id !== traceId)
    || typeof summary.Trace.StatusLabel !== 'string') {
    fail('PORTAL_CONTRACT_CHANGED', 'Trace summary dependency did not confirm valid input for the requested trace block.', { diagnosticStage: 'trace-summary' });
  }
  Object.assign(block, { IsReadyToLoad: true, StageKey: stageKey, StageName: stage.Environment.Name,
    StagePurpose: stage.Environment.Purpose, PortfolioKey: stage.Environment.PortfolioKey,
    TraceKey: traceId, TraceStartTime: summary.Trace.StartTime, TraceStatusLabel: summary.Trace.StatusLabel,
    MaxSupportedSpans: settings.MaxSupportedSpans, MaxSpansExpandDegreeLevel: settings.MaxSpansExpandDegreeLevel,
    IsTraceDuratiomFilterEnabled: settings.IsTraceDuratiomFilterEnabled });
  // The original model initializes every input's DataFetchStatus to 1 (fetched).
  // MaxSupportedSpans is the actual tenant setting, not the adapter's local cap.
  // BaseWebBlock inherits the containing screen's React viewName context. The
  // action path belongs to the block, but its request view is traces.trace.
  if (isSummary) {
    const spans = await invoke('monitoring', 'traces.trace', 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans',
      {}, block, request.signal, clientVariables, 'traces.trace');
    const evidence = dependencyData(spans, 'trace-summary');
    // Keep the wire summary untouched. The public normalizer independently
    // checks every bounded span ID and matches its unique entry to the summary.
    return { ...summaryResponse, data: { ...summary, SummaryIdentitySpans: evidence } };
  }
  return invoke(request.module, request.view, request.action, {}, block, request.signal, clientVariables, request.discoveryView);
}
