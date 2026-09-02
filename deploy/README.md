# Deploy

Single VPS, Docker Compose, Caddy for TLS, Postgres on Supabase (session pooler, port 5432).

```bash
# on the VPS
mkdir -p /opt/webmcp-workout
# app.env: DATABASE_URL, NEXT_PUBLIC_*, APP_TIMEZONE  (never committed)
# Caddyfile: copy deploy/Caddyfile, replace {$SITE_HOST} with the public hostname
docker build -t webmcp-workout:latest .
docker compose -f deploy/docker-compose.yml up -d
```
