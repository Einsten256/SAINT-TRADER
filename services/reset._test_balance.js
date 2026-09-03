/*
 * SAINT CRYPTO - TEST ONLY
 *
 * Resets the simulated test user's ENTIRE account to exactly $100.
 *
 * FINAL STATE:
 * - usdt_balance       = $100
 * - balances.trade     = $100
 * - balances.exchange  = $0
 * - balances.withdraw  = $0
 * - balances.perpetual = $0
 * - locked_principal   = $0
 * - withdrawable       = $100
 *
 * IMPORTANT:
 * - This is NOT a real deposit.
 * - This is ONLY for local testing.
 *
 * Usage from D:\BACKEND:
 *   node services/reset_test_balance.js
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  initializeApp,
  getApps,
  cert,
} = require("firebase-admin/app");

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const {
  getDatabase,
} = require("firebase-admin/database");

// ============================================================
// CONFIG
// ============================================================

const USER_ID = "swiRqeHIMFNTUs3CO6RdnSpDC8G2";

const TARGET_BALANCE = 100.00;

const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://kendrick-alph-mobile-default-rtdb.firebaseio.com/";

const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(__dirname, "..", "serviceAccountKey.json");

// ============================================================
// FIREBASE CREDENTIALS
// ============================================================

function loadCredential() {
  // 1. Full Firebase service-account JSON
  const json = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ""
  ).trim();

  if (json) {
    try {
      const serviceAccount = JSON.parse(json);

      if (
        !serviceAccount.project_id &&
        !serviceAccount.projectId
      ) {
        throw new Error(
          "Firebase service account JSON is missing project_id."
        );
      }

      return cert(serviceAccount);
    } catch (error) {
      throw new Error(
        "Invalid FIREBASE_SERVICE_ACCOUNT_JSON: " + error.message
      );
    }
  }

  // 2. Individual Firebase environment variables
  const projectId = String(
    process.env.FIREBASE_PROJECT_ID || ""
  ).trim();

  const clientEmail = String(
    process.env.FIREBASE_CLIENT_EMAIL || ""
  ).trim();

  let privateKey = String(
    process.env.FIREBASE_PRIVATE_KEY || ""
  );

  if (projectId && clientEmail && privateKey) {
    privateKey = privateKey
      .replace(/\\n/g, "\n")
      .trim();

    return cert({
      projectId,
      clientEmail,
      privateKey,
    });
  }

  // 3. GOOGLE_APPLICATION_CREDENTIALS
  const googleCredentials = String(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || ""
  ).trim();

  if (googleCredentials) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS is set, but this test script expects the same service-account configuration used by the Saint Crypto backend. Check FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY."
    );
  }

  // 4. Local service-account file
  if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    try {
      const serviceAccount = JSON.parse(
        fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8")
      );

      return cert(serviceAccount);
    } catch (error) {
      throw new Error(
        "Could not load Firebase service account file: " + error.message
      );
    }
  }

  throw new Error(
    "Firebase credentials were not found. The backend uses FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY, or serviceAccountKey.json."
  );
}

// ============================================================
// MONEY
// ============================================================

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!getApps().length) {
    initializeApp({
      credential: loadCredential(),
      databaseURL: FIREBASE_DATABASE_URL,
    });
  }

  const db = getFirestore();

  const userRef = db
    .collection("users")
    .doc(USER_ID);

  let result;

  // ==========================================================
  // RESET FIRESTORE ACCOUNT
  // ==========================================================

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(userRef);

    if (!snap.exists) {
      throw new Error(
        `User ${USER_ID} was not found in Firestore.`
      );
    }

    const user = snap.data() || {};
    const oldBalances = user.balances || {};

    const oldBalance = Number(
      user.usdt_balance || 0
    );

    const oldExchange = Number(
      oldBalances.exchange || 0
    );

    const oldTrade = Number(
      oldBalances.trade || 0
    );

    const oldWithdraw = Number(
      oldBalances.withdraw || 0
    );

    const oldPerpetual = Number(
      oldBalances.perpetual || 0
    );

    const oldLockedPrincipal = Number(
      user.locked_principal || 0
    );

    // ========================================================
    // EXACT $100 TOTAL ACCOUNT
    // ========================================================

    const newBalance = roundMoney(TARGET_BALANCE);

    const newBalances = {
      ...oldBalances,

      exchange: 0,
      trade: newBalance,
      withdraw: 0,
      perpetual: 0,
    };

    // Nothing is locked.
    const newLockedPrincipal = 0;

    // Entire $100 is available.
    const withdrawable = newBalance;

    // ========================================================
    // UPDATE USER
    // ========================================================

    transaction.set(
      userRef,
      {
        usdt_balance: newBalance,

        balances: newBalances,

        locked_principal: newLockedPrincipal,

        updatedAt: FieldValue.serverTimestamp(),
        last_updated: FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );

    // ========================================================
    // LEDGER RECORD
    // ========================================================

    const ledgerRef = db
      .collection("ledger_transactions")
      .doc();

    transaction.set(ledgerRef, {
      ledgerTransactionId: ledgerRef.id,

      userId: USER_ID,

      type: "TEST_BALANCE_RESET",

      direction: "RESET",

      amount: newBalance,

      currency: "USDT",

      source: "TEST_ONLY",

      note:
        "Reset entire simulated test account to exactly $100. All $100 placed in Trade. No locked principal.",

      previousBalance: oldBalance,

      previousBalances: {
        exchange: oldExchange,
        trade: oldTrade,
        withdraw: oldWithdraw,
        perpetual: oldPerpetual,
      },

      previousLockedPrincipal:
        oldLockedPrincipal,

      newBalance,

      newBalances: {
        exchange: 0,
        trade: newBalance,
        withdraw: 0,
        perpetual: 0,
      },

      newLockedPrincipal,

      withdrawable,

      createdAt:
        FieldValue.serverTimestamp(),
    });

    // ========================================================
    // RESULT
    // ========================================================

    result = {
      oldBalance,
      oldExchange,
      oldTrade,
      oldWithdraw,
      oldPerpetual,
      oldLockedPrincipal,

      newBalance,

      newExchange: 0,
      newTrade: newBalance,
      newWithdraw: 0,
      newPerpetual: 0,

      lockedPrincipal: newLockedPrincipal,

      withdrawable,

      ledgerTransactionId: ledgerRef.id,
    };
  });

  // ==========================================================
  // SYNC RTDB
  // ==========================================================

  try {
    const rtdb = getDatabase();

    await rtdb
      .ref(`users/${USER_ID}`)
      .update({
        usdt_balance: result.newBalance,
        last_updated: Date.now(),
      });

    result.rtdbSynced = true;
  } catch (error) {
    result.rtdbSynced = false;
    result.rtdbError = error.message;
  }

  // ==========================================================
  // OUTPUT
  // ==========================================================

  console.log("");

  console.log("==============================================");
  console.log("       SAINT CRYPTO TEST ACCOUNT RESET");
  console.log("==============================================");

  console.log(`User:              ${USER_ID}`);

  console.log("");

  console.log("Previous state:");

  console.log(
    `Total balance:     $${result.oldBalance.toFixed(2)}`
  );

  console.log(
    `Exchange:          $${result.oldExchange.toFixed(2)}`
  );

  console.log(
    `Trade:             $${result.oldTrade.toFixed(2)}`
  );

  console.log(
    `Withdraw:          $${result.oldWithdraw.toFixed(2)}`
  );

  console.log(
    `Perpetual:         $${result.oldPerpetual.toFixed(2)}`
  );

  console.log(
    `Locked principal:  $${result.oldLockedPrincipal.toFixed(2)}`
  );

  console.log("");

  console.log("NEW STATE:");

  console.log(
    `Total balance:     $${result.newBalance.toFixed(2)}`
  );

  console.log(
    `Exchange:          $${result.newExchange.toFixed(2)}`
  );

  console.log(
    `Trade:             $${result.newTrade.toFixed(2)}`
  );

  console.log(
    `Withdraw:          $${result.newWithdraw.toFixed(2)}`
  );

  console.log(
    `Perpetual:         $${result.newPerpetual.toFixed(2)}`
  );

  console.log(
    `Locked principal:  $${result.lockedPrincipal.toFixed(2)}`
  );

  console.log(
    `Withdrawable:      $${result.withdrawable.toFixed(2)}`
  );

  console.log(
    `RTDB synced:       ${result.rtdbSynced}`
  );

  console.log("");

  console.log("==============================================");
  console.log("TOTAL ACCOUNT VALUE: $100.00");
  console.log("==============================================");

  console.log("");

  console.log("Fresh test state is ready.");
  console.log("Next test: TRADE → WITHDRAW");

  console.log("==============================================");
  console.log("");
}

// ============================================================
// RUN
// ============================================================

main().catch((error) => {
  console.error("");

  console.error(
    "❌ TEST ACCOUNT RESET FAILED:"
  );

  console.error(error.message);

  process.exitCode = 1;
});
