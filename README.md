# GeeT Karaoke Platform

GeeT is a room-based karaoke architecture operating on a zero-recurring-cost infrastructure model:
- Frontend: Cloudflare Pages (React, Vite, TypeScript, Tailwind CSS)
- Coordination & State: Supabase Free Tier (PostgreSQL, Row Level Security, Realtime, Database Functions)
- Media & Processing: Local Host Agent (FastAPI, SQLite, Mutagen, FFmpeg/FFprobe)

Audio files, processed stems, full library paths, and local credentials remain strictly on the host system. Supabase stores only ephemeral room states and published metadata for active sessions.

---

## Project Status and Progress Overview

Overall Delivery Progress: 33% (3 of 9 roadmap phases verified).

| Phase | Milestone | Status | Test & Gate Status |
| :--- | :--- | :--- | :--- |
| Phase 1 | Foundation (Monorepo, Agent Skeleton, Cloud Schema, Baseline UI) | Completed | Verified (Vitest, Pytest, Build) |
| Phase 2 | Library Indexing (Incremental Scan, Deduplication, Cursor Pagination) | Completed | Verified (100 Mixed Files Test Gate) |
| Phase 3 | Lyrics Pipeline (LRC Parser, Sidecar Import, Offset Calibration, LRCLIB Integration) | Completed | Verified (10 Timed Songs Test Gate) |
| Phase 4 | Room Lifecycle & Realtime (Guest Auth, Room Creation, QR Code, State Sync) | Pending | Scheduled next |
| Phase 5 | Queue Management & Mutational RPCs (Atomic Ordering, Idempotency) | Pending | Planned |
| Phase 6 | Local Instrumental Separation (CPU/GPU Fallback, Cache Management) | Pending | Planned |
| Phase 7 | Hardening (Security Verification, Rate Limiting, Failure Recovery) | Pending | Planned |
| Phase 8 | Production Deployment (Cloudflare Pages Build, Supabase Migrations, Runbooks) | Pending | Planned |
| Phase 9 | Optional Low-Latency WebRTC Microphones | Pending | Experimental gate |

---

## Detailed Component Status

### 1. Ready and Implemented Components

#### Shared Contracts (`packages/shared`)
- Type definitions and Zod schemas for room states, queue entry statuses, song readiness flags, host agent health records, paginated catalogue pages, background jobs, and lyric records.
- Standardized cross-boundary data validation between frontend and local agent.

#### Lyrics Engine (`packages/lyrics`)
- Standard LRC parser supporting single and multi-timestamp records.
- Binary search indexer for zero-allocation active line resolution.
- Dynamic timeline offset engine supporting arbitrary micro-adjustments without destructive edits.

#### Local Host Agent (`services/host-agent`)
- HTTP loopback service bound strictly to `127.0.0.1:8765`.
- Path traversal protection enforcing directory boundary allowlists.
- Media streaming endpoint with RFC 7233 partial byte-range (`206`) support for seek operations.
- DRM detection mechanism automatically rejecting `.m4p` and FairPlay-protected containers while keeping original files untouched.
- Incremental library indexing leveraging file sizes, modification timestamps, and content hash fingerprints to detect duplicates without full scans.
- SQLite job ledger tracking scanning and processing states with cancellation capabilities.
- Timed lyrics management with automatic sidecar `.lrc` ingestion, durable manual updates, and metadata-validated LRCLIB querying.

#### Supabase Database Architecture (`supabase/migrations/0001_initial_schema.sql`)
- Tables: `rooms`, `room_participants`, `room_songs`, `queue_entries`, `playback_state`.
- Row Level Security (RLS) enabled on all exposed tables with explicit membership and host authorization policies using `SECURITY DEFINER` functions with fixed search paths.
- Transactional database functions for room creation, participant joining, queue insertion with idempotency keys, entry removal, and room closure.
- Direct mutations revoked from client roles, routing operations through validated RPC interfaces.

#### Web Interface (`apps/web`)
- React 19 application utilizing React Router and Tailwind CSS.
- Host Console featuring agent health diagnostics, directory configuration, incremental scanner triggers, cursor-paginated song browsing, local audio player, and an interactive lyrics sync and calibration interface.
- Client route structure established for `/`, `/host`, `/join/:code`, and `/room/:code`.
- Cloudflare Pages single-page application routing configuration via `_redirects`.

---

### 2. Pending Capabilities

1. **Phase 4 - Room Lifecycle, QR Code and Realtime Sync**
   - Supabase anonymous authentication integration.
   - Host room initialization with high-entropy host capability token.
   - Client join flow with QR code generation.
   - Host catalogue publishing to Supabase `room_songs`.
   - Realtime channel bindings for room state, presence, and queue notifications.

2. **Phase 5 - Queue Operations & Reconnection Robustness**
   - Server-side atomic queue sequencing and idempotency validation.
   - Participant song search within published room scope.
   - Host queue controls (skip, reorder, remove).
   - Reconnection state reconciliation ensuring offline playback continuity on network interruptions.

3. **Phase 6 - Local Audio Separation**
   - Local separation engine (Demucs or lightweight ONNX models) with CPU fallback.
   - Background processing queue prioritizing currently queued songs over general library files.
   - Instrumental stem caching and atomic cache promotion.
   - Fallback playback to original track when separation is pending or failed.

4. **Phase 7 through 9 - Production Hardening, Deployment & WebRTC**
   - Adversarial security testing against RLS policies.
   - Cloudflare Pages deployment automation and production environment binding.
   - Backup, export, and disaster recovery runbooks.
   - Experimental WebRTC microphone latency assessment.

---

## Directory Layout

```text
karaoke-platform/
  apps/
    web/                   # Cloudflare Pages React application
  packages/
    shared/                # Shared domain schemas and TypeScript contracts
    lyrics/                # LRC parsing and synchronized timeline engine
  services/
    host-agent/            # Python FastAPI service, SQLite, and audio indexer
  supabase/
    migrations/            # Version-controlled PostgreSQL schemas, RLS, and RPCs
    seed.sql               # Development fixtures
  docs/
    quotas.md              # Free-tier quota guardrails and operational constraints
```

---

## Setup and Verification

### Prerequisites
- Node.js >= 20.x and npm >= 10.x
- Python >= 3.11
- FFmpeg and FFprobe (optional for metadata reading via Mutagen fallback; required for stem separation)

### 1. Install Node Dependencies
```bash
npm install
```

### 2. Configure Host Agent Environment
```bash
cd services/host-agent
python -m venv .venv
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
# Unix / macOS
source .venv/bin/activate

pip install -r requirements.txt
```

### 3. Verification Suite
Execute the full automated test suite to validate all implemented modules:

```bash
# Typecheck TypeScript packages and web application
npm run typecheck

# Run unit tests across TypeScript packages
npm run test

# Compile production web bundle
npm run build

# Run host agent integration tests
python -m pytest services/host-agent/tests
```

### 4. Running the Development Environment
```bash
# Terminal 1: Host Agent (runs on http://127.0.0.1:8765)
cd services/host-agent
.\.venv\Scripts\python.exe -m host_agent

# Terminal 2: Web Application (runs on http://localhost:5173)
npm run dev:web
```
