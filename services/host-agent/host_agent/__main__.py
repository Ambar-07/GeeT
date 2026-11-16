import uvicorn

from .config import get_config

if __name__ == "__main__":
    cfg = get_config()
    uvicorn.run("host_agent.main:app", host=cfg["bind"], port=cfg["port"], reload=False)
