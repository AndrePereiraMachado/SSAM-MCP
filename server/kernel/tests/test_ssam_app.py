import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import ssam_app


class AppProtocolTests(unittest.TestCase):
    def test_csharp_source_is_forwarded_as_authored_files(self):
        source = {'files': {'Domain.cs': 'public record Item(int Quantity);', 'Rules.cs': 'public static class Rules { public static int Double(int x)=>x*2; }'}}
        server = ssam_app.Server(pathlib.Path('unused'))
        request = {'task_id': 'task', 'module': 'Probe', 'lane': 'ss4', 'environment': 'fixture.test', 'csharpSource': source}
        with patch.object(ssam_app, 'host', side_effect=[{'authorized': True}, {'accepted': True}]) as host:
            self.assertTrue(server.call('propose', request, 1)['accepted'])
            self.assertEqual(source, host.call_args.args[2]['proposal']['csharpSource'])
            self.assertNotIn('logic', host.call_args.args[2]['proposal'])
            self.assertNotIn('data', host.call_args.args[2]['proposal'])

    def test_ui_bundle_is_forwarded_with_all_authored_files(self):
        source = {'entry': 'main.html', 'files': {'main.html': '<component name="Page" kind="screen"></component>', 'card.html': '<component name="Card"></component>'}}
        server = ssam_app.Server(pathlib.Path('unused'))
        request = {'task_id': 'task', 'module': 'Probe', 'lane': 'ss5', 'environment': 'fixture.test', 'uiSource': source}
        with patch.object(ssam_app, 'host', side_effect=[{'authorized': True}, {'accepted': True}]) as host:
            self.assertTrue(server.call('propose', request, 1)['accepted'])
            self.assertEqual(source, host.call_args.args[2]['proposal']['uiSource'])

    def test_ui_source_is_forwarded_without_a_second_binding_manifest(self):
        source = '<component name="Page" kind="screen"><p>Hello</p></component>'
        server = ssam_app.Server(pathlib.Path('unused'))
        request = {'task_id': 'task', 'module': 'Probe', 'lane': 'ss5', 'environment': 'fixture.test', 'uiSource': source}
        with patch.object(ssam_app, 'host', side_effect=[{'authorized': True}, {'accepted': True}]) as host:
            self.assertTrue(server.call('propose', request, 1)['accepted'])
            self.assertEqual(source, host.call_args.args[2]['proposal']['uiSource'])
            self.assertNotIn('bindings', host.call_args.args[2]['proposal'])

    def test_only_four_controlled_tools_are_exposed(self):
        definitions = ssam_app.schemas()
        self.assertEqual({'context', 'propose', 'continue', 'status'}, {item['name'] for item in definitions})
        self.assertTrue(all(not item['inputSchema']['additionalProperties'] for item in definitions))
        self.assertTrue(all('task_id' in item['inputSchema']['required'] for item in definitions))

    def test_missing_host_permission_fails_before_dispatch(self):
        server = ssam_app.Server(pathlib.Path('unused'))
        with patch.object(ssam_app, 'host', side_effect=RuntimeError('no host grant')) as host:
            with self.assertRaisesRegex(RuntimeError, 'no host grant'):
                server.call('continue', {'task_id': 'task'}, 1)
            self.assertEqual('authorize', host.call_args.args[1])
            self.assertEqual(1, host.call_count)

    def test_model_cannot_supply_an_approval_flag_or_raw_job(self):
        server = ssam_app.Server(pathlib.Path('unused'))
        with patch.object(ssam_app, 'host') as host:
            for arguments in [{'task_id': 'task', 'approved': True}, {'task_id': 'task', 'job': 'arbitrary.json'}]:
                with self.assertRaises(ValueError):
                    server.call('continue', arguments, 1)
            host.assert_not_called()

    def test_decline_does_not_accept_changed_contract(self):
        server = ssam_app.Server(pathlib.Path('unused'))
        answers = [{'authorized': True}, {'accepted': False, 'proposal': {'data': {}}, 'contractHash': 'hash'}]
        with patch.object(ssam_app, 'host', side_effect=answers) as host, patch.object(server, 'accept_contract', return_value=False):
            result = server.call('propose', {'task_id': 'task', 'module': 'Probe', 'lane': 'ss5', 'environment': 'fixture.test', 'data': {}}, 1)
            self.assertFalse(result['accepted'])
            self.assertEqual(2, host.call_count)

    def test_initial_contract_does_not_request_redundant_acceptance(self):
        server = ssam_app.Server(pathlib.Path('unused'))
        with patch.object(ssam_app, 'host', side_effect=[{'authorized': True}, {'accepted': True}]), patch.object(server, 'accept_contract') as acceptance:
            result = server.call('propose', {'task_id': 'task', 'module': 'Probe', 'lane': 'ss5', 'environment': 'fixture.test', 'data': {}}, 1)
            self.assertTrue(result['accepted']); acceptance.assert_not_called()

    def test_connected_lane_is_ready_without_an_open_module(self):
        with patch('anvil_client.AnvilBridge') as bridge:
            bridge.return_value.ok.side_effect = lambda method: {
                'bridge_manifest': {'protocolVersion': 2},
                'list_open_modules': {'environments': ['fixture.test'], 'modules': []},
            }[method]
            result = ssam_app.Server.lanes()
            self.assertTrue(all(lane['ready'] for lane in result))
            self.assertTrue(all(lane['environment'] == 'fixture.test' and lane['activeModule'] is None for lane in result))
            self.assertNotIn('get_active_module', [call.args[0] for call in bridge.return_value.ok.call_args_list])

    def test_disconnected_lane_requires_login(self):
        with patch('anvil_client.AnvilBridge') as bridge:
            bridge.return_value.ok.side_effect = lambda method: {
                'bridge_manifest': {'protocolVersion': 2},
                'list_open_modules': {'environments': [], 'modules': []},
            }[method]
            self.assertTrue(all(not lane['ready'] for lane in ssam_app.Server.lanes()))

    def test_hook_error_denies_tool(self):
        stdin, stdout = io.StringIO(json.dumps({'hook_event_name': 'PreToolUse'})), io.StringIO()
        with patch.object(ssam_app.sys, 'stdin', stdin), patch.object(ssam_app.sys, 'stdout', stdout), patch.object(ssam_app, 'host', side_effect=RuntimeError('offline')):
            self.assertEqual(0, ssam_app.hook(pathlib.Path('unused')))
        self.assertEqual('deny', json.loads(stdout.getvalue())['hookSpecificOutput']['permissionDecision'])


    def test_workspace_is_trusted_launch_metadata_not_model_input(self):
        response = ssam_app.subprocess.CompletedProcess([], 0, stdout='{"ok":true,"data":{}}')
        payload = {'trustedWorkspace': 'forged', 'session_id': 'session'}
        with patch.object(ssam_app.subprocess, 'run', return_value=response) as run:
            ssam_app.host(pathlib.Path('unused'), 'capture', payload, ROOT)
            self.assertEqual(str(ROOT), json.loads(run.call_args.kwargs['input'])['trustedWorkspace'])
            ssam_app.host(pathlib.Path('unused'), 'capture', payload)
            self.assertNotIn('trustedWorkspace', json.loads(run.call_args.kwargs['input']))
        self.assertEqual('forged', payload['trustedWorkspace'])

    def test_scoped_model_cannot_override_workspace(self):
        server = ssam_app.Server(pathlib.Path('unused'), workspace=ROOT)
        with patch.object(ssam_app, 'host') as host:
            for key in ('workspace', 'trustedWorkspace'):
                with self.assertRaises(ValueError):
                    server.call('context', {'task_id': 'task', key: str(ROOT)}, 1)
            host.assert_not_called()
        self.assertTrue(all('trustedWorkspace' not in item['inputSchema']['properties'] for item in ssam_app.schemas()))

    def test_cached_mcp_requires_active_workspace_before_dispatch(self):
        server = ssam_app.Server(pathlib.Path('unused'), workspace=ROOT)
        with patch.object(ssam_app, 'host', side_effect=RuntimeError('workspace inactive')) as host, patch.object(server, 'lanes') as lanes:
            with self.assertRaisesRegex(RuntimeError, 'workspace inactive'):
                server.call('context', {'task_id': 'task'}, 1)
            host.assert_called_once_with(pathlib.Path('unused'), 'authorize', {'tool': 'context', 'arguments': {'task_id': 'task'}}, ROOT)
            lanes.assert_not_called()

    def test_outside_prompt_is_not_forwarded_or_announced_as_controlled(self):
        event = {'hook_event_name': 'UserPromptSubmit', 'session_id': 's', 'turn_id': 't',
                 'cwd': str(ROOT.parent), 'prompt': 'Private maintenance request'}
        stdin, stdout = io.StringIO(json.dumps(event)), io.StringIO()
        with patch.object(ssam_app.sys, 'stdin', stdin), patch.object(ssam_app.sys, 'stdout', stdout), patch.object(ssam_app, 'host', return_value={'captured': False, 'inScope': False}) as host:
            self.assertEqual(0, ssam_app.hook(pathlib.Path('unused'), ROOT))
            self.assertNotIn('prompt', host.call_args.args[2])
            self.assertEqual('s', host.call_args.args[2]['session_id'])
            self.assertEqual(ROOT, host.call_args.args[3])
        self.assertEqual('', stdout.getvalue())

    def test_outside_maintenance_tool_is_neutral_and_arguments_are_not_forwarded(self):
        event = {'hook_event_name': 'PreToolUse', 'session_id': 's', 'turn_id': 't',
                 'cwd': str(ROOT.parent), 'tool_name': 'Bash', 'tool_input': {'command': 'private'}}
        stdin, stdout = io.StringIO(json.dumps(event)), io.StringIO()
        with patch.object(ssam_app.sys, 'stdin', stdin), patch.object(ssam_app.sys, 'stdout', stdout), patch.object(ssam_app, 'host', return_value={'allowed': False, 'inScope': False}) as host:
            self.assertEqual(0, ssam_app.hook(pathlib.Path('unused'), ROOT))
            self.assertNotIn('tool_input', host.call_args.args[2])
        self.assertEqual('', stdout.getvalue())

    def test_outside_hybrid_tool_is_denied(self):
        event = {'hook_event_name': 'PreToolUse', 'session_id': 's', 'turn_id': 't',
                 'cwd': str(ROOT.parent), 'tool_name': 'mcp__ssam_hybrid__context', 'tool_input': {'task_id': 'task'}}
        stdin, stdout = io.StringIO(json.dumps(event)), io.StringIO()
        with patch.object(ssam_app.sys, 'stdin', stdin), patch.object(ssam_app.sys, 'stdout', stdout), patch.object(ssam_app, 'host', return_value={'allowed': False, 'inScope': False}):
            self.assertEqual(0, ssam_app.hook(pathlib.Path('unused'), ROOT))
        self.assertEqual('deny', json.loads(stdout.getvalue())['hookSpecificOutput']['permissionDecision'])

    def test_outside_host_error_does_not_block_or_capture_maintenance(self):
        for kind in ('UserPromptSubmit', 'PreToolUse'):
            event = {'hook_event_name': kind, 'cwd': str(ROOT.parent), 'tool_name': 'Bash', 'prompt': 'private'}
            stdin, stdout, stderr = io.StringIO(json.dumps(event)), io.StringIO(), io.StringIO()
            with self.subTest(kind=kind), patch.object(ssam_app.sys, 'stdin', stdin), patch.object(ssam_app.sys, 'stdout', stdout), patch.object(ssam_app.sys, 'stderr', stderr), patch.object(ssam_app, 'host', side_effect=RuntimeError('offline')):
                self.assertEqual(0, ssam_app.hook(pathlib.Path('unused'), ROOT))
            self.assertEqual('', stdout.getvalue())
            self.assertEqual('', stderr.getvalue())

    def test_real_capture_supplies_task_id_automatically(self):
        event = {'hook_event_name': 'UserPromptSubmit', 'session_id': 's', 'turn_id': 't', 'cwd': str(ROOT), 'prompt': 'Create Entry'}
        stdin, stdout = io.StringIO(json.dumps(event)), io.StringIO()
        with patch.object(ssam_app.sys, 'stdin', stdin), patch.object(ssam_app.sys, 'stdout', stdout), patch.object(ssam_app, 'host', return_value={'captured': True, 'taskId': 'host-task'}) as host:
            self.assertEqual(0, ssam_app.hook(pathlib.Path('unused'), ROOT))
            self.assertEqual(event, host.call_args.args[2])
        self.assertIn('host-task', json.loads(stdout.getvalue())['hookSpecificOutput']['additionalContext'])

    def test_main_passes_explicit_workspace_to_mcp(self):
        with patch.object(ssam_app.sys, 'argv', ['ssam_app.py', '--cli', 'unused', '--workspace', str(ROOT)]), patch.object(ssam_app, 'Server') as server:
            server.return_value.serve.return_value = 0
            self.assertEqual(0, ssam_app.main())
            server.assert_called_once_with(pathlib.Path('unused'), workspace=ROOT)


if __name__ == '__main__':
    unittest.main()
