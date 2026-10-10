// A fake Anvil CLI runner with the same call shape as createAnvilRunner(): runAnvil(args, options).
// handlers: { '<verb>': (args, options) => envelope | {exitCode, envelope, stderr} }. Unknown verbs exit 64.
export function fakeAnvil(handlers = {}) {
  const calls = [];
  async function runAnvil(args, options = {}) {
    calls.push({ args: [...args], options });
    const handler = handlers[args[0]];
    if (!handler) return { ok: false, exitCode: 64, envelope: null, stdout: [], stderr: ['unknown verb ' + args[0]], wallMs: 0, line: 'dotnet anvil.dll ' + args.join(' ') };
    const value = await handler(args, options);
    const shaped = value && Object.hasOwn(value, 'envelope') ? value : { envelope: value };
    const exitCode = shaped.exitCode ?? (shaped.envelope?.ok ? 0 : 1);
    return { ok: exitCode === 0 && shaped.envelope?.ok === true, exitCode, envelope: shaped.envelope ?? null,
      stderr: shaped.stderr ?? [], wallMs: 1, line: 'dotnet anvil.dll ' + args.join(' ') };
  }
  runAnvil.calls = calls;
  return runAnvil;
}
