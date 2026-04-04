# Contributing to Flash Terminal

Thank you for your interest in contributing. This guide covers everything you need to get started.

---

## Prerequisites

- Node.js >= 20.0.0
- npm

---

## Setup

```bash
git clone https://github.com/Abdr007/bolt-terminal.git
cd bolt-terminal
npm install
cp .env.example .env
```

---

## Development

### Run in Development Mode

```bash
npm run dev
```

Uses `tsx` for TypeScript execution without a compile step.

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` and makes the CLI executable.

### Type Check

```bash
npx tsc --noEmit
```

### Run Tests

```bash
npm run test
```

---

## Code Style

- **TypeScript strict mode** -- All code must pass `tsc --strict`
- **ESM modules** -- Use `.js` extensions in imports (`import { x } from './module.js'`)
- **No `any`** -- Use proper types or `unknown` with type guards
- **Defensive arithmetic** -- Use `Number.isFinite()` before arithmetic on external data
- **No fabricated data** -- Never hardcode fallback prices or synthetic market data

### Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files | `kebab-case.ts` | `risk-monitor.ts` |
| Classes | `PascalCase` | `MarketScanner` |
| Functions | `camelCase` | `getPoolForMarket` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_LEVERAGE` |
| Types | `PascalCase` | `ParsedIntent` |

### Commit Messages

Use conventional commit format:

```
feat: add market depth indicator
fix: handle zero-volume markets in scanner
docs: update quickstart with wallet import steps
refactor: simplify regime detection weights
```

---

## Pull Requests

1. **Open an issue first** for large changes. Discuss the approach before writing code.
2. **Fork the repository** and create a feature branch from `main`.
3. **Keep changes focused** -- one feature or fix per PR.
4. **Test your changes** -- run `npm run build` and `npx tsc --noEmit`.
5. **No breaking changes** to the core trading pipeline without prior discussion.

### Safety-Critical Paths

The following areas require extra review and must be discussed in an issue before modification:

- Transaction pipeline (`src/client/flash-client.ts`)
- Signing security (`src/security/signing-guard.ts`)
- Wallet management (`src/wallet/`)
- Risk limits (`src/security/signing-guard.ts`)
- Execution middleware (`src/core/execution-middleware.ts`)

---

## Reporting Issues

### Bug Reports

Open an issue using the **Bug Report** template with:

1. Description of the bug
2. Steps to reproduce
3. Environment (Node.js version, OS, RPC provider)
4. Full error output
5. Mode (Simulation or Live)

### Security Vulnerabilities

Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
