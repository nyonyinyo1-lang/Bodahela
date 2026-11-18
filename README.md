# Boda Hela
Static site - no build step.

Deploy: push this folder to GitHub, then in Vercel choose "Add New > Project", import the repo,
Framework Preset "Other", leave Build Command and Output Directory empty, Deploy.
(Or run `npx vercel --prod` inside this folder.)

Install: open the deployed URL in Chrome/Edge on Android -> "Install app" button (or browser menu).
On iPhone Safari: Share -> Add to Home Screen.
After changing any file, bump `V` in sw.js so users get the update.
