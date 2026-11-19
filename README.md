# Boda Hela
Static site - no build step.

Deploy: push this folder to GitHub, then in Vercel choose "Add New > Project", import the repo,
Framework Preset "Other", leave Build Command and Output Directory empty, Deploy.
(Or run `npx vercel --prod` inside this folder.)

Install: open the deployed URL in Chrome/Edge on Android -> "Install app" button (or browser menu).
On iPhone Safari: Share -> Add to Home Screen.
After changing any file, bump `V` in sw.js so users get the update.

## Accounts and private history (Firebase)
1. Firebase console: create a project > Add web app > copy the config into the `FB` object near the end of index.html.
2. Build > Authentication > Sign-in method > enable Email/Password. Players sign up with name, email, phone number and password, and sign in with email + password. "Forgot password?" sends a Firebase reset email. The name and phone are saved on the player's private profile. No SMS, so it stays on the free Spark plan. Phone numbers are not verified.
3. Build > Firestore Database > create (production mode) > Rules > paste firestore.rules > Publish.
4. Authentication > Settings > Authorized domains: add your Vercel domain.
5. Push to GitHub. Each player's balance, last 50 bets and top wins are saved to users/{their uid}; only they can read them.
Until the config is pasted, the game runs local-only as before.
Note: the balance is still decided by the phone. For tamper-proof play, move bet settlement to Cloud Functions (needs Blaze plan).
