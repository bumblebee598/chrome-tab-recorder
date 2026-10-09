from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth_routes import router as auth_router
from app.api.deps import get_settings
from app.api.jobs_routes import router as jobs_router
from app.api.webhook_routes import router as webhook_router

app = FastAPI(title="Tab Recorder API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"chrome-extension://{get_settings().extension_id}"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(jobs_router)
app.include_router(webhook_router)


# /healthz stays as a local alias only: Cloud Run's frontend reserves some
# paths ending in "z" and answers them with its own 404 before the container.
@app.get("/health")
@app.get("/healthz", include_in_schema=False)
def health() -> dict[str, str]:
    return {"status": "ok", "service": "api"}
