import base64
import pathlib
import sys
import tempfile
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import configure_app_profile as setup


class ProjectBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.home = self.root / 'codex'
        self.home.mkdir()
        self.config = self.home / 'config.toml'
        self.config.write_text('[mcp_servers.some_other_tool]\nenabled = true\n')
        self.original = self.config.read_bytes()
        self.workspace = self.root / "app's project"
        self.workspace.mkdir()
        self.cli = self.root / 'anvil.dll'
        self.cli.write_bytes(b'fixture')
        self.python = pathlib.Path(sys.executable).resolve()
        self.output = self.workspace / '.codex' / 'config.toml'

    def render(self):
        return setup.render(self.home, self.cli, self.python, self.workspace)

    def install(self):
        setup.write_managed(self.output, self.render())

    def check(self):
        return setup.check(self.output, self.home, self.cli, self.python, self.workspace)

    def test_project_mcp_and_hooks_use_the_same_explicit_workspace(self):
        doc = tomllib.loads(self.render())
        args = doc['mcp_servers']['ssam_hybrid']['args']
        self.assertEqual(self.workspace.resolve().as_posix(), args[args.index('--workspace') + 1])
        self.assertFalse(doc['mcp_servers']['some_other_tool']['enabled'])
        self.assertFalse(doc['features']['shell_tool'])
        self.assertFalse(doc['features']['multi_agent'])
        self.assertNotIn('profile', doc)
        for event in ('UserPromptSubmit', 'PreToolUse'):
            command = doc['hooks'][event][0]['hooks'][0]['command']
            body = base64.b64decode(command.split()[-1]).decode('utf-16-le')
            self.assertIn("--workspace '" + str(self.workspace.resolve()).replace("'", "''") + "' --hook;", body)
        self.assertEqual(self.original, self.config.read_bytes())

    def test_configured_never_means_client_active(self):
        self.install()
        result = self.check()
        self.assertTrue(result['configured'])
        self.assertIsNone(result['active'])
        self.assertEqual('awaiting-client-proof', result['state'])
        self.assertTrue(result['requiresHookTrust'])
        self.assertFalse(result['capabilities']['createApplication'])
        self.assertEqual(self.original, self.config.read_bytes())

    def test_managed_install_is_idempotent_but_unmanaged_file_is_preserved(self):
        self.install()
        before = self.output.read_bytes()
        self.install()
        self.assertEqual(before, self.output.read_bytes())
        self.output.write_text('unmanaged = true\n')
        with self.assertRaisesRegex(ValueError, 'not managed'):
            self.install()
        self.assertEqual('unmanaged = true\n', self.output.read_text())

    def test_missing_or_edited_config_and_controller_are_not_ready(self):
        self.assertFalse(self.check()['configured'])
        self.assertFalse(self.output.exists())
        self.install()
        self.output.write_text(self.output.read_text().replace('required = true', 'required = false'))
        self.assertFalse(self.check()['configured'])
        self.install()
        self.cli.unlink()
        self.assertFalse(self.check()['configured'])

    def test_global_encoded_hybrid_hook_is_flagged_without_changing_it(self):
        doc = tomllib.loads(self.render())
        command = doc['hooks']['UserPromptSubmit'][0]['hooks'][0]['command']
        import json
        self.config.write_text(self.config.read_text() + '\n[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = ' + json.dumps(command) + '\n')
        original = self.config.read_bytes()
        self.install()
        self.assertFalse(self.check()['configured'])
        self.assertTrue(any('duplicate' in issue for issue in self.check()['problems']))
        self.assertEqual(original, self.config.read_bytes())

    def test_review_copy_does_not_claim_project_is_configured(self):
        review = self.root / 'review.toml'
        setup.write_managed(review, self.render())
        result = setup.check(review, self.home, self.cli, self.python, self.workspace)
        self.assertTrue(result['reviewPrepared'])
        self.assertFalse(result['configured'])
        self.assertEqual('review-copy', result['state'])
        self.assertFalse(self.output.exists())

    def test_cli_refuses_global_output_even_if_absent_or_managed(self):
        from unittest.mock import patch
        for content in (None, setup.MARKER + '\n'):
            if content is None:
                self.config.unlink(missing_ok=True)
            else:
                self.config.write_text(content)
            before = self.config.read_bytes() if self.config.exists() else None
            argv = ['configure', '--codex-home', str(self.home), '--cli', str(self.cli), '--out', str(self.config)]
            with patch.object(sys, 'argv', argv), self.assertRaisesRegex(ValueError, 'global Codex'):
                setup.main()
            self.assertEqual(before, self.config.read_bytes() if self.config.exists() else None)

    def test_optional_legacy_profile_has_no_workspace_or_global_write(self):
        for legacy in (False, True):
            self.config.write_bytes(self.original)
            if legacy:
                self.config.write_text('sandbox_mode = "workspace-write"\n' + self.original.decode())
            original = self.config.read_bytes()
            doc = tomllib.loads(setup.render(self.home, self.cli, self.python))
            self.assertNotIn('--workspace', doc['mcp_servers']['ssam_hybrid']['args'])
            if legacy:
                self.assertEqual('read-only', doc['sandbox_mode'])
            self.assertEqual(original, self.config.read_bytes())


if __name__ == '__main__':
    unittest.main()
