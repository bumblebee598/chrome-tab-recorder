import base64
import json

import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from httpx import Response

from app.adapters.google_oauth import TOKEN_URL
from app.adapters.users import InMemoryUserStore
from app.api.deps import get_settings, get_user_store
from app.api.main import app
from app.security import issue_session_token
from app.settings import Settings

FERNET_KEY = Fernet.generate_key().decode()
TEST_SETTINGS = Settings(
    google_oauth_client_id="test-client-id",
    google_oauth_client_secret="test-secret",
    session_jwt_secret="session-secret",
    token_fernet_key=FERNET_KEY,
)


def fake_id_token(sub: str = "user-1", email: str = "a@b.test", aud: str = "test-client-id") -> str:
    def b64(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{b64({'alg': 'RS256'})}.{b64({'sub': sub, 'email': email, 'aud': aud})}.sig"


@pytest.fixture()
def client():
    store = InMemoryUserStore()
    app.dependency_overrides[get_settings] = lambda: TEST_SETTINGS
    app.dependency_overrides[get_user_store] = lambda: store
    yield TestClient(app), store
    app.dependency_overrides.clear()


@respx.mock
def test_exchange_stores_user_and_returns_session(client):
    http, store = client
    respx.post(TOKEN_URL).mock(
        return_value=Response(
            200,
            json={
                "access_token": "at-1",
                "refresh_token": "rt-1",
                "id_token": fake_id_token(),
                "expires_in": 3599,
            },
        )
    )

    response = http.post(
        "/auth/exchange",
        json={"code": "the-code", "codeVerifier": "ver", "redirectUri": "https://x.chromiumapp.org/"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == "a@b.test"
    assert body["sessionToken"]


@respx.mock
def test_exchange_rejects_wrong_audience(client):
    http, _ = client
    respx.post(TOKEN_URL).mock(
        return_value=Response(
            200,
            json={
                "access_token": "at-1",
                "refresh_token": "rt-1",
                "id_token": fake_id_token(aud="someone-else"),
            },
        )
    )
    response = http.post(
        "/auth/exchange",
        json={"code": "c", "codeVerifier": "v", "redirectUri": "https://x.chromiumapp.org/"},
    )
    assert response.status_code == 401


@respx.mock
def test_access_token_refreshes_via_google(client):
    http, store = client
    respx.post(TOKEN_URL).mock(
        side_effect=[
            Response(
                200,
                json={
                    "access_token": "at-1",
                    "refresh_token": "rt-1",
                    "id_token": fake_id_token(),
                },
            ),
            Response(200, json={"access_token": "at-2", "expires_in": 3599}),
        ]
    )
    session = http.post(
        "/auth/exchange",
        json={"code": "c", "codeVerifier": "v", "redirectUri": "https://x.chromiumapp.org/"},
    ).json()["sessionToken"]

    response = http.get("/auth/access-token", headers={"Authorization": f"Bearer {session}"})

    assert response.status_code == 200
    body = response.json()
    assert body["accessToken"] == "at-2"
    assert body["email"] == "a@b.test"


@respx.mock
def test_access_token_maps_invalid_grant_to_401(client):
    http, store = client
    respx.post(TOKEN_URL).mock(
        side_effect=[
            Response(
                200,
                json={
                    "access_token": "at-1",
                    "refresh_token": "rt-1",
                    "id_token": fake_id_token(),
                },
            ),
            Response(400, json={"error": "invalid_grant"}),
        ]
    )
    session = http.post(
        "/auth/exchange",
        json={"code": "c", "codeVerifier": "v", "redirectUri": "https://x.chromiumapp.org/"},
    ).json()["sessionToken"]

    response = http.get("/auth/access-token", headers={"Authorization": f"Bearer {session}"})

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid_grant"


def test_access_token_rejects_garbage_session(client):
    http, _ = client
    response = http.get("/auth/access-token", headers={"Authorization": "Bearer nonsense"})
    assert response.status_code == 401


def test_access_token_rejects_valid_jwt_for_unknown_user(client):
    http, _ = client
    token = issue_session_token("ghost", "g@b.test", TEST_SETTINGS.session_jwt_secret)
    response = http.get("/auth/access-token", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401
