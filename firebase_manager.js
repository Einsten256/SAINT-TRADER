// ============================================================
// SAINT CRYPTO
// firebase_manager.js
// ============================================================
// Firebase compatibility/utility manager.
//
// IMPORTANT:
// - Signal creation/release is now owned by services/signal.js.
// - Daily scheduling is now owned by services/scheduler.js.
// - Signal redemption/payout is owned by services/signal.js.
// - Financial ledger/recharge/withdrawal logic is owned by their
//   respective services.
// - This file keeps Firebase, RTDB compatibility, Telegram alerts,
//   freeze checks, and legacy balance helpers that other backend
//   modules may still use.
// - No Bybit/TRON/USDT withdrawal flow is implemented here.
// ============================================================

"use strict";

const crypto = require("crypto");

const {
  initializeApp,
  getApps,
  getApp,
  cert,
  applicationDefault,
} = require("firebase-admin/app");

const {
  getFirestore: getFirebaseFirestore,
  Timestamp,
  FieldValue,
} = require("firebase-admin/firestore");

const {
  getDatabase: getFirebaseDatabase,
} = require("firebase-admin/database");

// ============================================================
// 1. ENVIRONMENT
// ============================================================

const FIREBASE_DATABASE_URL =
  String(process.env.FIREBASE_DATABASE_URL || "").trim();

const TELEGRAM_BOT_TOKEN =
  String(process.env.TELEGRAM_BOT_TOKEN || "").trim();

const TELEGRAM_CHAT_ID =
  String(process.env.TELEGRAM_CHAT_ID || "").trim();

const SIGNAL_TIMEZONE =
  String(process.env.SIGNAL_TIMEZONE || "Africa/Kampala").trim();

const SIGNAL_DEFAULT_SYMBOL =
  String(process.env.SIGNAL_DEFAULT_SYMBOL || "XAUUSD")
    .trim()
    .toUpperCase();

// New system values. These are informational here; actual signal
// reward/processing/scheduling logic lives in services/signal.js
// and services/scheduler.js.
const SIGNAL_REWARD_UGX = Number(
  process.env.SIGNAL_REWARD_UGX || "20000"
);

const SIGNAL_PROCESSING_MINUTES = Number(
  process.env.SIGNAL_PROCESSING_MINUTES || "7"
);

const SIGNAL_EXPIRY_MINUTES = Number(
  process.env.SIGNAL_EXPIRY_MINUTES || "1440"
);

// ============================================================
// 2. FIREBASE REFERENCES
// ============================================================

let firebaseApp = null;
let firestoreDb = null;
let realtimeDb = null;

// ============================================================
// 3. FIREBASE INITIALIZATION
// ============================================================

function initializeFirebase() {
  try {
    // Reuse Firebase initialized by index.js or another service.
    if (getApps().length > 0) {
      firebaseApp = getApp();

      firestoreDb = getFirebaseFirestore(firebaseApp);

      if (FIREBASE_DATABASE_URL) {
        try {
          realtimeDb = getFirebaseDatabase(firebaseApp);
        } catch (error) {
          console.warn(
            "⚠️ Firebase RTDB unavailable:",
            error.message
          );
          realtimeDb = null;
        }
      }

      console.log(
        "🔥 firebase_manager.js reused existing Firebase Admin app."
      );
      console.log("🟢 Firestore connected.");
      console.log(
        `🟢 RTDB: ${realtimeDb ? "READY" : "UNAVAILABLE"}`
      );

      return {
        app: firebaseApp,
        firestore: firestoreDb,
        realtime: realtimeDb,
      };
    }

    let credential = null;

    const json = String(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ""
    ).trim();

    if (json) {
      try {
        const serviceAccount = JSON.parse(json);
        credential = cert(serviceAccount);

        console.log(
          "✅ Firebase manager using FIREBASE_SERVICE_ACCOUNT_JSON."
        );
      } catch (error) {
        throw new Error(
          `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`
        );
      }
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      credential = cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: String(
          process.env.FIREBASE_PRIVATE_KEY
        ).replace(/\\n/g, "\n"),
      });

      console.log(
        "✅ Firebase manager using individual environment variables."
      );
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      credential = applicationDefault();

      console.log(
        "✅ Firebase manager using application default credentials."
      );
    } else {
      const fs = require("fs");
      const path = require("path");

      const serviceAccountPath = path.join(
        __dirname,
        "serviceAccountKey.json"
      );

      if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = JSON.parse(
          fs.readFileSync(serviceAccountPath, "utf8")
        );

        credential = cert(serviceAccount);

        console.log(
          "✅ Firebase manager using serviceAccountKey.json."
        );
      }
    }

    if (!credential) {
      throw new Error("Firebase credentials were not found.");
    }

    const options = { credential };

    if (FIREBASE_DATABASE_URL) {
      options.databaseURL = FIREBASE_DATABASE_URL;
    }

    firebaseApp = initializeApp(options);

    firestoreDb = getFirebaseFirestore(firebaseApp);

    if (FIREBASE_DATABASE_URL) {
      try {
        realtimeDb = getFirebaseDatabase(firebaseApp);
      } catch (error) {
        console.warn(
          "⚠️ Firebase RTDB unavailable:",
          error.message
        );
        realtimeDb = null;
      }
    }

    console.log(
      "🔥 Firebase Admin initialized by firebase_manager.js."
    );
    console.log("🟢 Firestore connected.");
    console.log(
      `🟢 RTDB: ${realtimeDb ? "READY" : "UNAVAILABLE"}`
    );

    return {
      app: firebaseApp,
      firestore: firestoreDb,
      realtime: realtimeDb,
    };
  } catch (error) {
    console.error(
      "❌ Firebase initialization failed:",
      error.message
    );
    throw error;
  }
}

// ============================================================
// 4. INITIALIZE
// ============================================================

initializeFirebase();

// ============================================================
// 5. FIRESTORE / RTDB GETTERS
// ============================================================

function getFirestoreDb() {
  if (!firestoreDb) {
    initializeFirebase();
  }

  if (!firestoreDb) {
    throw new Error("Firestore is unavailable.");
  }

  return firestoreDb;
}

function getRealtimeDatabase() {
  if (!realtimeDb && FIREBASE_DATABASE_URL) {
    initializeFirebase();
  }

  return realtimeDb;
}

// ============================================================
// 6. USER ID VALIDATION
// ============================================================

function validateUserId(userId) {
  if (!userId || typeof userId !== "string") {
    return false;
  }

  const clean = userId.trim();

  if (!clean) {
    return false;
  }

  return /^[a-zA-Z0-9_-]{3,128}$/.test(clean);
}

// ============================================================
// 7. SIGNAL CODE HELPERS
// ============================================================

function normalizeSignalCode(code) {
  if (!code || typeof code !== "string") {
    return "";
  }

  const normalized = code.trim().toUpperCase();

  if (!/^[A-Z0-9]{12}$/.test(normalized)) {
    return "";
  }

  return normalized;
}

function generateSignalCode() {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let code = "";

  for (let i = 0; i < 12; i++) {
    code += characters[
      crypto.randomInt(0, characters.length)
    ];
  }

  return code;
}

// ============================================================
// 8. KAMPALA TIME
// ============================================================

function getKampalaTimeParts() {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: SIGNAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(new Date());
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

// ============================================================
// 9. TELEGRAM
// ============================================================

async function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error(
      "❌ Telegram credentials are missing."
    );
    return false;
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: String(message),
        parse_mode: "Markdown",
      }),
    });

    const data = await response.json();

    if (response.ok && data.ok === true) {
      return true;
    }

    console.error(
      "❌ Telegram API error:",
      data.description || "Unknown Telegram error"
    );

    return false;
  } catch (error) {
    console.error(
      "❌ Telegram request failed:",
      error.message
    );

    return false;
  }
}

async function sendBackendOnlineAlert() {
  return sendTelegramAlert(
    "🟢 *SAINT CRYPTO BACKEND IS ONLINE* ✝️⚡"
  );
}

// ============================================================
// 10. TELEGRAM SIGNAL SEND CLAIM
// ============================================================
// Kept for compatibility with older signal-release callers.
// New scheduled signal creation is owned by services/signal.js.

async function sendSignalTelegramOnce(signalCode, message) {
  const db = getFirestoreDb();
  const cleanCode = normalizeSignalCode(signalCode);

  if (!cleanCode) {
    return false;
  }

  const ref = db.collection("signals").doc(cleanCode);
  const CLAIM_TIMEOUT_MS = 120000;

  const claimed = await db.runTransaction(
    async (transaction) => {
      const snapshot = await transaction.get(ref);

      if (!snapshot.exists) {
        return false;
      }

      const data = snapshot.data() || {};

      if (data.telegramSent === true) {
        return false;
      }

      if (data.telegramClaimed === true) {
        const claimedAt = data.telegramClaimedAt;

        const claimedMillis =
          claimedAt?.toMillis
            ? claimedAt.toMillis()
            : (
                claimedAt instanceof Date
                  ? claimedAt.getTime()
                  : 0
              );

        if (
          claimedMillis &&
          Date.now() - claimedMillis < CLAIM_TIMEOUT_MS
        ) {
          return false;
        }
      }

      transaction.update(ref, {
        telegramClaimed: true,
        telegramClaimedAt:
          FieldValue.serverTimestamp(),
        telegramSendFailed: false,
      });

      return true;
    }
  );

  if (!claimed) {
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const sent = await sendTelegramAlert(message);

    if (sent) {
      await ref.set(
        {
          telegramClaimed: true,
          telegramSent: true,
          telegramSentAt:
            FieldValue.serverTimestamp(),
          telegramSendFailed: false,
          telegramSendAttempts: attempt,
        },
        { merge: true }
      );

      return true;
    }

    if (attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1500)
      );
    }
  }

  await ref.set(
    {
      telegramClaimed: false,
      telegramSendFailed: true,
      telegramSendFailedAt:
        FieldValue.serverTimestamp(),
      telegramSendError:
        "Telegram delivery failed after 3 attempts",
    },
    { merge: true }
  );

  return false;
}

// ============================================================
// 11. LEGACY USER BALANCE COMPATIBILITY
// ============================================================
// The new financial system uses:
//   locked_trading_capital_ugx
//   payout_balance_ugx
//
// These helpers remain only so older modules do not crash while
// the Flutter frontend is being migrated.

async function getUserBalance(userId) {
  if (!validateUserId(userId)) {
    throw new Error("Invalid user ID.");
  }

  const db = getFirestoreDb();

  const snapshot = await db
    .collection("users")
    .doc(userId)
    .get();

  if (!snapshot.exists) {
    throw new Error("User record not found.");
  }

  const data = snapshot.data() || {};

  // Prefer the new withdrawable payout balance.
  if (
    Number.isFinite(
      Number(data.payout_balance_ugx)
    )
  ) {
    return Number(data.payout_balance_ugx);
  }

  // Compatibility only for older records.
  return Number(data.usdt_balance || 0);
}

async function syncUserBalanceToRTDB(userId, balance) {
  if (!validateUserId(userId)) {
    return false;
  }

  const rtdb = getRealtimeDatabase();

  if (!rtdb) {
    return false;
  }

  const numericBalance = Number(balance);

  if (!Number.isFinite(numericBalance)) {
    return false;
  }

  try {
    await rtdb
      .ref(`users/${userId}`)
      .update({
        payout_balance_ugx: Math.round(
          numericBalance
        ),
        // Keep old key temporarily for frontend compatibility.
        usdt_balance: Number(
          numericBalance.toFixed(4)
        ),
        last_updated: Date.now(),
      });

    return true;
  } catch (error) {
    console.error(
      `⚠️ RTDB balance sync failed for ${userId}:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// 12. ACCOUNT FREEZE CHECK
// ============================================================

async function isAccountFrozen(userId) {
  if (!validateUserId(userId)) {
    return true;
  }

  try {
    const rtdb = getRealtimeDatabase();

    if (rtdb) {
      const globalFreezeSnapshot = await rtdb
        .ref("system_control/trading_frozen")
        .once("value");

      if (globalFreezeSnapshot.val() === true) {
        console.warn(
          "🧊 Global trading freeze is active."
        );
        return true;
      }
    }

    const db = getFirestoreDb();

    const userSnapshot = await db
      .collection("users")
      .doc(userId)
      .get();

    if (!userSnapshot.exists) {
      return false;
    }

    const userData =
      userSnapshot.data() || {};

    const status = String(
      userData.status || ""
    )
      .trim()
      .toUpperCase();

    if (
      userData.is_frozen === true ||
      [
        "FROZEN",
        "PAUSED",
        "SUSPENDED",
      ].includes(status)
    ) {
      console.warn(
        `🧊 Account ${userId} is frozen.`
      );
      return true;
    }

    return false;
  } catch (error) {
    console.error(
      `⚠️ Freeze verification failed for ${userId}:`,
      error.message
    );

    // Fail closed for account safety.
    return true;
  }
}

// ============================================================
// 13. WITHDRAWAL FREEZE
// ============================================================

async function areWithdrawalsFrozen() {
  const rtdb = getRealtimeDatabase();

  if (!rtdb) {
    return false;
  }

  try {
    const snapshot = await rtdb
      .ref("system_control/withdrawals_frozen")
      .once("value");

    return snapshot.val() === true;
  } catch (error) {
    console.error(
      "⚠️ Withdrawal freeze check failed:",
      error.message
    );

    return true;
  }
}

// ============================================================
// 14. MANAGER STATUS
// ============================================================

function getManagerStatus() {
  return {
    firebase: !!firebaseApp,
    firestore: !!firestoreDb,
    realtimeDatabase: !!realtimeDb,
    telegram: !!(
      TELEGRAM_BOT_TOKEN &&
      TELEGRAM_CHAT_ID
    ),

    timezone: SIGNAL_TIMEZONE,

    // New architecture information.
    signalRewardUgx: SIGNAL_REWARD_UGX,
    signalProcessingMinutes:
      SIGNAL_PROCESSING_MINUTES,
    signalExpiryMinutes:
      SIGNAL_EXPIRY_MINUTES,

    symbol: SIGNAL_DEFAULT_SYMBOL,

    signalSchedule: {
      timezone: "Africa/Kampala",
      days: "Monday-Friday",
      time: "21:00",
    },

    financialArchitecture: {
      recharge: "Mobile Money / manual admin approval",
      tradingCapital:
        "locked_trading_capital_ugx",
      payoutBalance:
        "payout_balance_ugx",
      withdrawal:
        "Mobile Money / manual admin disbursement",
      withdrawalFeePercent: 5,
      cryptoWithdrawal: false,
    },

    scheduler: {
      owner: "services/scheduler.js",
      legacySchedulerRemoved: true,
    },

    signalEngine: {
      owner: "services/signal.js",
      redemptionOwner: "services/signal.js",
      payoutProcessorOwner:
        "services/signal.js",
    },
  };
}

// ============================================================
// 15. SHUTDOWN
// ============================================================
// Do NOT stop services/scheduler.js or services/signal.js here.
// index.js owns their lifecycle.

async function shutdown() {
  console.log(
    "🧹 firebase_manager.js shutdown complete."
  );
}

// ============================================================
// 16. EXPORTS
// ============================================================

module.exports = {
  initializeFirebase,

  getFirestore: getFirestoreDb,

  getRealtimeDatabase,

  validateUserId,

  normalizeSignalCode,

  generateSignalCode,

  // Compatibility Telegram helpers.
  sendTelegramAlert,
  sendSignalTelegramOnce,
  sendBackendOnlineAlert,

  // Compatibility balance helpers.
  getUserBalance,
  syncUserBalanceToRTDB,

  isAccountFrozen,
  areWithdrawalsFrozen,

  getKampalaTimeParts,

  getManagerStatus,

  shutdown,
};

console.log(
  "✅ firebase_manager.js loaded successfully."
);
