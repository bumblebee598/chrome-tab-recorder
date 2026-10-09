from datetime import timedelta
from typing import Protocol


class AudioStorage(Protocol):
    async def upload_file(self, local_path: str, blob_name: str, content_type: str) -> str:
        """Upload and return the gs:// URI."""
        ...

    async def signed_url(self, blob_name: str, hours: int = 24) -> str: ...


class GcsAudioStorage:
    def __init__(self, bucket: str):
        from google.cloud import storage

        self._bucket_name = bucket
        self._client = storage.Client()

    async def upload_file(self, local_path: str, blob_name: str, content_type: str) -> str:
        import asyncio

        def run() -> None:
            bucket = self._client.bucket(self._bucket_name)
            bucket.blob(blob_name).upload_from_filename(local_path, content_type=content_type)

        await asyncio.to_thread(run)
        return f"gs://{self._bucket_name}/{blob_name}"

    async def signed_url(self, blob_name: str, hours: int = 24) -> str:
        import asyncio

        def run() -> str:
            # Cloud Run SA credentials are token-only (no private key), so V4
            # signing must go through the IAM signBlob API — hence the
            # service_account_email + access_token pair and the
            # roles/iam.serviceAccountTokenCreator grant in setup.sh.
            import google.auth
            from google.auth.transport import requests as auth_requests

            credentials, _ = google.auth.default()
            credentials.refresh(auth_requests.Request())
            bucket = self._client.bucket(self._bucket_name)
            return bucket.blob(blob_name).generate_signed_url(
                version="v4",
                expiration=timedelta(hours=hours),
                method="GET",
                service_account_email=getattr(credentials, "service_account_email", None),
                access_token=credentials.token,
            )

        return await asyncio.to_thread(run)
