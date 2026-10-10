import os
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import anvil_cli
import lanes


class RuntimeConnectionTests(unittest.TestCase):
    def test_selected_installation_is_used_by_lane(self):
        directory = str(pathlib.Path("normal-studio").resolve())
        # Without a connection record of this checkout (the record of ssam_connect comes first, as in the facade).
        with patch.dict(os.environ, {"ANVIL_STUDIO_DIR": directory}), patch.object(lanes, "connection", return_value=None):
            self.assertEqual(lanes.lane("ss4").studio_dir, pathlib.Path(directory))

    def test_the_connection_record_selects_the_studio_before_the_environment(self):
        record = {"studioDir": str(pathlib.Path("selected-studio").resolve()), "authorityDir": str(pathlib.Path("auth").resolve()), "port": 4516}
        with patch.dict(os.environ, {"ANVIL_STUDIO_DIR": str(pathlib.Path("normal-studio").resolve())}), \
             patch.object(lanes, "connection", return_value=record):
            lane = lanes.lane("ss4")
            self.assertEqual(lane.studio_dir, pathlib.Path(record["studioDir"]))
            self.assertEqual(lane.selection, "connection")
            self.assertEqual(lane.env()["ANVIL_STUDIO_DIR"], record["studioDir"])
            self.assertEqual(lane.env()["ANVIL_AUTHORITY_DIR"], record["authorityDir"])

    def test_worker_from_another_installation_is_not_used_or_restarted(self):
        with patch.dict(os.environ, {"ANVIL_STUDIO_DIR": str(pathlib.Path("normal-studio").resolve())}), \
             patch.object(anvil_cli, "avisar_se_o_deploy_esta_velho"), \
             patch.object(anvil_cli, "ping", return_value={"studio": str(pathlib.Path("clone").resolve()), "busy": True}), \
             patch.object(anvil_cli, "_request") as request:
            self.assertIsNone(anvil_cli.ensure_worker())
            request.assert_not_called()

    def test_worker_from_selected_installation_is_reused(self):
        directory = str(pathlib.Path("normal-studio").resolve())
        status = {"studio": directory, "busy": False}
        with patch.dict(os.environ, {"ANVIL_STUDIO_DIR": directory}), \
             patch.object(anvil_cli, "avisar_se_o_deploy_esta_velho"), \
             patch.object(anvil_cli, "ping", return_value=status), \
             patch.object(anvil_cli, "_kernel_mais_novo_que", return_value=False):
            self.assertEqual(anvil_cli.ensure_worker(), status)


if __name__ == "__main__":
    unittest.main()
