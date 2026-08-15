---
title: Transactional email templates + in-app notification/sound wiring
date: 2026-08-11
tags: [email, notifications, auth, mail, sentinel, frontend, backend]
---

# Transactional email + in-app notification/sound wiring

**Read before touching outbound email, the notification drawer/bell, or the Sentinel live-feed poll.** Two features landed together (a whole-app email + notification pass), reusing infrastructure that already existed rather than building new services.

## What already existed (do not rebuild)
- `services/api/src/mail/mail.service.ts` — the app's ONLY email sender. Generic SMTP via nodemailer; **console-fallback when SMTP unset** (`delivered:false`, logs the body) so OTP flows stay testable with no creds. SMTP is configured in the working-tree `.env`.
- `services/api/src/auth/otp.service.ts` — 6-digit OTP: 10-min expiry, 5-attempt cap, 60s resend cooldown, hashed, enumeration-safe. Channel derived from purpose (`phone_verify`→SMS, else mail).
- Trader password reset already worked end-to-end (`POST /auth/password/forgot` + `/reset`).
- `services/api/src/notification/` — real DB-backed `Notification` CRUD + `/notifications` REST. The `/notifications` **page** already read it; the **drawer + bell** did not.
- `apps/web` notification state lives in `workspaceStore` (zustand); bell badge + drawer + page all read that one slice.

## What was added
### Email (Phase 1)
- **New** `services/api/src/mail/templates.ts` — single branded template layer. Builders return `{subject,text,html}`. Table-based inline-styled HTML (no `<style>`, no remote assets — email clients strip those), CSS-text wordmark (no hosted logo / tracking pixel), every value HTML-escaped, real plain-text bodies. Builders: `otpCode`, `loginAlert`, `passwordChanged`, `eodSummary`.
- Wired into REAL flows: `otp.service` sends the HTML OTP; `auth.service` sends a **login-alert on every successful sign-in** (password/google/phone) and a **password-changed email on reset**. Both are **fire-and-forget** (`void mail.send(...).catch()`), modelled on the existing `audit()` — email must never slow or fail a login.
- Sender: `MAIL_FROM` / `SUPPORT_EMAIL` set to `admin@tradew-setup.com`. **Gotcha:** Gmail SMTP rewrites `From:` to `SMTP_USER` unless the address is a verified "Send mail as" alias — use a Workspace/SES/Resend sender for the real domain. Documented in `.env.example`.
- Synthetic phone accounts (`…@phone.tradew.local`) are skipped by `notifyLogin` — nobody reads that mailbox.

### In-app notifications + sound (Phase 2)
- **New** `apps/web/src/lib/notificationSound.ts` — the "TradeW mark": a **synthesized** two-note WebAudio chime (B5→E6), not an audio file (nothing to host/CSP/cache-bust; byte-identical every time = recognisable). Lazy AudioContext + `resume()` per play to satisfy the browser autoplay-gesture policy; every failure swallowed.
- **New** `apps/web/src/components/shell/NotificationSync.tsx` — headless, mounted once in `AppFrame`, gated on `sessionStatus==='authenticated'`. Polls `/notifications` every 30s, writes the store (single writer `setNotifications`), rings the chime on genuinely-new unread ids. **"No chime for the backlog" rule:** first load primes a seen-set silently; only ids appearing in a *later* poll ring. Reset on sign-out so a new user re-primes.
- `workspaceStore`: added `setNotifications`, persisted `notificationsMuted` + `toggleNotificationsMuted`.
- `NotificationCenter` drawer: read actions now persist to the API (`apiMarkRead`/`apiMarkAllRead`) optimistically; added a Sound on/off toggle. Removed the stale "No backend yet" comment.
- `useSentinel.ts`: the Sentinel **live feed** (the `/observe` 45s poll) now rings the mark when the observation set gains new text — signature = `synthesis.content` + each observation's `createdAt:content`, primed-skip on first load, muted-aware. This is the literal "live feed new text → unique sound" ask.

## Gotchas / constraints
- The `NotificationCategory` enum has **no security/login type** (trade|sentinel|learning|research|portfolio|broker|announcement). So login/security events are emailed, NOT pushed as in-app notifications — adding one would need a Prisma enum migration. In-app notifications come from events whose categories already exist (order fills=trade, Sentinel observations=sentinel).
- `ObserveResponse` has **no `headline`**; the non-directive headline lives in `Synthesis.status`/`content`, not `narrative` (that field name is on other types). Verify field names against `apps/web/src/lib/sentinel/types.ts` before use.
- Polling, not SSE, for `/notifications` — the seam is isolated to `NotificationSync.tsx`; an admin-style SSE swap touches only that file.

## Verified
- `services/api` and `apps/web` both `tsc --noEmit` clean.
- Email templates rendered to HTML and reviewed.
- **Not yet** browser-E2E'd against a live stack — deferred to the dev deployment.

Related: [[2026-08-11 - Sentinel dashboard redesign]] (if present), auth flows in `services/api/src/auth/`.
