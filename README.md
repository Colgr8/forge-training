# Forge Training — Setup Guide

## What's in this folder

| File | Purpose |
|------|---------|
| `index.html` | The full app (everything in one file) |
| `manifest.json` | Makes it installable as an app |
| `sw.js` | Enables offline use after first load |
| `icon-192.png` | App icon (small) |
| `icon-512.png` | App icon (large) |

---

## STEP 1 — Create a free GitHub account

1. Go to **github.com**
2. Click **Sign up** and create a free account
3. Verify your email address

---

## STEP 2 — Create a new repository (your app's home)

1. Once logged in, click the **+** icon (top right) → **New repository**
2. Repository name: `forge-training` (or anything you like)
3. Set it to **Public**
4. Click **Create repository**

---

## STEP 3 — Upload your files to GitHub

1. On your new repository page, click **uploading an existing file**
   *(or drag and drop files onto the page)*
2. Select ALL files from this folder:
   - `index.html`
   - `manifest.json`
   - `sw.js`
   - `icon-192.png`
   - `icon-512.png`
3. Scroll down, type a commit message like `Initial upload`
4. Click **Commit changes**

Your files are now saved on GitHub. ✅

---

## STEP 4 — Create a free Netlify account

1. Go to **netlify.com**
2. Click **Sign up** → choose **Sign up with GitHub**
3. Authorise Netlify to access your GitHub

---

## STEP 5 — Deploy your app on Netlify

1. In Netlify, click **Add new site** → **Import an existing project**
2. Choose **GitHub**
3. Select your `forge-training` repository
4. Leave all build settings blank (no build command needed)
5. Click **Deploy site**

Netlify will give you a live URL like `https://forge-training-abc123.netlify.app` ✅

---

## STEP 6 — Install on your Samsung phone & tablet

1. Open **Google Chrome** on your Samsung device
2. Go to your Netlify URL
3. Wait a few seconds for the app to fully load (first time only — it's caching for offline)
4. Tap the **three-dot menu** (⋮) in Chrome
5. Tap **Add to Home screen**
6. Tap **Add**

The Forge Training icon will appear on your home screen. Tap it to open like a native app. ✅

**It now works offline** — no internet needed after this first setup.

---

## STEP 7 — Generate a real Android APK (optional but recommended)

This gives you a proper app that installs like any other Android app.

1. Go to **pwabuilder.com**
2. Enter your Netlify URL and press **Start**
3. Wait for the analysis to complete
4. Click **Package for stores**
5. Choose **Android**
6. Click **Generate Package**
7. Download the `.apk` file
8. Email the `.apk` to yourself
9. Open the email on your Samsung → tap the `.apk` to install
   *(You may need to allow "Install unknown apps" in Samsung Settings → Apps)*

---

## HOW TO UPDATE THE APP IN THE FUTURE

When Claude gives you a new version of `index.html`:

1. Save the new file to your PC
2. Go to **github.com** → your `forge-training` repository
3. Click on `index.html` in the file list
4. Click the **pencil icon** (Edit) — top right of the file view
5. Click **...** → **Upload file** (or simply delete the old one and upload the new one)
6. Click **Commit changes**

Netlify detects the change automatically and redeploys within 30 seconds. ✅

### Keeping previous versions
GitHub saves **every version automatically**. To see older versions:
- Click on `index.html` in your repository
- Click **History** (top right of the file view)
- Every upload is listed with its date
- Click any entry → click **<> Browse files** to see that exact version
- Click **Raw** to download it

---

## DATA & PRIVACY

- All your client data is saved **locally on each device** (browser storage)
- Nothing is sent to any server — it's a private app
- To back up your data: use the **Export** button in the app settings
- To restore: use the **Import** button

---

## TROUBLE?

| Problem | Solution |
|---------|----------|
| App won't load offline | Open it once with WiFi first — it needs to cache CDN files |
| Data disappeared | You may have cleared browser data — use Export regularly to back up |
| Can't install on Samsung | Make sure you're using Chrome, not Samsung Internet |
| APK won't install | Go to Settings → Apps → Special access → Install unknown apps → Chrome → Allow |
