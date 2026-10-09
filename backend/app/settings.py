from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    google_cloud_project: str = "demo-tab-recorder"
    extension_id: str = "nfphhdblmoifbnbieoodhchadpcgnfjd"
    gcp_region: str = "us-central1"
    gcs_bucket: str = ""
    tasks_location: str = "local"

    api_base_url: str = "http://localhost:8000"
    worker_base_url: str = "http://localhost:8081"

    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    assemblyai_api_key: str = ""
    session_jwt_secret: str = ""
    webhook_secret: str = ""
    token_fernet_key: str = ""

    email_provider: str = "gmail"
    resend_api_key: str = ""

    cloud_tasks_emulator_host: str = ""
    # Fault injection for demos/tests, e.g. "extract:2" fails the first two
    # extract deliveries per process with a 503 (exercises queue retries)
    fail_stage: str = ""
    tasks_invoker_service_account: str = ""
    webhook_header_name: str = "X-Tabrec-Webhook-Secret"
