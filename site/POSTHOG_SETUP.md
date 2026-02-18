# PostHog Analytics Setup — Command Central Landing Page

## Project Info
- **PostHog Project ID:** 316491
- **Cloud:** US (`us.i.posthog.com`)
- **Autocapture:** Disabled (manual events only)

## Events Tracked

| Event | Trigger | Properties |
|---|---|---|
| `$pageview` | Automatic (PostHog snippet) | — |
| `install_click` | Click on install/marketplace links | `source`, `label` |
| `github_click` | Click on GitHub repo links | `source`, `label` |
| `email_submit` | Form submission (Buttondown) | `source` |
| `feature_card_click` | Click on feature cards | `source` (multi-workspace, git-status, filter) |
| `scroll_depth` | IntersectionObserver at 25/50/75/100% | `depth` (25, 50, 75, 100) |
| `x_click` | Click on Twitter/X link | `source`, `label` |

## Dashboard Setup

### Dashboard 1: Launch Funnel

1. Go to **PostHog → Dashboards → New Dashboard**
2. Name: **"Launch Funnel"**
3. Add insight → **Funnels**
4. Steps:
   - Step 1: `$pageview`
   - Step 2: `feature_card_click`
   - Step 3: `install_click`
5. Set window: **Same session** (or 1 day)
6. Save

### Dashboard 2: Engagement

1. Go to **PostHog → Dashboards → New Dashboard**
2. Name: **"Engagement"**
3. Add these insights:

#### Scroll Depth Distribution
- **Insight type:** Trends
- **Event:** `scroll_depth`
- **Breakdown by:** `depth` property
- **Display:** Bar chart

#### Email Submit Rate
- **Insight type:** Trends
- **Series A:** `$pageview` (total)
- **Series B:** `email_submit` (total)
- **Formula:** `B / A` for conversion rate
- **Display:** Line chart

#### GitHub Click Rate
- **Insight type:** Trends
- **Series A:** `$pageview`
- **Series B:** `github_click`
- **Formula:** `B / A`
- **Display:** Line chart

4. Save all insights to the dashboard.

## Implementation Notes

- All click events use `data-track` attributes for clean binding
- Scroll depth uses `IntersectionObserver` with sentinel divs at 25/50/75/100% of body height — no scroll event listeners
- Email submit fires on `form.submit` event (not button click) to capture actual submissions
- Event labels are truncated to 80 chars to keep data clean
