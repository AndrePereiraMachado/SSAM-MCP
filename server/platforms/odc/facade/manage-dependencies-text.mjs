// servidor/fase4-26 a8 round 2 (review C:\t\revisoes\agent-pack-next\REVISAO.md, IP option D): the explanation and the fix of
// each problem of the Studio's Manage Dependencies, written on the server. The thin bridge of the agent pack answers a problem
// with its cause and facts only (a neutral message, the neutral fix); o11_studio refresh-references writes the user's text
// here, and the hosted kernel does the same (kernel/src/Anvil.Core/Adapters.SS11/ManageDependenciesText.cs, the same table:
// hosted-a8-agent.test.mjs keeps the two equal). The sentences are the kernel's ManageDependencies ones for the owner's full
// bridge. studio-dialog (review M1): a dialog the Studio opened during the command, which the thin bridge closed.
// Placeholders: {producer}, {element} (the name after "Type:"), {elements} (the names of a list of specs), {title} (the
// element as it is), {module}, {count}, {after}, {published}.
export const MANAGE_DEPENDENCIES_TEXTS = Object.freeze({
  'catalog-unavailable': { message: 'The Studio could not read the referenceable producers of {module} from its environment.', fix: "check that the Studio is signed in to the module's environment (o11_studio status), then deliver the same job again" },
  'not-referenceable:environment': { message: "{producer} is not a referenceable producer of the module's environment.", fix: 'check that {producer} is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again' },
  'not-referenceable:catalog': { message: "The Studio's catalog has no published signature of {producer}.", fix: 'check that {producer} is published and referenceable in this environment (o11_environment referenceable), then deliver the same job again' },
  'signature-unavailable': { message: 'The published signature of {producer} could not be loaded by the Studio.', fix: 'publish {producer} again (its published signature does not load), then deliver the same job again' },
  'not-in-signature': { message: '{element} is not in the published signature of {producer}.', fix: 'publish {producer} with {element} public, then deliver the same job again (o11_dependencies list shows what {producer} publishes)' },
  ambiguous: { message: '{element} names {count} elements of {producer}.', fix: 'name it by its original key, Type:@<key> (o11_dependencies list shows the keys of {producer}), then deliver again' },
  'not-allowed': { message: 'The Studio does not let {module} reference {element} of {producer} in this module kind.', fix: 'use {element} through a form this module may reference (for a server entity in a UI module, a service or server action of {producer}), then deliver again' },
  'not-retained': { message: "The Studio's Manage Dependencies did not keep {elements} of {producer} in {module}.", fix: 'an SSAM defect (reported); nothing was applied (the command rolled back): deliver the same job again once the bridge is updated' },
  'not-at-published': { message: 'The Studio kept {producer} at {after}; its published signature is {published}.', fix: 'an SSAM defect (reported); nothing was applied (the command rolled back)' },
  'studio-dialog': { message: 'A Studio dialog opened during the Manage Dependencies of {module}: "{title}". The bridge closed it (Cancel, the window\'s X) so the command does not wait in the Studio; nothing was applied.', fix: "answer what the Studio asks first (for a sign-in: sign in to the module's environment in the Studio; o11_studio status shows it), then repeat the same call" },
});

const nameOf = spec => { const s = String(spec); const colon = s.indexOf(':'); return colon > 0 ? s.slice(colon + 1) : s; };

// {message, fix} of one problem, or null for a cause the table does not know (the bridge's own texts stay).
export function explainManageProblem(problem, module) {
  const cause = problem?.cause;
  if (typeof cause !== 'string') return null;
  const facts = problem.facts && typeof problem.facts === 'object' ? problem.facts : {};
  const template = (facts.where ? MANAGE_DEPENDENCIES_TEXTS[cause + ':' + facts.where] : null) ?? MANAGE_DEPENDENCIES_TEXTS[cause];
  if (!template) return { message: problem.message ?? null, fix: problem.fix ?? null };
  const element = problem.element == null ? null : String(problem.element);
  const fill = text => text
    .replaceAll('{producer}', String(problem.producer ?? problem.key ?? '?'))
    .replaceAll('{elements}', element == null ? '?' : element.split(', ').map(nameOf).join(', '))
    .replaceAll('{element}', element == null ? '?' : nameOf(element))
    .replaceAll('{title}', element ?? '?')
    .replaceAll('{module}', String(module ?? 'the module'))
    .replaceAll('{count}', String(facts.count ?? '?'))
    .replaceAll('{after}', String(facts.after ?? '?'))
    .replaceAll('{published}', String(facts.published ?? '?'));
  return { message: fill(template.message), fix: fill(template.fix) };
}

// The problems with the server's texts (new objects; the facts stay).
export const renderManageProblems = (problems, module) => (Array.isArray(problems) ? problems : [])
  .map(p => (p && typeof p === 'object' ? { ...p, ...(explainManageProblem(p, module) ?? {}) } : p));
