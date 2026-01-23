# AGENTS

This file orients coding agents to this repository.
Keep edits consistent with existing patterns in the codebase.

## Repository Summary
- Electron desktop app that syncs folders into a sqlite-vec database.
- Main process TypeScript lives in `src/` and renderer in `src/index.html`.
- Tests live in `tests/` and run with Jest + ts-jest.
- Build output is `dist/`; packaged apps go to `release/`.

## Setup Requirements
- Node.js 18+ and npm.
- Optional: OpenAI API key for full embedding tests.
- Optional: external file parsers are installed on demand.

## Core Commands
- Install: `npm install`
- Rebuild native deps (Electron): `npm run rebuild` or `npm run rebuild:electron`
- Development app: `npm run dev`
- Build TypeScript + locales: `npm run build`
- Run app (full build): `npm start`
- Package current platform: `npm run package`

## Packaging Targets
- macOS: `npm run package:mac`
- Linux: `npm run package:linux`
- Windows (Docker): `npm run package:win:docker`

## Tests
- Run all tests: `npm test`
- Watch mode: `npm run test:watch`
- Coverage: `npm run test:coverage`

## Run A Single Test
- By file path: `npm test -- tests/processor.test.ts`
- By name: `npm test -- -t "normalizes legacy"`
- In watch mode: `npm run test:watch -- tests/embeddings.test.ts`
- Direct Jest (skips rebuild/build): `npx jest tests/mcp-server.test.ts`

## Linting/Formatting
- No ESLint/Prettier config in this repo.
- Use `npm run build` as the TypeScript check.
- Match formatting of the file you are editing.

## TypeScript Configuration
- `tsconfig.json` targets ES2022, `commonjs`, and `strict: true`.
- Prefer explicit types when exporting public APIs.
- Use `import type` for type-only imports.

## Code Style Basics
- Source files use 4-space indentation; tests commonly use 2 spaces.
- Use single quotes for strings and end statements with semicolons.
- Keep functions and classes small and focused.
- Favor `async/await` over raw promise chains.
- Use early returns to reduce nesting.

## Import Conventions
- Group imports: external packages, Node built-ins, then local modules.
- Keep `import type` adjacent to related value imports.
- Prefer `import * as fs from 'fs'` for Node built-ins.
- Use explicit named exports for shared utilities.

## Naming Conventions
- Types/interfaces/classes: PascalCase.
- Functions/variables: camelCase.
- Constants: UPPER_SNAKE_CASE for true constants.
- Booleans: prefix with `is`, `has`, or `should`.
- File names are kebab-case or lower camel (`mcp-server.ts`, `llm-chat.ts`).

## Error Handling
- Use `try/catch` around filesystem, database, and network calls.
- Log errors with `console.error` and warnings with `console.warn`.
- Prefer returning `null`/`false` for recoverable failures.
- Throw only when callers need to handle a hard failure.
- Reuse domain-specific errors (ex: `InvalidApiKeyError`).

## Logging and Diagnostics
- Use `console.log` for operational events (startup, sync start/stop).
- Include key identifiers (profile id, file path, port) in logs.
- Avoid noisy logs inside tight loops unless gated by state.

## Testing Conventions
- Jest config lives in `jest.config.js` and uses `tests/setup.ts`.
- Tests are `.test.ts` under `tests/` and use `describe`/`it`.
- Prefer helper utilities in `tests/helpers.ts` for temp dirs/ports.
- Mock external services (OpenAI, electron) with `jest.mock`.
- Default test timeout is 60s, so avoid slow I/O where possible.

## Data and Optional Dependencies
- File parsing libraries are optional; handle `MODULE_NOT_FOUND`.
- Translation JSON lives in `src/locales/*.json` and is copied to `dist/`.
- SQLite vector table uses `vec0` and embedding dimensions are stored in metadata.

## Electron-Specific Notes
- Main process entry: `src/main.ts`.
- Preload bridge: `src/preload.ts` using `contextBridge`.
- Renderer HTML: `src/index.html` (no React/Vite).
- Keep IPC channel names stable and explicit.

## Cursor/Copilot Rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.

## When Adding New Files
- Place new app logic in `src/` and new tests in `tests/`.
- Update `dist/locales` copying if adding locales.
- Add scripts to `package.json` only when needed.

## Agent Checklist Before PRs
- Run `npm run build` for type safety.
- Run relevant Jest tests or a targeted test file.
- Verify optional dependency behavior when touching parsers.
- Avoid touching generated `dist/` and `release/` outputs.
