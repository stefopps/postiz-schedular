# Postiz Scheduler — Agent Runbook (read this first)

This is the **accurate, current** description of how Steve's local Postiz runs.
If anything here conflicts with `HOW_THIS_WORKS.md`, **this file wins** (that older
doc describes the all-in-one Docker image on `:4007`, which is NOT what runs here).

Last verified: 2026-07-01.

---

## 0. RULE: back up before you overwrite a post (version control)

Steve edits posts directly in the Postiz UI. **Never blindly recreate/overwrite a post
from a script's hardcoded text** — you may revert his hand edits (this happened once on the
Fri Jul 3 post). Before any delete+recreate or content overwrite:

1. **Snapshot the current live content first** into a text doc next to the post
   (e.g. `scheduled/<week>/<slot>/_VERSIONS.md`, newest entry on top, with a timestamp).
2. Prefer **editing the existing post** (DB `UPDATE ... SET content` / `image`, or the API
   update endpoint) over delete+recreate, so the post id and any UI edits survive.
3. If you must recreate, **pull the latest content from the DB first** and carry it forward;
   do not trust the text baked into an old `.ps1`.

Recovery: Postiz **soft-deletes** (sets `"deletedAt"`), so prior versions are still in the
`Post` table. To see every version of a slot (including ones you "deleted"):

```sql
SELECT id, "createdAt", "deletedAt", content
FROM "Post" WHERE "publishDate" = '<UTC timestamp>' ORDER BY "createdAt";
```

To restore one without retyping (no encoding risk), copy content row-to-row:

```sql
UPDATE "Post" SET content = (SELECT content FROM "Post" WHERE id='<good-id>')
WHERE id='<live-id>';
```

UI edits are stored as **HTML** (`<p>`, `<strong>`); script-created posts are plain text
with Unicode bold. Both publish fine — just don't let one clobber the other silently.

---

## 1. Architecture — it is a SOURCE BUILD, not the all-in-one image

Postiz runs as **four separate parts**. Three are Node processes on the host, one is Docker:

| Part | How it runs | Port | Notes |
|------|-------------|------|-------|
| **Postgres + Redis + Temporal** | Docker (`postiz-app/docker-compose.yaml`) | Postgres **5432**, Temporal 7233 | data lives in volume `postiz-app_postgres-volume` |
| **Backend** (NestJS) | Node, **under PM2** (`postiz-backend`) | **3000** | prod build |
| **Frontend** (Next.js, **production** `next start`) | Node, **under PM2** (`postiz-frontend`) | **4200** | **this is the UI Steve opens** |
| **Orchestrator** (Temporal worker) | Node, **under PM2** (`postiz-orchestrator`) | none | actually **publishes** scheduled posts at their time |

The three Node parts run as **one supervised unit under PM2** (`postiz-app/ecosystem.config.js`),
in **production** mode, with **auto-restart** if any part crashes or wedges. Docker is managed
separately by `docker compose`. We do NOT run the all-in-one image and we do NOT use Next dev
mode (dev mode = slow / blank-modal; we deliberately moved off it).

> The UI is **http://localhost:4200**, NOT 4007. There is no all-in-one container in use.

Credentials / connection facts:
- `DATABASE_URL` (in `postiz-app/.env`): `postgresql://postiz-local:postiz-local-pwd@localhost:5432/postiz-db-local`
- The backend runs **on the host** and reaches Postgres over **`localhost:5432`**, so the
  Postgres container **must publish port 5432 to the host**.
- App login (for API scripts): `steven.oppong@gmail.com` (password in `.postiz-credentials.env`).

---

## 2. Launching everything

One command brings the whole stack up (idempotent — leaves healthy apps alone):

```
Double-click:  C:\dev\Schedular\Launch Postiz.bat
or:            powershell -ExecutionPolicy Bypass -File C:\dev\Schedular\launch-postiz.ps1
```

It does: Docker (postgres/redis/temporal) -> **DB reachability guard** -> `pm2 start ecosystem.config.js`
(backend + frontend + orchestrator) -> status -> opens the UI. Use `-NoBrowser` for headless.

### PM2 — the apps run as one supervised unit
```powershell
pm2 status            # see all three apps (online / restarts / uptime)
pm2 logs              # tail all logs ; pm2 logs postiz-frontend for one
pm2 restart all       # or: pm2 restart postiz-backend
pm2 stop all          # stop the apps (Docker stays up)
pm2 save              # remember the current set
```
PM2 **auto-restarts** any app that crashes/wedges (this is what prevents the earlier
black-screen-on-wedged-frontend problem). Config: `postiz-app/ecosystem.config.js`.

### Boot persistence (survives reboots)
`pm2 startup` is NOT supported on Windows, so persistence is handled two ways, both running
`launch-postiz.ps1 -NoBrowser` (which does Docker + DB guard + `pm2 start`):
- **Startup folder** (per-login, no admin): `…\Start Menu\Programs\Startup\Postiz Startup.bat`
- **"Postiz Morning Wake" scheduled task** (daily, wake-to-run) -> runs `ensure-postiz-up.ps1`,
  which now delegates to the same launcher.

To change the morning wake time (needs an elevated shell):
```powershell
Set-ScheduledTask -TaskName "Postiz Morning Wake" -Trigger (New-ScheduledTaskTrigger -Daily -At 7:30AM)
```

---

## 3. !!! CRITICAL GOTCHA — do not silently break the database !!!

**Symptom:** UI loads black/blank, login returns 400/401, backend logs
`Can't reach database server at localhost:5432`.

**Root cause (happened 2026-06-26):** running `docker compose up -d` recreated the
`postiz-postgres` container. The stock compose file **did not publish port 5432** to the
host (and listed the wrong credentials). The recreated container came back **without the
host port**, so the host backend could no longer reach the DB. The UI went black because
no data loads when the backend has no database.

**The fix that is now in place:** `postiz-app/docker-compose.yaml` `postiz-postgres` service
now has:
```yaml
    environment:
      POSTGRES_PASSWORD: postiz-local-pwd
      POSTGRES_USER: postiz-local
      POSTGRES_DB: postiz-db-local
    ports:
      - "5432:5432"        # <-- REQUIRED. Host backend connects via localhost:5432.
```
Keep that `ports:` mapping. **Never remove it.** With it, `docker compose up` is safe.

**Important:** the data volume (`postiz-app_postgres-volume`) was initialized with the
`postiz-local` user. Postgres ignores `POSTGRES_USER`/`POSTGRES_DB` env once the volume has
data, so the real superuser inside is **`postiz-local`**, DB **`postiz-db-local`**.

---

## 4. If the DB connection breaks again — recovery (data is safe in the volume)

```powershell
# 1. Is the host port published? (should list 0.0.0.0:5432)
docker port postiz-postgres

# 2. If 5432 is missing, make sure docker-compose.yaml has the ports mapping (section 3),
#    then recreate ON THE SAME VOLUME (data persists):
cd C:\dev\Schedular\postiz-app
docker compose up -d postiz-postgres

# 3. Confirm host 5432 is up
Test-NetConnection localhost -Port 5432

# 4. Confirm the data is intact (uses the real superuser postiz-local):
"SELECT count(*) FROM \"Post\";" | docker exec -i postiz-postgres psql -U postiz-local -d postiz-db-local

# 5. Restart the backend so Prisma reconnects (apps run under PM2):
pm2 restart postiz-backend
```

---

## 5. Inspect the schedule without the UI (read straight from the DB)

```powershell
@'
SELECT to_char("publishDate",'Dy Mon DD HH24:MI') AS when_utc, state,
       CASE WHEN image IS NULL OR image::text='[]' THEN 'text' ELSE 'image' END AS media,
       left(regexp_replace(content,'\s+',' ','g'),50) AS preview
FROM "Post" WHERE "deletedAt" IS NULL AND "publishDate" >= now()::date
ORDER BY "publishDate";
'@ | docker exec -i postiz-postgres psql -U postiz-local -d postiz-db-local
```

`state = QUEUE` means scheduled and waiting. The **orchestrator** (part 4) publishes it at
`publishDate` (stored in UTC; 13:00 UTC = 09:00 ET).

---

## 6. Image uploads gotcha (fixed 2026-06-26)

Local uploads are stored under `C:/dev/Schedular/content/uploads` and are served by the
frontend only at **`/api/uploads/...`** (the bare `/uploads/...` path returns 404 in
production `next start`). When attaching images to posts via the API, use the
`http://localhost:4200/api/uploads/...` URL, not `/uploads/...`, or the image will be blank
in preview and fail to publish.

---

## 7. Content source of truth

The LinkedIn posts (copy + images, organized by week) live at:
`C:\Users\steve\MeWorld\game\linkedin\` — see its `README.md`. Each scheduled post folder
carries its `postiz_post_id` so the markdown and the Postiz queue stay linked.

---

## 8. Arc-Viz → Postiz Sync Bridge (state-server.js)

The `state-server.js` running on port **9801** now auto-pushes posts to Postiz the moment
you mark them "ready" with a LinkedIn take selected in `arc-viz.html`.

### How it works

1. In `arc-viz.html`, mark a post status as **"Ready"** and click the **LI** badge next to
   the take you want (`Original` / `My Read` / `Fused`).
2. `arc-viz.html` auto-saves state to `http://127.0.0.1:9801/save`.
3. `state-server.js` detects `status=ready` + `linkedinTake=original|spoken|fused` and
   pushes it to Postiz via the API automatically:
   - Uploads the post's media (image or video) if present
   - Creates a scheduled post at the correct UTC datetime
   - Marks it as synced to prevent duplicates
4. Run: `node C:\dev\Schedular\state-server.js`

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/save` | POST | arc-viz auto-saves state — triggers sync if new ready+LI posts exist |
| `/ready` | GET | Lists posts marked "ready" with their linkedinTake and sync status |
| `/sync-status` | GET | Shows which post indices have been pushed to Postiz |
| `/sync-now` | POST | Manually triggers a sync of all pending ready+LI posts |
| `/latest` | GET | Most recent state snapshot |
| `/upload-image` | POST | Drag-and-drop image upload from arc-viz |

### Postiz credentials for API

```
API Base: http://localhost:3000
Integration ID: cmquj5fvl00011t1w3auhpuqb (LinkedIn)
Auth: login to /auth/login, extract auth cookie
```

### DB access (for direct edits)

```
Host: localhost:5432
User: postiz-local
Password: postiz-local-pwd
Database: postiz-db-local
```

### Current schedule

Posts run weekdays only. Arc starts **Wed Jul 1** (Two worlds, PUBLISHED) through
**Wed Aug 12** (31 posts, no weekends).
