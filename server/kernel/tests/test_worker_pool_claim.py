"""Worker pool reservation: two dispatchers never take the same free worker while another one is free.

Pure file-level tests: no worker process is started. The reservation directory is redirected to a temporary
folder by replacing the lane's local path in the pool table.
"""
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import worker_pool  # noqa: E402


class WorkerPoolClaimTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.original = dict(worker_pool.FAIXAS["o11"])
        worker_pool.FAIXAS["o11"]["local"] = pathlib.Path(self.temp.name)
        self.addCleanup(lambda: worker_pool.FAIXAS.__setitem__("o11", self.original))

    def test_a_claimed_worker_is_refused_to_a_second_dispatcher_until_released(self):
        first = worker_pool._reservar("o11", 15517)
        self.assertIsNotNone(first)
        self.assertIsNone(worker_pool._reservar("o11", 15517))
        self.assertIsNotNone(worker_pool._reservar("o11", 15617))
        worker_pool._liberar(first)
        self.assertIsNotNone(worker_pool._reservar("o11", 15517))

    def test_a_claim_left_by_a_dead_process_is_discarded(self):
        path = pathlib.Path(self.temp.name) / "pool" / "15517" / "claim.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"pid": 999999, "birth": "1", "thread": 1, "created": 0}), encoding="utf-8")
        self.assertIsNotNone(worker_pool._reservar("o11", 15517))

    def test_releasing_never_removes_another_dispatchers_claim(self):
        first = worker_pool._reservar("o11", 15517)
        worker_pool._liberar(first)
        second = worker_pool._reservar("o11", 15517)
        worker_pool._liberar(first)  # stale handle: must not delete the second claim
        self.assertIsNone(worker_pool._reservar("o11", 15517))
        worker_pool._liberar(second)

    def test_concurrent_dispatchers_spread_over_free_workers(self):
        free = [{"porta": p, "de_pe": True, "ocupado": False, "na_fila": 0, "servidos": 0, "dono": None}
                for p in (15517, 15617)]
        original_estado = worker_pool.estado
        worker_pool.estado = lambda nome, n=None: free
        self.addCleanup(lambda: setattr(worker_pool, "estado", original_estado))
        chosen, barrier = [], threading.Barrier(2)

        def dispatch():
            barrier.wait()
            chosen.append(worker_pool.reservar_livre("o11", espera=1))

        threads = [threading.Thread(target=dispatch) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(port for port, _ in chosen), [15517, 15617])
        self.assertTrue(all(claim is not None for _, claim in chosen))
        for _, claim in chosen:
            worker_pool._liberar(claim)


if __name__ == "__main__":
    unittest.main()
