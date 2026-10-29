# Daily Break

One quick game a day, starting with Daily Chain. Runs on a Cloudflare Worker, the same way as joashjobson.me.

- `public/` is the website. `index.html` is the whole game; `answers.js` is the list of about 240,000 real names. Nothing needs building.
- `src/worker.js` answers `/api/check`: when an answer isn't on the list, it looks it up on Wikidata and saves the verdict.
- `wrangler.toml` holds the settings: the Worker's name, your contact email and the saved-checks store.

## How answers are checked

1. The page checks its own list first (instant, no request). Almost every answer is found here.
2. Only a miss goes to `/api/check`, which looks the name up on Wikidata (the free database behind Wikipedia) and checks it fits the category: a country, a person, an animal and so on.
3. The verdict is saved in the `ANSWERS` KV store for 90 days, so each unknown name is looked up once for everyone.
4. If Wikidata can't be reached, the answer counts as "unverified" for 1 point instead of blocking the player.

Wikidata is free, including for sites with ads (CC0 licence). It asks for a User-Agent with a contact, which the Worker sends from `CONTACT_EMAIL`.

## Setup, once

See the setup guide. In short: upload this folder to a GitHub repo, import it in Cloudflare Workers & Pages, set `CONTACT_EMAIL`, create the KV store and paste its ID into `wrangler.toml`.

## Still simulated

The Duel bot, the Global chain feed, "Top X% today" and "% of players said this" are made up in the page for now. Making them real needs a shared database (a Durable Object, like the shave game's leaderboard). Daily prompts come from the date, so everyone gets the same ones.
