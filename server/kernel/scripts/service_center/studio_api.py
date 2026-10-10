"""Service Center through the connected Studio's own authenticated clients (bridge sc_api): the SOAP ServiceStudio.asmx
(IServiceCenter), server.api/v1 (provider.ServerApiService) and /ServiceCenter/rest (ServerCommonService).

Arguments are the .NET parameter names without the credential, CancellationToken and out parameters; the bridge
injects the Studio's user and fresh secret per call and calls each write once, never through the Studio's
re-sending wrapper. Results are projected business data, redacted again here."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path

from .bridge import redact
from .client import run_write, utc
from .http import BridgeError, ProtocolError

KEY = re.compile(r'[A-Za-z0-9*_+/=-]{1,100}')

# action -> (surface, operation, arguments from the CLI arguments)
READS = {
    'applications': ('soap', 'ListApplications', lambda a: {'withIcons': False}),
    'application': ('soap', 'GetApplicationDetails', lambda a: {'appKey': key(a, 'application_key')}),
    'application-dependencies': ('soap', 'GetApplicationDependenciesDetails', lambda a: {'appKey': key(a, 'application_key')}),
    'modules': ('soap', 'ListEspaces', lambda a: {}),
    'extensions': ('soap', 'ListExtensions', lambda a: {}),
    'versions': ('soap', 'ListVersions', lambda a: {'eSpaceKey': key(a, 'module_key')}),
    'module-id': ('soap', 'GetESpaceId', lambda a: {'eSpaceKey': key(a, 'module_key')}),
    'consumers': ('soap', 'GetConsumers', lambda a: {'producerESpaceKey': key(a, 'module_key'),
                                                     'referenceableElementKey': a.element_key or ''}),
    'public-elements': ('soap', 'GetPublicElements', lambda a: {}),
    'commits': ('soap', 'ListCommits', lambda a: {'eSpacesStartVersion': 0, 'extensionsStartVersion': 0, 'startDate': since(a)}),
    'developer-operations': ('soap', 'GetDeveloperOperations', lambda a: {'startDate': since(a)}),
    'license': ('soap', 'GetLicenseInformation', lambda a: {}),
    'databases': ('server-api', 'ListDatabases', lambda a: {'withAppsInfo': True}),
    'application-database': ('server-api', 'GetDatabaseByApplicationKey', lambda a: {'applicationKey': key(a, 'application_key')}),
    'solution-components': ('soap', 'ListSolutionComponents', lambda a: {'solutionName': text(a, 'solution')}),
    'solution-publish-status': ('soap', 'CheckSolutionPublish', lambda a: {'solutionPublishId': number(a, 'publish_id'),
                                                                          'lastSeenMessageId': int(a.last_message_id or 0)}),
    'apply-settings-status': ('sc-rest', 'apply-settings-status', lambda a: {'id': number(a, 'apply_id')}),
}
# action -> the plan keys that lock its target in the journal
WRITES = {'module-delete': ('moduleKey',), 'extension-delete': ('moduleKey',), 'solution-publish': ('solution',),
          'apply-settings': ('applicationKey',), 'application-database-set': ('applicationKey',),
          'application-delete': ('applicationKey',), 'module-move': ('moduleKey',), 'module-add-to-application': ('moduleKey',),
          'commit-message-set': ('versionId',), 'extension-publish': ('xifSha256',)}
# Destructive writes: the user's words must name every plan['namedTargets'] (checked before the reservation).
DESTRUCTIVE = ('module-delete', 'extension-delete', 'application-delete')
XIF_LIMIT = 256 * 1024 * 1024  # the bridge reads at most this much from args.file


def key(a, name):
    value = getattr(a, name)
    if not value or not KEY.fullmatch(value):
        raise ProtocolError('--' + name.replace('_', '-') + ' must be the key from a Service Center listing')
    return value


def text(a, name):
    value = getattr(a, name)
    if not value or len(value) > 200:
        raise ProtocolError('--' + name.replace('_', '-') + ' is required')
    return value


def number(a, name):
    value = getattr(a, name)
    if not value or not re.fullmatch(r'[0-9]{1,10}', str(value)):
        raise ProtocolError('--' + name.replace('_', '-') + ' must be the numeric ID returned by the operation')
    return int(value)


def since(a):
    value = a.since or ''
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except ValueError:
        raise ProtocolError('--since must be an ISO date/time (for example 2026-10-01T00:00:00Z)') from None


def field(value, *names):
    """A projected field by any of its names, case-insensitively (the projection keeps the .NET member names)."""
    if not isinstance(value, dict):
        return None
    folded = {str(k).casefold(): v for k, v in value.items()}
    return next((folded[n.casefold()] for n in names if n.casefold() in folded), None)


def items(result):
    value = field(result, 'returnValue', 'items', 'value') if isinstance(result, dict) else result
    return value if isinstance(value, list) else []


def module_key(row):
    return field(row, 'Key', 'ESpaceKey', 'ModuleKey', 'SS_Key')


def app_key(row):
    return field(row, 'ApplicationKey', 'AppKey')


def failed(messages):
    """Error messages of an HEMessage list (Type Error), redacted."""
    return [redact(field(m, 'Message') or '') for m in messages if isinstance(m, dict) and str(field(m, 'Type') or '').casefold() == 'error'] \
        if isinstance(messages, list) else []


def message_of(result):
    """The text of a SOAP message field, redacted; the server's empty HEMessage (Type Error, no text, live on 11.42 after a
    successful MoveModuleBetweenApps) is no message at all."""
    value = field(result, 'message', 'msg')
    if isinstance(value, dict):
        definition = field(value, 'MessageDefinition')
        value = field(value, 'Message') or field(definition, 'Message') or field(definition, 'Detail') or field(definition, 'Id')
    return redact(value) if value else None


def commit_text(a):
    value = a.commit_message
    if value is None or not 1 <= len(value) <= 2000 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value):
        raise ProtocolError('--commit-message must be 1..2000 characters of plain text')
    return value


class StudioApi:
    def __init__(self, bridge, host):
        self.bridge, self.host = bridge, host

    def call(self, surface, operation, args):
        return self.bridge.api(self.host, surface, operation, args).get('result')

    def read(self, action, a):
        surface, operation, build = READS[action]
        result = self.call(surface, operation, build(a))
        return {'operation': operation, 'surface': surface, 'result': redact(result), 'observedAt': utc()}

    def named(self, operation, a, kind):
        """One module or extension by exact key or exact name from the live listing; never the first of several."""
        rows = items(self.call('soap', operation, {}))
        if a.module_key:
            matches = [r for r in rows if module_key(r) == a.module_key]
        elif a.module:
            matches = [r for r in rows if field(r, 'Name') == a.module]
        else:
            raise ProtocolError(f'The {kind} needs --module <name> or --module-key <key>')
        if len(matches) != 1:
            raise ProtocolError(f'Expected exactly one {kind} with that name/key in the live listing; found {len(matches)}')
        return matches[0]

    def module(self, a, kinds=None):
        """(kind, row) of one module or extension by exact name/key across both listings (--module-kind narrows it)."""
        kinds = kinds or ([a.module_kind] if getattr(a, 'module_kind', None) else ['eSpace', 'Extension'])
        if any(k not in ('eSpace', 'Extension') for k in kinds):
            raise ProtocolError('--module-kind is eSpace or Extension')
        if not a.module_key and not a.module:
            raise ProtocolError('Use --module <name> or --module-key <key>')
        found = []
        for kind in kinds:
            rows = items(self.call('soap', 'ListEspaces' if kind == 'eSpace' else 'ListExtensions', {}))
            found += [(kind, r) for r in rows if (module_key(r) == a.module_key if a.module_key else field(r, 'Name') == a.module)]
        if len(found) != 1:
            raise ProtocolError(f'Expected exactly one module or extension with that name/key; found {len(found)} (--module-kind narrows it)')
        return found[0]

    def applications(self):
        return items(self.call('soap', 'ListApplications', {'withIcons': False}))

    def application(self, a, name_attr='application', key_attr='application_key'):
        """(key, name) of one application by exact name or key, from the live listing when it is needed."""
        given_key, given_name = getattr(a, key_attr, None), getattr(a, name_attr, None)
        if given_key:
            return key(a, key_attr), given_key
        if not given_name:
            raise ProtocolError(f"Use --{name_attr.replace('_', '-')} <name> or --{key_attr.replace('_', '-')} <key>")
        matches = [r for r in self.applications() if field(r, 'Name') == given_name]
        if len(matches) != 1:
            raise ProtocolError(f'Expected exactly one application named {given_name!r}; found {len(matches)}')
        return field(matches[0], 'Key', 'ApplicationKey'), given_name

    def application_row(self, application_key):
        matches = [r for r in self.applications() if str(field(r, 'Key', 'ApplicationKey')).casefold() == str(application_key).casefold()]
        if len(matches) != 1:
            raise ProtocolError(f'Expected exactly one application with key {application_key}; found {len(matches)}')
        return matches[0]

    # ---- writes: prepare by default; send runs once inside the journal reservation
    def write(self, action, a, *, execute, words, operation_id, journal, osp=None, approve=None):
        prepare = getattr(self, '_prepare_' + action.replace('-', '_'))
        send = getattr(self, '_send_' + action.replace('-', '_'))

        def run(plan, state, receipt):
            receipt['plan'] = plan
            return send(plan, state, receipt)

        def gate(plan):
            # Before the reservation: a delete the server's own simulation refuses is never sent.
            if plan.get('blocked'):
                raise ProtocolError(plan['blocked'])
            if approve:
                approve(plan)
        # The target lock uses the resolved key, whether the call named the target or gave its key.
        return run_write(self.identity(action, a), lambda: prepare(a, osp), run, execute=execute, words=words,
                         operation_id=operation_id, journal=journal, approve=gate,
                         lock=lambda plan: {'host': self.host, **{k: str(plan[k]) for k in WRITES[action]}})

    def identity(self, action, a):
        """The journal identity is known before any network read, so a reused operationId answers from the journal."""
        module = a.module_key or a.module
        target = {'module-delete': module, 'extension-delete': module, 'solution-publish': a.solution,
                  'apply-settings': a.application_key or a.application, 'application-database-set': a.application_key or a.application,
                  'application-delete': a.application_key or a.application, 'module-move': module, 'module-add-to-application': module,
                  'commit-message-set': module and a.version and f'{module}#{a.version}', 'extension-publish': a.xif_file}[action]
        if not target:
            raise ProtocolError('The write needs its target (name or key)')
        return {'host': self.host, 'action': action, 'target': str(target)}

    def _send(self, surface, operation, args, receipt, target=None):
        return self.bridge.api(self.host, surface, operation, args, write=True, operation_id=receipt['operationId'],
                               authorize_sha256=receipt['authorization']['wordsSha256'], target=target).get('result')

    def _prepare_delete(self, a, operation, kind):
        row = self.named(operation, a, kind)
        resolved = module_key(row)
        consumers = None
        if kind == 'eSpace':
            try:
                consumers = sorted({field(c, 'Name') or '?' for c in items(self.call('soap', 'GetConsumers', {
                    'producerESpaceKey': resolved, 'referenceableElementKey': ''}))})
            except ProtocolError:
                consumers = None
        plan = {'host': self.host, 'action': 'module-delete' if kind == 'eSpace' else 'extension-delete', 'moduleKind': kind,
                'moduleKey': resolved, 'name': field(row, 'Name'), 'consumers': consumers if consumers is not None else 'unknown',
                'simulation': 'target resolved from the live listing; nothing was deleted', 'destructive': True,
                'namedTargets': [field(row, 'Name')], 'execute': False}
        return plan, {'listing': operation}

    def _prepare_module_delete(self, a, osp=None):
        return self._prepare_delete(a, 'ListEspaces', 'eSpace')

    def _prepare_extension_delete(self, a, osp=None):
        return self._prepare_delete(a, 'ListExtensions', 'Extension')

    def _send_delete(self, plan, state, receipt):
        # target names the key of the args, so the bridge checks the destructive call is the one prepared.
        result = self._send('soap', 'DeleteModule', {'moduleKey': plan['moduleKey'], 'moduleKind': plan['moduleKind']}, receipt,
                            target=plan['moduleKey'])
        # The bridge projects DeleteModule as {success, message}.
        accepted = field(result, 'success', 'returnValue') if isinstance(result, dict) else result
        message = message_of(result)
        if accepted is False:
            return {'state': 'rejected', 'message': message}
        still = any(module_key(r) == plan['moduleKey'] for r in items(self.call('soap', state['listing'], {})))
        return {'state': 'accepted-unverified' if still else 'confirmed', 'message': message}

    _send_module_delete = _send_delete
    _send_extension_delete = _send_delete

    def _prepare_solution_publish(self, a, osp):
        """osp: the absolute .osp the user gave, or the solution's own download (web transport) done in prepare."""
        name = text(a, 'solution')
        if osp is None:
            raise ProtocolError('solution-publish needs the solution package: --osp-file or a Service Center download')
        body = Path(osp['file']).read_bytes()
        if hashlib.sha256(body).hexdigest() != osp['sha256'] or not body.startswith(b'PK'):
            raise ProtocolError('The solution package changed or is not an OSP')
        plan = {'host': self.host, 'action': 'solution-publish', 'solution': name, 'osp': osp['file'], 'ospSha256': osp['sha256'],
                'size': len(body), 'execute': False,
                'note': 'Publishes this package (the versions it holds); status by solution-publish-status'}
        return plan, {}

    def _send_solution_publish(self, plan, state, receipt):
        if hashlib.sha256(Path(plan['osp']).read_bytes()).hexdigest() != plan['ospSha256']:
            raise BridgeError('BAD_REQUEST', 'The package changed after it was prepared; nothing was sent', write=True)
        # The bridge reads the package itself from this absolute path (args.file), inside the Studio process.
        result = self._send('soap', 'PublishSolution', {'file': plan['osp'], 'filename': Path(plan['osp']).name}, receipt)
        publish_id = field(result, 'solutionPublishId')
        return {'state': 'accepted' if publish_id else 'accepted-unverified', 'executionCompleted': False,
                'solutionPublishId': publish_id, 'needsConfiguration': field(result, 'needsConfiguration'),
                'messages': redact(field(result, 'messages', 'returnValue')),
                **({'continuation': {'tool': 'o11_service_center_read', 'action': 'solution-publish-status', 'publishId': str(publish_id)}} if publish_id else {})}

    def _prepare_apply_settings(self, a, osp=None):
        application_key, name = self.application(a)
        return {'host': self.host, 'action': 'apply-settings', 'applicationKey': application_key, 'application': name, 'execute': False}, {}

    def _send_apply_settings(self, plan, state, receipt):
        result = self._send('sc-rest', 'apply-settings', {'applicationKey': plan['applicationKey']}, receipt)
        # The bridge sends the PUT itself and answers {status, body}; body is StartApplySettingsServerResponse
        # {OperationId, REST_Error{ErrorMessage}}, the shape the Studio checks (ServerCommonService.StartApplySettings).
        body = field(result, 'body')
        response = body if isinstance(body, dict) else result
        error = field(field(response, 'REST_Error'), 'ErrorMessage')
        if error:
            return {'state': 'rejected', 'message': redact(error), 'result': redact(result)}
        apply_id = field(response, 'OperationId', 'id')
        return {'state': 'accepted', 'executionCompleted': False, 'applyId': apply_id, 'result': redact(result),
                **({'continuation': {'tool': 'o11_service_center_read', 'action': 'apply-settings-status', 'applyId': str(apply_id)}} if apply_id is not None else {})}

    def _prepare_application_database_set(self, a, osp=None):
        application_key, name = self.application(a)
        database = text(a, 'database_id')
        known = [d for d in items(self.call('server-api', 'ListDatabases', {'withAppsInfo': False})) if str(field(d, 'Id', 'DatabaseId', 'Key')) == database]
        if len(known) != 1:
            raise ProtocolError('--database-id is not one database of this environment (see databases)')
        current = self.call('server-api', 'GetDatabaseByApplicationKey', {'applicationKey': application_key})
        return {'host': self.host, 'action': 'application-database-set', 'applicationKey': application_key, 'application': name,
                'databaseId': database, 'currentDatabase': redact(field(current, 'Id', 'DatabaseId', 'Key')), 'execute': False}, {}

    def _send_application_database_set(self, plan, state, receipt):
        result = self._send('server-api', 'AssociateAppWithDatabase', {'applicationKey': plan['applicationKey'], 'databaseId': plan['databaseId']}, receipt)
        if (field(result, 'associated', 'returnValue') if isinstance(result, dict) else result) is False:
            return {'state': 'rejected'}
        now = self.call('server-api', 'GetDatabaseByApplicationKey', {'applicationKey': plan['applicationKey']})
        return {'state': 'confirmed' if str(field(now, 'Id', 'DatabaseId', 'Key')) == plan['databaseId'] else 'accepted-unverified'}

    # ---- application delete: the server's own simulation first (a read), then the delete naming the application
    def _prepare_application_delete(self, a, osp=None):
        application_key, _ = self.application(a)
        name = field(self.application_row(application_key), 'Name')
        # DeleteApplication with simulate:true is a read in the bridge: it lists what the delete would take with it.
        simulation = self.call('soap', 'DeleteApplication', {'appKey': application_key, 'simulate': True})
        success = field(simulation, 'success', 'returnValue')
        plan = {'host': self.host, 'action': 'application-delete', 'applicationKey': application_key, 'application': name,
                'simulation': {'success': success, 'messages': redact(field(simulation, 'messages')),
                               'affectedApplications': redact(field(simulation, 'affectedApplications', 'affectedApps')),
                               'deletedModules': redact(field(simulation, 'deletedModules', 'deletedComponents'))},
                'destructive': True, 'namedTargets': [name], 'execute': False}
        if success is False:
            plan['blocked'] = f'The Service Center simulation refuses to delete {name}; nothing was sent (see simulation.messages)'
        return plan, {}

    def _send_application_delete(self, plan, state, receipt):
        # target names the application key, so the bridge checks the destructive call is the one simulated.
        result = self._send('soap', 'DeleteApplication', {'appKey': plan['applicationKey'], 'simulate': False}, receipt, target=plan['applicationKey'])
        messages = redact(field(result, 'messages', 'message'))
        if field(result, 'success', 'returnValue') is False:
            return {'state': 'rejected', 'messages': messages}
        return {'state': 'confirmed' if self.application_gone(plan['applicationKey']) else 'accepted-unverified', 'messages': messages,
                'deletedModules': redact(field(result, 'deletedModules', 'deletedComponents'))}

    def application_gone(self, application_key):
        return not any(str(field(r, 'Key', 'ApplicationKey')).casefold() == str(application_key).casefold() for r in self.applications())

    # ---- modules and applications
    def module_plan(self, action, a, kinds=None):
        kind, row = self.module(a, kinds)
        return {'host': self.host, 'action': action, 'module': field(row, 'Name'), 'moduleKey': module_key(row), 'moduleKind': kind,
                'currentApplicationKey': app_key(row), 'currentApplication': field(row, 'ApplicationName'), 'execute': False}

    def module_application(self, plan):
        """The application key the live listing shows for the module now (None when the listing omits it)."""
        listing = 'ListEspaces' if plan['moduleKind'] == 'eSpace' else 'ListExtensions'
        rows = [r for r in items(self.call('soap', listing, {})) if module_key(r) == plan['moduleKey']]
        return app_key(rows[0]) if len(rows) == 1 else None

    def moved(self, plan, result, application_key):
        if field(result, 'success', 'returnValue') is False:
            return {'state': 'rejected', 'message': message_of(result)}
        now = self.module_application(plan)
        return {'state': 'confirmed' if now and str(now).casefold() == str(application_key).casefold() else 'accepted-unverified',
                'message': message_of(result), 'observedApplicationKey': now}

    def _prepare_module_move(self, a, osp=None):
        plan = self.module_plan('module-move', a)
        to_key, to_name = self.application(a, 'to_application', 'to_application_key')
        source = a.from_application_key or plan['currentApplicationKey']
        if not source:
            raise ProtocolError('The live listing does not show the module\'s application; give --from-application-key')
        if a.from_application_key and plan['currentApplicationKey'] and plan['currentApplicationKey'].casefold() != a.from_application_key.casefold():
            raise ProtocolError('--from-application-key is not the application the live listing shows for this module')
        if str(source).casefold() == str(to_key).casefold():
            raise ProtocolError('The module already belongs to that application')
        plan.update(fromApplicationKey=source, toApplicationKey=to_key, toApplication=to_name)
        return plan, {}

    def _send_module_move(self, plan, state, receipt):
        result = self._send('soap', 'MoveModuleBetweenApps', {'fromAppKey': plan['fromApplicationKey'], 'toAppKey': plan['toApplicationKey'],
                                                              'moduleKind': plan['moduleKind'], 'moduleKey': plan['moduleKey']}, receipt)
        return self.moved(plan, result, plan['toApplicationKey'])

    def _prepare_module_add_to_application(self, a, osp=None):
        plan = self.module_plan('module-add-to-application', a)
        application_key, name = self.application(a)
        if plan['currentApplicationKey'] and str(plan['currentApplicationKey']).casefold() == str(application_key).casefold():
            raise ProtocolError('The module already belongs to that application')
        plan.update(applicationKey=application_key, application=name)
        return plan, {}

    def _send_module_add_to_application(self, plan, state, receipt):
        result = self._send('soap', 'AddModuleToApplication', {'appKey': plan['applicationKey'], 'moduleKind': plan['moduleKind'],
                                                               'moduleKey': plan['moduleKey']}, receipt)
        return self.moved(plan, result, plan['applicationKey'])

    # ---- the commit message of one published module version
    def version_row(self, plan):
        rows = [r for r in items(self.call('soap', 'ListVersions', {'eSpaceKey': plan['moduleKey']}))
                if str(field(r, 'Version')) == str(plan['version'])]
        if len(rows) != 1:
            raise ProtocolError(f"Expected exactly one version {plan['version']} of {plan['module']}; found {len(rows)}")
        return rows[0]

    def _prepare_commit_message_set(self, a, osp=None):
        if not re.fullmatch(r'[1-9][0-9]{0,6}', str(a.version or '')):
            raise ProtocolError('--version is the module version number (see versions)')
        plan = self.module_plan('commit-message-set', a, ['eSpace'])  # versions are listed for modules only
        plan.update(version=int(a.version), commitMessage=commit_text(a))
        row = self.version_row(plan)
        version_id = field(row, 'Version_Id', 'VersionId', 'ESpaceVersionId')
        if not re.fullmatch(r'[0-9]{1,10}', str(version_id or '')):
            raise ProtocolError('The version listing does not show this version\'s id')
        plan.update(versionId=int(version_id), currentCommitMessage=redact(field(row, 'CommitMessage')))
        return plan, {}

    def _send_commit_message_set(self, plan, state, receipt):
        self._send('soap', 'ChangeCommitMessage', {'eSpaceVersionId': plan['versionId'], 'newCommitMessage': plan['commitMessage']}, receipt)
        now = field(self.version_row(plan), 'CommitMessage')
        return {'state': 'confirmed' if now == plan['commitMessage'] else 'accepted-unverified'}

    # ---- upload and publish an extension (.xif), the package prepared and checked by sha256
    def _prepare_extension_publish(self, a, osp=None):
        file = Path(a.xif_file or '')
        if not file.is_absolute() or file.suffix.lower() != '.xif' or not file.is_file():
            raise ProtocolError('--xif-file must be an absolute, existing .xif file')
        size = file.stat().st_size
        if not 0 < size <= XIF_LIMIT:
            raise ProtocolError('The .xif must be nonempty and at most 256 MiB')
        plan = {'host': self.host, 'action': 'extension-publish', 'xif': str(file), 'xifSha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                'size': size, 'execute': False, 'note': 'Uploads and publishes exactly this package; its consumers keep the producer they were built with'}
        if a.commit_message is not None:
            plan['commitMessage'] = commit_text(a)
        if a.application or a.application_key:
            plan['applicationKey'], plan['application'] = self.application(a)
        return plan, {}

    def _send_extension_publish(self, plan, state, receipt):
        if hashlib.sha256(Path(plan['xif']).read_bytes()).hexdigest() != plan['xifSha256']:
            raise BridgeError('BAD_REQUEST', 'The extension package changed after it was prepared; nothing was sent', write=True)
        # The bridge reads the package itself from this absolute path (args.file), inside the Studio process.
        args = {'file': plan['xif'], **({'commitMessage': plan['commitMessage']} if 'commitMessage' in plan else {}),
                **({'applicationKey': plan['applicationKey']} if 'applicationKey' in plan else {})}
        result = self._send('soap', 'UploadAndPublishExtension', args, receipt)
        messages, version_id = field(result, 'messages', 'returnValue'), field(result, 'extensionVersionId')
        errors = failed(messages)
        if errors:
            return {'state': 'rejected', 'errors': errors, 'messages': redact(messages)}
        published = bool(version_id) and any(str(field(r, 'Version_Id', 'VersionId')) == str(version_id) for r in items(self.call('soap', 'ListExtensions', {})))
        return {'state': 'confirmed' if published else 'accepted-unverified', 'extensionId': field(result, 'extensionId'),
                'extensionVersionId': version_id, 'messages': redact(messages)}

    def observe(self, receipt):
        """Read-only reconciliation of an uncertain API write, from the plan its receipt kept."""
        plan, action = receipt.get('plan') or {}, receipt['identity']['action']
        if not plan:
            return False
        if action in ('module-delete', 'extension-delete'):
            listing = 'ListEspaces' if action == 'module-delete' else 'ListExtensions'
            return not any(module_key(r) == plan['moduleKey'] for r in items(self.call('soap', listing, {})))
        if action == 'application-database-set':
            now = self.call('server-api', 'GetDatabaseByApplicationKey', {'applicationKey': plan['applicationKey']})
            return str(field(now, 'Id', 'DatabaseId', 'Key')) == plan['databaseId']
        if action == 'application-delete':
            return self.application_gone(plan['applicationKey'])
        if action in ('module-move', 'module-add-to-application'):
            now = self.module_application(plan)
            return bool(now) and str(now).casefold() == str(plan.get('toApplicationKey') or plan.get('applicationKey')).casefold()
        if action == 'commit-message-set':
            return field(self.version_row(plan), 'CommitMessage') == plan['commitMessage']
        if action == 'extension-publish':
            raise ProtocolError('An uncertain extension publish is reconciled by reading the extension versions (extensions), never by a new upload')
        raise ProtocolError('This write is a started job; follow its status read (solution-publish-status, apply-settings-status)')
