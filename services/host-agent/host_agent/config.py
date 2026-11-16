import os
from pathlib import Path


def get_config() -> dict:
    data_dir = Path(os.getenv("HOST_DATA_DIR", "./data")).resolve()
    cache_dir = Path(os.getenv("HOST_CACHE_DIR", "./cache")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return {
        "bind": os.getenv("HOST_BIND", "127.0.0.1"),
        "port": int(os.getenv("HOST_PORT", "8765")),
        "data_dir": data_dir,
        "cache_dir": cache_dir,
        "db_path": data_dir / "host_agent.sqlite3",
        "app_origin": os.getenv("APP_ORIGIN", "http://localhost:5173"),
    }
