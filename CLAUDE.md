# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

NanoClaw is a personal AI assistant accessible via WhatsApp and Telegram. Single Node.js process that connects to messaging channels, stores messages in SQLite, and spawns isolated containers running Codex CLI to handle conversations. Each group gets its own filesystem, memory, and session.

## Commands

```bash
npm run dev              # Run with hot reload (tsx)
npm run build            # Compile TypeScript (tsc → dist/)
npm test                 # Run all tests (vitest)
npm run test:watch       # Watch mode
npm run typecheck        # Type checking only (tsc --noEmit)
npm run format           # Prettier format
npm run format:check     # Check formatting
npm run setup            # First-time setup wizard
./container/build.sh     # Build agent container image
```

Run a single test file:
```bash
npx vitest run src/db.test.ts
```

Test locations: `src/**/*.test.ts`, `setup/**/*.test.ts`, `skills-engine/__tests__/*.test.ts`. Skills have a separate config: `npx vitest run --config vitest.skills.config.ts`.

## Architecture

```
WhatsApp/Telegram → SQLite → Message Loop (polls every 2s)
                                  ↓
                    GroupQueue (max 5 concurrent containers)
                                  ↓
                    Container (Codex CLI) ← IPC Watcher (file-based)
                                  ↓
                    Agent Response → formatted → Channel.sendMessage()
```

**Orchestrator** (`src/index.ts`): Loads state from SQLite, connects channels, starts message loop + scheduler + IPC watcher. The message loop polls for new messages, checks trigger patterns, and dispatches to the GroupQueue.

**Channels** (`src/channels/`): Implement the `Channel` interface (`src/types.ts`). WhatsApp uses baileys, Telegram uses grammy. Each channel owns certain JID patterns — WhatsApp: `@g.us`/`@s.whatsapp.net`, Telegram: `tg:` prefix.

**Container Runner** (`src/container-runner.ts`): Spawns Docker containers with carefully mounted filesystems. Group folder mounted rw, project root mounted ro. Secrets loaded from disk only at spawn time, never in env vars.

**GroupQueue** (`src/group-queue.ts`): Per-group message queue with global concurrency limit. Supports piping new messages to already-running containers via stdin. Exponential backoff on failure.

**IPC** (`src/ipc.ts`, `src/ipc-auth.ts`): File-based communication between containers and host. Containers write JSON files to `data/ipc/{group}/messages/` and `data/ipc/{group}/tasks/`. Host polls, validates authorization, and acts.

**Task Scheduler** (`src/task-scheduler.ts`): Cron/interval/once tasks stored in SQLite, polled every 60s.

**Skills Engine** (`skills-engine/`): Infrastructure for applying, replaying, updating, and uninstalling Codex skills. Skills live in `.codex/skills/` and teach Codex how to transform the installation.

**Memory hierarchy**: Global (`CODEX.md` at root) → Group (`groups/{name}/CODEX.md`). Main group can write global memory; other groups get read-only access.

## Key Conventions

- **ESM throughout**: `"type": "module"` in package.json. All local imports use `.js` extensions.
- **Strict TypeScript**: ES2022 target, NodeNext module resolution, strict mode.
- **Absolute paths**: Container mounts require absolute paths — `process.cwd()` and `path.resolve()` used everywhere.
- **Trigger pattern**: Non-main groups require `@{AssistantName}` at message start (case-insensitive regex). Main group processes all messages.
- **XML message format**: Messages sent to the agent are formatted as XML with HTML entity escaping (`src/router.ts`).
- **`<internal>` tags**: Agent output wrapped in `<internal>...</internal>` is logged but stripped before sending to users.
- **Database**: Synchronous `better-sqlite3`. Test helpers use `_initTestDatabase()` for in-memory DBs.
- **Container isolation**: Security boundary is OS-level container isolation, not app-level permission checks. Mount allowlist at `~/.config/nanoclaw/mount-allowlist.json` (outside project, never mounted).

## Contributing Policy

Source code PRs: only bug fixes, security fixes, simplifications. New features should be skills (`.codex/skills/`), not source modifications. A skill contains instructions for Codex to transform the installation — not pre-built code.

## Environment

Key `.env` variables: `ASSISTANT_NAME` (trigger word, default "Andy"), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ONLY`, `ASSISTANT_HAS_OWN_NUMBER`. Container tunables: `CONTAINER_IMAGE`, `CONTAINER_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS`, `IDLE_TIMEOUT`.
