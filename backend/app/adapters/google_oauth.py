import httpx

TOKEN_URL = "https://oauth2.googleapis.com/token"


class OAuthError(Exception):
    pass


class InvalidGrantError(OAuthError):
    """Refresh token revoked/expired: the user must sign in again."""


class GoogleOAuthClient:
    def __init__(self, client_id: str, client_secret: str):
        self.client_id = client_id
        self.client_secret = client_secret

    async def exchange_code(self, code: str, code_verifier: str, redirect_uri: str) -> dict:
        return await self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": code_verifier,
                "redirect_uri": redirect_uri,
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        )

    async def refresh_access_token(self, refresh_token: str) -> dict:
        return await self._token_request(
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }
        )

    async def _token_request(self, data: dict) -> dict:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(TOKEN_URL, data=data)
        if response.status_code == 200:
            return response.json()
        try:
            error = response.json().get("error", "")
        except ValueError:
            error = ""
        if error == "invalid_grant":
            raise InvalidGrantError(error)
        raise OAuthError(f"token endpoint returned {response.status_code}: {error or response.text[:200]}")
