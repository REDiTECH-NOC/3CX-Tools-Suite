# 3CX Tools Suite

Three independent tools for real-time 3CX PBX monitoring and automation.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Host                              │
│                                                                 │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐            │
│  │  Wallboard   │  │ Postgres │  │  Auto-Pager   │            │
│  │  :4200       │  │  :5432   │  │  :3001        │            │
│  │  WS :3100    │  │          │  │  SIP :5060    │            │
│  └──────┬───────┘  └──────────┘  └───────┬───────┘            │
│         │                                 │                     │
└─────────┼─────────────────────────────────┼─────────────────────┘
          │  WebSocket (persistent)         │  HTTP POST (on change)
          │                                 │
┌─────────┴─────────────────────────────────┴─────────────────────┐
│                        3CX PBX Server                           │
│                                                                 │
│  ┌──────────────────────────────────────┐                      │
│  │        Relay Agent (systemd)         │                      │
│  │  Polls ActiveCalls every 750ms       │                      │
│  │  MyPhone WS for agent login/logout   │                      │
│  │  Report API every 30s               │                      │
│  └──────────────────────────────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

| Tool | Purpose | Runs On | Port(s) |
|------|---------|---------|---------|
| **Wallboard** | Real-time queue dashboard + analytics | Docker | 4200, 3100 (WS) |
| **Auto-Pager** | Queue overflow auto-paging via Asterisk | Docker | 3001, 5060 (SIP) |
| **Relay Agent** | PBX-local data collector, pushes to wallboard + auto-pager | PBX (systemd) | none |

---

## Quick Start

### 1. Deploy Wallboard + Auto-Pager (Docker Host)

```bash
git clone https://github.com/REDiTECH-NOC/3CX-Tools-Suite.git
cd 3CX-Tools-Suite

# Create .env from example
cp .env.example .env

# Edit — set real passwords (generate with: openssl rand -hex 24)
nano .env
```

**.env required values:**
```
POSTGRES_PASSWORD=<strong random password>
ENCRYPTION_KEY=<32+ char random string>
ENCRYPTION_SALT=<random string>
SESSION_SECRET=<random string>
ADMIN_EXTENSIONS=100,101
```

```bash
# Start everything
docker compose up -d

# Or start tools independently:
docker compose up -d wallboard db    # Wallboard only
docker compose up -d auto-pager     # Auto-Pager only
```

### 2. Configure Wallboard

1. Open `http://<docker-host>:4200`
2. Complete the setup wizard (PBX URL, admin extension, password)
3. Go to **Admin > Settings** and generate a **Relay API Key** — copy it

### 3. Configure Auto-Pager

1. Open `http://<docker-host>:3001`
2. Enter PBX connection details (URL, extension, password)
3. Add monitored queues with thresholds and paging extensions
4. Configure SIP trunk for Asterisk originate
5. Enable relay mode (so it uses the relay agent instead of polling):

```bash
curl -X PUT http://<docker-host>:3001/api/relay/config \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "apiKey": "your-auto-pager-relay-key"}'
```

### 4. Install Relay Agent on PBX

```bash
# SSH into the 3CX PBX, then:
curl -sSL https://raw.githubusercontent.com/REDiTECH-NOC/3CX-Tools-Suite/main/relay-agent/install.sh | sudo bash
```

The interactive installer will prompt for:

| Prompt | Example | Notes |
|--------|---------|-------|
| Wallboard URL | `https://10.0.1.225:4200` | Your Docker host |
| Relay API key | `wb_relay_abc123...` | From wallboard admin settings |
| PBX URL | `https://localhost:5001` | Default for local 3CX |
| PBX extension | `100` | Needs admin API access |
| PBX password | *(hidden input)* | Extension's web client password |
| Auto-Pager URL | `http://10.0.1.225:3001` | Optional — press Enter to skip |
| Auto-Pager key | `ap_relay_xyz789...` | Required if auto-pager URL set |
| Poll interval | `750` | Default 750ms, rarely needs changing |
| Log level | `info` | Use `debug` for troubleshooting |

You can also run non-interactively:

```bash
sudo ./install.sh \
  --wallboard-url https://10.0.1.225:4200 \
  --api-key wb_relay_abc123 \
  --pbx-url https://localhost:5001 \
  --pbx-ext 100 \
  --pbx-pass secret \
  --autopager-url http://10.0.1.225:3001 \
  --autopager-key ap_relay_xyz789
```

---

## Relay Agent Management

The relay agent runs as a systemd service called `3cx-relay`.

### Service Commands

```bash
# Check if running
systemctl status 3cx-relay

# Start / stop / restart
sudo systemctl start 3cx-relay
sudo systemctl stop 3cx-relay
sudo systemctl restart 3cx-relay

# Enable/disable auto-start on boot
sudo systemctl enable 3cx-relay
sudo systemctl disable 3cx-relay
```

### Viewing Logs

```bash
# Last 50 lines
journalctl -u 3cx-relay -n 50

# Follow live (Ctrl+C to stop)
journalctl -u 3cx-relay -f

# Logs since last boot
journalctl -u 3cx-relay -b

# Logs from last hour
journalctl -u 3cx-relay --since "1 hour ago"

# Filter errors only
journalctl -u 3cx-relay -p err
```

### Healthy Log Output

When running correctly you'll see:

```
[Relay] PBX authentication successful
[Relay] Found 20 queues, 53 users
[Relay] Loaded agent memberships: 87 total across 20 queues
[Relay] Connecting to wallboard via WebSocket...
[Relay] Starting PBX queue monitor...
[Monitor] WebSocket connected
[Relay] Starting fast poll loop (750ms)
[Relay] ws=connected mon=active polls=40 pushes=5 queues=20 agents=53 autopager=active
```

Status line meaning:
- `ws=connected` — WebSocket to wallboard is live
- `mon=active` — PBX MyPhone WebSocket is receiving agent login/logout events
- `polls=40` — ActiveCalls API calls since last status (40 polls in 30s = 750ms interval)
- `pushes=5` — State changes pushed to wallboard (only pushes when data changes)
- `autopager=active` — HTTP pushes to auto-pager working (`auth-failed` = bad API key, `n/a` = not configured)

### Editing Configuration

```bash
# View current config
sudo cat /etc/3cx-relay/config.json

# Edit config
sudo nano /etc/3cx-relay/config.json

# Restart to apply changes
sudo systemctl restart 3cx-relay
```

**Config fields:**

```json
{
  "wallboardUrl": "https://10.0.1.225:4200",
  "apiKey": "your-wallboard-relay-key",
  "pbxUrl": "https://localhost:5001",
  "pbxExtension": "100",
  "pbxPassword": "extension-password",
  "pollIntervalMs": 750,
  "logLevel": "info",
  "autoPagerUrl": "http://10.0.1.225:3001",
  "autoPagerApiKey": "your-auto-pager-relay-key"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `wallboardUrl` | *(required)* | Wallboard HTTP URL |
| `apiKey` | *(required)* | Relay API key from wallboard admin |
| `pbxUrl` | *(required)* | 3CX PBX URL (use localhost if on the PBX) |
| `pbxExtension` | *(required)* | Extension number with admin API access |
| `pbxPassword` | *(required)* | Extension's web client password |
| `pollIntervalMs` | `750` | How often to poll ActiveCalls (ms) |
| `logLevel` | `info` | `debug`, `info`, `warn`, or `error` |
| `autoPagerUrl` | *(optional)* | Auto-pager HTTP URL for push delivery |
| `autoPagerApiKey` | *(optional)* | API key for auto-pager authentication |

### Uninstalling

```bash
# Interactive uninstall (confirms before removing)
curl -sSL https://raw.githubusercontent.com/REDiTECH-NOC/3CX-Tools-Suite/main/relay-agent/uninstall.sh | sudo bash
```

This removes the systemd service, `/opt/3cx-relay/`, and `/etc/3cx-relay/`. Does NOT remove Node.js.

---

## Docker Management

### Container Commands

```bash
cd /path/to/3CX-Tools-Suite

# Status
docker compose ps

# Logs
docker compose logs wallboard -f     # Wallboard logs (follow)
docker compose logs auto-pager -f    # Auto-Pager logs
docker compose logs db -f            # PostgreSQL logs

# Restart a single service
docker compose restart wallboard
docker compose restart auto-pager

# Stop everything
docker compose down

# Stop and remove volumes (DELETES ALL DATA)
docker compose down -v
```

### Rebuilding After Code Changes

```bash
# Pull latest code
git pull

# Rebuild and restart (zero-downtime for DB)
docker compose up -d --build

# Rebuild a single service
docker compose up -d --build wallboard
docker compose up -d --build auto-pager
```

### Database Access

```bash
# Connect to PostgreSQL
docker compose exec db psql -U wallboard

# Backup database
docker compose exec db pg_dump -U wallboard wallboard > backup.sql

# Restore database
cat backup.sql | docker compose exec -T db psql -U wallboard wallboard
```

### Auto-Pager API

```bash
# Check status (includes relay status)
curl http://<host>:3001/api/status

# View monitored queues
curl http://<host>:3001/api/monitored-queues

# View page log
curl http://<host>:3001/api/page-log?limit=20

# Check relay status
curl http://<host>:3001/api/relay/status

# Enable/disable relay mode
curl -X PUT http://<host>:3001/api/relay/config \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "apiKey": "your-key"}'

# Test page a specific queue
curl -X POST http://<host>:3001/api/test-page \
  -H 'Content-Type: application/json' \
  -d '{"queue_number": "8003"}'

# Get PBX queues (for setup)
curl http://<host>:3001/api/pbx-queues
```

---

## Troubleshooting

### Relay Agent Won't Connect to Wallboard

```bash
# Check logs for connection errors
journalctl -u 3cx-relay -n 20

# Common issues:
# - "Auth failed (4001)" → API key is wrong, regenerate in wallboard admin
# - "ECONNREFUSED" → Wallboard isn't running or wrong URL/port
# - "ETIMEDOUT" → Firewall blocking port 3100 (WebSocket) or 4200 (HTTP)
```

**Fix:** Verify wallboard is accessible from the PBX:
```bash
curl -k https://<docker-host>:4200   # Should return HTML
```

### Relay Agent Can't Authenticate with PBX

```bash
# Test PBX API access manually
curl -k -X POST https://localhost:5001/webclient/api/Login/GetAccessToken \
  -H 'Content-Type: application/json' \
  -d '{"Username":"100","Password":"your-pass","SecurityCode":""}'

# Should return: {"Status":"AuthSuccess","Token":{"access_token":"..."}}
```

**Common issues:**
- Wrong extension password
- Extension doesn't have admin API permissions in 3CX
- PBX URL wrong (check if HTTPS port is 5001 or different)

### Wallboard Stuck in "POLLING" Mode

The wallboard shows "POLLING" instead of "LIVE" when relay data is stale (>15s old).

```bash
# Check relay agent is running and pushing
journalctl -u 3cx-relay -f

# Look for: "ws=connected" and "pushes=X" (X should be > 0)
# If ws=disconnected, check firewall for port 3100
```

### Auto-Pager Not Receiving Relay Data

```bash
# Check relay status on auto-pager
curl http://<host>:3001/api/relay/status

# Should show: {"enabled":true,"hasFreshData":true,...}

# If hasFreshData is false:
# 1. Check relay agent logs for auto-pager push errors
# 2. Verify autoPagerUrl in /etc/3cx-relay/config.json
# 3. Verify API key matches between relay config and auto-pager
```

### Asterisk/SIP Issues (Auto-Pager)

```bash
# Check Asterisk is running inside the container
docker compose exec auto-pager asterisk -rx "core show version"

# Check SIP registration
docker compose exec auto-pager asterisk -rx "pjsip show registrations"

# Check active channels
docker compose exec auto-pager asterisk -rx "core show channels"
```

---

## Ports Reference

| Port | Protocol | Service | Purpose |
|------|----------|---------|---------|
| 4200 | TCP | Wallboard | Web UI + API |
| 3100 | TCP | Wallboard | WebSocket (relay agent connection) |
| 5432 | TCP | PostgreSQL | Database (internal, not exposed by default) |
| 3001 | TCP | Auto-Pager | Web UI + API + relay push endpoint |
| 5060 | UDP | Auto-Pager | SIP (Asterisk → PBX for paging calls) |

### Firewall Rules

**Docker host** needs inbound:
- `4200/tcp` — wallboard web UI (from browsers)
- `3100/tcp` — relay WebSocket (from PBX)
- `3001/tcp` — auto-pager web UI (from browsers) + relay push (from PBX)
- `5060/udp` — SIP (from/to PBX for paging)

**PBX** needs outbound:
- `3100/tcp` — WebSocket to wallboard
- `3001/tcp` — HTTP POST to auto-pager (if configured)

---

## File Locations

### Docker Host
```
3CX-Tools-Suite/
├── .env                    # Environment variables (secrets)
├── docker-compose.yml      # Container orchestration
├── wallboard/              # Wallboard source
├── auto-pager/             # Auto-Pager source
└── relay-agent/            # Relay agent source (for reference)
```

### PBX (Relay Agent)
```
/opt/3cx-relay/             # Compiled JavaScript + node_modules
/etc/3cx-relay/config.json  # Configuration (chmod 600)
/etc/systemd/system/3cx-relay.service  # systemd unit file
```
