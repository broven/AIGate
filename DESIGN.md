# AIGate Design System

## Visual Direction

Terminal/dev-tool aesthetic. Dark mode default. Dense information display.
Think Grafana/Datadog, not Notion. This is an infrastructure monitoring tool
for developers — the design should feel intentional, not generated.

## Colors

```
Background:
  --bg-primary:    #0a0a0a    (near-black, main background)
  --bg-surface:    #141414    (card/panel background)
  --bg-hover:      #1a1a1a    (hover state)
  --border:        #262626    (subtle borders)

Text:
  --text-primary:  #e5e5e5    (main text)
  --text-secondary:#737373    (labels, timestamps)
  --text-muted:    #525252    (disabled, placeholders)

Accent:
  --accent-green:  #22c55e    (success, active, routed, savings)
  --accent-red:    #ef4444    (error, failed, cooldown)
  --accent-yellow: #eab308    (warning, partial, stale)
  --accent-blue:   #3b82f6    (links, interactive elements, primary actions)
```

## Typography

```
Fonts:
  --font-mono:     "JetBrains Mono", "Fira Code", monospace
  --font-sans:     "Inter", system-ui, sans-serif

Usage:
  Monospace: prices, token counts, model names, provider IDs,
             timestamps, API keys, status codes, numbers
  Sans-serif: labels, descriptions, navigation, empty state text,
              wizard copy, error messages
```

## Spacing

```
Base unit: 4px
Scale: 4, 8, 12, 16, 24, 32, 48
```

## Border Radius

```
  --radius-sm:  4px   (buttons, inputs, badges)
  --radius-md:  8px   (cards, panels)
  --radius-lg:  12px  (modals, dialogs)
```

## Component Patterns

### Stat Card
- `bg-surface`, `radius-md`
- Number: mono, 24px, `text-primary`
- Label: sans, 12px, `text-secondary`
- Delta badge: green (up) / red (down) vs yesterday

### Table Row
- Hover: `bg-hover`
- Data: mono, `text-primary`
- Labels: sans, `text-secondary`
- Expandable: smooth height transition (200ms ease)

### Status Indicator
- 8px circle: `accent-green` (active), `accent-red` (failed), `accent-yellow` (stale/partial)

### Button
- Ghost (default): `bg-surface`, `border`, hover `bg-hover`
- Primary: `accent-blue` background — use sparingly (1 per screen max)
- Destructive: `accent-red` text, ghost style

### Toast / Notification
- Bottom-right, auto-dismiss 3s
- Accent-colored left border (green=success, red=error, yellow=warning)

### Fallback Chain (signature component)
Compact (in table row):
- Failed provider: strikethrough + `accent-red`
- Arrow: `text-muted`
- Succeeded provider: `accent-green` + checkmark

Expanded (on click):
- Vertical timeline, each attempt is a node
- Failed: red left border, error code displayed
- Succeeded: green left border, token count + latency

## Navigation

Sidebar nav, collapsible. Icon + label. Collapses to icon-only on narrow viewports.

Pages: Overview, Providers, Logs, Settings (MVP)
Post-MVP: Benchmark

## First-Run Experience

3-step setup wizard:
1. Create your first API key
2. Add your first provider
3. Test the connection

After completion → redirect to Overview with live data.

## Empty States

Every empty state includes:
1. A warm, human description (not "No items found")
2. A primary action button
3. Context about why this section will be useful

## Loading States

Skeleton pulse animations matching the final layout shape.
Never show a blank page or generic spinner.
