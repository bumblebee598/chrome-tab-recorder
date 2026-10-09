"""Completion/failure emails. Gmail sends as the user, to the user — nothing
to sign up for and it works for any OAuth test user. Resend is the fallback
(its sandbox sender only delivers to the Resend account owner)."""

import base64
from email.message import EmailMessage
from typing import Protocol

import httpx

GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
RESEND_URL = "https://api.resend.com/emails"


class EmailError(Exception):
    pass


class EmailSender(Protocol):
    async def send(
        self,
        access_token: str,
        to: str,
        subject: str,
        text: str,
        html: str,
        job_id: str,
    ) -> None: ...


class GmailSender:
    async def send(
        self,
        access_token: str,
        to: str,
        subject: str,
        text: str,
        html: str,
        job_id: str,
    ) -> None:
        message = EmailMessage()
        message["To"] = to
        message["From"] = to  # users.messages.send always sends as the authorized user
        message["Subject"] = subject
        message["X-Job-Id"] = job_id
        message.set_content(text)
        message.add_alternative(html, subtype="html")
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode()

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                GMAIL_SEND_URL,
                json={"raw": raw},
                headers={"Authorization": f"Bearer {access_token}"},
            )
        if response.status_code != 200:
            raise EmailError(f"Gmail send failed: HTTP {response.status_code}")


class ResendSender:
    def __init__(self, api_key: str):
        self._api_key = api_key

    async def send(
        self,
        access_token: str,  # unused; Resend authenticates with its own key
        to: str,
        subject: str,
        text: str,
        html: str,
        job_id: str,
    ) -> None:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                RESEND_URL,
                json={
                    "from": "onboarding@resend.dev",
                    "to": [to],
                    "subject": subject,
                    "text": text,
                    "html": html,
                },
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
        if response.status_code not in (200, 201):
            raise EmailError(f"Resend send failed: HTTP {response.status_code}")
