"""Public Service Center entry point used by `ssam service-center` and MCP (o11_service_center_session/read/write).

Authentication per call and host (service_center/auth.py): the connected Studio (its own clients, and its own web
window for .aspx pages), else the Windows vault, else a private prompt in its own window. Writes prepare by default;
executing needs the user's words, an operationId UUID and the journal reservation, and is never repeated."""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from service_center import studio_api
from service_center.auth import AuthRequired, Resolver, credential_target, guard_write, hidden_sign_in, host_class, open_prompt
from service_center.bridge import HIDDEN_LOGIN, StudioBridge, redact
from service_center.client import ACTIONS, LOG_PAGES, SCHEDULE, SECRET_WRITES, VALUE_ACTIONS, WEB_WRITES, Client, Journal
from service_center.http import BridgeError, ProtocolError, StudioWebTransport, Transport, Vault, host_name

KERNEL = Path(__file__).resolve().parents[1]
SESSION = ['session-status', 'session-sign-in', 'session-web-sign-in', 'session-close']
WEB_READS = ['timers', 'site-properties', 'property-value', 'logs', 'error-detail', 'trace', 'bpt-processes', 'bpt-process',
             'bpt-instance', 'bpt-activity', 'integrations', 'db-connections', 'solutions', 'solution-download', 'page-layout']
API_READS = list(studio_api.READS)
READS = ['capabilities', 'receipt', *WEB_READS, *API_READS]
WRITES = [*ACTIONS, *WEB_WRITES, *studio_api.WRITES]
DESTRUCTIVE = {'db-connection-delete', *studio_api.DESTRUCTIVE}
FLAGS = ('application', 'module', 'message', 'source', 'server', 'since', 'until', 'error-id', 'request-key', 'operation-id',
         'words', 'value-file', 'value-vault', 'application-key', 'module-key', 'element-key', 'solution', 'component',
         'description', 'osp-file', 'publish-id', 'last-message-id', 'apply-id', 'database-id', 'process', 'process-key',
         'process-id', 'activity-id', 'integration', 'integration-kind', 'level', 'connection', 'dbms',
         'db-server', 'db-database', 'extension', 'extension-id', 'confirm-host', 'stack-contains', 'log-type', 'log-action',
         'timer', 'path', 'to-application', 'to-application-key', 'from-application-key', 'module-kind', 'version',
         'commit-message', 'xif-file', *('schedule-' + key for key in SCHEDULE))
# logs filter -> CLI attribute
LOG_FILTER_ARGS = {'application': 'application', 'module': 'module', 'message': 'message', 'source': 'source', 'server': 'server',
                   'since': 'since', 'until': 'until', 'type': 'log_type', 'action': 'log_action', 'timer': 'timer'}


def parser():
    p = argparse.ArgumentParser(description='O11 Service Center through the connected Studio session (SSO included); the '
                                'Windows vault without a Studio; a private prompt only when neither exists', allow_abbrev=False)
    p.add_argument('action', choices=[*SESSION, *dict.fromkeys(READS), *WRITES, 'verify'])
    p.add_argument('--host')
    p.add_argument('--credential-target')
    p.add_argument('--session', choices=['auto', 'studio', 'studio-web', 'vault'], default='auto')
    p.add_argument('--auth-prompt', choices=['auto', 'never'], default='auto')
    p.add_argument('--surface', choices=['service-center', 'lifetime'], default='service-center')
    p.add_argument('--module-id')
    p.add_argument('--name')
    p.add_argument('--kind', choices=LOG_PAGES, default='error')
    p.add_argument('--limit', type=int, default=100)
    p.add_argument('--max-pages', type=int, default=20)
    for flag in FLAGS:
        p.add_argument('--' + flag)
    p.add_argument('--param', action='append', default=[], help='Non-secret database connection parameter label=value')
    p.add_argument('--include-references', action='store_true')
    p.add_argument('--export', action='store_true')
    p.add_argument('--reveal', action='store_true')
    p.add_argument('--execute', action='store_true')
    return p


def required(args, *names):
    if any(not getattr(args, n, None) for n in names):
        raise ProtocolError('Required: ' + ', '.join('--' + n.replace('_', '-') for n in names))


def value_file(path):
    file = Path(path)
    if not file.is_absolute() or file.stat().st_size > 1024 * 1024:
        raise ProtocolError('Use an absolute UTF-8 value file of at most 1 MiB')
    return file.read_text(encoding='utf-8-sig')


def journal_default():
    # All checkouts and both the user's and the Claude app's processes share one journal outside %LOCALAPPDATA%
    # (the MSIX app sees a private copy of it); receipts already written there still answer for their IDs.
    home = Path(os.environ.get('USERPROFILE') or Path.home())
    legacy = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.local' / 'share'))) / 'SSAM' / 'O11' / 'ServiceCenter' / 'receipts'
    # .ssam-hybrid, never .ssam: that folder belongs to GitSSAM (credentials, browser profiles).
    return Journal(Path(os.environ.get('SSAM_SC_RECEIPTS') or home / '.ssam-hybrid' / 'o11' / 'service-center' / 'receipts'), legacy)


def capabilities():
    return {'ok': True, 'protocol': 'Service Center through the connected Service Studio: its SOAP/server.api/rest clients (sc_api) '
            'and its own web window for .aspx pages (sc_web); direct HTTPS with the vault form login when no Studio is connected',
            'authentication': 'studio -> studio-web -> vault (SSAM/O11/<host>/ServiceCenter) -> private prompt (only with no Studio and no vault entry)',
            'session': SESSION, 'reads': {'studio-api': API_READS, 'pages': WEB_READS, 'local': ['capabilities', 'receipt']},
            'writes': {'pages': [*ACTIONS, *WEB_WRITES], 'studio-api': list(studio_api.WRITES), 'local': ['verify']},
            'default': 'prepare only; execute requires the user words, a UUID operation-id and the journal reservation; never replayed',
            'guards': ['corporate or unregistered hosts need confirmHost=<host> and words naming the environment on every write',
                       'module-delete, extension-delete, application-delete and db-connection-delete need words that name the '
                       'target (and the extensions using a connection); prepare simulates (application-delete: the server simulation)'],
            'secrets': 'database logins and secret site property values travel only as vault target names (sc_web secretRefs); '
                       'the Studio reads them inside its own process; without a Studio, or with a bridge without sc_web:secretRefs, '
                       'those writes are refused',
            'limits': ['Service Center pages are internal English Web Forms; pages modeled only on synthetic fixtures (ASSUMED) '
                       'refuse another layout with LAYOUT_UNKNOWN and the page-layout read that captures them live',
                       'Trace means log correlation, not distributed tracing', 'Run Now schedules work; it does not prove execution completed',
                       'Solution publish, extension publish and apply settings start server work; follow their status reads'],
            'liveValidation': 'not yet validated live; see docs/OPERACOES-O11.md'}


def answer(auth, result):
    return {'ok': result.get('ok', True) if isinstance(result, dict) else True, 'host': auth.host, 'auth': auth.describe(),
            **(result if isinstance(result, dict) else {'result': result})}


def session(args, locate, present, opener, running):
    host = host_name(args.host) if args.host else None
    if args.action == 'session-status':
        try:
            bridge = locate()
        except BridgeError as e:
            bridge, problem = None, {'code': e.code, 'error': str(e)}
        else:
            problem = None
        out = {'ok': True, 'studio': {'connected': bridge is not None, **({'pid': bridge.pid, 'bridgeVersion': bridge.version,
               'serviceCenterVerbs': bridge.supports()} if bridge else {}), **({'problem': problem} if problem else {})}}
        if host:
            out.update(host=host, hostClass=host_class(host),
                       vault={'ServiceCenter': bool(present(credential_target(host, 'ServiceCenter'))),
                              'LifeTime': bool(present(credential_target(host, 'LifeTime')))})
            if bridge is not None and bridge.supports():
                out['session'] = redact(bridge.session(host))
            dry = Resolver(host, session=args.session, prompt='never', locate=lambda: bridge, present=present, running=running, login=False)
            out['wouldUse'] = {}
            for need in ('api', 'web'):
                try:
                    out['wouldUse'][need] = dry.resolve(need).path
                except AuthRequired as e:
                    out['wouldUse'][need] = e.code
        return out
    required(args, 'host')
    if args.action == 'session-sign-in' and args.surface == 'lifetime':
        target = credential_target(host, 'LifeTime')
        if present(target):
            return {'ok': True, 'host': host, 'already': True, 'auth': {'path': 'vault', 'host': host, 'target': target}}
        return {'ok': True, 'host': host, 'code': 'CREDENTIAL_PROMPT_OPENED', 'prompt': opener(host, 'LifeTime'),
                'instruction': 'The user types the LifeTime service account and its token in the private window; repeat the call afterwards.'}
    bridge = locate()
    if bridge is not None and not bridge.supports():
        raise AuthRequired('STUDIO_BRIDGE_OUTDATED', 'The connected Studio runs a bridge without the Service Center verbs; reconnect a new bridge version.',
                           continuation={'tool': 'ssam_connect', 'lane': 'o11'})
    if args.action == 'session-sign-in':
        if bridge is not None:
            info = bridge.session(host)
            studio = info.get('studio') if isinstance(info.get('studio'), dict) else info
            if studio.get('signedIn') is True:
                return {'ok': True, 'host': host, 'already': True, 'auth': {'path': 'studio', 'host': host, 'user': studio.get('user')}}
            reply = bridge.login(host)
            return {'ok': True, 'host': host, 'dialog': 'opened', 'auth': {'path': 'studio', 'host': host},
                    'studio': {k: redact(reply[k]) for k in ('signedIn', 'dialogOpened', 'pending', 'accepted') if k in reply},
                    'instruction': "The Studio shows its own login dialog (password or SSO); the user signs in there, then repeat the call."}
        if running():
            raise AuthRequired('STUDIO_NOT_CONNECTED', 'A Service Studio is open but not connected to SSAM; run ssam_connect {lane:"o11"}.',
                               continuation={'tool': 'ssam_connect', 'lane': 'o11'})
        target = args.credential_target or credential_target(host, 'ServiceCenter')
        if present(target):
            return {'ok': True, 'host': host, 'already': True, 'auth': {'path': 'vault', 'host': host, 'target': target}}
        return {'ok': True, 'host': host, 'code': 'CREDENTIAL_PROMPT_OPENED', 'prompt': opener(host, 'ServiceCenter'),
                'instruction': 'No Studio and no vault entry: the user types the Service Center login in the private window; repeat the call afterwards.'}
    if bridge is None:
        raise AuthRequired('STUDIO_NOT_CONNECTED', "The Studio's Service Center window needs a connected Studio; run ssam_connect {lane:\"o11\"}.",
                           continuation={'tool': 'ssam_connect', 'lane': 'o11'})
    if args.action == 'session-web-sign-in':
        if HIDDEN_LOGIN in (bridge.capabilities() or ()):
            # The window stays hidden: the Studio signs it in with the stored login; the only thing the user sees is the
            # private prompt, when the login is missing or was rejected.
            reply = hidden_sign_in(bridge, host, present=present, opener=opener, prompt=args.auth_prompt)
            return {'ok': True, 'host': host, 'window': 'hidden', 'signedIn': reply.get('signedIn'), 'submitted': reply.get('submitted'),
                    'auth': {'path': 'studio-web', 'host': host}}
        reply = bridge.web(host, 'open')
        return {'ok': True, 'host': host, 'window': 'opened', 'signedIn': reply.get('signedIn'), 'auth': {'path': 'studio-web', 'host': host},
                **({'persistentProfile': reply['persistentProfile']} if 'persistentProfile' in reply else {}),
                'instruction': f'The Studio opened its Service Center window for {host}; the user signs in there once (SSO), then repeat the call.'}
    reply = bridge.web(host, 'close')
    return {'ok': True, 'host': host, 'closed': True, **({'signedIn': reply['signedIn']} if 'signedIn' in reply else {})}


def main(argv=None, *, journal=None, locate=None, present=None, opener=None, running=None, exports=None):
    args = parser().parse_args(argv)
    locate = locate or StudioBridge.locate
    present = present or Vault.present
    opener = opener or open_prompt
    exports = Path(exports) if exports else KERNEL / '.local' / 'service-center' / 'exports'
    if args.action == 'capabilities':
        return capabilities()
    journal = journal or journal_default()
    if args.action == 'receipt':
        required(args, 'operation_id')
        result = journal.lookup(args.operation_id)
        if result is None:
            raise ProtocolError('Receipt not found')
        return result
    resolver_options = dict(session=args.session, prompt=args.auth_prompt, credential_target=args.credential_target,
                            locate=locate, present=present, opener=opener, **({'running': running} if running else {}))
    if args.action in SESSION:
        from service_center.auth import studio_running
        return session(args, locate, present, opener, running or studio_running)
    required(args, 'host')
    host = host_name(args.host)
    write = args.action in WRITES
    if args.execute and not write:
        raise ProtocolError('--execute is only valid for a write operation')
    if not 1 <= args.limit <= 5000:
        raise ProtocolError('--limit must be between 1 and 5000')
    if not write and args.action != 'verify' and any((args.words, args.value_file, args.value_vault, args.confirm_host)):
        raise ProtocolError('Read operations cannot carry authorization or a property value')
    if args.reveal and args.action != 'property-value':
        raise ProtocolError('--reveal applies to property-value only')
    schedule = {key: getattr(args, 'schedule_' + key) for key in SCHEDULE if getattr(args, 'schedule_' + key) is not None} or None
    if schedule and args.action != 'timer-schedule':
        raise ProtocolError('--schedule-* applies to timer-schedule only')
    if write and args.execute:
        required(args, 'words', 'operation_id')
        guard_write(host, args.words, args.confirm_host)
    # Past the guard, a write to a non-personal host tells the bridge it carries the explicit instruction.
    corporate = write and args.execute and host_class(host) != 'personal'
    resolver = Resolver(host, **resolver_options)

    def studio(auth):
        if corporate and auth.bridge is not None:
            auth.bridge.corporate = True
        return auth

    def pages_client():
        auth = studio(resolver.resolve('web'))
        transport = StudioWebTransport(host, auth.bridge) if auth.path == 'studio-web' else Transport(host)
        return auth, Client(Vault(host, args.credential_target), transport, exports)

    def api():
        auth = studio(resolver.resolve('api'))
        return auth, studio_api.StudioApi(auth.bridge, host)

    if args.action == 'verify':
        required(args, 'operation_id')
        receipt = journal.lookup(args.operation_id)
        if not receipt:
            raise ProtocolError('Receipt not found')
        if args.words or args.value_vault:
            raise ProtocolError('Verification takes no authorization words; a vault value is never read back to compare')
        action = receipt['identity']['action']
        if action in studio_api.WRITES:
            auth, client = api()
            observed = client.observe(receipt)
            if observed:
                journal.reconcile(receipt)
            return answer(auth, dict(receipt, observedDesiredState=observed, replayed=False))
        auth, client = pages_client()
        # A schedule is compared with the one its receipt kept; a property only with the value file the user gives.
        value = value_file(args.value_file) if args.value_file else None
        return answer(auth, client.verify(receipt, journal, value))

    if write:
        approve = None
        if args.action in DESTRUCTIVE and args.execute:
            def approve(plan):
                # The words name the resolved target and everything the plan says goes with it.
                guard_write(host, args.words, args.confirm_host, plan.get('namedTargets') or [plan.get('name') or plan.get('connection')])
        options = dict(execute=args.execute, words=args.words, operation_id=args.operation_id, journal=journal)
        if args.action in ACTIONS:
            required(args, 'module_id', 'name')
            if args.action != 'property-set' and (args.value_file or args.value_vault):
                raise ProtocolError('Only property-set accepts a value source')
            if args.action == 'timer-schedule' and args.execute and not schedule:
                raise ProtocolError('timer-schedule needs at least one of --schedule-recurrence, --schedule-at, --schedule-every, --schedule-timeout')
            if args.value_file and args.value_vault:
                raise ProtocolError('Choose one property value source')
            auth, client = pages_client()
            value, secret = (schedule if args.action == 'timer-schedule' else None), None
            if args.action == 'property-set':
                if args.value_vault:
                    secret = site_property_target(host, args.value_vault)
                if args.execute:
                    identity = {'host': host, 'action': args.action, 'moduleId': args.module_id, 'name': args.name}
                    existing = journal.lookup(args.operation_id, identity)
                    if existing:
                        return answer(auth, dict(existing, existingReceipt=True, replayed=False))
                    if args.value_file:
                        value = value_file(args.value_file)
                    elif secret:
                        # The value stays in the vault: only its target name goes, and the Studio fills the field.
                        secret_ready(client, present, opener, host, 'SiteProperty', secret.rsplit('/', 1)[1])
                    else:
                        raise ProtocolError('Use --value-file for nonsecret values or --value-vault SSAM/O11/<host>/SiteProperty/<name> for secrets')
            return answer(auth, client.mutate(args.action, args.module_id, args.name, value=value, secret=secret, **options))
        if args.action in WEB_WRITES:
            data = web_arguments(args)
            auth, client = pages_client()
            if args.action in SECRET_WRITES and args.execute:
                identity = {'host': host, 'action': args.action, 'connection': args.connection}
                if not journal.lookup(args.operation_id, identity):
                    secret_ready(client, present, opener, host, 'DatabaseConnection', args.connection)
            return answer(auth, client.web_write(args.action, data, approve=approve, **options))
        auth, client = api()
        osp = None
        if args.action == 'solution-publish':
            required(args, 'solution')
            if args.osp_file:
                file = Path(args.osp_file)
                if not file.is_absolute() or not file.is_file() or file.stat().st_size > 64 * 1024 * 1024:
                    raise ProtocolError('--osp-file must be an absolute .osp of at most 64 MiB')
                osp = {'file': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
            elif not (args.execute and journal.lookup(args.operation_id, client.identity(args.action, args))):
                osp = pages_client()[1].solution_download(args.solution)
        return answer(auth, client.write(args.action, args, osp=osp, approve=approve, **options))

    if not 1 <= args.max_pages <= 100:
        raise ProtocolError('--max-pages must be between 1 and 100')
    if args.action == 'modules' and args.session in ('auto', 'studio'):
        # The Studio's module listing when a Studio is connected; the page listing (numeric IDs) otherwise.
        try:
            auth, client = api()
        except AuthRequired as e:
            if e.code != 'STUDIO_REQUIRED':
                raise
        else:
            return answer(auth, client.read('modules', args))
    if args.action in API_READS and args.action != 'modules':
        auth, client = api()
        return answer(auth, client.read(args.action, args))
    auth, client = pages_client()
    if args.action == 'modules':
        result = client.modules(args.limit)
    elif args.action in ('timers', 'site-properties'):
        required(args, 'module_id')
        result = client.resources(args.module_id, args.action, args.limit)
    elif args.action == 'property-value':
        required(args, 'module_id', 'name')
        result = client.property_value(args.module_id, args.name, args.reveal)
    elif args.action == 'logs':
        filters = {k: getattr(args, a) for k, a in LOG_FILTER_ARGS.items() if getattr(args, a) is not None}
        result = client.logs(args.kind, args.limit, filters, stack_contains=args.stack_contains, export=args.export, max_pages=args.max_pages)
    elif args.action == 'page-layout':
        required(args, 'path')
        result = client.page_layout(args.path)
    elif args.action == 'error-detail':
        required(args, 'error_id')
        result = client.error_detail(args.error_id)
    elif args.action == 'trace':
        required(args, 'request_key')
        result = client.trace(args.request_key, args.limit)
    elif args.action == 'bpt-processes':
        result = client.bpt_processes(args.module, args.process, args.limit, args.max_pages)
    elif args.action == 'bpt-process':
        required(args, 'process_key', 'module_key')
        result = client.bpt_process(args.process_key, args.module_key, args.limit, args.max_pages)
    elif args.action == 'bpt-instance':
        required(args, 'process_id')
        result = client.bpt_instance(args.process_id)
    elif args.action == 'bpt-activity':
        required(args, 'activity_id')
        result = client.bpt_activity(args.activity_id)
    elif args.action == 'integrations':
        required(args, 'module_id')
        result = client.integrations(args.module_id)
    elif args.action == 'db-connections':
        result = client.db_connections()
    elif args.action == 'solutions':
        result = client.solutions(args.limit)
    else:
        required(args, 'solution')
        result = client.solution_download(args.solution)
    return answer(auth, result)


def site_property_target(host, target):
    """--value-vault names the same-host SiteProperty vault entry; its value is never read here."""
    prefix = f'SSAM/O11/{host}/SiteProperty/'
    if not target.startswith(prefix):
        raise ProtocolError(f'--value-vault must be {prefix}<name> (an entry of this host)')
    return credential_target(host, 'SiteProperty', target[len(prefix):])


def secret_ready(client, present, opener, host, kind, name):
    """Before any reservation: the write needs the Studio window that fills secretRefs, and the vault entry it reads.
    A missing entry opens the private prompt (status only here: the value is never read in this process)."""
    if not client.http.secrets_supported():
        raise client.secret_refusal()
    target = credential_target(host, kind, name)
    if not present(target):
        what = f'database login for {name}' if kind == 'DatabaseConnection' else f'secret value of the site property {name}'
        raise AuthRequired('CREDENTIAL_PROMPT_OPENED', f'The {what} is not stored; a private Windows prompt opened for {target}. '
                           'The user types it there; repeat the call after it is stored.',
                           auth={'path': 'prompt', 'host': host, 'target': target, **opener(host, kind, name)})


def web_arguments(args):
    """The arguments of a page write, by name; secrets are never among them."""
    a = args.action
    if a.startswith('solution-'):
        required(args, 'solution', *(('component',) if 'component' in a else ()))
        return {'solution': args.solution, 'component': args.component, 'description': args.description,
                'includeReferences': args.include_references}
    if a.startswith('db-connection-'):
        required(args, 'connection')
        parameters = {}
        for item in args.param:
            label, sep, value = item.partition('=')
            if not sep or not label.strip():
                raise ProtocolError('--param takes label=value')
            parameters[label.strip()] = value
        return {'connection': args.connection, 'dbms': args.dbms, 'server': args.db_server, 'database': args.db_database,
                'parameters': parameters}
    if a == 'extension-db-connection':
        required(args, 'connection')
        if not args.extension_id and not args.extension:
            raise ProtocolError('Use --extension-id <n> or --extension <name>')
        return {'extensionId': args.extension_id or args.extension, 'connection': args.connection}
    required(args, 'module_id', 'integration', 'level')
    return {'moduleId': args.module_id, 'integration': args.integration, 'kind': args.integration_kind, 'level': args.level}


if __name__ == '__main__':
    try:
        result = main()
    except AuthRequired as e:
        result = e.answer()
    except BridgeError as e:
        result = {'ok': False, 'code': e.code, 'error': str(e), **({'continuation': e.extra['continuation']} if 'continuation' in e.extra else {})}
    except ProtocolError as e:
        result = {'ok': False, 'error': str(e)}
    except Exception:
        # Never serialize native/network exceptions: they may contain a form value or credential.
        result = {'ok': False, 'error': 'Service Center operation failed locally; no automatic retry'}
    print(json.dumps(result, ensure_ascii=True, indent=2))
    sys.exit(0 if result.get('ok', True) else 1)
