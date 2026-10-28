# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run the app:

```bash
python start.py                        # desktop mode (Electron shell + backend)
python start.py --mode network         # browser mode, http://localhost:18080
python start.py --port 9090            # 18080 is the default everywhere (Vite proxy, CORS, entrypoint.py)
python quick-start.py --skip-install   # desktop mode without reinstalling deps
```

Dev servers (frontend proxies `/api` and `/ws` to `localhost:18080`):

```bash
cd frontend && npm run dev
cd backend && python -m uvicorn main:app --host 127.0.0.1 --port 18080 --reload
```

Lint, typecheck, test:

```bash
cd backend && ruff check .
python -m pytest backend/tests -q                       # from repo root; test files insert backend/ into sys.path themselves
python -m pytest backend/tests/test_kb_retriever.py -q   # single file
python -m pytest backend/tests -q -k test_keyword_hit    # single test by name

cd frontend && npx tsc -b --noEmit
cd frontend && npm test                                  # vitest run
cd frontend && npx vitest run src/stores/uiPrefsStore.test.ts   # single file
cd frontend && npm run build && npm run test:e2e         # Playwright previews dist/, so build first
cd frontend && npm run test:e2e:update-snapshots         # regenerate @visual baselines only

cd desktop && node --test updater.test.js                # Electron main-process helpers; single file
```

Package a Windows build:

```bash
cd frontend && npm ci && npm run build
cd desktop && npm ci && npm run dist      # PyInstaller backend + NSIS installer → desktop/dist/
cd desktop && npm run dist:dir            # layout only, no installer
```

## Architecture

Three processes, three build systems. `desktop/main.js` (Electron) spawns the backend as a child
process, `backend/` is a FastAPI app, `frontend/` is a React SPA that the backend serves statically in
production. In dev the three are started separately; in a packaged build Electron owns the lifecycle.

### Runtime paths are env-indirected — this is the main source of "works in dev, not packaged" bugs

The backend never hardcodes where config or data lives:

- `core/config.py` reads `IA_CONFIG_PATH`, falling back to `backend/config.json`.
- `services/storage/paths.py` reads `IA_DATA_DIR`, falling back to `backend/data/`. All five SQLite
  files (`knowledge.db`, `job_tracker.db`, `review.db`, `mock_interview.db`, `resume_history.db`) go
  through `sqlite_path()`, which also performs a one-time migration from the legacy `backend/*.db`.
- `core/runtime_paths.py` reads `IA_FRONTEND_DIST` for the static SPA.

`desktop/runtimePaths.js` sets all three into the Electron `userData` directory. So a packaged install
reads its config and databases from `AppData/Roaming/interview-assistant-desktop/`, **not** from the
repo. When debugging a packaged build, look there, and remember an upgrade must preserve it.

### `backend/main.py` lifespan is the only wiring point

Every background worker and the WebSocket fan-out are created in `lifespan()` and torn down in reverse.
Nothing self-starts on import. That includes `init_auth()`, `mock_interview.init_db()`, the
`asyncio.Queue` behind `ws.init_broadcast()` plus the `ws_dispatcher` / `ws_heartbeat` tasks,
`assist.init_background_workers()`, `assist.init_translate_worker()`, a daemon STT preload thread, and
resume restore. If a new subsystem needs a worker, add it here — tests that mount routers directly
(`tests/test_kb_api.py` builds a minimal `FastAPI()`) deliberately bypass this, which is why routers
must not assume lifespan ran.

Backend → frontend is one-way through `ws.broadcast()`, a sync function callable from worker threads
that pushes onto the lifespan queue; `ws_dispatcher` is the only task that touches sockets. Message
`type` values are the real backend/frontend contract — `frontend/src/hooks/useInterviewWS.ts` switches
on ~30 of them (`transcription`, `answer_chunk`, `kb_hits`, `model_health`, …). Adding a broadcast type
means adding a case there. Multiple browser tabs elect a single WS owner via `lib/wsLeader.ts`
(BroadcastChannel) so streamed chunks are not applied twice.

### Assist pipeline (`backend/api/assist/`)

Audio → answer is split across four files so the scheduling rules stay testable:

- `pipeline.py` — capture threads, VAD, interviewer segment assembly, module-level mutable state.
- `asr_state.py` — `AssistAsrStateMachine` merges ASR fragments into question groups and decides when a
  group is worth answering (confirm window, constraint tails, high-churn suppression).
- `scheduler.py` — pure functions over `TaskPayload` tuples: model eligibility, parallel slots, stale-ASR
  arbitration, commit ordering. No side effects, so it is unit-testable in isolation.
- `answer_worker.py` — builds the prompt (one of four `PROMPT_MODE_*` values), optionally retrieves KB
  hits, streams from the LLM, re-broadcasts.

Correctness here depends on generation/sequence counters (`_bump_generation`, session version, ASR turn
ids): a question superseded by newer speech must be dropped rather than answered late. Read
`scheduler.py` before touching dispatch.

### Knowledge base (`backend/services/kb/`)

Ingest: `loaders/* → chunker.chunk_doc → store.replace_chunks`. Loaders self-register on import of
`loaders/__init__.py` and are dispatched by file extension.

Retrieval is SQLite FTS5 (`kb_fts`) with BM25. Because FTS5's `unicode61` tokenizer treats contiguous
CJK as a single token, `_tokenize.py` rewrites text into **character bigrams on both the write and the
query side** — index and query must stay in sync or Chinese search silently returns nothing. Query
bigrams are OR-joined on purpose (AND kills long CJK questions). `bm25()` returns non-positive scores
that get sign-flipped for upper layers.

Retrieval is deadline-bounded, not best-effort: `retriever.py` runs the query on a worker thread and a
watchdog calls `sqlite3.Connection.interrupt()` at `kb_asr_deadline_ms` (80ms, realtime ASR path) or
`kb_deadline_ms` (150ms). Missing the deadline degrades the answer, never blocks it. An optional
semantic lane (embeddings + cosine + RRF fusion) activates only when `kb_semantic_model` is non-empty.

All KB HTTP work is submitted through `core/resource_lanes.py` (`run_low_priority`, 1 worker + 8 pending
by default), which returns **429** rather than queueing without bound — indexing must never starve the
live interview path.

### Config surface

`core/config.py` holds every knob as a Pydantic model and is the single source of defaults. Only an
explicit allow-list in `api/common/router.py` is writable from the UI: for KB that is `kb_enabled`,
`kb_top_k`, `kb_deadline_ms`, `kb_asr_deadline_ms`. Everything else (`kb_max_upload_bytes`,
`kb_chunk_max_chars`, `kb_min_score`, OCR/vision flags) is config.json-only by design. `update_config()`
ignores unknown keys silently, so a typo'd field name fails quietly.

### Auth

No auth locally: `core/auth.py` `is_auth_disabled()` returns true unless `IA_AUTH_ENABLE=1` or
`IA_AUTH_TOKEN` is set, so `npm run dev` and desktop mode work without a token. With auth on, loopback
is still bypassed and only LAN clients need `Authorization: Bearer` (HTTP) or `?token=` (WebSocket).
`--mode network` is the path that turns this on. CORS defaults to a loopback-only origin regex,
overridable via `IA_CORS_REGEX`.

Other env vars that change behavior: `IA_BROADCAST_QUEUE_SIZE` (default 2000),
`IA_LOW_PRIORITY_WORKERS` / `IA_LOW_PRIORITY_MAX_PENDING`, `IA_ACCESS_LOG`, `IA_AUTH_DISABLE`.

## CI quirks worth knowing before pushing

- `.github/workflows/ci.yml` is path-filtered per area, and the backend job runs an **explicit list of
  ~26 test files**, not `pytest tests`. A new test file passes locally and is simply never executed in
  CI until it is added to that list. Same pattern for the desktop job's `node --test <13 named files>`.
- CI strips `faster-whisper` out of `requirements.txt` into `requirements-ci.txt` (model downloads are
  too large), so anything importing it at module scope will fail there.
- Playwright is split: `--grep-invert "@visual"` for functional specs, a separate `e2e-visual` job for
  pixel baselines in `frontend/e2e/__screenshots__/`. Intentional UI changes need the
  `update-visual-snapshots` workflow run on the feature branch, not a local snapshot commit.
- `backend/pyproject.toml` enables only `E9`/`F`/`B0` with `E501`, `F401` and others ignored. The narrow
  rule set is deliberate; do not widen it as a drive-by change.

## Release constraints

Releases are tag-driven via `.github/workflows/release-windows.yml`: bump `desktop/package.json`
`version`, commit, then push a tag that **exactly** matches (`vX.Y.Z`). The workflow throws if the tag
and package version disagree, and pre-release tags like `v1.3.0-beta` are rejected outright.

The NSIS install identity must not change — `appId: com.interviewassistant.desktop`,
`productName: Interview Assistant`, `oneClick: false`, `perMachine: false`. Altering any of them makes
the next installer create a parallel install instead of upgrading, orphaning the user's `userData`.
`docs/release/windows-upgrade-checklist.md` covers the real-Windows verification that static tests
cannot replace.

