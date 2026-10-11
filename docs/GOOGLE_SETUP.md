# Connect DriveRelay to Google Drive (one-time, ~3 minutes)

Uploading to Google Drive (and reading private files) needs a Google **OAuth client**.
Google does not allow apps to share one publicly, so you create your own — it is free
and only you will use it.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/projectcreate>.
2. Project name: `DriveRelay` → **Create**. Make sure the new project is selected (top bar).

## 2. Enable the Google Drive API

1. Open <https://console.cloud.google.com/apis/library/drive.googleapis.com>.
2. Click **Enable**.

## 3. Configure the consent screen

1. Open <https://console.cloud.google.com/auth/branding> (Google Auth Platform → Branding).
   If asked, click **Get started**.
2. App name: `DriveRelay`, support email: your Gmail → Next.
3. Audience: **External** → Next. Contact email: your Gmail → Next → **Create**.
4. Go to **Audience** → **Test users** → **Add users** → add every Gmail address you
   will sign in with (for example the account that owns the destination folder).

> The app stays in "Testing" mode — that is fine for personal use. Google will show a
> "Google hasn't verified this app" screen when you sign in: click **Continue**.
> (In testing mode Google asks you to sign in again roughly every 7 days.)

## 4. Create the OAuth client

1. Open <https://console.cloud.google.com/auth/clients/create>.
2. Application type: **Desktop app**, name: `DriveRelay desktop` → **Create**.
3. Click **Download JSON** (file named `client_secret_….json`).

## 5. Add it to DriveRelay

1. Open DriveRelay → **Google Accounts**.
2. Click **Import JSON…** and pick the downloaded file
   (or paste the *Client ID* and *Client secret* and press **Save**).
3. Click **Add Google account** → your browser opens → choose the account → **Continue** → **Allow**.
4. Repeat step 3 for each account you want (e.g. a second account that owns the destination folder).

Done. Tokens are stored encrypted with your OS keychain (Windows DPAPI / macOS Keychain).

## Which account is used?

* **Upload as** (destination) — the account that can add files to the destination folder.
* **Read source as** — `Auto` tries your signed-in accounts first, then falls back to the
  public link (works for "Anyone with the link" files without signing in).

## Troubleshooting

| Message | Fix |
| --- | --- |
| `access_denied` / "app is being tested" | Add your Gmail as a **test user** (step 3.4). |
| `redirect_uri_mismatch` | The client type must be **Desktop app**, not Web. |
| "needs to sign in again" | Click **Sign in again** on the Accounts page (testing-mode tokens expire after 7 days). |
| "download quota exceeded" | The file was downloaded too many times today. Use **Cloud copy** mode, or try later. |
| "does not have permission to add files" | The *Upload as* account needs Editor access to the destination folder. |
