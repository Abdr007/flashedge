/**
 * Trade Templates
 *
 * Reusable trade command shortcuts stored in ~/.flash/templates.json.
 *
 * Usage:
 *   template scalp = long sol 3x 50 tp 2% sl 1%
 *   template swing = long btc 2x 200 tp 5% sl 3%
 *   scalp                    (expands to the full command)
 *   templates                (list all)
 *   untemplate scalp         (remove)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TEMPLATE_FILE = join(homedir(), '.flash', 'templates.json');
const MAX_TEMPLATES = 100;

let _cache: Record<string, string> | null = null;

export function loadTemplates(): Record<string, string> {
  if (_cache) return _cache;
  try {
    if (!existsSync(TEMPLATE_FILE)) {
      _cache = {};
      return _cache;
    }
    const raw = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      _cache = {};
      return _cache;
    }
    _cache = raw as Record<string, string>;
    return _cache;
  } catch {
    _cache = {};
    return _cache;
  }
}

function saveTemplates(templates: Record<string, string>): void {
  try {
    const dir = join(homedir(), '.flash');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TEMPLATE_FILE, JSON.stringify(templates, null, 2), { mode: 0o600 });
    _cache = templates;
  } catch {
    /* best-effort */
  }
}

export function setTemplate(name: string, command: string): boolean {
  const templates = loadTemplates();
  if (Object.keys(templates).length >= MAX_TEMPLATES && !(name in templates)) return false;
  templates[name.toLowerCase()] = command;
  saveTemplates(templates);
  return true;
}

export function removeTemplate(name: string): boolean {
  const templates = loadTemplates();
  const key = name.toLowerCase();
  if (!(key in templates)) return false;
  delete templates[key];
  saveTemplates(templates);
  return true;
}

/** Expand a template if the first token matches. Returns null if no match. */
export function expandTemplate(input: string): string | null {
  const templates = loadTemplates();
  const lower = input.toLowerCase().trim();
  const firstToken = lower.split(/\s+/)[0];
  if (firstToken && templates[firstToken]) {
    const rest = input.slice(firstToken.length).trim();
    // Allow appending extra params: "scalp 100" → "long sol 3x 100"
    return rest ? templates[firstToken] + ' ' + rest : templates[firstToken];
  }
  return null;
}

export function getAllTemplates(): Record<string, string> {
  return { ...loadTemplates() };
}

export function clearTemplateCache(): void {
  _cache = null;
}
