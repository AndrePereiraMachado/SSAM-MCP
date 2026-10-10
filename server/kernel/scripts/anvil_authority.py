"""Shared authority location for the trusted maintenance clients; never search for or generate credentials."""
import os
import pathlib


def key_path() -> pathlib.Path:
    configured = os.environ.get("ANVIL_AUTHORITY_DIR")
    if configured is None and os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                configured = winreg.QueryValueEx(key, "ANVIL_AUTHORITY_DIR")[0]
        except FileNotFoundError:
            pass
    if configured and configured.strip():
        directory = pathlib.Path(configured)
        if not directory.is_absolute():
            raise ValueError("ANVIL_AUTHORITY_DIR must be an absolute authority directory")
    else:
        directory = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local")) / "Anvil" / "authority"
    return directory / "bridge.key"
