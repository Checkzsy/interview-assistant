"""Standalone backend entrypoint for packaged desktop builds."""
from __future__ import annotations

import os

import uvicorn

from main import app


def main() -> None:
    port = int(os.environ.get("PORT", "18080"))
    access_log = os.environ.get("IA_ACCESS_LOG", "1").strip().lower() not in ("0", "false", "no")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
        reload=False,
        access_log=access_log,
    )


if __name__ == "__main__":
    main()
