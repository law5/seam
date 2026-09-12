from __future__ import annotations

import uvicorn

from .config import app_host, app_port


def main() -> None:
    uvicorn.run(
        "podcast_prep.server:app",
        host=app_host(),
        port=app_port(),
        reload=False,
    )
