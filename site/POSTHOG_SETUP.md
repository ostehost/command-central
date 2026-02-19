# PostHog Analytics — Partner AI Products

## Project Info
- **PostHog Project ID:** 316491
- **Cloud:** US (`us.i.posthog.com`)
- **Autocapture:** Disabled (manual events only)
- **Session Replay:** Enabled, 10% sample rate (launch), mask inputs
- **Page Leave:** Built-in (`capture_pageleave: true`)

## Event Taxonomy

**Format:** `site_{object}_{action}` — all events include `product` property (`cc`, `dg`, etc.)

| Event | Trigger | Properties |
|---|---|---|
| `$pageview` | Automatic (PostHog) | UTM params auto-captured |
| `$pageleave` | Automatic (PostHog) | time on page auto-captured |
| `site_install_click` | Click on install/marketplace links | `product`, `source`, `label` |
| `site_github_click` | Click on GitHub repo links | `product`, `source`, `label` |
| `site_email_submit` | Buttondown form submission | `product`, `source` |
| `site_feature_click` | Click on feature cards | `product`, `source` |
| `site_scroll_depth` | IntersectionObserver at 25/50/75/100% | `product`, `depth` |
| `site_x_click` | Click on Twitter/X link | `product`, `source`, `label` |

## UTM Conventions

```
https://partnerai.dev/?utm_source={source}&utm_medium={medium}&utm_campaign=launch-2026-02
```

| Channel | utm_source | utm_medium | utm_content |
|---|---|---|---|
| Show HN | `hackernews` | `social` | `show-hn` |
| Reddit r/vscode | `reddit` | `social` | `r-vscode` |
| Reddit r/programming | `reddit` | `social` | `r-programming` |
| Twitter/X | `twitter` | `social` | `tweet-main` |
| GitHub README | `github` | `referral` | `readme-hero` |
| Buttondown email | `buttondown` | `email` | `newsletter` |

## Dashboards

### Launch Command Center (real-time during launch)
1. Visitors today — `$pageview`, daily
2. Traffic by source — `$pageview` breakdown by `utm_source`
3. Install click rate — `site_install_click / $pageview`
4. Top referrers — `$pageview` breakdown by `$referring_domain`
5. Email signups — `site_email_submit` count
6. Scroll depth — `site_scroll_depth` breakdown by `depth`

### Product Funnel (permanent)
Steps: `$pageview` → `site_scroll_depth (depth=50)` → `site_feature_click` → `site_install_click`

### Weekly KPIs (all products)
- Unique visitors, install clicks, email signups (PostHog)
- Marketplace installs, stars (manual Monday check)

## Multi-Product Strategy
- Single PostHog project, `product` property on all events
- Clone dashboards per product, filter by `product`
- Event prefix `site_` for landing pages, `cc_` for in-extension (future), `dg_` for DiffGuard

## Free Tier Budget
- 1M events/month, 5K session recordings
- ~5-6 events/visitor → handles 150K visitors/month
- Session replay at 10% → covers ~50K visitors before hitting limit
- If budget tightens: scroll_depth (4 events/visitor) is first to cut

## Full Playbook
See `~/.openclaw/workspace/memory/posthog-playbook-2026-02-19.md` for complete reference.
