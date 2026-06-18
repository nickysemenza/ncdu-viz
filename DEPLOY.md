# Deploying ncdu-viz

Target: Cloudflare Workers at `https://ncdu-viz.nickysemenza.com`.
Prereq: `wrangler whoami` shows the account that owns the `nickysemenza.com` zone.

## One-time infrastructure

```bash
# 1. Create the R2 bucket (the only persistent store).
#    `--remote` dev reuses this same bucket (preview_bucket_name); local dev
#    uses a simulated R2, so no second bucket is needed.
wrangler r2 bucket create ncdu-viz-scans

# 2. Auto-expire scans after 7 days (object-age based — no cron needed).
#    Also abort incomplete multipart uploads (e.g. from aborted oversize uploads).
wrangler r2 bucket lifecycle add ncdu-viz-scans expire-7d \
  --expire-days 7 --abort-multipart-days 1

# verify
wrangler r2 bucket lifecycle list ncdu-viz-scans
```

The custom domain `ncdu-viz.nickysemenza.com` is declared in `wrangler.jsonc`
(`routes` → `custom_domain: true`); the first `wrangler deploy` provisions it
automatically (creates the DNS record + cert). The zone must already be on this
Cloudflare account.

## Deploy

```bash
pnpm build          # tsc --noEmit && vite build  → dist/
wrangler deploy     # auto-uses dist/ncdu_viz/wrangler.json (Vite plugin redirect)
```

`pnpm deploy` runs both steps.

## Post-deploy verification

```bash
BASE=https://ncdu-viz.nickysemenza.com

# round-trip the documented curl recipe
URL=$(ncdu -o- -x . | gzip | curl -s --data-binary @- \
  -H "Content-Encoding: gzip" $BASE/api/upload)
echo "$URL"                                    # → https://.../v/<slug>
SLUG=${URL##*/v/}

# the served blob must be SINGLE-gzipped (proves encodeBody:"manual")
curl -sI "$BASE/api/scan/$SLUG" | grep -i content-encoding   # → content-encoding: gzip
curl -s --compressed "$BASE/api/scan/$SLUG" | head -c 40      # → valid JSON

# open $URL in a browser → treemap renders
# anti-abuse: a non-ncdu body is rejected
curl -s -o /dev/null -w "%{http_code}\n" --data-binary 'not-ncdu' $BASE/api/upload  # → 415
```

## Notes

- Rerun `wrangler types` after any change to `wrangler.jsonc` bindings.
- The viewer treats a missing R2 object as "expired" (friendly 404), so the
  lifecycle rule needs no application-side coordination.
- Optional CI: connect Workers Builds to the repo for deploy-on-push.
