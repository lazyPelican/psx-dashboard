# Deploying to Render (free)

Your app is ready to host. Render's free tier gives you a public URL like
`https://psx-dashboard-XXXX.onrender.com`. The instance sleeps after 15 min
of no traffic and takes ~30 s to wake on first hit — but it's free forever
and you can share it with anyone.

## One-time setup

### 1. Push this folder to GitHub

If you don't have a GitHub repo for it yet:

```bash
cd "C:\Users\SURFACE\Downloads\QWEN APP"
git init
git add .
git commit -m "PSX Dashboard"
# Create a new repo on github.com (call it psx-dashboard or anything),
# then connect this folder to it:
git remote add origin https://github.com/YOUR_USERNAME/psx-dashboard.git
git branch -M main
git push -u origin main
```

If this folder is already part of a bigger repo (it currently lives under
`Downloads/QWEN APP/`), either:
- Make it its own repo by copying the folder out and `git init`-ing fresh, **or**
- Leave it inside the big repo and just keep `rootDir: "Downloads/QWEN APP"`
  in `render.yaml` so Render knows where to look.

### 2. Sign in to Render

Go to [render.com](https://render.com) and sign up with your GitHub account.
Free, no credit card.

### 3. Create the web service

- Click **New +** → **Web Service**
- Connect the GitHub repo you just pushed
- Render will detect `render.yaml` and auto-fill the settings
- Click **Create Web Service**

Render now installs `npm install` and runs `node server.js`. First deploy
takes ~2-3 minutes. You'll get a URL like `https://psx-dashboard-abcd.onrender.com`.

### 4. Test it

Open the URL. The dashboard should load. Try Markets → click an index →
click a stock → confirm prices match what you saw locally.

## Subsequent updates

Anytime you change `app.html` or `server.js`:

```bash
git add -A
git commit -m "describe change"
git push
```

Render auto-redeploys within ~1 minute (because `autoDeploy: true` is in
`render.yaml`).

## Sharing the URL

Just send anyone the Render URL. Their portfolio is stored in **their**
browser's localStorage — completely private and separate from yours. No
sign-up needed.

## Caveats

- **Sleep on free tier.** No traffic for 15 min → instance sleeps. The next
  visitor will wait ~30 s for it to wake up. If you want always-on, upgrade
  Render to Starter ($7/mo) or move to a $5/mo VPS.
- **Prewarm on cold start.** When the instance wakes, the Screener tab's
  484-stock indicator prewarm runs fresh — give it a minute on first visit.
- **PSX data hours.** Live prices only update Mon-Fri 09:30-15:30 PKT.
  Outside those hours you see the last close.
- **No auth.** Anyone with the URL can use it. Their trades live in their
  own browser, so they can't see yours, but they can browse the same market
  data. If you want a password gate, ask me to add basic-auth and I'll set
  it up.

## Alternative: free tunnel from your laptop (Cloudflare Tunnel)

If you'd rather not deploy and just want to access your *local* server from
your phone or another computer occasionally:

1. Install `cloudflared` (Cloudflare's tunnel client)
2. Run `node server.js` as usual
3. In another terminal: `cloudflared tunnel --url http://localhost:3000`
4. It prints a `https://something.trycloudflare.com` URL — that's yours, free,
   no signup, no sleep — but it only works while your laptop is on and
   running both processes.
