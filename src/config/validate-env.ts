/**
 * Environment Variable Validator — strict type checking at startup.
 *
 * Validates format and range of environment variables before the config
 * loader runs. Invalid values cause an immediate abort with a descriptive error.
 *
 * IMPORTANT: Only validates vars that are actually SET. Unset vars use defaults
 * and are handled by the config loader.
 */

import chalk from 'chalk';

interface EnvValidationError {
  variable: string;
  value: string;
  expected: string;
}

function isPositiveInteger(value: string): boolean {
  const n = parseInt(value, 10);
  return !Number.isNaN(n) && n > 0 && String(n) === value.trim();
}

function isNonNegativeNumber(value: string): boolean {
  const n = parseFloat(value);
  return !Number.isNaN(n) && n >= 0 && Number.isFinite(n);
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isBoolean(value: string): boolean {
  return ['true', 'false'].includes(value.toLowerCase().trim());
}

function isLogLevel(value: string): boolean {
  return ['debug', 'info', 'warn', 'error'].includes(value.toLowerCase().trim());
}

function isLogFormat(value: string): boolean {
  return ['text', 'json'].includes(value.toLowerCase().trim());
}

function isAlertSeverity(value: string): boolean {
  return ['info', 'warning', 'critical'].includes(value.toLowerCase().trim());
}

interface EnvRule {
  validate: (value: string) => boolean;
  expected: string;
}

const ENV_RULES: Record<string, EnvRule> = {
  SESSION_TIMEOUT_MS: {
    validate: isPositiveInteger,
    expected: 'positive integer (milliseconds), e.g. 900000',
  },
  MAX_DAILY_LOSS_USD: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number (USD), e.g. 1000',
  },
  MAX_SESSION_LOSS_USD: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number (USD), e.g. 500',
  },
  MAX_PORTFOLIO_EXPOSURE: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number (USD), e.g. 10000',
  },
  ALERT_WEBHOOK_URL: {
    validate: isValidUrl,
    expected: 'valid HTTP/HTTPS URL',
  },
  SLACK_WEBHOOK_URL: {
    validate: isValidUrl,
    expected: 'valid HTTP/HTTPS URL',
  },
  FLASH_DYNAMIC_CU: {
    validate: isBoolean,
    expected: 'true or false',
  },
  FLASH_CU_BUFFER_PCT: {
    validate: (v) => {
      const n = parseInt(v, 10);
      return !Number.isNaN(n) && n >= 0 && n <= 100;
    },
    expected: 'integer between 0 and 100',
  },
  FLASH_LOG_LEVEL: {
    validate: isLogLevel,
    expected: 'debug, info, warn, or error',
  },
  FLASH_LOG_FORMAT: {
    validate: isLogFormat,
    expected: 'text or json',
  },
  ALERT_MIN_SEVERITY: {
    validate: isAlertSeverity,
    expected: 'info, warning, or critical',
  },
  SIMULATION_MODE: {
    validate: isBoolean,
    expected: 'true or false',
  },
  TRADING_ENABLED: {
    validate: isBoolean,
    expected: 'true or false',
  },
  SHADOW_TRADING: {
    validate: isBoolean,
    expected: 'true or false',
  },
  FLASH_STRICT_PROTOCOL: {
    validate: isBoolean,
    expected: 'true or false',
  },
  MAX_TRADES_PER_MINUTE: {
    validate: isPositiveInteger,
    expected: 'positive integer',
  },
  MIN_DELAY_BETWEEN_TRADES_MS: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number (milliseconds)',
  },
  COMPUTE_UNIT_LIMIT: {
    validate: isPositiveInteger,
    expected: 'positive integer',
  },
  COMPUTE_UNIT_PRICE: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number (microLamports)',
  },
  DEFAULT_SLIPPAGE_BPS: {
    validate: isPositiveInteger,
    expected: 'positive integer (basis points)',
  },
  MAX_COLLATERAL_PER_TRADE: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number (USD), 0 = unlimited',
  },
  MAX_POSITION_SIZE: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number (USD), 0 = unlimited',
  },
  MAX_LEVERAGE: {
    validate: isNonNegativeNumber,
    expected: 'non-negative number, 0 = use market defaults',
  },
};

/**
 * Validate all set environment variables against their rules.
 * Returns an array of errors. Empty array = all valid.
 */
export function validateEnvironment(): EnvValidationError[] {
  const errors: EnvValidationError[] = [];

  for (const [name, rule] of Object.entries(ENV_RULES)) {
    const value = process.env[name];
    if (value === undefined || value === '') continue;

    if (!rule.validate(value)) {
      errors.push({
        variable: name,
        value: value.length > 50 ? value.slice(0, 50) + '...' : value,
        expected: rule.expected,
      });
    }
  }

  return errors;
}

/**
 * Validate environment and abort with descriptive errors if invalid.
 * Call this before config loading.
 */
export function validateEnvironmentOrExit(): void {
  const errors = validateEnvironment();
  if (errors.length === 0) return;

  console.error('');
  console.error(chalk.red('  Environment variable validation failed:'));
  console.error('');
  for (const err of errors) {
    console.error(`    ${chalk.yellow(err.variable)}="${err.value}"`);
    console.error(`      Expected: ${err.expected}`);
    console.error('');
  }
  console.error('  Fix the values above in your .env file and restart.');
  console.error('');
  process.exit(1);
}
