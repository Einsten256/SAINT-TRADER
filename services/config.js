/*
================================================================================
SAINT CRYPTO
services/config.js

DESTINATION:
SAINT CRYPTO/services/config.js

PURPOSE:
Central configuration for the Saint Crypto backend.

This version is aligned with the new financial architecture:
- UGX Mobile Money recharge
- UGX withdrawable payout balance
- 5% withdrawal fee
- 21:00 EAT Monday-Friday signal
- UGX 20,000 signal reward
- 7-minute signal processing period
- MTN/Airtel manual admin approval
- No TRON/USDT requirement for recharge or withdrawal

Existing trading/Bybit variables are retained as optional configuration so the
market/trading side of Saint Crypto is not unnecessarily broken.
================================================================================
*/

"use strict";

const path = require("path");

// ============================================================================
// ENV HELPERS
// ============================================================================

function envString(name, fallback = "") {
  const value = process.env[name];

  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function envNumber(name, fallback) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback = false) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }

  return [
    "1",
    "true",
    "yes",
    "y",
    "on",
  ].includes(
    String(raw).trim().toLowerCase()
  );
}

function cleanPrefix(value) {
  const result =
    String(value || "/api")
      .trim()
      .replace(/\/+/g, "/");

  if (!result || result === "/") {
    return "";
  }

  return `/${result.replace(/^\/+|\/+$/g, "")}`;
}

// ============================================================================
// APPLICATION
// ============================================================================

const PORT =
  envNumber(
    "PORT",
    3000
  );

const HOST =
  envString(
    "HOST",
    "0.0.0.0"
  );

const NODE_ENV =
  envString(
    "NODE_ENV",
    "development"
  );

const SERVICE_NAME =
  envString(
    "SERVICE_NAME",
    "Saint Crypto Trade Engine"
  );

const API_PREFIX =
  cleanPrefix(
    process.env.API_PREFIX || "/api"
  );

// ============================================================================
// FIREBASE
// ============================================================================

const FIREBASE_DATABASE_URL =
  envString(
    "FIREBASE_DATABASE_URL",
    "https://kendrick-alph-mobile-default-rtdb.firebaseio.com/"
  );

const FIREBASE_PROJECT_ID =
  envString(
    "FIREBASE_PROJECT_ID",
    ""
  );

const FIREBASE_CLIENT_EMAIL =
  envString(
    "FIREBASE_CLIENT_EMAIL",
    ""
  );

const FIREBASE_PRIVATE_KEY =
  envString(
    "FIREBASE_PRIVATE_KEY",
    ""
  ).replace(
    /\\n/g,
    "\n"
  );

const SERVICE_ACCOUNT_PATH =
  envString(
    "FIREBASE_SERVICE_ACCOUNT_PATH",
    path.join(
      __dirname,
      "..",
      "serviceAccountKey.json"
    )
  );

// ============================================================================
// MOBILE MONEY RECHARGE
// ============================================================================

const RECHARGE_MTN_NUMBER =
  envString(
    "RECHARGE_MTN_NUMBER",
    envString(
      "MTN_RECHARGE_NUMBER",
      ""
    )
  );

const RECHARGE_AIRTEL_NUMBER =
  envString(
    "RECHARGE_AIRTEL_NUMBER",
    envString(
      "AIRTEL_RECHARGE_NUMBER",
      ""
    )
  );

const RECHARGE_AIRTEL_NAME =
  envString(
    "RECHARGE_AIRTEL_NAME",
    envString(
      "AIRTEL_RECHARGE_NAME",
      ""
    )
  );

const RECHARGE_MINIMUM_UGX =
  envNumber(
    "RECHARGE_MINIMUM_UGX",
    envNumber(
      "MIN_RECHARGE_AMOUNT_UGX",
      1000
    )
  );

const RECHARGE_MAXIMUM_UGX =
  envNumber(
    "RECHARGE_MAXIMUM_UGX",
    envNumber(
      "MAX_RECHARGE_AMOUNT_UGX",
      100000000
    )
  );

// ============================================================================
// WITHDRAWAL
// ============================================================================

const WITHDRAWAL_FEE_PERCENT =
  envNumber(
    "WITHDRAWAL_FEE_PERCENT",
    5
  );

const WITHDRAWAL_MINIMUM_UGX =
  envNumber(
    "WITHDRAWAL_MINIMUM_UGX",
    1000
  );

const WITHDRAWAL_MAXIMUM_UGX =
  envNumber(
    "WITHDRAWAL_MAXIMUM_UGX",
    100000000
  );

// ============================================================================
// SIGNALS
// ============================================================================

const SIGNAL_REWARD_UGX =
  envNumber(
    "SIGNAL_REWARD_UGX",
    envNumber(
      "SIGNAL_PAYOUT_UGX",
      20000
    )
  );

const SIGNAL_PROCESSING_MINUTES =
  envNumber(
    "SIGNAL_PROCESSING_MINUTES",
    7
  );

const SIGNAL_EXPIRY_MINUTES =
  envNumber(
    "SIGNAL_EXPIRY_MINUTES",
    1440
  );

const SIGNAL_TIMEZONE =
  envString(
    "SIGNAL_TIMEZONE",
    "Africa/Kampala"
  );

const SIGNAL_TIME =
  envString(
    "SIGNAL_TIME",
    (() => {
      const hour = envNumber("SIGNAL_HOUR", 21);
      const minute = envNumber("SIGNAL_MINUTE", 0);
      return `${String(Math.trunc(hour)).padStart(2, "0")}:${String(Math.trunc(minute)).padStart(2, "0")}`;
    })()
  );

const SIGNAL_MIN_LOCKED_CAPITAL_UGX =
  envNumber(
    "SIGNAL_MIN_LOCKED_CAPITAL_UGX",
    1
  );

// ============================================================================
// TELEGRAM
// ============================================================================

const TELEGRAM_BOT_TOKEN =
  envString(
    "TELEGRAM_BOT_TOKEN",
    ""
  );

const TELEGRAM_ADMIN_CHAT_ID =
  envString(
    "TELEGRAM_ADMIN_CHAT_ID",
    ""
  );

const TELEGRAM_SIGNAL_CHAT_ID =
  envString(
    "TELEGRAM_SIGNAL_CHAT_ID",
    ""
  );

const TELEGRAM_RECHARGE_CHAT_ID =
  envString(
    "TELEGRAM_RECHARGE_CHAT_ID",
    TELEGRAM_ADMIN_CHAT_ID
  );

const TELEGRAM_WITHDRAWAL_CHAT_ID =
  envString(
    "TELEGRAM_WITHDRAWAL_CHAT_ID",
    TELEGRAM_ADMIN_CHAT_ID
  );

const TELEGRAM_ENABLED =
  envBoolean(
    "TELEGRAM_ENABLED",
    Boolean(TELEGRAM_BOT_TOKEN)
  );

// ============================================================================
// TRADING / BYBIT
//
// These values are retained for the existing trading/market engine.
// They are NOT required by the new Mobile Money financial flow.
// ============================================================================

const BYBIT_API_KEY =
  envString(
    "BYBIT_API_KEY",
    ""
  );

const BYBIT_API_SECRET =
  envString(
    "BYBIT_API_SECRET",
    ""
  );

const BYBIT_TESTNET =
  envBoolean(
    "BYBIT_TESTNET",
    false
  );

const BYBIT_DEMO =
  envBoolean(
    "BYBIT_DEMO",
    false
  );

const BYBIT_TIMEOUT_MS =
  envNumber(
    "BYBIT_TIMEOUT_MS",
    30000
  );

const BYBIT_RECV_WINDOW =
  envNumber(
    "BYBIT_RECV_WINDOW",
    10000
  );

// ============================================================================
// MARKET / TRADING DEFAULTS
// ============================================================================

const SYMBOLS =
  envString(
    "SYMBOLS",
    "BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const TIMEFRAME =
  envString(
    "TIMEFRAME",
    "15m"
  );

const LEVERAGE =
  envNumber(
    "LEVERAGE",
    5
  );

const MAX_TRADE_CAPITAL =
  envNumber(
    "MAX_TRADE_CAPITAL",
    100
  );

const MIN_TRADE_CAPITAL =
  envNumber(
    "MIN_TRADE_CAPITAL",
    10
  );

const RISK_PERCENTAGE =
  envNumber(
    "RISK_PERCENTAGE",
    0.20
  );

const MAX_DAILY_TRADES =
  envNumber(
    "MAX_DAILY_TRADES",
    10
  );

// ============================================================================
// SECURITY / AUTH
// ============================================================================

const JWT_SECRET =
  envString(
    "JWT_SECRET",
    ""
  );

const ADMIN_API_KEY =
  envString(
    "ADMIN_API_KEY",
    ""
  );

const BUSINESS_MANAGER_KEY =
  envString(
    "BUSINESS_MANAGER_KEY",
    ADMIN_API_KEY
  );

const REQUIRE_ADMIN_KEY =
  envBoolean(
    "REQUIRE_ADMIN_KEY",
    NODE_ENV === "production"
  );

// ============================================================================
// RATE LIMITING
// ============================================================================

const RATE_LIMIT_WINDOW_MS =
  envNumber(
    "RATE_LIMIT_WINDOW_MS",
    15 * 60 * 1000
  );

const RATE_LIMIT_MAX =
  envNumber(
    "RATE_LIMIT_MAX",
    300
  );

const STRICT_RATE_LIMIT_MAX =
  envNumber(
    "STRICT_RATE_LIMIT_MAX",
    30
  );

// ============================================================================
// CORS
// ============================================================================

const CORS_ORIGINS =
  envString(
    "CORS_ORIGINS",
    "*"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// ============================================================================
// FEATURE FLAGS
// ============================================================================

const ENABLE_MOBILE_MONEY_RECHARGE =
  envBoolean(
    "ENABLE_MOBILE_MONEY_RECHARGE",
    envBoolean(
      "MOBILE_MONEY_RECHARGE_ENABLED",
      true
    )
  );

const ENABLE_SIGNAL_SYSTEM =
  envBoolean(
    "ENABLE_SIGNAL_SYSTEM",
    envBoolean(
      "ENABLE_DAILY_SIGNAL",
      true
    )
  );

const ENABLE_WITHDRAWALS =
  envBoolean(
    "ENABLE_WITHDRAWALS",
    envBoolean(
      "ENABLE_MOBILE_MONEY_WITHDRAWAL",
      true
    )
  );

const ENABLE_TELEGRAM =
  envBoolean(
    "ENABLE_TELEGRAM",
    TELEGRAM_ENABLED
  );

const ENABLE_BYBIT_MARKET_ENGINE =
  envBoolean(
    "ENABLE_BYBIT_MARKET_ENGINE",
    true
  );

/*
 * Compatibility aliases used by older Saint Crypto startup code.
 * They intentionally resolve to the same canonical feature flags above.
 */
const ENABLE_MOBILE_MONEY_WITHDRAWAL =
  ENABLE_WITHDRAWALS;

const ENABLE_DAILY_SIGNAL =
  ENABLE_SIGNAL_SYSTEM;

// ============================================================================
// PUBLIC CONFIG
//
// Only non-secret information belongs here.
// Never expose API keys, private keys, JWT secrets or Telegram bot tokens.
// ============================================================================

function getPublicConfig() {
  return {
    success: true,

    service: {
      name: SERVICE_NAME,
      environment: NODE_ENV,
      apiPrefix: API_PREFIX,
    },

    financial: {
      currency: "UGX",

      recharge: {
        enabled:
          ENABLE_MOBILE_MONEY_RECHARGE,

        networks: [
          "MTN",
          "AIRTEL",
        ],

        minimumUgx:
          RECHARGE_MINIMUM_UGX,

        maximumUgx:
          RECHARGE_MAXIMUM_UGX,

        // These are intentionally public because the app needs to display
        // the operator numbers to the user after accepting recharge terms.
        mtnNumber:
          RECHARGE_MTN_NUMBER,

        airtelNumber:
          RECHARGE_AIRTEL_NUMBER,

        airtelName:
          RECHARGE_AIRTEL_NAME,

        feePercent: 0,
      },

      withdrawal: {
        enabled:
          ENABLE_WITHDRAWALS,

        networks: [
          "MTN",
          "AIRTEL",
        ],

        minimumUgx:
          WITHDRAWAL_MINIMUM_UGX,

        maximumUgx:
          WITHDRAWAL_MAXIMUM_UGX,

        feePercent:
          WITHDRAWAL_FEE_PERCENT,
      },
    },

    signals: {
      enabled:
        ENABLE_SIGNAL_SYSTEM,

      rewardUgx:
        SIGNAL_REWARD_UGX,

      processingMinutes:
        SIGNAL_PROCESSING_MINUTES,

      expiryMinutes:
        SIGNAL_EXPIRY_MINUTES,

      timezone:
        SIGNAL_TIMEZONE,

      time:
        SIGNAL_TIME,

      weekdaysOnly: true,

      minimumLockedCapitalUgx:
        SIGNAL_MIN_LOCKED_CAPITAL_UGX,

      codeLength: 12,
    },

    telegram: {
      enabled:
        ENABLE_TELEGRAM,
    },

    trading: {
      marketEngineEnabled:
        ENABLE_BYBIT_MARKET_ENGINE,
    },
  };
}

// ============================================================================
// DIAGNOSTIC CONFIG
//
// Safe for backend logs. Secrets are represented only by configured flags.
// ============================================================================

function getDiagnostics() {
  return {
    serviceName: SERVICE_NAME,
    environment: NODE_ENV,
    host: HOST,
    port: PORT,
    apiPrefix: API_PREFIX,

    firebase: {
      databaseUrlConfigured:
        Boolean(FIREBASE_DATABASE_URL),

      projectIdConfigured:
        Boolean(FIREBASE_PROJECT_ID),

      serviceAccountPathConfigured:
        Boolean(SERVICE_ACCOUNT_PATH),

      serviceAccountEnvConfigured:
        Boolean(
          FIREBASE_PROJECT_ID &&
          FIREBASE_CLIENT_EMAIL &&
          FIREBASE_PRIVATE_KEY
        ),
    },

    financial: {
      currency: "UGX",

      recharge: {
        enabled:
          ENABLE_MOBILE_MONEY_RECHARGE,

        mtnConfigured:
          Boolean(RECHARGE_MTN_NUMBER),

        airtelConfigured:
          Boolean(RECHARGE_AIRTEL_NUMBER),

        minimumUgx:
          RECHARGE_MINIMUM_UGX,

        maximumUgx:
          RECHARGE_MAXIMUM_UGX,
      },

      withdrawal: {
        enabled:
          ENABLE_WITHDRAWALS,

        feePercent:
          WITHDRAWAL_FEE_PERCENT,

        minimumUgx:
          WITHDRAWAL_MINIMUM_UGX,

        maximumUgx:
          WITHDRAWAL_MAXIMUM_UGX,
      },
    },

    signals: {
      enabled:
        ENABLE_SIGNAL_SYSTEM,

      rewardUgx:
        SIGNAL_REWARD_UGX,

      processingMinutes:
        SIGNAL_PROCESSING_MINUTES,

      timezone:
        SIGNAL_TIMEZONE,

      time:
        SIGNAL_TIME,

      weekdaysOnly: true,
    },

    telegram: {
      enabled:
        ENABLE_TELEGRAM,

      botConfigured:
        Boolean(TELEGRAM_BOT_TOKEN),

      adminChatConfigured:
        Boolean(TELEGRAM_ADMIN_CHAT_ID),

      signalChatConfigured:
        Boolean(TELEGRAM_SIGNAL_CHAT_ID),

      rechargeChatConfigured:
        Boolean(TELEGRAM_RECHARGE_CHAT_ID),

      withdrawalChatConfigured:
        Boolean(TELEGRAM_WITHDRAWAL_CHAT_ID),
    },

    bybit: {
      apiConfigured:
        Boolean(
          BYBIT_API_KEY &&
          BYBIT_API_SECRET
        ),

      testnet:
        BYBIT_TESTNET,

      demo:
        BYBIT_DEMO,

      marketEngineEnabled:
        ENABLE_BYBIT_MARKET_ENGINE,
    },

    security: {
      jwtConfigured:
        Boolean(JWT_SECRET),

      adminKeyConfigured:
        Boolean(ADMIN_API_KEY),

      businessManagerKeyConfigured:
        Boolean(BUSINESS_MANAGER_KEY),

      requireAdminKey:
        REQUIRE_ADMIN_KEY,
    },
  };
}

// ============================================================================
// ENVIRONMENT VALIDATION
//
// This does not crash the server. It reports configuration problems so the
// application can still boot and expose its diagnostics endpoint.
// ============================================================================

function validateConfig() {
  const warnings = [];

  if (!FIREBASE_DATABASE_URL) {
    warnings.push(
      "FIREBASE_DATABASE_URL is not configured."
    );
  }

  if (
    ENABLE_MOBILE_MONEY_RECHARGE &&
    !RECHARGE_MTN_NUMBER &&
    !RECHARGE_AIRTEL_NUMBER
  ) {
    warnings.push(
      "Mobile Money recharge is enabled but no MTN/Airtel recharge number is configured."
    );
  }

  if (
    ENABLE_TELEGRAM &&
    !TELEGRAM_BOT_TOKEN
  ) {
    warnings.push(
      "Telegram is enabled but TELEGRAM_BOT_TOKEN is not configured."
    );
  }

  if (
    REQUIRE_ADMIN_KEY &&
    !ADMIN_API_KEY &&
    !BUSINESS_MANAGER_KEY
  ) {
    warnings.push(
      "Admin protection is enabled but no admin/business-manager key is configured."
    );
  }

  if (
    SIGNAL_REWARD_UGX <= 0
  ) {
    warnings.push(
      "SIGNAL_REWARD_UGX must be greater than zero."
    );
  }

  if (
    SIGNAL_PROCESSING_MINUTES < 0
  ) {
    warnings.push(
      "SIGNAL_PROCESSING_MINUTES cannot be negative."
    );
  }

  if (
    WITHDRAWAL_FEE_PERCENT < 0 ||
    WITHDRAWAL_FEE_PERCENT > 100
  ) {
    warnings.push(
      "WITHDRAWAL_FEE_PERCENT should be between 0 and 100."
    );
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Application
  PORT,
  HOST,
  NODE_ENV,
  SERVICE_NAME,
  API_PREFIX,

  // Firebase
  FIREBASE_DATABASE_URL,
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  SERVICE_ACCOUNT_PATH,

  // Mobile Money recharge
  RECHARGE_MTN_NUMBER,
  RECHARGE_AIRTEL_NUMBER,
  RECHARGE_AIRTEL_NAME,
  RECHARGE_MINIMUM_UGX,
  RECHARGE_MAXIMUM_UGX,

  // Withdrawals
  WITHDRAWAL_FEE_PERCENT,
  WITHDRAWAL_MINIMUM_UGX,
  WITHDRAWAL_MAXIMUM_UGX,

  // Signals
  SIGNAL_REWARD_UGX,
  SIGNAL_PROCESSING_MINUTES,
  SIGNAL_EXPIRY_MINUTES,
  SIGNAL_TIMEZONE,
  SIGNAL_TIME,
  SIGNAL_MIN_LOCKED_CAPITAL_UGX,

  // Telegram
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ADMIN_CHAT_ID,
  TELEGRAM_SIGNAL_CHAT_ID,
  TELEGRAM_RECHARGE_CHAT_ID,
  TELEGRAM_WITHDRAWAL_CHAT_ID,
  TELEGRAM_ENABLED,

  // Bybit / trading
  BYBIT_API_KEY,
  BYBIT_API_SECRET,
  BYBIT_TESTNET,
  BYBIT_DEMO,
  BYBIT_TIMEOUT_MS,
  BYBIT_RECV_WINDOW,

  SYMBOLS,
  TIMEFRAME,
  LEVERAGE,
  MAX_TRADE_CAPITAL,
  MIN_TRADE_CAPITAL,
  RISK_PERCENTAGE,
  MAX_DAILY_TRADES,

  // Security
  JWT_SECRET,
  ADMIN_API_KEY,
  BUSINESS_MANAGER_KEY,
  REQUIRE_ADMIN_KEY,

  // Rate limiting
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  STRICT_RATE_LIMIT_MAX,

  // CORS
  CORS_ORIGINS,

  // Feature flags
  ENABLE_MOBILE_MONEY_RECHARGE,
  ENABLE_SIGNAL_SYSTEM,
  ENABLE_WITHDRAWALS,
  ENABLE_MOBILE_MONEY_WITHDRAWAL,
  ENABLE_DAILY_SIGNAL,
  ENABLE_TELEGRAM,
  ENABLE_BYBIT_MARKET_ENGINE,

  // Functions
  getPublicConfig,
  getDiagnostics,
  validateConfig,

  // Helpers
  envString,
  envNumber,
  envBoolean,
  cleanPrefix,
};
