"""Worker pool base affinity: an `apply` goes first to the free worker whose ping reports a spare of its base.

Pure tests: no worker process is started. `estado` is replaced by fixed ping lines and the reservation directory is
redirected to a temporary folder, as in test_worker_pool_claim.py.
"""
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import worker_pool  # noqa: E402

ESTADO = worker_pool.estado
SHA = "497c8bda97d47b18" + "0" * 48


def line(port, served=0, bases=(), warming=(), busy=False):
    return {"porta": port, "de_pe": True, "ocupado": busy, "na_fila": 0, "servidos": served, "dono": None,
            "bases": list(bases), "a_aquecer": list(warming)}


class WorkerPoolAffinityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.original = dict(worker_pool.FAIXAS["o11"])
        worker_pool.FAIXAS["o11"]["local"] = pathlib.Path(self.temp.name)
        self.addCleanup(lambda: worker_pool.FAIXAS.__setitem__("o11", self.original))
        original_estado = worker_pool.estado
        self.addCleanup(lambda: setattr(worker_pool, "estado", original_estado))

    def pick(self, lines, base):
        worker_pool.estado = lambda nome, n=None: lines
        port, claim = worker_pool.reservar_livre("o11", espera=1, base=base)
        worker_pool._liberar(claim)
        return port

    def test_a_free_worker_holding_the_base_wins_over_a_less_busy_one(self):
        lines = [line(15517, served=0), line(15617, served=9, bases=[SHA[:16]])]
        self.assertEqual(self.pick(lines, SHA), 15617)

    def test_a_ready_spare_wins_over_one_being_prepared_and_a_busy_holder_is_skipped(self):
        lines = [line(15517, warming=[SHA[:16]], served=5), line(15617, bases=[SHA[:16]], served=9), line(15717)]
        self.assertEqual(self.pick(lines, SHA), 15617)
        lines[1]["ocupado"] = True
        self.assertEqual(self.pick(lines, SHA), 15517)

    def test_without_affinity_the_least_busy_free_worker_is_chosen_as_before(self):
        lines = [line(15517, served=4, bases=["ffffffffffffffff"]), line(15617, served=1)]
        self.assertEqual(self.pick(lines, SHA), 15617)
        self.assertEqual(self.pick(lines, None), 15617)

    def test_the_base_sha_comes_from_base_or_from_the_jobs_fixture(self):
        repo = pathlib.Path(self.temp.name) / "repo"
        (repo / "tests" / "fixtures").mkdir(parents=True)
        (repo / "tests" / "jobs").mkdir()
        (repo / "MANIFESTO.md").write_text("", encoding="utf-8")
        fixture = repo / "tests" / "fixtures" / "base.oml"
        fixture.write_bytes(b"oml bytes")
        expected = hashlib.sha256(b"oml bytes").hexdigest()
        job = repo / "tests" / "jobs" / "j.json"
        job.write_text(json.dumps({"base": "tests/fixtures/base.oml", "ops": []}), encoding="utf-8")
        self.assertEqual(worker_pool.base_sha(["apply", "--job", job, "--out", "x.oml"]), expected)
        self.assertEqual(worker_pool.base_sha(["apply", "--job", job, "--base", fixture]), expected)
        job.write_text(json.dumps({"base": "job:other", "ops": []}), encoding="utf-8")
        self.assertIsNone(worker_pool.base_sha(["apply", "--job", job]))
        outside = pathlib.Path(self.temp.name) / "loose.oml"
        outside.write_bytes(b"x")
        job.write_text(json.dumps({"base": str(outside), "ops": []}), encoding="utf-8")
        self.assertIsNone(worker_pool.base_sha(["apply", "--job", job]))   # outside tests/fixtures: the kernel refuses it too
        self.assertIsNone(worker_pool.base_sha(["inspect", "--oml", fixture]))

    def test_ping_lines_carry_the_worker_bases(self):
        client = self.original["cliente"]
        original_ping = client.ping
        client.ping = lambda port: {"busy": False, "queued": 0, "served": 1, "pid": 1,
                                    "baseCache": {"keys": [SHA[:16]], "warming": ["abc"]}}
        self.addCleanup(lambda: setattr(client, "ping", original_ping))
        rows = ESTADO("o11", 1)
        self.assertEqual(rows[0]["bases"], [SHA[:16]])
        self.assertEqual(rows[0]["a_aquecer"], ["abc"])
        client.ping = lambda port: {"busy": False}      # a worker without the cache (older kernel, or switched off)
        self.assertEqual(ESTADO("o11", 1)[0]["bases"], [])


if __name__ == "__main__":
    unittest.main()
