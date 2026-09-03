# Deploy

One VPS, Docker Compose, Postgres in the same stack, Caddy for TLS. The app is
a standalone Next.js server (`Dockerfile`) that needs exactly one thing from
outside: `DATABASE_URL`. Every visitor's workspace is a schema inside that one
database, created on first visit, so there is nothing to migrate or seed by
hand.

```bash
git clone https://github.com/moolikethecow/webmcp-workout && cd webmcp-workout
SITE_HOST=gym.example.com POSTGRES_PASSWORD=change-me \
  docker compose -f deploy/docker-compose.yml up -d --build
```

Point the hostname's DNS at the box first; Caddy obtains the certificate on
the first request. `curl https://$SITE_HOST/api/health` should answer
`{"ok":true,…}`.

Optional environment:

| Variable | Purpose |
|---|---|
| `WEBMCP_ORIGIN_TRIAL_TOKEN` | Chrome origin-trial token(s) for WebMCP, emitted as `<meta http-equiv="origin-trial">` at request time. Without it, Chrome needs `chrome://flags/#enable-webmcp-testing`; ChatGPT's built-in browser needs nothing. |
| `APP_TIMEZONE` | The calendar day used for "today" (default `UTC`). |
| `NEXT_PUBLIC_PRODUCT_*` | Rebrand at build time — see `.env.example` and the `ARG`s in `Dockerfile`. |

Workspaces that have not been visited for a while can be reclaimed with
`POST /api/workspace/sweep` (see the route for the age threshold); a daily
cron hitting it is enough.

The public demo at https://spot.mootoo.co runs this same image, built for
`linux/arm64`, behind the author's existing reverse proxy instead of the Caddy
service above.
