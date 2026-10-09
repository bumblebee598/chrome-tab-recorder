from dataclasses import dataclass
from typing import Protocol


@dataclass
class UserRecord:
    sub: str
    email: str
    refresh_token_encrypted: str
    created_at: str


class UserStore(Protocol):
    async def get(self, sub: str) -> UserRecord | None: ...

    async def upsert(self, record: UserRecord) -> None: ...


class InMemoryUserStore:
    def __init__(self) -> None:
        self._users: dict[str, UserRecord] = {}

    async def get(self, sub: str) -> UserRecord | None:
        return self._users.get(sub)

    async def upsert(self, record: UserRecord) -> None:
        self._users[record.sub] = record


class FirestoreUserStore:
    """users/{sub} documents; works against the emulator via FIRESTORE_EMULATOR_HOST."""

    def __init__(self, project: str):
        from google.cloud import firestore

        self._client = firestore.AsyncClient(project=project)

    def _doc(self, sub: str):
        return self._client.collection("users").document(sub)

    async def get(self, sub: str) -> UserRecord | None:
        snapshot = await self._doc(sub).get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        return UserRecord(
            sub=sub,
            email=data.get("email", ""),
            refresh_token_encrypted=data.get("refreshTokenEncrypted", ""),
            created_at=data.get("createdAt", ""),
        )

    async def upsert(self, record: UserRecord) -> None:
        await self._doc(record.sub).set(
            {
                "email": record.email,
                "refreshTokenEncrypted": record.refresh_token_encrypted,
                "createdAt": record.created_at,
            }
        )
