# Pinbowl

Pinbowl scoring for Matchplay tournaments. Players open the site on their phones,
pick their name once, and see their card, standings, machines and rules.
Admins log in to enter and fix scores, run weekly tournaments and archive old ones.

## What's in here

- `server.js` – the server. It saves everything, checks Matchplay for new player
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

## Running a week

The Tournaments tab starts with "This week at a glance": a checklist showing whether the
tournament is linked to Matchplay, whether every machine has a target, how many cards are
complete, and what comes next (mark done, make the finals, Matchplay totals, archive),
with an Open button for each step.

## First run

1. Open the site. It asks you to create the first admin.
2. Tournaments tab: paste your Matchplay API token (Matchplay, Account
   settings, API tokens).
3. Create the tournament in Matchplay, then paste its link on the Tournaments
   tab. Players and machines come over automatically, and new player sign-ups
   keep arriving every minute until you archive it. Machine changes in Matchplay
   come over only when you press "Refresh machines from Matchplay".
4. Machines tab: check each machine's ball count and target score.

## Settings you can add (Variables)

| Name | What it does |
| --- | --- |
| `DATA_DIR` | Folder where scores are saved. Required on most hosts. |
| `MATCHPLAY_TOKEN` | Optional. Token to use if none is saved in the app. |
| `SYNC_SECONDS` | How often to check Matchplay. Default 60. |
| `RESET_ADMIN` | Locked out? Set to `Name:newpassword`, restart, log in, then delete it. |

## Players

Players pick their name (there's a search box once the list is long) and set a 4-digit
PIN the first time. After that the phone remembers them for a year, and a returning
player's 4th PIN digit logs them in by itself. Admins can reset a forgotten PIN on the
Players tab: tap a player there for Reset PIN, scorekeeper and remove.
Players enter their score after each ball; admins can enter or fix anyone's game.
Admins can make any player a scorekeeper on the Players tab. Scorekeepers keep their
own card and also get a Scorekeeper tab for entering and fixing anyone's scores.

## Printable how-to sheet, daily sheet and machine cards

Log in as an admin and tap **Share**. Under "Print" there are three links:

- **How-to-play sheet** (`your-site/?sheet=1`) for the weekly tournament.
- **Daily challenge sheet** (`your-site/?sheet=daily`): the same one-page layout with the
  challenge hours, how to join, and how the winner is picked.
- **Machine cards** (`your-site/?sheet=cards`): one card per machine, 6 per letter page
  with dashed cut lines. Each card has the machine name, a big "Enter your score after
  every ball", a QR code, and the strike, spare and pin scores for its target. Pick this
  tournament's machines, all stored machines, or blank cards, and turn the scores off if
  you'd rather not reprint when targets change.
- **Generic "score every ball" cards** (`your-site/?sheet=cards&kind=generic`): 6 identical
  cards with only the notice and a QR code, no machine details.

The how-to sheet (`your-site/?sheet=1`) It's one letter-size page with a QR code for your site, the
steps to get started, a big reminder to enter your score after every ball, how
scoring works, and a short finals note. Press "Print this page".

## Machines

**Slots.** A tournament has one machine slot per frame ("Frames per card" on the
Tournaments tab). The Machines tab lists Slot 1, Slot 2 and so on. Tap a slot to swap in
any stored machine, or "Delete game" to take the machine out (the slot then shows as "Slot 8 · blank" until you
fill it). If games were already played on that machine, the app asks whether to keep
them (they still count) or delete them. Bonus slots 11 and 12 stay hidden until someone
earns them, then appear with a stored-machine dropdown and Draw again. "Add a machine by
hand" puts a new machine in the first blank slot.

**Matchplay.** Machines come from Matchplay only when the tournament is created from a
Matchplay link and when you press "Refresh machines from Matchplay" on the Machines tab
(it refills the slots in Matchplay's order and keeps games already played). The automatic
check every minute, and the Players tab button, only add players.

The Machines and Stored machines tabs show one line per machine. Tap a machine to see
its score table and stats and, for admins, to change its target, category, ball count
and short name (changes save by themselves). Search, the Classic / Mid / Modern chips,
"Needs attention" and Expand all help with long lists. Targets, ball counts and short
names are saved per machine on the Stored machines tab and filled in automatically the
next time that machine is in a tournament. Edit any stored machine there, even one that
isn't in this week's tournament, and sort them by name, last used, most played or
category.

**EM machines.** Tick "EM (electromechanical)" on a stored machine (or on its slot on the
Machines tab). EM machines get 5 balls: a strike is reaching the target on ball 1 or 2, a
spare is reaching it on ball 3, 4 or 5, and the first throw's pins come from the score
after ball 2. The setting is remembered for next time like targets are.

Anywhere a score or target is typed, commas appear as you type (50,000 vs 500,000), and
shorthand works: 150m is 150,000,000 and 45k is 45,000.

## Bonus frames 11 and 12

The first time anyone gets a strike or spare in frame 10, frame 11's machine is
drawn at random from stored machines that have a target and are in the bonus draw.
The first time anyone strikes frames 10 and 11, frame 12's machine is drawn the same
way. Everyone plays those same machines, in that order. Each machine has a
category (Classic, Mid or Modern). Frames 1-10 use 3, 3 and 4 of them, and frames
11 and 12 are drawn from the two categories with 3, so a full card has 4 of each. Admins can draw again or
choose a machine on the Machines tab, and leave machines out of the draw on the
Stored machines tab.

A bonus game that only needs one more throw (after a spare in frame 10, or frame 12
after strikes in 10 and 11) ends after the first throw: ball 1, or balls 1 and 2 on an EM
machine. The app stops the game there for players, and staff entry only shows those
boxes. After a strike in frame 10, frame 11 is a full game (both throws count).

## NPC Daily Pinbowl Challenge

Runs by itself Friday 5 PM to midnight, and Saturday and Sunday 11 AM to 7 PM,
Central time. Each one is named "NPC Daily Pinbowl Challenge" plus the date and gets
10 machines picked at random from Stored machines that have a target and are
marked "Can be picked at random": 3 Classic, 3 Mid, 3 Modern and 1 more from any
category. Players join by picking their name from past players or adding a new
name, then play a normal card (bonus frames work the same way). At closing time
scores lock and the highest total wins. Admins can turn it off, start one early,
or end one early on the Tournaments tab.

### IFPA submission

Tournaments tab → **Open IFPA submission** (weekly tournaments only). It builds:

- **Standings to paste into IFPA:** one line per player, `place,name,IFPA #` (unknown numbers
  show as `????`). Finalists come first in finals order: the final group by finish, then
  players knocked out in later rounds above earlier ones (within a round: 3rd places before
  4th places, then by seed). Everyone else follows by qualifying total; equal totals share a
  place. Players who never finished a game are left off. Copy, download as CSV, or print.
- **IFPA numbers:** taken from players' Matchplay profiles (the IFPA number they linked), then
  an IFPA name search for the rest (needs an IFPA API key, saved on that screen or set as the
  `IFPA_API_KEY` variable; only an exact match to one player is used). You can type numbers
  in; they're remembered by name for future weeks.
- **Balls played per game:** for qualifying (frames 1–N, bonus frames separately) and each
  finals round: games, average balls, share of a full game, and which ball games ended on.
- **TGP three ways:** IFPA's 1/3 rule, counting each game by the balls actually played, and
  full games. Plus a ready-to-paste note for the IFPA comments box.

### Daily challenge leaderboard

Daily challenges get a **Leaderboard** tab. Points work like IFPA WPPR points:

- Every player in a challenge is worth 0.5 points, so the winner gets 0.5 for each player
  they beat (1 player = 0; 2 players = winner 0.5, 2nd 0; 10 players = winner 4.5). Capped at 32.
- Everyone else gets a share of that: 10% is split evenly down the standings and 90% follows
  IFPA's curve (`(1 - ((place-1)/(players/2))^0.7)^3`), which goes to 0 past the top half.
  Last place always gets 0. Tied players share the points for their places.
- Only players who finished at least one game count. Points are added once a challenge closes;
  the running challenge shows "if it ended now" points.
- The board can show all time, this year, or the last 30 days. Tap a name to see each result.
  Players are matched by name across challenges.

## Finals (PAPA style)

On the Finals tab of a weekly tournament: pick how many make the finals (top half by
default; the cut line shows in Standings, the TV board and the stream window), adjust
seeds with Up/Down if needed, then **Mark as done** (locks qualifying scores) and
**Make the finals**. Finals are their own tournament named "<name> Finals".

Groups are dealt PAPA style (1-8-9-16 ...). If the field isn't 4, 8, 16 or 32 the top
seeds get byes into round 2. Each group plays 3 games: the top seed picks one Classic,
one Mid and one Modern from the tournament's machines and their order; playing positions
are picked starting with the 2nd seed and ending with the top seed. The 3 games are
scored as a 3-frame pinbowl card and the top 2 totals move on. Game 3 plays like frame 10:
a spare earns a one-throw bonus game, a strike a full bonus game (plus one more throw if
that's a strike too). Each group's 2 bonus machines are drawn at random, from 2 different
categories and not from the group's own games, as soon as someone needs them.
Ties are flagged so an admin can set the finishing order after a tiebreaker. Each
finished group shows Matchplay points: the totals shared out of 21.

Groups pick their games one after another, starting with the group that has the highest
seed (the group with seed 1 first). A group can't put a machine in the same game slot that
an earlier group already has it in, but it can use that machine for a different game
(if Group A plays Rush as game 1, Group B can play Rush as game 2 or 3).

**No repeat picks** (Tournaments tab, on by default): whoever picks a group's games can't
pick a machine they already picked in an earlier finals round. Those machines are greyed
out for them, and staff edits follow the same rule. Set it on the weekly tournament (it's
copied into the finals when they're made) or change it on the finals tournament itself.
Turn it off to allow repeat picks. Random draws (when everyone defers) aren't limited.

Instead of picking, the player whose turn it is to pick games can defer: the pick passes
to the next seed in the group, who can defer too. If the last seed defers, the games are
drawn at random (one per category, following the same-slot rule). Playing positions are
then picked from the top seed down, with whoever picked the games picking last (so if
nobody picked, it's plain seed order). Admins can also press "Draw at random" for a group.

When the finals are made, everyone who made them gets a "You made the finals!" prompt on
their phone (within about 15 seconds) with a button to open the finals, plus a banner
on the qualifying tournament until they do.

Players run their own group from their phones on the Finals tab: the top seed is asked
to pick the 3 games when their group's turn comes, then each player is asked for their position when it's their turn
(the page updates by itself and says "It's your turn to pick!"). Once positions are set,
players enter their score after each ball just like qualifying, and can fix or cancel
their own games. Everyone in a group finishes a game before anyone can start the next
one. Admins and scorekeepers can still do any of it for them: on the Finals tab, press
**Enter scores** under a group, pick a player and game, and fill in the Ball 1, 2 and 3
boxes (the total score after each ball). Balls after the target is reached are greyed out.
Saving moves on to the next player who still needs that game. Tap any game box to open
that player and game to enter or fix it. The Scorekeeper / Enter score tab for qualifying
uses the same Ball 1, 2, 3 boxes.

For Matchplay, the admin **Matchplay totals** tab in the finals gives each game's points
(4 for 1st, 2 for 2nd, 1 for 3rd, 0 for 4th) once all 3 games in a group are done. Because
strike and spare bonuses carry between games, the split is chosen so each player's 3-game
total is as close as possible to their share of 21 and the pinbowl finishing order is kept.
Games where the points differ from who actually won that game are marked with *.

The same tab shows an **IFPA TGP** estimate (WPPR v6.2 rules): 4% per meaningful game;
qualifying counts only if at least half the field is cut, and a pinbowl frame can end on
ball 1 so each game counts as 1/3 (a 10-frame card is about 3.33 games); finals games the
winner plays count 3 per round, doubled for 4-player groups. Before the champion is
decided it assumes the winner plays every round after the byes. IFPA makes the final call.

To swap a group's games, press **Change games** under the group on the Finals tab. If
scores are already in for a game you change, the app warns you first and then clears
only that game's scores.

The Standings tab shows every group drawn like bowling frames (the same look the TV
board and the stream window use), with the top 2 in each group highlighted.

To fix a mistake: delete the finals, undo Done, change the scores, mark done again,
and make the finals again.

## Broadcast

- TV board: every player's full card. Use "Copy TV link" and open it on the TV.
- Stream window: a page for an OBS Browser source showing each player's frame in
  progress, 1 to 4 frames behind it, and their total on the far right. It fits
  any source size. Set the source's Width and Height to the spot on your layout
  (for example 480 x 800) instead of cropping it. Pick the settings, then
  "Copy this address" and paste it into OBS. Settings are part of the address,
  so nothing but the scores shows on stream. "Show" picks which tournament: the one
  selected at the top of the page (the default), or "Whatever is running now", which
  switches by itself and puts a running daily challenge first.
- Machine window: a second OBS Browser source showing the machine being played, its
  target, and the score needed for a strike, a spare and each pin count, in short form
  (25M, 450k). Pick the machine on Broadcast, Machine window. The address never changes:
  the window switches to the newly picked machine by itself within a few seconds.
- During finals the TV board shows every group, and the stream window shows one group.
  Pick it with "Finals group" in the stream settings and copy the address again.
  Both screens switch to the finals by themselves once they're made.

## Stats

The admin Stats tab gathers every finished game from open and archived tournaments
and daily challenges (deleted tournaments are left out) and groups them by machine.
Each machine opens to show strike and spare rates, how games ended, pins after each
ball, ball 1 score levels, a results row per event, and a suggested target for the
strike rate you pick. "Use" applies the suggestion to Stored machines.

## Colors

The circle button at the top switches between NPC Fancy (default: Northstar colors with
faint geometric patterns and soft depth), Northstar, Classic and Dark. Each phone
remembers its own choice. The stream and machine windows can use NPC Fancy too.

## Backups

The server writes `db.json` in the data folder, plus one `backup-YYYY-MM-DD.json`
per day (the newest 30 are kept).
