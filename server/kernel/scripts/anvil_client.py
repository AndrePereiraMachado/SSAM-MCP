"""Cliente minimo do bridge Anvil: JSON-lines sobre TCP. Sem dependencias fora da biblioteca padrao."""
from __future__ import annotations

import json
import os
import pathlib
import socket
from typing import Any


class AnvilBridge:
    def __init__(self, port: int | None = None, timeout: float = 120.0) -> None:
        if port is None:
            import pathlib, sys
            sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
            import lanes
            port = lanes.lane().bridge
        self.port, self.timeout = port, timeout
        self._sock: socket.socket | None = None
        self._buf = b""

    def _connect(self) -> None:
        self._sock = socket.create_connection(("127.0.0.1", self.port), timeout=self.timeout)

    def call(self, method: str, **params: Any) -> dict:
        if self._sock is None:
            self._connect()
        assert self._sock is not None
        from anvil_authority import key_path
        credential_file = key_path()
        try:
            credential = credential_file.read_text(encoding="ascii").strip()
        except (FileNotFoundError, PermissionError):
            credential = None  # Legacy bridges may allow reads; authenticated bridges still reject this request.
        self._sock.sendall((json.dumps({"method": method, "params": params, "authorization": credential}) + "\n").encode("utf-8"))
        while b"\n" not in self._buf:
            chunk = self._sock.recv(1 << 18)
            if not chunk:
                raise ConnectionError("bridge closed the connection")
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        return json.loads(line.decode("utf-8"))

    def ok(self, method: str, **params: Any) -> Any:
        r = self.call(method, **params)
        if not r.get("success"):
            raise RuntimeError(f"{method}: {r.get('error')}")
        return r.get("data")

    def close(self) -> None:
        if self._sock is not None:
            self._sock.close()
            self._sock = None
