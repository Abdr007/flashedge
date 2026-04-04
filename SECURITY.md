# Security Policy

Flash Terminal interacts with the Solana blockchain and manages cryptographic keys. Security is a core design priority.

---

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly.

**Do not** open a public GitHub issue for security vulnerabilities.

### How to Report

1. Email a description of the issue to the repository maintainers (see the GitHub profile for contact information).
2. Include:
   - A description of the vulnerability and its potential impact
   - Steps to reproduce the issue
   - Affected files or components
   - Any suggested fix, if you have one
3. Use the subject line: `[SECURITY] Flash Terminal - <brief description>`

### Response Timeline

| Stage | Expected Timeline |
|-------|-------------------|
| Acknowledgment | Within 48 hours of report |
| Initial assessment | Within 5 business days |
| Fix development | Within 14 business days for critical issues |
| Disclosure coordination | Agreed upon with reporter before public disclosure |

We will coordinate with the reporter on disclosure timing. Please allow reasonable time for a fix before any public disclosure.

---

## Security Architecture

### Critical Invariants

The following security properties must never be violated:

1. **Private keys must never be logged.** No secret key material may appear in console output, log files, error messages, or audit trails.
2. **Signing confirmation gates must not be bypassed.** Every trade must display a full position summary and receive explicit user confirmation before signing.
3. **RPC URLs must be validated.** All RPC endpoints must use HTTPS (except localhost). Embedded credentials in URLs are rejected.
4. **Wallet file access must be restricted.** Wallet paths are validated within the home directory with symlink resolution. File size limits prevent reading non-wallet files.
5. **Transaction dry-run must never sign.** The `previewOpenPosition` method must never call `.sign()` on the transaction.

### Wallet Security

#### Key Storage

- Wallet files are stored in `~/.flash/wallets/` with `0600` permissions (owner-only read/write)
- The `~/.flash/` directory is created with `0700` permissions; existing directories are re-secured on startup
- Wallet names are sanitized to alphanumeric characters, hyphens, and underscores (max 64 chars) to prevent path traversal

#### Key Handling

- Private keys are never printed to the terminal
- Private keys are never written to log files
- Private key bytes are zeroed from memory after use
- During interactive wallet import, key input is hidden (no echo)
- Secret key arrays are validated as exactly 64 bytes, each value 0-255

#### Path Security

- Wallet file paths are restricted to the user's home directory
- Symlinks are resolved via `realpathSync()` and verified to prevent directory traversal
- File size limited to 1024 bytes to prevent reading arbitrary files

### Transaction Signing

- **Confirmation gate**: Full position summary (market, side, leverage, collateral, size, fees, wallet) displayed before every trade
- **Rate limiter**: Configurable `MAX_TRADES_PER_MINUTE` and `MIN_DELAY_BETWEEN_TRADES_MS`; recorded only after successful confirmation
- **Trade limits**: Configurable `MAX_COLLATERAL_PER_TRADE`, `MAX_POSITION_SIZE`, `MAX_LEVERAGE`
- **Trade mutex**: Per-market/side lock acquired before any async operations, prevents concurrent transaction submissions
- **Signature cache**: 120-second TTL cache prevents duplicate trade submissions
- **Audit log**: All trade attempts logged to `~/.flash/signing-audit.log` (never includes key material)

### API Key Safety

The logger automatically scrubs sensitive patterns from all file log output:

- `api_key=...` --> `api_key=***`
- `sk-ant-...` (Anthropic keys) --> `sk-ant-***`
- `gsk_...` (Groq keys) --> `gsk_***`

API keys should only be set in `.env` files, never in shell history or command arguments. The `.env` file is listed in `.gitignore`.

### Network Security

- RPC URLs validated for HTTPS protocol (HTTP rejected for non-localhost endpoints)
- RPC URLs rejected if they contain embedded credentials
- All API calls have timeouts (8-10s for data, 120s for transactions)
- Response body size limits prevent OOM from oversized responses (2MB fstats, 1MB CoinGecko)
- Slot lag monitoring triggers automatic failover when an endpoint falls >50 slots behind
- Log files rotate at 10MB with `.old` backup

---

## Simulation Mode

- `SIMULATION_MODE` defaults to `true` -- the system starts in paper trading mode
- Live mode requires explicit opt-in (`SIMULATION_MODE=false`)
- Simulation and live modes are locked for the entire session once selected

---

## Dependencies

Key dependencies with security implications:

| Package | Purpose | Maintainer |
|---------|---------|------------|
| `@solana/web3.js` | Solana RPC and transaction signing | Solana Foundation |
| `flash-sdk` | Flash Trade protocol interaction | Flash Trade |
| `@pythnetwork/client` | Oracle price feeds | Pyth Network |
| `@anthropic-ai/sdk` | LLM-powered command parsing (optional) | Anthropic |
| `zod` | Input validation schemas | Community standard |

---

## Data Integrity

- The system uses only live market data -- no hardcoded prices or synthetic signals
- Markets without reliable price data are excluded from analysis
- If external data sources (CoinGecko, fstats.io) are unreachable, affected features degrade gracefully rather than producing incorrect results
- Oracle price validation rejects zero or negative values from Pyth

---

## Known Vulnerability Allowlist

The following vulnerabilities are present in upstream dependencies and cannot be fixed in Flash Terminal. They are allowlisted in CI and documented here for transparency.

### bigint-buffer (high severity)

- **Advisory**: [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)
- **Severity**: High
- **Issue**: Buffer overflow in `toBigIntLE()` function
- **Dependency chain**: `flash-sdk` → `@solana/spl-token` → `@solana/buffer-layout-utils` → `bigint-buffer`
- **Status**: No fix available upstream
- **Risk assessment**: The vulnerable function is not exposed to user-controlled input in Flash Terminal. All bigint conversions use internally validated on-chain data from Solana RPC responses.
- **Allowlisted since**: v1.0.0 (2026-03-15)

### Review schedule

Allowlisted vulnerabilities are reviewed monthly. When an upstream fix becomes available, the dependency will be upgraded and the entry removed from this list.
