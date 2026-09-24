# Pinbowl

Pinbowl scoring for Matchplay tournaments. Players open the site on their phones,
pick their name once, and see their card, standings, machines and rules.
Admins log in to enter and fix scores, run weekly tournaments and archive old ones.

## What's in here

- `server.js` – the server. It saves everything, checks Matchplay for new
  sign-ups every minute, and keeps your Matchplay token private.
- `public/index.html` – the web page players and admins see.
- `public/qrcode.js` – draws the Share QR code (MIT-licensed library by Kazuhiko Arase).
- `package.json` – tells the host how to start it (`npm start`).

No extra packages are needed. It needs Node.js 18 or newer.

## Putting it online (Railway)

1. Make a free GitHub account, create a new repository, and upload these files
   (Add file, then Upload files). Keep the `public` folder.
2. Make a Railway account (railway.com) and choose New Project, then Deploy from
   GitHub repo, and pick your repository. It detects Node and starts it.
3. Add a volume so scores survive restarts: in your service, add a Volume
   and set its mount path to `/data`.
4. Under Variables, add `DATA_DIR` = `/data`.
5. Under Settings, Networking, click Generate Domain. That is your website.
   Turn it into a QR code and post it at the venue.

Any host that runs Node.js and has a persistent disk works the same way
(Render, Fly.io, a VPS). Set `DATA_DIR` to the disk's folder. Avoid hosting
plans without a persistent disk: the scores would be wiped on each restart.

## First run

1. Open the site. It asks you to create the first admin.
2. Tournaments tab: paste your Matchplay API token (Matchplay, Account
   settings, API tokens).
3. Create the tournament in Matchplay, then paste its link on the Tournaments
   tab. Players and machines come over automatically, and new sign-ups keep
   arriving every minute until you archive it.
4. Machines tab: check each machine's ball count and target score.

## Settings you can add (Variables)

| Name | What it does |
| --- | --- |
| `DATA_DIR` | Folder where scores are saved. Required on most hosts. |
| `MATCHPLAY_TOKEN` | Optional. Token to use if none is saved in the app. |
| `SYNC_SECONDS` | How often to check Matchplay. Default 60. |
| `RESET_ADMIN` | Locked out? Set to `Name:newpassword`, restart, log in, then delete it. |

## Players

Players pick their name and set a 4-digit PIN the first time. After that the phone
remembers them for a year. Admins can reset a forgotten PIN on the Players tab.
Players enter their score after each ball; admins can enter or fix anyone's game.

## Machines

Targets, ball counts and short names are saved per machine and filled in
automatically the next time that machine is in a tournament.

## Backups

The server writes `db.json` in the data folder, plus one `backup-YYYY-MM-DD.json`
per day (the newest 30 are kept).
