"use strict";

const fs = require("fs");

const {
  initializeApp,
  cert,
  getApps,
} = require("firebase-admin/app");

const {
  getFirestore,
} = require("firebase-admin/firestore");

const {
  getDatabase,
} = require("firebase-admin/database");

// ============================================================
// ENVIRONMENT HELPERS
// ============================================================

function env(...names) {
  for (const name of names) {
    if (
      process.env[name] !== undefined &&
      String(process.env[name]).trim() !== ""
    ) {
      return String(process.env[name]).trim();
    }
  }

  return "";
}

function num(value, fallback) {
  const n = Number.parseFloat(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function bool(value, fallback = false) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  return [
    "1",
    "true",
    "yes",
    "on",
  ].includes(
    String(value).toLowerCase()
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function roundMoney(value, decimals = 4) {
  const factor = 10 ** decimals;

  return (
    Math.round(
      (Number(value) || 0) * factor
    ) / factor
  );
}

// ============================================================
// BUSINESS CONFIGURATION
// ============================================================

// ------------------------------------------------------------
// SIGNAL / PAYOUT
// ------------------------------------------------------------

const PAYOUT_TIER_100 = num(
  process.env.PAYOUT_TIER_100,
  2
);

const PAYOUT_TIER_200 = num(
  process.env.PAYOUT_TIER_200,
  3
);

const PAYOUT_TIER_500 = num(
  process.env.PAYOUT_TIER_500,
  4
);

const PAYOUT_MINIMUM_CAPITAL = num(
  process.env.PAYOUT_MINIMUM_CAPITAL,
  100
);

// ------------------------------------------------------------
// DEPOSITS
// ------------------------------------------------------------

const DEPOSIT_COIN =
  env("DEPOSIT_COIN") || "USDT";

const DEPOSIT_CHAIN = (
  env("DEPOSIT_CHAIN") || "TRX"
).toUpperCase();

const DEPOSIT_MINIMUM = num(
  process.env.DEPOSIT_MINIMUM,
  100
);

const CENTRAL_DEPOSIT_ADDRESS =
  env("CENTRAL_DEPOSIT_ADDRESS") ||
  "TKeND3TnF2L1J7LUjatwrGoxLXP9AH5wZw";

// ------------------------------------------------------------
// WITHDRAWALS
// ------------------------------------------------------------

const WITHDRAW_COIN =
  env(
    "WITHDRAWAL_COIN",
    "WITHDRAW_COIN"
  ) || "USDT";

const WITHDRAW_CHAIN = (
  env(
    "WITHDRAWAL_CHAIN",
    "WITHDRAW_CHAIN"
  ) || "TRX"
).toUpperCase();

const WITHDRAW_ACCOUNT_TYPE = (
  env(
    "BYBIT_WITHDRAWAL_ACCOUNT_TYPE",
    "BYBIT_WITHDRAW_ACCOUNT_TYPE"
  ) || "FUND"
).toUpperCase();

const WITHDRAW_MINIMUM = num(
  env(
    "MIN_WITHDRAWAL_AMOUNT",
    "WITHDRAW_MINIMUM"
  ),
  10
);

const WITHDRAW_MAXIMUM = num(
  env(
    "MAX_WITHDRAWAL_AMOUNT",
    "WITHDRAW_MAXIMUM"
  ),
  100000
);

const WITHDRAW_FEE_PERCENT = num(
  process.env.WITHDRAWAL_FEE,
  5
);

// ------------------------------------------------------------
// MONITORING
// ------------------------------------------------------------

const DEPOSIT_MONITOR_MINUTES =
  Math.max(
    1,
    int(
      process.env.DEPOSIT_MONITOR_MINUTES,
      1
    )
  );

const WITHDRAWAL_MONITOR_MINUTES =
  Math.max(
    1,
    int(
      process.env.WITHDRAWAL_MONITOR_MINUTES,
      1
    )
  );

const SIGNAL_EXPIRY_MINUTES =
  Math.max(
    1,
    int(
      process.env.SIGNAL_EXPIRY_MINUTES,
      10
    )
  );

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------

const ALLOW_LEGACY_USER_ID = bool(
  process.env.ALLOW_LEGACY_USER_ID,
  true
);

// ============================================================
// BYBIT
// ============================================================

const BYBIT_API_KEY =
  env("BYBIT_API_KEY");

const BYBIT_API_SECRET =
  env("BYBIT_API_SECRET");

const BYBIT_TESTNET = bool(
  process.env.BYBIT_TESTNET,
  false
);

const BYBIT_RECV_WINDOW = int(
  process.env.BYBIT_RECV_WINDOW,
  10000
);

const BYBIT_TIMEOUT_MS = int(
  process.env.BYBIT_TIMEOUT_MS,
  30000
);

const BYBIT_RETRY_ATTEMPTS =
  Math.max(
    1,
    int(
      process.env.BYBIT_RETRY_ATTEMPTS,
      3
    )
  );

const BYBIT_RETRY_DELAY =
  Math.max(
    1,
    int(
      process.env.BYBIT_RETRY_DELAY,
      2
    )
  );

// ============================================================
// TELEGRAM
// ============================================================

const TELEGRAM_BOT_TOKEN =
  env("TELEGRAM_BOT_TOKEN");

const TELEGRAM_CHAT_ID =
  env("TELEGRAM_CHAT_ID");

const TELEGRAM_ENABLED = Boolean(
  TELEGRAM_BOT_TOKEN &&
  TELEGRAM_CHAT_ID
);

// ============================================================
// FIREBASE
// ============================================================

const FIREBASE_DATABASE_URL =
  env("FIREBASE_DATABASE_URL") ||
  "https://kendrick-alph-mobile-default-rtdb.firebaseio.com/";

const FIREBASE_SERVICE_ACCOUNT_PATH =
  env("FIREBASE_SERVICE_ACCOUNT_PATH") ||
  "./serviceAccountKey.json";

let firebaseReady = false;
let firestore = null;
let realtimeDb = null;

// ============================================================
// INITIALIZE FIREBASE
// ============================================================

try {
  if (getApps().length > 0) {
    firebaseReady = true;

    console.log(
      "✅ Firebase Admin already initialized."
    );
  } else if (
    fs.existsSync(
      FIREBASE_SERVICE_ACCOUNT_PATH
    )
  ) {
    initializeApp({
      credential: cert(
        require(
          FIREBASE_SERVICE_ACCOUNT_PATH
        )
      ),

      databaseURL:
        FIREBASE_DATABASE_URL,
    });

    firebaseReady = true;

    console.log(
      "✅ Firebase Admin initialized from service account file."
    );
  } else if (
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ) {
    initializeApp({
      credential: cert(
        JSON.parse(
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        )
      ),

      databaseURL:
        FIREBASE_DATABASE_URL,
    });

    firebaseReady = true;

    console.log(
      "✅ Firebase Admin initialized from environment JSON."
    );
  } else {
    console.warn(
      "⚠️ Firebase service account is not configured."
    );
  }
} catch (error) {
  console.error(
    "❌ Firebase initialization error:",
    error.message
  );
}

// ============================================================
// FIREBASE DATABASE INSTANCES
// ============================================================

if (firebaseReady) {
  try {
    firestore = getFirestore();
  } catch (error) {
    console.error(
      "❌ Firestore initialization error:",
      error.message
    );
  }

  try {
    realtimeDb = getDatabase();
  } catch (error) {
    console.warn(
      "⚠️ Realtime Database unavailable:",
      error.message
    );
  }
}

// ============================================================
// FIRESTORE HELPER
// ============================================================

function getFirestoreSafe() {
  if (!firestore) {
    throw new Error(
      "Firestore is not available."
    );
  }

  return firestore;
}

// ============================================================
// REALTIME DATABASE HELPER
// ============================================================

function getRealtimeDatabase() {
  return realtimeDb;
}

// ============================================================
// CONFIG OBJECT
// ============================================================

const config = {
  PAYOUT_TIER_100,
  PAYOUT_TIER_200,
  PAYOUT_TIER_500,
  PAYOUT_MINIMUM_CAPITAL,

  DEPOSIT_COIN,
  DEPOSIT_CHAIN,
  DEPOSIT_MINIMUM,
  CENTRAL_DEPOSIT_ADDRESS,

  WITHDRAW_COIN,
  WITHDRAW_CHAIN,
  WITHDRAW_ACCOUNT_TYPE,
  WITHDRAW_MINIMUM,
  WITHDRAW_MAXIMUM,
  WITHDRAW_FEE_PERCENT,

  DEPOSIT_MONITOR_MINUTES,
  WITHDRAWAL_MONITOR_MINUTES,
  SIGNAL_EXPIRY_MINUTES,

  ALLOW_LEGACY_USER_ID,

  BYBIT_API_KEY,
  BYBIT_API_SECRET,
  BYBIT_TESTNET,
  BYBIT_RECV_WINDOW,
  BYBIT_TIMEOUT_MS,
  BYBIT_RETRY_ATTEMPTS,
  BYBIT_RETRY_DELAY,

  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_ENABLED,

  FIREBASE_DATABASE_URL,
  FIREBASE_SERVICE_ACCOUNT_PATH,

  USERS_COLLECTION:
    env("USERS_COLLECTION") ||
    "users",

  WITHDRAWALS_COLLECTION:
    env("WITHDRAWALS_COLLECTION") ||
    "withdrawals",

  LEDGER_COLLECTION:
    env("LEDGER_COLLECTION") ||
    "ledger",
};

// ============================================================
// STARTUP LOG
// ============================================================

console.log(
  "============================================================"
);

console.log(
  "⚙️ Saint Crypto configuration loaded."
);

console.log(
  `   Bybit configured: ${Boolean(
    BYBIT_API_KEY &&
    BYBIT_API_SECRET
  )}`
);

console.log(
  `   Bybit testnet: ${BYBIT_TESTNET}`
);

console.log(
  `   Deposit coin: ${DEPOSIT_COIN}`
);

console.log(
  `   Deposit chain: ${DEPOSIT_CHAIN}`
);

console.log(
  `   Withdrawal coin: ${WITHDRAW_COIN}`
);

console.log(
  `   Withdrawal chain: ${WITHDRAW_CHAIN}`
);

console.log(
  `   Withdrawal account: ${WITHDRAW_ACCOUNT_TYPE}`
);

console.log(
  `   Telegram enabled: ${TELEGRAM_ENABLED}`
);

console.log(
  `   Firebase ready: ${firebaseReady}`
);

console.log(
  "============================================================"
);

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  config,

  roundMoney,

  sleep,

  getFirestore:
    getFirestoreSafe,

  getRealtimeDatabase,

  firebaseReady,

  env,

  num,

  int,

  bool,
};