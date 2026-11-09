// r44 round 4: the PHP class map of the generated files, and a static check of those files against it.
// Round 3 shipped rollback-coolify.php calling `AppModelsService` (a class name typed in a JS template literal, where
// "\M" becomes "M"): the apply branch never ran anywhere, so neither the dry run nor the shell tests saw it. The family:
// a class or static method the PHP names that does not exist on Coolify. Two guards:
//   1. CLASSES: every class the generated PHP uses is written ONCE here, as plain JS strings, and interpolated;
//      runtimeCheck() emits PHP that, in EVERY mode (dry run included), stops unless each class and method exists on
//      the Coolify it runs in: the read-only VPS dry run exercises what the apply branch will call.
//   2. checkGenerated(): every `Name::` / `Name::class` in a generated file is fully qualified, is in CLASSES and is
//      in that file's runtime check; no glued namespace (`AppModels…`) anywhere.
export const CLASSES = {
  kernel: 'Illuminate\\Contracts\\Console\\Kernel',
  model: 'Illuminate\\Database\\Eloquent\\Model',
  builder: 'Illuminate\\Database\\Eloquent\\Builder',
  service: 'App\\Models\\Service',
  startService: 'App\\Actions\\Service\\StartService',
  yaml: 'Symfony\\Component\\Yaml\\Yaml',
};
// [class, method|null]: `App\Models\Service::where(...)->sole()` goes through Model::__callStatic to Builder::where/sole.
export const SERVICE_READ = [[CLASSES.kernel, null], [CLASSES.model, '__callStatic'], [CLASSES.service, null], [CLASSES.builder, 'where'], [CLASSES.builder, 'sole']];
export const SERVICE_WRITE = [[CLASSES.service, 'save'], [CLASSES.startService, 'run']];
const q = s => `'${s}'`; // PHP single quotes keep "\" before a letter as is
export function runtimeCheck(needs) {
  const list = needs.map(([c, m]) => `[${q(c)}, ${m === null ? 'null' : q(m)}]`).join(', ');
  return `// Every class and method this file uses, in ANY mode, checked on the Coolify it runs in (r44 round 4).
foreach ([${list}] as [$c, $m]) {
  if (!class_exists($c) && !interface_exists($c)) stop("class $c not found on this Coolify");
  if ($m !== null && !method_exists($c, $m)) stop("method $c::$m not found on this Coolify");
}
fwrite(STDERR, "runtime check: ${needs.length} classes/methods present\\n");`;
}
const BUILTIN = new Set(['self', 'static', 'parent']);
// checkGenerated(text) -> list of problems (empty = ok).
export function checkGenerated(name, text) {
  const problems = [];
  const known = new Set(Object.values(CLASSES));
  const checked = new Set();
  const block = text.match(/foreach \(\[(.*)\] as \[\$c, \$m\]\)/);
  if (!block) problems.push(`${name}: no runtime class check`);
  else for (const m of block[1].matchAll(/\['([^']+)'/g)) checked.add(m[1]);
  // Code only: drop // comments and quoted strings (messages may contain "::").
  const code = text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  for (const m of code.matchAll(/(?<![\w\\$>])(\\?[A-Za-z_][\w\\]*)::/g)) {
    const cls = m[1].replace(/^\\/, '');
    if (BUILTIN.has(cls)) continue;
    if (!cls.includes('\\')) { problems.push(`${name}: ${cls}:: is not a fully qualified class (glued namespace?)`); continue; }
    if (!known.has(cls)) problems.push(`${name}: ${cls} is not in the class map`);
    else if (!checked.has(cls)) problems.push(`${name}: ${cls} is used but not in the runtime check`);
  }
  for (const m of text.matchAll(/(^|[^\\A-Za-z])((?:App|Illuminate|Symfony)[A-Z][a-z]+[A-Z]\w*)/g)) problems.push(`${name}: glued namespace ${m[2]}`);
  return problems;
}
