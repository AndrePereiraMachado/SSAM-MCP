"""Worker ownership and startup lock. Process creation identity prevents killing a reused PID."""
from __future__ import annotations
import contextlib
import ctypes
import json
import os
import pathlib
import signal
import subprocess
import time


def birth(pid: int) -> str | None:
    if os.name != "nt":
        try:
            return pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        except OSError:
            return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_uint64)] * 4
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        values = [ctypes.c_uint64() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *[ctypes.byref(v) for v in values]):
            return None
        return str(values[0].value) if values[1].value == 0 else None
    finally:
        kernel.CloseHandle(handle)


def terminate_known(pid: int, expected_birth: str) -> bool:
    if os.name != "nt":
        if birth(pid) != expected_birth:
            return False
        os.kill(pid, signal.SIGTERM)
        return True
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_uint64)] * 4
    kernel.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x1000 | 1, False, pid)
    if not handle:
        return False
    try:
        values = [ctypes.c_uint64() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *[ctypes.byref(v) for v in values]) or str(values[0].value) != expected_birth:
            return False
        return bool(kernel.TerminateProcess(handle, 1))
    finally:
        kernel.CloseHandle(handle)


def remember(local: pathlib.Path, port: int, status: dict) -> None:
    if status.get("protocol") != "anvil-worker-1":
        return
    pid = int(status["pid"])
    stamp = birth(pid)
    if stamp is None:
        return
    local.mkdir(parents=True, exist_ok=True)
    path = local / f"worker-{port}.json"
    temporary = local / f"worker-{port}-{os.getpid()}.tmp"
    temporary.write_text(json.dumps({"pid": pid, "birth": stamp, "instanceId": status["instanceId"]}))
    os.replace(temporary, path)


def recover_unresponsive(local: pathlib.Path, port: int) -> bool:
    path = local / f"worker-{port}.json"
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        return False
    return terminate_known(int(state["pid"]), state["birth"])


@contextlib.contextmanager
def startup_lock(local: pathlib.Path, port: int, wait: float = 25):
    local.mkdir(parents=True, exist_ok=True)
    path = local / f"worker-{port}.lock"
    token = {"pid": os.getpid(), "birth": birth(os.getpid()), "created": time.time()}
    deadline = time.monotonic() + wait
    while True:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(token, stream)
            break
        except FileExistsError:
            try:
                owner = json.loads(path.read_text())
                if owner.get("birth") and birth(int(owner["pid"])) != owner["birth"]:
                    path.unlink(missing_ok=True)
                    continue
            except (OSError, ValueError, KeyError):
                # The owner may still be filling in the just-created file.
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError(f"worker startup lock did not clear: {path}")
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            if json.loads(path.read_text()) == token:
                path.unlink()
        except (OSError, ValueError):
            pass


def launch(cli: pathlib.Path, local: pathlib.Path, port: int, cwd: pathlib.Path, env: dict) -> subprocess.Popen:
    # The worker writes its main log as worker-PORT-PID.log. This captures startup failures only.
    with (local / f"worker-{port}-startup.log").open("ab") as stream:
        options = {"creationflags": 0x00000008 | 0x00000200 | 0x08000000} if os.name == "nt" else {"start_new_session": True}
        return subprocess.Popen(["dotnet", str(cli), "serve", "--port", str(port), "--log-dir", str(local)],
            stdout=stream, stderr=stream, stdin=subprocess.DEVNULL, cwd=str(cwd), env=env, close_fds=True, **options)
