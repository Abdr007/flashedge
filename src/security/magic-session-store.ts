/**
 * Magic-mode session keypair persistence.
 *
 * Sessions are short-lived ed25519 keypairs that the FMT program accepts as
 * trade signers (in lieu of the owner wallet). Persisting them lets the user
 * keep ER trades flowing across CLI restarts without re-signing on the L1
 * mainchain every time.
 *
 * Format: a JSON file per `<network>:<wallet-pubkey>` at
 * `~/.flash/sessions/<network>-<walletPubkey>.json` containing:
 *   {
 *     network: "mainnet-beta" | "devnet",
 *     ownerPubkey: string,
 *     sessionPubkey: string,
 *     secretKey: number[],         // 64-byte ed25519 secret
 *     expiresAt: number,           // unix seconds
 *   }
 *
 * Mode 0o600. The directory is 0o700.
 *
 * Note on threat model: the session secret is on disk in plaintext under the
 * user's home directory — same trust boundary as their owner wallet keypair
 * stored at `~/.config/solana/id.json`. We do NOT add encryption-at-rest with
 * a passphrase here because (a) it would re-prompt on every CLI start, killing
 * the speed-of-flow goal of session keys, and (b) the session is bounded by
 * `expiresAt`, so leaked sessions self-revoke. Users who want stronger
 * isolation should use full-disk encryption.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Keypair } from '@solana/web3.js';

const SESSION_DIR = join(homedir(), '.flash', 'sessions');

export interface StoredSession {
  network: 'mainnet-beta' | 'devnet';
  ownerPubkey: string;
  sessionPubkey: string;
  secretKey: number[];
  expiresAt: number;
}

function ensureDir(): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

function pathFor(network: string, ownerPubkey: string): string {
  return join(SESSION_DIR, `${network}-${ownerPubkey}.json`);
}

export function saveSession(s: StoredSession): void {
  ensureDir();
  writeFileSync(pathFor(s.network, s.ownerPubkey), JSON.stringify(s), { mode: 0o600 });
}

/** Load a stored session if one exists and hasn't expired. */
export function loadSession(
  network: 'mainnet-beta' | 'devnet',
  ownerPubkey: string,
): { keypair: Keypair; expiresAt: number } | null {
  const file = pathFor(network, ownerPubkey);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as StoredSession;
    if (raw.network !== network) return null;
    if (raw.ownerPubkey !== ownerPubkey) return null;
    if (raw.expiresAt < Date.now() / 1000 + 30) {
      // expired — sweep it
      try {
        unlinkSync(file);
      } catch {
        /* ignore */
      }
      return null;
    }
    if (!Array.isArray(raw.secretKey) || raw.secretKey.length !== 64) return null;
    const keypair = Keypair.fromSecretKey(Uint8Array.from(raw.secretKey));
    if (keypair.publicKey.toBase58() !== raw.sessionPubkey) return null;
    return { keypair, expiresAt: raw.expiresAt };
  } catch {
    return null;
  }
}

export function clearSession(network: string, ownerPubkey: string): void {
  const file = pathFor(network, ownerPubkey);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** List all stored sessions (for `magic session status` across wallets). */
export function listSessions(): StoredSession[] {
  if (!existsSync(SESSION_DIR)) return [];
  const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
  const out: StoredSession[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(join(SESSION_DIR, f), 'utf8')) as StoredSession);
    } catch {
      /* skip corrupt files */
    }
  }
  return out;
}
