# Boda Hela
Static site - no build step.

Deploy: push this folder to GitHub, then in Vercel choose "Add New > Project", import the repo,
Framework Preset "Other", leave Build Command and Output Directory empty, Deploy.
(Or run `npx vercel --prod` inside this folder.)

Install: open the deployed URL in Chrome/Edge on Android -> "Install app" button (or browser menu).
On iPhone Safari: Share -> Add to Home Screen.
After changing any file, bump `V` in sw.js so users get the update.

## Server-side game (Vercel API + Firebase)
The crash points, the clock and every balance change now live on the server, so players cannot read crashes in advance, change their phone clock, or edit their balance.

Files: `api/game.js` (bets, cash-outs, balance), `api/round.js` (public ride info, cached 1 second), `lib/game.js` (game logic), `package.json` (firebase-admin).

Setup (once):
1. Firebase console > Build > Authentication > enable Email/Password.
2. Firebase console > Build > Firestore Database > create it > Rules > paste `firestore.rules` (denies all browser access) > Publish.
3. Firebase console > Project settings > Service accounts > Generate new private key. Open the downloaded .json file and copy ALL of its text. Never put this file in GitHub.
4. Vercel > your project > Settings > Environment Variables, add:
   - `FIREBASE_SERVICE_ACCOUNT` = the whole JSON text from step 3
   - `CRASH_SECRET` = a long random phrase (30+ characters). Keep it private; changing it changes every future ride.
5. Firebase console > Authentication > Settings > Authorized domains: add your Vercel domain.
6. Push to GitHub so Vercel redeploys (it installs firebase-admin by itself).

Notes: sign-in is email + password. A player can top up to KSh 1,000 only when below KSh 10 (once a minute). Without the two environment variables the game shows an error after sign-in.
