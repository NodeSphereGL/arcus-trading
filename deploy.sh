#!/usr/bin/env bash
# Sets up and (re)starts the Arcus volume bot as a systemd service on Ubuntu 22.04 / 24.04.
# Run from the repo checkout: sudo ./deploy.sh   (safe to re-run after `git pull`)
#
# Steps: install Node.js 22+ when missing (an existing nvm install is reused), npm ci,
# create .env, prompt for private keys when .env has none, dry-run every wallet, then
# enable and (re)start the service after a 10 second countdown.
# The service runs as the owner of the checkout. Override the bot's time zone with BOT_TZ.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE=arcus-bot
UNIT_FILE="/etc/systemd/system/$SERVICE.service"
ENV_FILE="$APP_DIR/.env"
BOT_TZ="${BOT_TZ:-Asia/Ho_Chi_Minh}"
MIN_NODE_MAJOR=22
KEY_RE='^0x[0-9a-fA-F]{64}$'

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARN:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || exec sudo BOT_TZ="$BOT_TZ" bash "$0" "$@"

# --- environment checks ---------------------------------------------------------------
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} =~ ^(22\.04|24\.04)$ ]] ||
  die "unsupported OS: ${PRETTY_NAME:-unknown} (needs Ubuntu 22.04 or 24.04)"
command -v systemctl >/dev/null || die "systemd is required"
[[ -f $APP_DIR/package.json && -f $APP_DIR/deploy/$SERVICE.service ]] || die "run this script from the repo checkout"
[[ -e /usr/share/zoneinfo/$BOT_TZ ]] || die "unknown time zone BOT_TZ=$BOT_TZ"

OWNER="$(stat -c %U "$APP_DIR")"
id "$OWNER" >/dev/null 2>&1 || die "$APP_DIR is owned by a missing user (uid $(stat -c %u "$APP_DIR")); chown it to the user that should run the bot"
GROUP="$(id -gn "$OWNER")"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
TMP_UNIT=""
trap '[[ -n $TMP_UNIT ]] && rm -f "$TMP_UNIT"' EXIT

# --- Node.js ----------------------------------------------------------------------------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Prefers the checkout owner's newest nvm Node, then any system Node, if it is new enough.
find_node() {
  local -a candidates=()
  local c
  while IFS= read -r c; do candidates+=("$c"); done < <(
    ls -d "$OWNER_HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV
  )
  candidates+=(/usr/bin/node /usr/local/bin/node)
  for c in "${candidates[@]}"; do
    if [[ -x $c ]] && (($(node_major "$c") >= MIN_NODE_MAJOR)); then
      echo "$c"
      return 0
    fi
  done
  return 1
}

if ! NODE_BIN="$(find_node)"; then
  info "Installing Node.js 22 LTS from NodeSource"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  NODE_BIN="$(find_node)" || die "Node.js installation failed"
fi
NODE_DIR="$(dirname "$NODE_BIN")"
info "Node $("$NODE_BIN" -v) at $NODE_BIN | checkout $APP_DIR (owner $OWNER)"

# Runs a command as the checkout owner with the selected Node first on PATH.
as_owner() {
  if [[ $OWNER == root ]]; then
    env PATH="$NODE_DIR:$PATH" "$@"
  else
    sudo -u "$OWNER" -H env PATH="$NODE_DIR:$PATH" "$@"
  fi
}

info "Installing dependencies"
(cd "$APP_DIR" && as_owner npm ci --no-audit --no-fund --loglevel=error)

# --- .env and private keys --------------------------------------------------------------
if [[ ! -f $ENV_FILE ]]; then
  info "Creating .env from .env.example"
  install -m 600 -o "$OWNER" -g "$GROUP" "$APP_DIR/.env.example" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
install -d -o "$OWNER" -g "$GROUP" "$APP_DIR/logs"

# Last value of a .env variable, without quotes or whitespace.
env_value() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- | tr -d ' "\r'\'; }

# Prints the address of every key on stdin; keys travel over pipes, never on a command line.
derive_addresses() {
  (cd "$APP_DIR" && as_owner node --input-type=module -e '
    import { readFileSync } from "node:fs"
    import { privateKeyToAccount } from "viem/accounts"
    for (const key of readFileSync(0, "utf8").split(/[\s,]+/).filter(Boolean)) {
      console.log(privateKeyToAccount(key).address)
    }') 2>/dev/null
}

# Checks a comma-separated key list; on success sets ADDRESSES (one per line).
validate_keys() {
  local -a keys
  local key other seen=","
  IFS=, read -ra keys <<<"$1"
  ((${#keys[@]})) || return 1
  for key in "${keys[@]}"; do
    [[ $key =~ $KEY_RE ]] || return 1
    other="${key,,}"
    [[ $seen == *",$other,"* ]] && return 1
    seen+="$other,"
  done
  ADDRESSES="$(printf '%s' "$1" | derive_addresses)" || return 1
}

# Reads keys from the terminal (hidden) until an empty line; sets NEW_KEYS.
prompt_keys() {
  [[ -r /dev/tty ]] || die "no valid PRIVATE_KEYS in $ENV_FILE and no terminal to prompt on"
  local -a keys=()
  local key addr k dup
  printf '\n\033[1mEnter wallet private keys (input is hidden). Press Enter on an empty line when done.\033[0m\n'
  while :; do
    read -rs -p "  Private key #$((${#keys[@]} + 1)): " key </dev/tty
    printf '\n'
    key="${key//[[:space:]]/}"
    if [[ -z $key ]]; then
      ((${#keys[@]})) && break
      warn "at least one key is required"
      continue
    fi
    [[ ${key,,} == 0x* ]] && key="${key:2}"
    key="0x$key"
    if [[ ! $key =~ $KEY_RE ]]; then
      warn "invalid key: expected 64 hex characters (0x prefix optional)"
      continue
    fi
    dup=0
    for k in "${keys[@]}"; do [[ ${k,,} == "${key,,}" ]] && dup=1; done
    if ((dup)); then
      warn "duplicate key, skipped"
      continue
    fi
    if ! addr="$(printf '%s' "$key" | derive_addresses)"; then
      warn "not a valid secp256k1 private key"
      continue
    fi
    info "wallet #$((${#keys[@]} + 1)) -> $addr"
    keys+=("$key")
  done
  NEW_KEYS="$(IFS=,; printf '%s' "${keys[*]}")"
}

# Replaces PRIVATE_KEYS (and any legacy PRIVATE_KEY line) in .env, keeping everything else.
write_keys() {
  local tmp line found=0
  tmp="$(mktemp "$APP_DIR/.env.XXXXXX")"
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == PRIVATE_KEYS=* ]]; then
      ((found)) || printf 'PRIVATE_KEYS=%s\n' "$1"
      found=1
    elif [[ $line != PRIVATE_KEY=* ]]; then
      printf '%s\n' "$line"
    fi
  done <"$ENV_FILE" >"$tmp"
  ((found)) || printf 'PRIVATE_KEYS=%s\n' "$1" >>"$tmp"
  chmod 600 "$tmp"
  chown "$OWNER:$GROUP" "$tmp"
  mv "$tmp" "$ENV_FILE"
}

EXISTING="$(env_value PRIVATE_KEYS)"
[[ -n $EXISTING ]] || EXISTING="$(env_value PRIVATE_KEY)"
if [[ -n $EXISTING ]] && validate_keys "$EXISTING"; then
  info "Using private keys from .env"
else
  [[ -n $EXISTING ]] && warn ".env contains malformed or duplicate private keys; enter them again"
  prompt_keys
  validate_keys "$NEW_KEYS" || die "key validation failed"
  write_keys "$NEW_KEYS"
  info "Saved $(wc -l <<<"$ADDRESSES") key(s) to .env (mode 600)"
fi
unset EXISTING NEW_KEYS
mapfile -t WALLETS <<<"$ADDRESSES"

# --- dry run ----------------------------------------------------------------------------
info "Dry run for ${#WALLETS[@]} wallet(s): quote + sign, nothing is submitted"
LOW=()
for i in "${!WALLETS[@]}"; do
  n=$((i + 1))
  if ! out="$(cd "$APP_DIR" && as_owner npm run -s probe -- --wallet "$n" 2>&1)"; then
    sed 's/^/    /' <<<"$out"
    die "dry run failed for wallet #$n (${WALLETS[$i]})"
  fi
  printf '  #%d %s\n' "$n" "$(grep -m1 -E '^  USDG' <<<"$out" | sed 's/^ *//')"
  grep -q 'insufficient USDG' <<<"$out" && LOW+=("#$n")
done
((${#LOW[@]} == 0)) || warn "wallet(s) ${LOW[*]} hold too little USDG and will stop right away until topped up"

# --- systemd unit -----------------------------------------------------------------------
PROTECT_HOME=true
[[ $APP_DIR == /home/* || $APP_DIR == /root/* || $NODE_BIN == /home/* || $NODE_BIN == /root/* ]] &&
  PROTECT_HOME=read-only
TMP_UNIT="$(mktemp --suffix=.service)"
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@USER@|$OWNER|g" -e "s|@GROUP@|$GROUP|g" \
  -e "s|@NODE_DIR@|$NODE_DIR|g" -e "s|@TZ@|$BOT_TZ|g" -e "s|@PROTECT_HOME@|$PROTECT_HOME|g" \
  "$APP_DIR/deploy/$SERVICE.service" >"$TMP_UNIT"
systemd-analyze verify "$TMP_UNIT" || die "rendered unit failed systemd-analyze verify"

# --- countdown and start ----------------------------------------------------------------
if systemctl is-active --quiet "$SERVICE"; then
  ACTION=restart
  NOTE="restart (the running bot finishes any open trade first)"
else
  ACTION=start
  NOTE="start"
fi
printf '\nDry run OK. The service will %s.\n' "$NOTE"
trap 'printf "\n"; warn "cancelled; the service was left unchanged"; exit 130' INT
for ((s = 10; s > 0; s--)); do
  printf '\r\033[1m%s %s in %2ds\033[0m  (Ctrl+C to cancel) ' "${ACTION^}ing" "$SERVICE" "$s"
  sleep 1
done
printf '\r\033[K'
trap - INT

install -m 644 "$TMP_UNIT" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
info "${ACTION^}ing $SERVICE"
systemctl "$ACTION" "$SERVICE"
sleep 3

if ! systemctl is-active --quiet "$SERVICE"; then
  if [[ $(systemctl show -p Result --value "$SERVICE") == success ]]; then
    journalctl -u "$SERVICE" -n 15 --no-pager -o cat
    warn "the bot exited cleanly: every wallet already meets a stop condition (see summary above)"
    exit 0
  fi
  journalctl -u "$SERVICE" -n 30 --no-pager
  die "$SERVICE failed to start"
fi

journalctl -u "$SERVICE" -n 10 --no-pager -o cat
printf '\n\033[32m%s is running\033[0m and starts automatically on boot.\n' "$SERVICE"
printf '  Follow logs:  journalctl -u %s -f\n  Stop safely:  systemctl stop %s\n' "$SERVICE" "$SERVICE"
