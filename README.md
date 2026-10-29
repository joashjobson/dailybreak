# Daily Break

One quick game a day, starting with Daily Chain. Runs on a Cloudflare Worker, the same way as joashjobson.me.

- `public/` is the website. `index.html` is the whole game; `answers.js` is the list of about 240,000 real names. Nothing needs building.
- `src/worker.js` answers `/api/check` (when an answer isn't on the list, it looks it up on Wikidata and saves the verdict), runs friend duels at `/api/duel`, saves daily scores and groups at `/api/score` and `/api/group`, and fills in link previews for the home page and challenge links.
- `public/og/` holds the link preview pictures: `home.png` and one per daily letter.
- `wrangler.toml` holds the settings: the Worker's name, your contact email and the saved-checks store.

## How answers are checked

1. The page checks its own list first (instant, no request). Almost every answer is found here.
2. Only a miss goes to `/api/check`, which looks the name up on Wikidata (the free database behind Wikipedia) and checks it fits the category: a country, a person, an animal and so on.
3. The verdict is saved in the `ANSWERS` KV store for 90 days, so each unknown name is looked up once for everyone.
4. In the daily chain a rare answer counts straight away and is checked in the background. If it turns out not to be real it's crossed out, doesn't count and costs 5 seconds. In duels the turn clock pauses for the check instead.

The site itself never mentions Wikipedia or Wikidata (Wikidata is CC0, so no credit is needed).

Wikidata is free, including for sites with ads (CC0 licence). It asks for a User-Agent with a contact, which the Worker sends from `CONTACT_EMAIL`.

## Setup, once

See the setup guide. In short: upload this folder to a GitHub repo, import it in Cloudflare Workers & Pages, set `CONTACT_EMAIL`. The KV store's ID is already in `wrangler.toml`.

## Friend duels

"Make a code" creates a room with a 5-character code (also shareable as a link, `/#duel=CODE`). Each room is a Durable Object called `DuelRoom` that keeps the chain, whose turn it is and the 15-second turn clock, so a turn runs out even if someone closes the tab. Rooms delete themselves 2 days after the last move. Cloudflare creates the Durable Object on deploy from the `[[migrations]]` lines in `wrangler.toml`; it works on the free plan and needs no setup. Never rename `DuelRoom` or change the `v1` migration tag.

## Sharing (v5)

- **Challenge links.** The share text ends with a link like `/c/142-k-14?n=Archer`. WhatsApp, iMessage and Discord show "Archer got 14 links in Daily Chain. Can you beat it?" with the letter's picture from `public/og/`. Opening it shows who to beat, and the result screen says who won.
- **Streaks.** Each day with a ranked go counts. The streak shows on the home card and in the share text (from 2 days). It's kept in the browser.
- **Ranks.** Only the first go of the day is ranked and saved. The result shows "#3 of 41 today", or "Top 12% today" once 20 people have played that day.
- **Groups.** Anyone can make a group (up to 50 people; 10 groups each) and send `/#group=CODE`. Each group shows a leaderboard for today's chain and yesterday's winner. Groups delete themselves after 60 days with no scores; daily scores are deleted after 3 days.
- Scores and groups live in a Durable Object called `Board` (migration tag `v2`). Cloudflare creates it on deploy, on the free plan, with no setup. Never rename `Board` or change the `v2` tag.

## Still simulated

Chainbot, the Global chain feed and "% of players said this" are made up in the page for now. Daily prompts come from the date, so everyone gets the same ones.
