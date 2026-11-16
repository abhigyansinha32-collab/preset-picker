"""Entry point: `python main.py`, and the script PyInstaller bundles into the app."""
import os
import sys
from pathlib import Path


def unblock_bundle():
    """Remove Windows' "downloaded from the internet" mark from the app's own files.

    Explorer copies that mark onto everything it unzips, and .NET Framework refuses to load
    a marked Python.Runtime.dll, so the window could never open.
    """
    if os.environ.get("PRESETPICKER_SKIP_UNBLOCK"):
        return
    for f in Path(sys._MEIPASS).rglob("*"):
        if f.suffix.lower() in (".dll", ".pyd", ".exe"):
            try:
                os.remove(f"{f}:Zone.Identifier")
            except OSError:
                pass


def smoke_test(result_file):
    """CI only: prove the frozen app's window backend loads, record the result and exit."""
    try:
        if sys.platform == "win32":
            import webview.platforms.winforms  # noqa: F401  loads .NET + pythonnet
        else:
            import webview  # noqa: F401
        Path(result_file).write_text("OK")
        sys.exit(0)
    except Exception as e:  # noqa: BLE001
        Path(result_file).write_text(f"FAIL {e!r}")
        sys.exit(1)


if __name__ == "__main__":
    if sys.platform == "win32" and getattr(sys, "frozen", False):
        unblock_bundle()
    if os.environ.get("PRESETPICKER_SMOKE"):
        smoke_test(os.environ["PRESETPICKER_SMOKE"])
    from presetpicker.app import main
    main()
