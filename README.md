# arcus-trading

Spot volume bot for [Arcus](https://app.arcus.xyz). Each trade buys NVDA with the wallet's entire USDG balance and immediately sells it back through the Arcus Spot Router (Robinhood Chain, gasless). Several wallets run in parallel; each rolls a random number of trades per day, spreads them across an active-hours window with random gaps, and stops once it has spent its loss budget.

```bash
npm install
cp .env.example .env        # fill in PRIVATE_KEYS; every variable is explained in the file
npm run probe               # dry run: quote + sign, nothing submitted
npm run probe -- --live     # one real $10 buy + sell with the first wallet
npm run bot                 # run the bot
npm test                    # scheduling tests
```

Running it continuously on a server: [docs/deployment.md](docs/deployment.md).
