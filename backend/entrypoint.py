"""Standalone backend entrypoint for packaged desktop builds."""
from __future__ import annotations

import os


def main() -> None:
    from core import server_runner

    port = int(os.environ.get("PORT", "18080"))
    access_log = os.environ.get("IA_ACCESS_LOG", "1").strip().lower() not in ("0", "false", "no")
    server_runner.run_managed(
        host="127.0.0.1",
        port=port,
        access_log=access_log,
    )


if __name__ == "__main__":
    main()
