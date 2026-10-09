from fastapi import FastAPI

from app.worker.task_routes import router as tasks_router

app = FastAPI(title="Tab Recorder Worker")

app.include_router(tasks_router)


# /healthz stays as a local alias only: Cloud Run's frontend reserves some
# paths ending in "z" and answers them with its own 404 before the container.
@app.get("/health")
@app.get("/healthz", include_in_schema=False)
def health() -> dict[str, str]:
    return {"status": "ok", "service": "worker"}
