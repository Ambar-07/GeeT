# Free-Tier Quotas & Guardrails

Verify current official limits before deploying to production:
- Cloudflare Pages: https://developers.cloudflare.com/pages/platform/limits/
- Supabase Free: https://supabase.com/docs/guides/platform/billing-on-supabase

## Operational Rules
- Never enable automatic paid upgrades or overages.
- Keep cloud storage near zero: publish only room-specific song metadata (`room_songs`), never audio or stems.
- Subscribe to Supabase Realtime only while a room is open; unsubscribe on exit.
- Free Supabase projects may pause after inactivity; local host playback continues offline, and cloud room features resume after manual project wake-up.
