#!/usr/bin/env python3
"""Prod alerts to the Development Telegram group.

Run by cron every 5 minutes (see README-hetzner.md, "Alerts"). Checks the
containers, the two public endpoints, disk space, 5xx bursts and the nightly
backup. A check must fail twice in a row before it alerts, so a deploy's
restart (about a minute of 502s) never pages. Each problem posts once, and
once more when it clears. State: /var/lib/fibuki-alerts/state.json.

Reads TELEGRAM_BOT_TOKEN and TELEGRAM_DEV_CHAT_ID from the stack's .env;
without them it only prints. --dry-run prints instead of posting.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

STACK = "/opt/fibuki/deploy/selfhost"
STATE = "/var/lib/fibuki-alerts/state.json"
SERVICES = ["fibuki-api", "fibuki-web", "postgres", "caddy"]
ENDPOINTS = {"fibuki.com": "https://fibuki.com/", "API": "https://new-api.fibuki.com/healthz"}
DISK_PCT = 90
FIVEXX_PER_5MIN = 20
BACKUP_MAX_AGE_H = 26
FAILS_BEFORE_ALERT = 2
DRY_RUN = "--dry-run" in sys.argv


def env_file():
    out = {}
    try:
        with open(f"{STACK}/.env") as f:
            for line in f:
                if "=" in line and not line.lstrip().startswith("#"):
                    k, v = line.rstrip("\n").split("=", 1)
                    out[k.strip()] = v.strip().strip('"')
    except OSError:
        pass
    return out


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=60).stdout


def check_containers():
    problems = {}
    rows = {}
    for line in sh("docker", "compose", "-f", f"{STACK}/docker-compose.yml", "ps", "-a", "--format", "json").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        rows[row.get("Service")] = row
    for svc in SERVICES:
        row = rows.get(svc)
        if row is None:
            problems[f"container:{svc}"] = f"Container <b>{svc}</b> fehlt"
        elif row.get("State") != "running":
            problems[f"container:{svc}"] = f"Container <b>{svc}</b> ist {row.get('State')}"
        elif row.get("Health") == "unhealthy":
            problems[f"container:{svc}"] = f"Container <b>{svc}</b> ist unhealthy"
    return problems


def check_endpoints():
    problems = {}
    for name, url in ENDPOINTS.items():
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                status = r.status
        except urllib.error.HTTPError as e:
            status = e.code
        except Exception as e:  # timeout, DNS, TLS
            status = type(e).__name__
        if not isinstance(status, int) or status >= 500:
            problems[f"http:{name}"] = f"<b>{name}</b> antwortet nicht ({status})"
    return problems


def check_disk():
    u = shutil.disk_usage("/")
    # Same figure as `df`: the root-reserved blocks don't count as available.
    pct = round(u.used * 100 / (u.used + u.free))
    if pct >= DISK_PCT:
        return {"disk": f"Disk zu <b>{pct}%</b> voll ({u.free // 2**30} GB frei). <code>docker builder prune</code> hilft meist."}
    return {}


def check_5xx():
    n = 0
    # Caddy writes its access log to stderr.
    out = subprocess.run(["docker", "logs", "--since", "5m", "selfhost-caddy-1"], capture_output=True, text=True, timeout=60)
    for line in (out.stdout + out.stderr).splitlines():
        try:
            if int(json.loads(line).get("status", 0)) >= 500:
                n += 1
        except (ValueError, AttributeError):
            continue
    if n >= FIVEXX_PER_5MIN:
        return {"5xx": f"<b>{n}</b> Server-Fehler (5xx) in den letzten 5 Minuten"}
    return {}


def check_backup():
    problems = {}
    root = "/var/backups/fibuki"
    try:
        newest = max(os.path.getmtime(os.path.join(root, d)) for d in os.listdir(root))
        age_h = (time.time() - newest) / 3600
        if age_h > BACKUP_MAX_AGE_H:
            problems["backup"] = f"Letztes Backup ist <b>{age_h:.0f} h</b> alt"
    except (OSError, ValueError):
        problems["backup"] = "Kein Backup in /var/backups/fibuki gefunden"
    try:
        with open("/var/log/fibuki-restore-test.log") as f:
            tail = f.read()[-4000:]
        last = [l for l in tail.splitlines() if "RESTORE TEST" in l]
        if last and "PASSED" not in last[-1]:
            problems["restore-test"] = "Wöchentlicher <b>Restore-Test fehlgeschlagen</b>"
    except OSError:
        pass
    return problems


def send(env, text):
    print(text)
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_DEV_CHAT_ID")
    if DRY_RUN or not token or not chat:
        return
    body = json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML",
                       "link_preview_options": {"is_disabled": True}}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", body,
                                 {"content-type": "application/json"})
    urllib.request.urlopen(req, timeout=15).read()


def main():
    env = env_file()
    problems = {}
    for check in (check_containers, check_endpoints, check_disk, check_5xx, check_backup):
        try:
            problems.update(check())
        except Exception as e:
            problems[f"check:{check.__name__}"] = f"Check {check.__name__} ist abgestürzt: {type(e).__name__}"

    try:
        with open(STATE) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    fails, alerted = state.get("fails", {}), set(state.get("alerted", []))

    for key in problems:
        fails[key] = fails.get(key, 0) + 1
    for key in list(fails):
        if key not in problems:
            del fails[key]

    new = [k for k in problems if fails[k] >= FAILS_BEFORE_ALERT and k not in alerted]
    cleared = [k for k in alerted if k not in problems]

    if new:
        send(env, "🚨 <b>Prod-Problem</b>\n\n" + "\n".join(f"• {problems[k]}" for k in new))
        alerted.update(new)
    if cleared:
        send(env, "✅ <b>Wieder ok</b>\n\n" + "\n".join(f"• {k}" for k in cleared))
        alerted.difference_update(cleared)

    if DRY_RUN:
        print(json.dumps({"problems": problems, "fails": fails, "alerted": sorted(alerted)}, indent=2))
        return
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as f:
        json.dump({"fails": fails, "alerted": sorted(alerted)}, f)


if __name__ == "__main__":
    main()
