# Virtual Models Design

## Overview

Add a "Virtual Models" feature to AIGate that allows users to create custom model aliases with explicit multi-model fallback chains. A virtual model contains an ordered list of canonical models; when a client requests a virtual model, the gateway tries each model tier in order, applying price-based routing within each tier's deployments.

## Motivation

The existing price-based router automatically selects the cheapest deployment for a single canonical model. Virtual models give users explicit control over cross-model fallback — e.g., try Claude first, fall back to GPT-4o, then to DeepSeek — while still leveraging price-based routing within each tier.

## Data Model

### New Tables

**`virtualModels`**

| Column | Type | Description |
|--------|------|-------------|
| `id` | text PK | UUID |
| `name` | text UNIQUE | User-defined name (stored without prefix, e.g., `my-smart-model`) |
| `description` | text | Optional description |
| `createdAt` | integer | Timestamp |
| `updatedAt` | integer | Timestamp |

**`virtualModelEntries`**

| Column | Type | Description |
|--------|------|-------------|
| `id` | text PK | UUID |
| `virtualModelId` | text FK | References `virtualModels.id` |
| `canonical` | text | The real model's canonical name (e.g., `gpt-4o`) |
| `priority` | integer | Order in fallback chain (0 = first) |
| `createdAt` | integer | Timestamp |

**`virtualModelDeploymentOverrides`**

| Column | Type | Description |
|--------|------|-------------|
| `virtualModelId` | text FK | References `virtualModels.id` |
| `deploymentId` | text FK | References `modelDeployments.deploymentId` |
| `disabled` | integer | 1 = skip this deployment |

Only disabled deployments are stored as overrides. By default, all active deployments of a canonical model are eligible. This avoids sync drift — new deployments are auto-included, stale ones auto-excluded.

### Modified Tables

**`requestLogs`** — add column:

| Column | Type | Description |
|--------|------|-------------|
| `virtualModelName` | text | Name of the virtual model used (null if direct request) |

## API Endpoints

New routes under `/api/virtual-models`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/virtual-models` | List all virtual models with entries and overrides |
| `POST` | `/api/virtual-models` | Create virtual model with entries and overrides |
| `PUT` | `/api/virtual-models/:id` | Update name, description, entries, and overrides |
| `DELETE` | `/api/virtual-models/:id` | Delete virtual model (cascade entries/overrides) |

### Request Body (Create/Update)

```json
{
  "name": "my-smart-model",
  "description": "Smart fallback chain",
  "entries": [
    {
      "canonical": "claude-sonnet-4-20250514",
      "priority": 0,
      "disabledDeployments": ["openrouter-claude-sonnet-4-20250514"]
    },
    {
      "canonical": "gpt-4o",
      "priority": 1,
      "disabledDeployments": []
    }
  ]
}
```

## Routing Logic

### Client-Facing Model Name

Virtual models use the prefix `virtual:` — clients request `model: "virtual:my-smart-model"`.

### Resolution Flow

1. If model starts with `virtual:`, look up virtual model by name
2. Get entries ordered by priority
3. For each entry:
   - Get all active, non-blacklisted deployments for that canonical
   - Filter out disabled deployments (from overrides table)
   - Run existing price-based routing on remaining deployments
   - If any succeeds → return response
   - If all fail → move to next entry
4. If all entries exhausted → return error

### What Stays the Same

- Per-deployment routing, cooldown logic, adapter selection, request logging — all untouched
- The virtual model layer is purely an outer loop around existing routing

### `/v1/models` Integration

Virtual models appear in the `GET /v1/models` response alongside real models, with `id: "virtual:my-smart-model"`.

## Dashboard UI

New page at `/virtual-models`, added to sidebar between Models and Logs.

### Main View — List

- Table: Name, Description, Model Chain (pill badges), Deployment Count, Actions (edit/delete)
- "Create Virtual Model" button top-right
- Empty state explaining the feature

### Create/Edit Page

- Name input, Description input
- Model chain builder:
  - "Add Model" dropdown listing available canonical models
  - Each model rendered as a draggable card with:
    - Drag handle for reordering
    - Expandable deployment list with toggle switches (enabled by default)
    - Remove button
  - Visual arrow connectors between cards showing fallback order

```
┌─────────────────────────────────────────┐
│ Name: [my-smart-model]                  │
│ Description: [Smart fallback chain    ] │
│                                         │
│ Model Chain:                            │
│ ┌─ ☰ claude-sonnet-4  ──────── [✕] ──┐ │
│ │  ✓ anthropic    $3.00/M in          │ │
│ │  ✓ openrouter   $3.10/M in          │ │
│ │  ✗ newapi       $3.50/M in          │ │
│ └─────────────────────────────────────┘ │
│              ↓                          │
│ ┌─ ☰ gpt-4o ────────────── [✕] ──────┐ │
│ │  ✓ openai      $2.50/M in          │ │
│ │  ✓ openrouter  $2.60/M in          │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [+ Add Model]                           │
│                                         │
│              [Cancel]  [Save]           │
└─────────────────────────────────────────┘
```

## Implementation Summary

- **3 new tables**: `virtualModels`, `virtualModelEntries`, `virtualModelDeploymentOverrides`
- **1 new column**: `requestLogs.virtualModelName`
- **4 API endpoints**: CRUD on `/api/virtual-models`
- **2 routing touch points**: virtual model resolution in `price-router.ts`, listing in `/v1/models`
- **1 new dashboard page**: `/virtual-models` with list + create/edit views
