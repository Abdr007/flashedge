# Dependency Audit Notes
# Last reviewed: 2026-03-08

## Known Vulnerabilities

### bigint-buffer (high severity)
- Advisory: GHSA-3gc7-fjrx-p6mg — Buffer Overflow via toBigIntLE()
- Source: bigint-buffer → @solana/buffer-layout-utils → @solana/spl-token → flash-sdk
- Impact: Requires malicious buffer input to exploit. Flash SDK controls
  all inputs to this function — no user-supplied buffers reach toBigIntLE().
- Practical risk: LOW — the vulnerability requires crafted input that the
  SDK never provides during normal trading operations.
- Fix available: No upstream fix. flash-sdk depends on @solana/spl-token
  which depends on @solana/buffer-layout-utils.
- Action: Pin flash-sdk version. Monitor for upstream migration to
  @solana/spl-token v0.5+ which removes bigint-buffer dependency.
- Review schedule: Check monthly via `npm audit`.
