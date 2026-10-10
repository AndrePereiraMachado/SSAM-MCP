"""Prepare an opt-in Hybrid profile or dedicated project. Never modifies global settings or hook trust."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
import pathlib
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]
MARKER = "# Managed by SSAM Hybrid: restricted app profile"


def render(codex_home: pathlib.Path, cli: pathlib.Path, python: pathlib.Path, workspace: pathlib.Path | None = None) -> str:
    configuration = codex_home / "config.toml"
    existing = tomllib.loads(configuration.read_text(encoding="utf-8-sig")) if configuration.exists() else {}
    quote = lambda value: json.dumps(str(value).replace("\\", "/"), ensure_ascii=False)
    authority = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local")) / "Anvil" / "authority"
    ps_quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    hook_script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & " + ps_quote(python) + " -B " + ps_quote(ROOT / "scripts" / "ssam_app.py") + " --cli " + ps_quote(cli) + " --hook; exit $LASTEXITCODE"
    if workspace is not None:
        hook_script = hook_script.replace(" --hook;", " --workspace " + ps_quote(workspace.resolve()) + " --hook;")
    command = "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(hook_script.encode("utf-16-le")).decode("ascii")
    legacy = "sandbox_mode" in existing or "sandbox_workspace_write" in existing
    lines = [MARKER, 'approval_policy = "never"', 'web_search = "disabled"']
    if legacy:
        # Codex gives legacy sandbox settings precedence over named profiles. Override that setting explicitly.
        lines += ['sandbox_mode = "read-only"', '# Legacy read-only mode; private authority files are also protected by owner-only OS ACLs.']
    else:
        lines += ['default_permissions = "ssam-app"', '', '[permissions.ssam-app]',
            'description = "SSAM app: only controlled task tools; no maintenance or direct writes"', 'extends = ":read-only"',
            '[permissions.ssam-app.filesystem]', f'{quote(authority)} = "deny"', f'{quote(codex_home)} = "deny"', f'{quote(ROOT)} = "deny"',
            '[permissions.ssam-app.network]', 'enabled = false']
    lines += ['', '[windows]', 'sandbox = "elevated"', '', '[features]']
    for name in ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'browser_use',
        'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'code_mode_host', 'workspace_dependencies']:
        lines.append(f'{name} = false')
    lines += ['hooks = true', '[features.code_mode]', 'enabled = false']
    for name in existing.get('mcp_servers', {}):
        if name != 'ssam_hybrid': lines += ['', f'[mcp_servers.{quote(name)}]', 'enabled = false']
    lines += ['', '[mcp_servers.ssam_hybrid]', f'command = {quote(python)}',
        'args = ["-B", ' + quote(ROOT / 'scripts' / 'ssam_app.py') + ', "--cli", ' + quote(cli) + (', "--workspace", ' + quote(workspace.resolve()) if workspace is not None else '') + ']',
        'enabled = true', 'required = true', 'tool_timeout_sec = 600', 'enabled_tools = ["context", "propose", "continue", "status"]']
    for event in ['UserPromptSubmit', 'PreToolUse']:
        lines += ['', f'[[hooks.{event}]]']
        if event == 'PreToolUse': lines.append('matcher = ".*"')
        lines += [f'[[hooks.{event}.hooks]]', 'type = "command"', 'command = ' + json.dumps(command, ensure_ascii=False), 'timeout = 30']
    lines += ['', '# Review and trust these hooks through /hooks before using the app tools.',
        '# Without a host capture and one-use hook grant, the MCP server refuses execution.']
    return '\n'.join(lines) + '\n'


def digest(path: pathlib.Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def contains_hybrid_hook(entries: object) -> bool:
    if isinstance(entries, dict):
        command = entries.get('command', '')
        if isinstance(command, str):
            if 'ssam_app.py' in command:
                return True
            if ' -EncodedCommand ' in command:
                try:
                    script = base64.b64decode(command.split(' -EncodedCommand ', 1)[1].strip(), validate=True).decode('utf-16-le')
                    if 'ssam_app.py' in script:
                        return True
                except (ValueError, UnicodeError):
                    pass
        return any(contains_hybrid_hook(value) for value in entries.values())
    return isinstance(entries, list) and any(contains_hybrid_hook(value) for value in entries)


def check(configuration: pathlib.Path, codex_home: pathlib.Path, cli: pathlib.Path,
          python: pathlib.Path, workspace: pathlib.Path | None = None) -> dict:
    """Inspect installed bytes only; no captures, permits, trust edits or Studio calls."""
    validate_destination(configuration, codex_home)
    project_config = workspace.resolve() / '.codex' / 'config.toml' if workspace is not None else None
    review_copy = project_config is not None and configuration.resolve() != project_config
    expected = render(codex_home, cli, python, workspace)
    exact = configuration.is_file() and configuration.read_text(encoding='utf-8-sig') == expected
    files = {'controller': cli, 'adapter': ROOT / 'scripts' / 'ssam_app.py', 'python': python}
    problems = []
    if not exact:
        problems.append('Configuration is missing or differs from the generated setup')
    for name, path in files.items():
        if not path.is_file():
            problems.append(name + ' file is missing: ' + str(path))
    if workspace is not None and not workspace.is_dir():
        problems.append('Dedicated workspace does not exist')
    user_config = codex_home / 'config.toml'
    current = tomllib.loads(user_config.read_text(encoding='utf-8-sig')) if user_config.exists() else {}
    if workspace is not None and contains_hybrid_hook(current.get('hooks', {})):
        problems.append('Global SSAM hooks already exist; review duplicate capture before using project hooks')
    return {'configured': not problems and not review_copy, 'reviewPrepared': not problems and review_copy, 'active': None,
        'state': 'configuration-incomplete' if problems else 'review-copy' if review_copy else 'awaiting-client-proof',
        'projectConfiguration': str(project_config) if project_config is not None else None,
        'workspace': str(workspace.resolve()) if workspace is not None else None,
        'configuration': str(configuration.resolve()), 'configurationSha256': digest(configuration),
        'files': {name: {'path': str(path.resolve()), 'sha256': digest(path)} for name, path in files.items()},
        'tools': ['context', 'propose', 'continue', 'status'],
        'capabilities': {'existingModuleDelivery': True, 'createApplication': False, 'createModules': False},
        'changesDefaultProfile': False, 'requiresHookTrust': True, 'problems': problems,
        'next': ['Open a NEW local task in the dedicated project; do not also select the ssam-app profile' if workspace is not None else 'Select the ssam-app profile explicitly',
            'Review project trust and the exact hooks in the client; generated files do not grant trust',
            'A real UserPromptSubmit hook must supply task_id and the four MCP tools must be available',
            'Call context with the captured id to verify the requested lane and environment'],
        'limitations': ['Static preflight does not prove MCP startup, trusted hooks, actual client capture or lane readiness',
            'Opening Service Studio or loading the Hybrid skill does not activate the controlled session',
            'Never ask the user to invent or locate a task_id; absent capture is an onboarding failure']}


def validate_destination(path: pathlib.Path, codex_home: pathlib.Path) -> None:
    if path.resolve() == (codex_home / 'config.toml').resolve():
        raise ValueError('Refusing to modify the global Codex configuration; select a dedicated workspace or optional profile')


def write_managed(path: pathlib.Path, content: str) -> None:
    if path.exists() and not path.read_text(encoding='utf-8-sig').startswith(MARKER):
        raise ValueError('Refusing to replace a configuration not managed by SSAM Hybrid: ' + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--codex-home', type=pathlib.Path, default=pathlib.Path(os.environ.get('CODEX_HOME', pathlib.Path.home() / '.codex')))
    parser.add_argument('--cli', type=pathlib.Path, required=True)
    parser.add_argument('--out', type=pathlib.Path, help='Profile output or review copy; default with --workspace is .codex/config.toml')
    parser.add_argument('--workspace', type=pathlib.Path, help='Dedicated app project, with project-local MCP/hooks instead of an optional CLI profile')
    parser.add_argument('--check', action='store_true', help='Read-only static preflight; never activates hooks or changes trust')
    args = parser.parse_args()
    if args.out is None and args.workspace is None:
        parser.error('--out or --workspace is required')
    workspace = args.workspace.resolve() if args.workspace is not None else None
    configuration = args.out or workspace / '.codex' / 'config.toml'
    cli, python = args.cli.resolve(), pathlib.Path(sys.executable).resolve()
    validate_destination(configuration, args.codex_home)
    if not args.check:
        content = render(args.codex_home, cli, python, workspace)
        tomllib.loads(content)
        write_managed(configuration, content)
    result = check(configuration, args.codex_home, cli, python, workspace)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['configured'] or result['reviewPrepared'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
