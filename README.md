# WeddingWebsite

The wedding design is plain HTML, CSS and JavaScript. The protected deployment
uses a Cloudflare Pages advanced-mode Worker; GitHub is not required.

## Build and test

Requires Node.js 24 or later. No npm packages are required.

```powershell
npm test
npm run build
```

Upload **only `deploy`**, not this repository, to Cloudflare Pages using direct
upload. The build embeds wedding content in `_worker.js`, which Cloudflare
executes on the server. Public static assets contain only a generic unavailable
page. If the Function is absent, misconfigured, or bypassed after a quota limit,
private wedding content is not present in the static asset store.

## Cloudflare setup (required before guests can sign in)

1. Create a Pages direct-upload project, using `cathanandlaura` if available.
2. Create a D1 database and execute `security\schema.sql` in its console.
3. In the Pages project's Settings > Bindings, bind that database as `AUTH_DB`.
4. Add two **encrypted secrets**, not plaintext variables:
   - `WEDDING_PASSWORD`: a new unique guest passphrase, 16-256 characters.
   - `SESSION_SECRET`: an independently generated random secret of at least
     32 characters (use a password manager; do not share this with guests).
5. Apply bindings and secrets to production. Apply them to preview only if
   private preview access is required; otherwise previews intentionally return 503.
6. Upload the built `deploy` folder and redeploy after changing bindings/secrets.
7. If the account offers a Functions failure-mode setting, choose **Fail closed**.
8. Before sharing the link, confirm unauthenticated requests to `/`, `/rsvp.html`,
   `/script.js`, `/styles.css` and deployment-preview URLs cannot retrieve wedding
   content. Then sign in, check both pages, and sign out.

Enter actual secrets directly into Cloudflare. Never put them in source control,
chat, deployment archives, screenshots, or notes. Do not reuse the old browser
invite code: it was visible in the previous JavaScript and Git history.

## Protection and limits

- Every wedding page and local asset requires a signed, origin-bound session.
- The cookie is Secure, HttpOnly, SameSite=Lax and expires after 24 hours.
- Changing either secret invalidates existing sessions on the new deployment.
- Login allows at most 10 submissions per IP address per 15 minutes, including
  successful submissions. Guests on the same network share that allowance.
- D1 uses atomic counters, keyed with an HMAC rather than storing raw IPs.
  Expired counters are removed on the next login attempt; no passwords are logged.
- Missing secrets/database and authentication errors deny access, never expose assets.
- Same-origin form submissions, no-store caching headers and noindex directives
  are applied. Noindex alone is not access control.
- Signing out clears that browser's cookie. A previously stolen copy remains
  valid until expiry or secret rotation; this is a shared-password site, not
  individual user accounts.
- Guests can still share the password, downloaded content, or screenshots.
- Remote fonts, images and Spotify remain external dependencies. Future RSVP
  submissions need a separate protected backend; the current RSVP page is closed.
- The free Cloudflare plan has request/database quotas. Exhaustion can make the
  site unavailable; it must not make it public.

**Existing public copies are unaffected.** If GitHub Pages or another host still
serves an earlier copy, disable that deployment separately before treating the
wedding details as private. A public Git repository also exposes source content.
Do not publish the new source HTML using GitHub Pages or another static-only host;
the browser-only gate has been removed in favour of the server gate.

## Updates

Edit the four source website files, run the commands above, then upload `deploy`
as a new deployment. Do not manually upload the source pages as public assets.
Do not commit generated deployment output or secrets.
