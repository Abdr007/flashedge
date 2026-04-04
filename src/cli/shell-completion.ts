/**
 * Shell Completion Script Generator
 *
 * Generates completion scripts for bash, zsh, and fish shells.
 * All completions are derived dynamically from the command registry and market config.
 */

import { COMMAND_REGISTRY } from './command-registry.js';
import { getAllMarkets } from '../config/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect all top-level command words (primary names + aliases, no dispatch-only aliases). */
function getAllCommandWords(): string[] {
  const words = new Set<string>();
  for (const entry of COMMAND_REGISTRY) {
    words.add(entry.name);
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        words.add(alias);
      }
    }
  }
  return [...words].sort();
}

/** Commands that accept a market/asset argument. */
const MARKET_TAKING_PREFIXES = [
  'open',
  'close',
  'analyze',
  'liquidations',
  'funding',
  'depth',
  'inspect market',
  'inspect pool',
  'source verify',
  'verify source',
  'protocol fees',
  'position debug',
];

/** Get commands that take market arguments (just the first word for simple matching). */
function getMarketCommands(): string[] {
  const first = new Set<string>();
  for (const cmd of MARKET_TAKING_PREFIXES) {
    first.add(cmd.split(' ')[0]);
  }
  return [...first].sort();
}

// ─── Bash ────────────────────────────────────────────────────────────────────

export function generateBashCompletion(): string {
  const commands = getAllCommandWords();
  const markets = getAllMarkets();
  const marketCmds = getMarketCommands();

  return `# bash completion for flash
# Install: flash completion bash > ~/.bash_completion.d/flash
# Then:    source ~/.bash_completion.d/flash

_flash_completions() {
  local cur prev words cword
  _init_completion || return

  local commands="${commands.join(' ')}"
  local markets="${markets.join(' ')}"
  local market_commands="${marketCmds.join('|')}"

  # If previous word is a market-taking command, complete with market names
  case "$prev" in
    ${marketCmds.join('|')})
      COMPREPLY=( $(compgen -W "$markets" -- "$cur") )
      return
      ;;
  esac

  # Default: complete with command names
  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}

complete -F _flash_completions flash
`;
}

// ─── Zsh ─────────────────────────────────────────────────────────────────────

export function generateZshCompletion(): string {
  const markets = getAllMarkets();
  const marketCmds = getMarketCommands();

  // Build descriptions for zsh from registry
  const descriptions: string[] = [];
  for (const entry of COMMAND_REGISTRY) {
    if (entry.hidden) continue;
    const escaped = entry.description.replace(/'/g, "'\\''");
    descriptions.push(`'${entry.name}:${escaped}'`);
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        descriptions.push(`'${alias}:${escaped}'`);
      }
    }
  }

  return `#compdef flash
# zsh completion for flash
# Install: flash completion zsh > ~/.zsh/completions/_flash
# Then ensure ~/.zsh/completions is in your fpath:
#   fpath=(~/.zsh/completions $fpath)
#   autoload -Uz compinit && compinit

_flash() {
  local -a commands markets market_commands

  commands=(
    ${descriptions.join('\n    ')}
  )

  markets=(${markets.join(' ')})

  market_commands=(${marketCmds.join(' ')})

  # Check if previous word is a market-taking command
  if (( CURRENT > 2 )); then
    local prev_word="\${words[CURRENT-1]}"
    if (( \${market_commands[(Ie)$prev_word]} )); then
      _describe 'market' markets
      return
    fi
  fi

  # First argument: complete commands
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    # For subsequent words, check if the subcommand takes markets
    local cmd="\${words[2]}"
    if (( \${market_commands[(Ie)$cmd]} )); then
      _describe 'market' markets
    fi
  fi
}

_flash "$@"
`;
}

// ─── Fish ────────────────────────────────────────────────────────────────────

export function generateFishCompletion(): string {
  const markets = getAllMarkets();
  const marketCmds = getMarketCommands();

  const lines: string[] = [
    '# fish completion for flash',
    '# Install: flash completion fish > ~/.config/fish/completions/flash.fish',
    '',
    '# Disable file completions by default',
    'complete -c flash -f',
    '',
  ];

  // Add command completions from registry
  for (const entry of COMMAND_REGISTRY) {
    if (entry.hidden) continue;
    const escaped = entry.description.replace(/'/g, "\\'");
    // Primary name — use first word as subcommand condition if multi-word
    const parts = entry.name.split(' ');
    if (parts.length === 1) {
      lines.push(`complete -c flash -n '__fish_use_subcommand' -a '${entry.name}' -d '${escaped}'`);
    } else {
      lines.push(
        `complete -c flash -n '__fish_seen_subcommand_from ${parts[0]}' -a '${parts.slice(1).join(' ')}' -d '${escaped}'`,
      );
    }

    // Aliases
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        const aliasParts = alias.split(' ');
        if (aliasParts.length === 1) {
          lines.push(`complete -c flash -n '__fish_use_subcommand' -a '${alias}' -d '${escaped}'`);
        } else {
          lines.push(
            `complete -c flash -n '__fish_seen_subcommand_from ${aliasParts[0]}' -a '${aliasParts.slice(1).join(' ')}' -d '${escaped}'`,
          );
        }
      }
    }
  }

  lines.push('');
  lines.push('# Market name completions for trade/analysis commands');

  for (const cmd of marketCmds) {
    for (const market of markets) {
      lines.push(`complete -c flash -n '__fish_seen_subcommand_from ${cmd}' -a '${market}'`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
