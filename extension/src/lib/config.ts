// Build-time configuration. Values come from extension/.env (gitignored):
//   WXT_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
//   WXT_API_BASE_URL=http://localhost:8000
// Client IDs are public by design; the client secret lives only in the backend.

const env = import.meta.env as Record<string, string | undefined>;

export const GOOGLE_CLIENT_ID = env.WXT_GOOGLE_CLIENT_ID ?? '';
export const DEFAULT_API_BASE = env.WXT_API_BASE_URL ?? '';

export const OAUTH_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send',
];
