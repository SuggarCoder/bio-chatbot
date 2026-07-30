# Repository Guidelines

## Project Structure & Module Organization

This repository contains a SolidJS client and a Fastify server.

- `src/client/`: browser entry point, routing, global CSS, and application UI.
- `src/client/pages/`: route-level views; chatbot screens live under `pages/chatbot/`.
- `src/client/features/`: feature state and behavior, such as chat streaming and storage.
- `src/client/shared/ui/`: reusable UI components.
- `src/client/assets/`: fonts, icons, and other bundled static files.
- `src/server/index.ts`: API, health check, static-file serving, and SPA fallback.
- `.github/workflows/deploy.yml`, `Dockerfile`, and `compose.yaml`: production build and deployment configuration.

Generated output belongs in `dist/`; dependencies belong in `node_modules/`. Do not commit either directory.

## Build, Test, and Development Commands

Use Node.js 22 (matching the Docker image) and install exact dependencies with `npm ci`.

- `npm run dev`: starts Vite and the Fastify API together with file watching.
- `npm run dev:web`: starts only the client on port 5173.
- `npm run dev:api`: starts only the API on port 8090 with client serving disabled.
- `npm run check`: type-checks both client and server without emitting files.
- `npm run build`: runs type checks, builds the Vite client, and compiles the server.
- `npm start`: runs the compiled server from `dist/server/index.js`.

## Coding Style & Naming Conventions

Write strict TypeScript and TSX with two-space indentation, single quotes, and no semicolons, matching existing files. Use `PascalCase` for components and types, `camelCase` for functions and variables, and descriptive feature filenames such as `chatStore.tsx`. Keep route-level composition in `pages/`, reusable primitives in `shared/ui/`, and feature logic in `features/`. Prefer UnoCSS utility classes and extend `uno.config.ts` for reusable rules. No formatter or linter is configured, so preserve the surrounding style and run `npm run check`.

## Testing Guidelines

There is currently no automated test framework or coverage threshold. Every change must pass `npm run check` and `npm run build`. Manually verify affected routes and `/ai-chatbot/api/health`. If introducing tests, add an explicit npm script and use `*.test.ts` or `*.test.tsx` beside the code under test.

## Commit & Pull Request Guidelines

History uses short messages and occasionally Conventional Commit prefixes (`feat:`). Prefer an imperative, scoped summary such as `fix: preserve chat stream state`. Keep commits focused. Pull requests should explain behavior changes, list validation commands, link relevant issues, and include screenshots for visible UI changes. Call out changes to deployment files, environment variables, API paths, or the `/ai-chatbot/` base path.

## Security & Configuration

Never commit `.env` files, credentials, or production host details. Document new variables in a sanitized `.env.example`, and validate Docker and reverse-proxy assumptions when changing ports or URL prefixes.
