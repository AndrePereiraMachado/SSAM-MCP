// Traditional is a runtime boundary, not a lexical suggestion to use Reactive widgets.
import { selectedTraditionalTasks } from './traditional-tasks.mjs';
import { kindReading, kindOfModuleType, KIND_LAYER } from './app-kinds.mjs';
// The kind is F4's (app-kinds.mjs): the module the packet read (its module type), else the kind words of the request as
// kindReading reads them (an object noun next to the kind word, a migration's target). A Traditional answer is given only
// when the request is for O11 Traditional alone: a request for Traditional and Reactive or Mobile keeps the lane's view, a
// migration to Reactive is for its target.
export function traditionalKinds(lane, intent = '', found = null, kinds = null) {
  if (lane !== 'o11') return [];
  if (Array.isArray(kinds)) return kinds;
  const module = found?.ok !== false ? found?.digest?.module : null;
  const fromModule = kindOfModuleType(lane, module?.kind ?? module?.type ?? null);
  return fromModule ? [fromModule] : kindReading(lane, intent).kinds;
}
export const traditionalOnly = kinds => (kinds ?? []).includes('o11-traditional') && !(kinds ?? []).some(k => KIND_LAYER[k] === 'client');
export function isTraditionalContext(lane, intent = '', found = null, kinds = null) {
  return traditionalOnly(traditionalKinds(lane, intent, found, kinds));
}

export const traditionalComponentRules = [
  'Start from the module official Traditional layout and theme. Reuse its Title, Actions, MainContent and navigation placeholders; do not add a second shell/menu or reset native widgets with global CSS.',
  'Prefer official Traditional components: OutSystemsUIWeb for layouts, responsive content and Modal; RichWidgets for its supported feedback, list navigation/sorting and popup patterns. Inspect the installed producer contract before choosing inputs, events and dependencies. OutSystemsUI Reactive/IPopup is not Traditional.',
  'Popup_Editor is a separate screen with LayoutPopup, opened by a named Navigate link and bound through LinkOrButtonWidgetId=Link.Id. On success call Popup_Editor_Notify then Popup_Editor_Close; the parent handles OnNotify and refreshes data and the affected region. Keep the popup instance and trigger together when Ajax refresh replaces them.',
  'Check deprecation and device restrictions in the installed version. Some RichWidgets Popup_Editor versions are deprecated and not supported on mobile; do not silently use them as the default responsive modal. Use them for an explicit compatibility request and record the limitation.',
  'A custom overlay, pager, calendar or feedback message is not the default when an official compatible component exists. Read its contract and report a missing authoring capability instead of silently recreating it.',
  'First-delivery acceptance includes published producer/theme references, visible navigation, readable titles/fields, empty/error states, desktop/narrow layout and keyboard/close behavior. Test initial load AND the same controls after Ajax refresh in the authenticated browser; Verify/publish alone is insufficient.'
];

export const traditionalComponentLookups = [
  { catalog: 'OutSystemsUIWeb', name: 'Modal' },
  { catalog: 'OutSystemsUIWeb', name: 'LayoutPopup' },
  { catalog: 'RichWidgets', name: 'Popup_Editor' },
  { catalog: 'RichWidgets', name: 'List_Navigation' },
  { catalog: 'RichWidgets', name: 'Feedback_Message' }
].map(query => ({ tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'ui-block', query } }));

export function traditionalMatches(matches, replacement) {
  const compatible = matches.filter(m => !m.id.startsWith('ui.') || m.id.startsWith('ui.traditional-') || ['ui.theme-css', 'ui.script-resource'].includes(m.id));
  return replacement ? [replacement, ...compatible.filter(m => m.id !== replacement.id)] : compatible;
}

export function isTraditionalUiIntent(lane, intent, found = null, kinds = null) {
  return isTraditionalContext(lane, intent, found, kinds) && (/\b(ui|frontend|front[ -]end|telas?|screens?|páginas?|paginas?|blocos?|blocks?|webblock|html|layout|modal|modais|popup|components?|componentes?|interface|apps?|dashboard)\b|richwidgets|outsystemsuiweb/i.test(intent) || selectedTraditionalTasks(intent).length > 0);
}
