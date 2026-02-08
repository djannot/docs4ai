# Google Drive Sync Setup

Docs4ai does not ship Google OAuth credentials. To enable Drive sync, bring your own.

Quickstart: https://developers.google.com/drive/api/quickstart/nodejs

## One-time setup

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Configure the OAuth consent screen (External is fine for personal use).
4. If the app is in Testing, add your Google account under Test users.
5. Create OAuth Client ID credentials (Application type: Desktop app).
6. Set these environment variables before launching the app:

```bash
export GOOGLE_DRIVE_CLIENT_ID="your-client-id"
export GOOGLE_DRIVE_CLIENT_SECRET="your-client-secret"
```

## Connect in Docs4ai

1. Select **Google Drive folder** as the sync source.
2. Click **Connect** to authorize your Google account.
3. Browse and select a folder (My Drive or Shared Drives).
4. Start syncing.

Drive content is cached under your app data directory (e.g. `~/Library/Application Support/docs4ai/drive-cache/<profileId>` on macOS). Search results link back to the Drive file.
