# Deploying the bot on Ubuntu 22.04 / 24.04

The bot runs as a **systemd** service: it starts with the server, restarts after a crash, and stops safely on `systemctl stop` (it sells back any NVDA it is holding before exiting). [`deploy.sh`](../deploy.sh) sets all of this up.

> **Run it in one place only.** Never run the bot on your own machine and on the server at the same time with the same wallets — the two processes would fight over balances and corrupt the daily trade count and loss budget.

## Quick deploy

```bash
git clone <repo-url> arcus-trading && cd arcus-trading
sudo ./deploy.sh
```

The service runs as the user that owns the checkout. For isolation, clone as a dedicated non-root user; cloning as `root` also works.

`deploy.sh` does the following, stopping on the first error:

1. Checks for Ubuntu 22.04 or 24.04 with systemd.
2. Finds Node.js 22 or newer — the checkout owner's newest **nvm** install first, then the system Node — and installs Node 22 LTS from NodeSource when neither is found.
3. Runs `npm ci` as the checkout owner.
4. Creates `.env` from [`.env.example`](../.env.example) when it is missing. That file holds the tuned defaults, each explained inline.
5. When `.env` has no valid `PRIVATE_KEYS`, prompts for keys one at a time with hidden input. Each key must be 64 hex characters (the `0x` is optional) and a valid secp256k1 key, and duplicates are rejected. The derived wallet address is shown for each key. Press Enter on an empty line to finish; the keys are then written to `.env` with mode `600`.
6. Dry-runs every wallet with `npm run probe -- --wallet N`, which quotes and signs without submitting. It warns when a wallet holds too little USDG to trade.
7. Renders [`deploy/arcus-bot.service`](../deploy/arcus-bot.service) for this server (paths, user, Node binary, time zone), then counts down 10 seconds before enabling and starting the service. Press Ctrl+C during the countdown to cancel and leave the service unchanged. If the service is already running, it is restarted, and the running bot finishes any open trade first.

The bot's time zone defaults to `Asia/Ho_Chi_Minh`, so `ACTIVE_HOURS_START/END` and the start of each day follow Vietnam time even when the server runs on UTC. Override it with `sudo BOT_TZ=Europe/London ./deploy.sh`.

## Updating

```bash
cd arcus-trading && git pull && sudo ./deploy.sh
```

Re-running reuses the keys in `.env` without prompting. `logs/state.json` is kept, so each wallet's daily trade count and loss budget carry on where they left off.

## Day-to-day operations

| Task | Command |
|---|---|
| Status | `systemctl status arcus-bot` |
| Follow logs | `journalctl -u arcus-bot -f` |
| Today's logs | `journalctl -u arcus-bot --since today` |
| Per-wallet overview | `jq 'to_entries[] \| {wallet: .key[0:10], volumeUsd: .value.volumeUsd, trades: .value.roundTrips, today: .value.day}' logs/state.json` |
| Individual swaps | `tail -n 20 logs/trades.jsonl` |
| Stop safely | `sudo systemctl stop arcus-bot` |
| Start again | `sudo systemctl start arcus-bot` |

After each trade, the bot logs a line like `trade 5/18 today | total rt=40 vol=$2320.10 loss=$3.1200 ...`. `loss` is the USDG spent since the wallet's first run. Use it to track budget pace: about $1.4/day for the $20-over-14-days target.

Once every wallet has hit a stop condition (it lost `MAX_LOSS_USD`, or its USDG dropped below `MIN_TRADE_USD`), the bot prints a summary and exits; systemd does **not** restart it in that case.

## Notes

- **Changing wallets or settings:** edit `.env`, then run `sudo systemctl restart arcus-bot`. Alternatively, empty `PRIVATE_KEYS` and re-run `deploy.sh` to enter the keys again.
- **Topping up / resetting the budget:** a wallet's budget baseline is its USDG balance on its first run, stored in `logs/state.json`. To start a wallet's budget over, run `systemctl stop`, delete that wallet's key from `state.json`, then run `start`.
- **Node upgrades through nvm:** the unit points at an absolute Node path, so re-run `deploy.sh` after installing a new version.
- **RPC:** the public Robinhood Chain RPC is used by default and is rate limited. If the logs show frequent RPC errors, set `RPC_URL` to a dedicated provider.
- **Security:** `.env` holds private keys, so keep it at mode `600` (`deploy.sh` enforces this). The service can only write to `logs/`, and it sees the rest of the system as read-only.
