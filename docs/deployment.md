# Deploying the bot on Ubuntu 22.04

The bot runs as a **systemd** service: it starts with the server, restarts after a crash, and stops safely on `systemctl stop` (it sells back any NVDA it is holding before exiting).

Unit file: [`deploy/arcus-bot.service`](../deploy/arcus-bot.service). This guide installs into `/opt/arcus` and runs as a dedicated `arcus` user.

> **Run it in one place only.** Never run the bot on your own machine and on the server at the same time with the same wallets — the two processes would fight over balances and corrupt the daily trade count and loss budget.

## 1. Install Node.js 22

Ubuntu 22.04 ships Node v12, which is too old. Install 22 LTS from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs jq
node -v   # must be >= v22
```

## 2. Create the user and directory

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin arcus
sudo mkdir -p /opt/arcus/logs
sudo chown -R arcus:arcus /opt/arcus
```

## 3. Copy the code to the server

From your machine, inside the project directory (skipping `node_modules`, `.env` and `logs`):

```bash
rsync -av --exclude node_modules --exclude .env --exclude logs --exclude .git \
  ./ USER@SERVER:/tmp/arcus/
```

On the server:

```bash
sudo rsync -a /tmp/arcus/ /opt/arcus/ && rm -rf /tmp/arcus
sudo chown -R arcus:arcus /opt/arcus
cd /opt/arcus && sudo -u arcus npm ci
```

If the repo is pushed to a git remote, you can use git instead of rsync (the target directory must be empty):

```bash
sudo rm -rf /opt/arcus/logs
sudo -u arcus git clone <repo-url> /opt/arcus
sudo -u arcus mkdir -p /opt/arcus/logs
cd /opt/arcus && sudo -u arcus npm ci
```

## 4. Create `.env`

Create it directly on the server; never send private keys over chat or email:

```bash
sudo -u arcus cp /opt/arcus/.env.example /opt/arcus/.env
sudo -u arcus nano /opt/arcus/.env     # set PRIVATE_KEYS=0x...,0x...
sudo chmod 600 /opt/arcus/.env
```

Every setting and its default is documented in [`.env.example`](../.env.example).

## 5. Check before starting

A dry run fetches a quote and signs for a wallet **without submitting anything**:

```bash
cd /opt/arcus && sudo -u arcus npm run probe
sudo -u arcus npm run probe -- --wallet 2    # repeat for each wallet
```

Each wallet should show the expected address and a USDG balance above `MIN_TRADE_USD`.

## 6. Install and enable the service

```bash
sudo cp /opt/arcus/deploy/arcus-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arcus-bot
```

`enable` starts the bot again after every reboot; `--now` also starts it immediately.

## Day-to-day operations

| Task | Command |
|---|---|
| Status | `systemctl status arcus-bot` |
| Follow logs | `journalctl -u arcus-bot -f` |
| Today's logs | `journalctl -u arcus-bot --since today` |
| Per-wallet overview | `jq 'to_entries[] \| {wallet: .key[0:10], volumeUsd: .value.volumeUsd, trades: .value.roundTrips, today: .value.day}' /opt/arcus/logs/state.json` |
| Individual swaps | `tail -n 20 /opt/arcus/logs/trades.jsonl` |
| Stop safely | `sudo systemctl stop arcus-bot` |
| Start again | `sudo systemctl start arcus-bot` |

After each trade the bot logs a line like `trade 5/18 today | total rt=40 vol=$2320.10 loss=$3.1200 ...`. `loss` is the USDG spent since the wallet's first run; use it to track budget pace (about $1.4/day for the $20-over-14-days target).

Once every wallet has hit a stop condition (lost `MAX_LOSS_USD`, or USDG below `MIN_TRADE_USD`), the bot prints a summary and exits; systemd does **not** restart it in that case.

## Updating the code

```bash
sudo systemctl stop arcus-bot          # waits for any open trade to finish (up to 3 minutes)
# copy the new code as in step 3, then:
cd /opt/arcus && sudo -u arcus npm ci
sudo systemctl start arcus-bot
```

`logs/state.json` is kept, so each wallet's daily trade count and loss budget carry on where they left off.

## Notes

- **Time zone:** the unit sets `TZ=Asia/Ho_Chi_Minh`, so `ACTIVE_HOURS_START/END` and the start of each day follow Vietnam time even when the server runs on UTC. To use another zone, change the `Environment=TZ=...` line, then `daemon-reload` and restart.
- **Topping up / resetting the budget:** a wallet's budget baseline is its USDG balance on its first run, stored in `logs/state.json`. To start a wallet's budget over: `systemctl stop`, delete that wallet's key from `state.json`, then `start`.
- **Adding or removing wallets:** edit `PRIVATE_KEYS` in `.env`, then `sudo systemctl restart arcus-bot`.
- **RPC:** the public Robinhood Chain RPC is used by default and is rate limited. If the logs show frequent RPC errors, set `RPC_URL` to a dedicated provider.
- **Security:** `.env` holds private keys — keep it at mode `600`, readable only by `arcus`. The service runs without root and can only write to `/opt/arcus/logs`.
