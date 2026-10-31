# Email Sender

A small self-hosted tool for lead-generation email: sends one personalised email at a time from your own Google Workspace mailbox, warms the mailbox up, slows down or pauses itself when bounces rise or replies drop, and tracks replies, bounces, clicks, opens and unsubscribes.

Runs on free tiers: **Supabase** (database, login, background jobs, tracking) and **Cloudflare Workers** (web interface).

## What's where

```
supabase/
  migrations/          database schema, queue logic, health rules, cron schedules
  functions/app/       one Edge Function with a route per job
    handlers/          send-tick, inbox-sync, daily-health, track, google-oauth, send-test
    lib/               Gmail API, email rendering, delivery
web/                   React app (Vite): dashboard, contacts, templates, campaigns, settings
```

Background jobs (pg_cron, already scheduled):

| Job | When | What |
| --- | --- | --- |
| send-tick | every 2 min | sends at most one email per mailbox, inside the campaign's send window, under today's limit, with a random 2–6 min gap |
| inbox-sync | every 15 min | finds replies (auto-replies filtered out) and bounces; bounced addresses are never emailed again |
| daily-health | 05:00 UTC (06:00 Prague in winter) | sets tomorrow's limit from the warm-up ramp, halves it on 2–5% bounces or a reply-rate drop, pauses on >5% bounces or 0 replies in 100 sends, emails you a summary |

Supabase project: `nhnryvxhirqrqgciolxn` (Frankfurt).

## Setup (one time)

### 1. Google Cloud: let the tool use your Workspace mailbox

1. Go to <https://console.cloud.google.com>, signed in with your Workspace account, and create a project (e.g. "Email Sender").
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **Google Auth Platform → Branding / Audience** (older UI: *OAuth consent screen*): app name "Email Sender", your email as support and developer contact. Under **Audience**, choose **Internal**. Internal means only your organisation's accounts can use it, and Google does not require app verification.
4. **Clients → Create client** (older UI: *Credentials → Create credentials → OAuth client ID*):
   - Application type: **Web application**
   - Authorized redirect URI: `https://nhnryvxhirqrqgciolxn.supabase.co/functions/v1/app/google-oauth`
5. Copy the **Client ID** and **Client secret**.

### 2. Supabase: store the Google keys

Supabase dashboard → project **email-sender** → **Edge Functions → Secrets** → add:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### 3. Cloudflare: host the web interface

1. <https://dash.cloudflare.com> → **Workers & Pages → Create → Import a repository** → pick `email_sender`.
2. Settings:
   - Project / Worker name: **email-sender** (must match `name` in `web/wrangler.jsonc`)
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Root directory: `/web`
3. Deploy. You get an address like `https://email-sender.<your-subdomain>.workers.dev`. Every push to `main` redeploys.

### 4. Supabase Auth: point it at the web app

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL**: your Cloudflare address
- **Redirect URLs**: add the same address

### 5. Create your account and connect the mailbox

1. Open the Cloudflare address. The first account created becomes the **only** admin; everyone else is locked out.
2. Confirm the email Supabase sends you, then sign in. (Supabase's built-in mailer only delivers to members of your Supabase organisation. If the confirmation never arrives, temporarily turn off **Authentication → Sign In / Providers → Email → Confirm email**, sign up, then turn it back on.)
3. **Settings → Connect Google mailbox** → sign in with the address you want to send from → allow sending and reading email.
4. In Settings, set the **sender name** and the **alert email**.

### 6. DNS for the sending domain (before real sends)

In your DNS provider, for the domain you send from:

| Record | Host | Value |
| --- | --- | --- |
| SPF (TXT) | `@` | `v=spf1 include:_spf.google.com ~all` (merge with any existing SPF record; only one is allowed) |
| DKIM (TXT) | `google._domainkey` | generate in Google Admin → Apps → Google Workspace → Gmail → **Authenticate email**, add the record, then click **Start authentication** |
| DMARC (TXT) | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@yourdomain.cz` |

## First campaign

1. **Templates → New template** → start from "Personal" (best for cold first emails) or "Designed", or paste HTML. Use **Send test** to check it in Gmail and Outlook.
2. **Contacts → Import CSV**. An email column is required; first name, last name and company are detected automatically, and any other column becomes a `{{variable}}`.
3. **Campaigns → New campaign** → pick list, template and mailbox → **Start sending**.

Template variables: `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{email}}`, any imported column (e.g. `{{city}}`), fallbacks like `{{first_name | there}}`, and `{{unsubscribe_url}}`. If a template has no unsubscribe link, the footer from Settings is added. Every email also carries a one-click `List-Unsubscribe` header.

## Good to know

- **Warm-up:** a new mailbox starts at 10/day, then 20, 30, 40, and up to 50/day from week 5. Change the ramp in Settings, or set a manual limit per mailbox.
- **Open tracking** is off by default. It is inaccurate (Apple Mail pre-loads images) and a tracking pixel slightly hurts deliverability. Click tracking is on.
- **Free tier pause:** Supabase pauses free projects after 7 days without activity. The scheduled jobs should count as activity, but check the dashboard in the first weeks. If it ever pauses, restore it in the Supabase dashboard, or move to Pro ($25/month) to remove the risk.
- **Legal:** Czech law (Act 480/2004) and GDPR restrict unsolicited commercial email. Check what applies to your contact list before launching.

## Development

```bash
cd web && npm install && npm run dev      # web app on http://localhost:5173 against the live project
```

Edge Function deploy with the Supabase CLI: `supabase functions deploy app --project-ref nhnryvxhirqrqgciolxn` (uses `supabase/config.toml`, `verify_jwt = false`). Migrations in `supabase/migrations` are already applied to the project.
