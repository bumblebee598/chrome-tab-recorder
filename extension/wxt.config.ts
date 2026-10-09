import { defineConfig } from 'wxt';

// Pinned public key keeps the unpacked extension ID stable across machines:
// nfphhdblmoifbnbieoodhchadpcgnfjd -> OAuth redirect https://nfphhdblmoifbnbieoodhchadpcgnfjd.chromiumapp.org/
// Regenerate with scripts/gen_ext_key.sh (private half stays out of git).
const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqIQiaw4z2HQ2KFUz3pXCf8gU0IwQfXWi01/twqB6SQyTYiD6bNDsCa/gj2AmM0bNJMX6aVD5iqoHBXKSebudWohA+y//zgc0sD7dbUhTTEpzVw+3mTS6BwupZVkBlKWCEriX/qYi+I6mhgtlgtuj04CHE7DfZzGEpmq9MxLtL+KvpX8ew9owl36tEYV6DE2Y6jwltz7NtauaGmzAOsg+Wh6c6w38pOpBrj/MqudzYmEO/5xyrZNlEBaV+NoQgL/98YB3KqVaoshwo7g77oOuK+kFvUurEfrULA27y6CMcRSJ//pR+GZG22D+OoXLbhX+9kIP5dAQsJxscGYPlZgy8wIDAQAB';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Tab Recorder',
    description: 'Record tab + mic, upload to Drive, receive a transcript Doc by email.',
    permissions: [
      'activeTab',
      'scripting',
      'tabCapture',
      'offscreen',
      'storage',
      'unlimitedStorage',
      'identity',
      'alarms',
    ],
    key: EXTENSION_PUBLIC_KEY,
  },
});
