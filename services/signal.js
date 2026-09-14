// ============================================================
// SAINT CRYPTO TRADE ENGINE
// services/signal.js
//
// SIGNAL SERVICE
//
// RESPONSIBILITIES:
// - Read signals created by firebase_manager.js
// - Get active signals
// - Check signal expiry
// - Validate authenticated user
// - Validate user's qualifying capital
// - Redeem signal codes
// - Queue Copy Trading settlement and atomically credit user at settlement
// - Update the user's trade balance
// - Create signal redemption records
//
// IMPORTANT:
// - THIS FILE DOES NOT GENERATE SIGNAL CODES.
// - THIS FILE DOES NOT SEND SIGNAL CODES.
// - THIS FILE DOES NOT SEND TELEGRAM MESSAGES.
// - THIS FILE DOES NOT RUN THE signal scheduler.
//
// SIGNAL CREATION IS OWNED BY:
//
//     firebase_manager.js
//
// firebase_manager.js creates:
//
//     signals/{CODE}
//
// with fields such as:
//
//     code
//     profit
//     symbol
//     session
//     status
//     active
//     created_at
//     expires_at
//
// index.js supplies the authenticated Firebase UID.
//
// Flutter NEVER supplies a trusted UID.
// ============================================================

"use strict";

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const {
  getDatabase,
} = require("firebase-admin/database");

// ============================================================
// FIRESTORE
// ============================================================

let firestore = null;

try {
  firestore = getFirestore();
} catch (error) {
  console.warn(
    "⚠️ Firestore is not initialized yet."
  );
}

// ============================================================
// RTDB
// ============================================================

let realtimeDatabase = null;

try {
  realtimeDatabase = getDatabase();
} catch (error) {
  console.warn(
    "⚠️ Firebase Realtime Database is not initialized yet."
  );
}

// ============================================================
// CONFIGURATION
// ============================================================

const PAYOUT_TIER_100 = parseFloat(
  process.env.PAYOUT_TIER_100 || "2"
);

const PAYOUT_TIER_200 = parseFloat(
  process.env.PAYOUT_TIER_200 || "3"
);

const PAYOUT_TIER_500 = parseFloat(
  process.env.PAYOUT_TIER_500 || "4"
);

const PAYOUT_MINIMUM_CAPITAL = parseFloat(
  process.env.PAYOUT_MINIMUM_CAPITAL || "100"
);

// Copy Trading settlement is server-controlled.
// The client never waits and credits its own balance.
const COPY_TRADING_SETTLEMENT_MINUTES = 7;
const COPY_TRADING_SETTLEMENT_MS =
  COPY_TRADING_SETTLEMENT_MINUTES * 60 * 1000;
const COPY_TRADING_SETTLEMENT_INTERVAL_MS = 30 * 1000;

const SIGNAL_DEFAULT_SYMBOL =
  String(
    process.env.SIGNAL_DEFAULT_SYMBOL ||
      "XAUUSD"
  )
    .trim()
    .toUpperCase();

// ============================================================
// HELPERS
// ============================================================

function roundMoney(
  value,
  decimals = 4
) {
  const number =
    parseFloat(value) || 0;

  const factor =
    Math.pow(10, decimals);

  return (
    Math.round(
      number * factor
    ) / factor
  );
}

// ============================================================
// GET FIRESTORE
// ============================================================

function getFirestoreInstance() {
  if (!firestore) {
    try {
      firestore = getFirestore();
    } catch (error) {
      throw new Error(
        "Database service unavailable."
      );
    }
  }

  return firestore;
}

// ============================================================
// GET RTDB
// ============================================================

function getRealtimeDatabaseInstance() {
  if (!realtimeDatabase) {
    try {
      realtimeDatabase =
        getDatabase();
    } catch (error) {
      return null;
    }
  }

  return realtimeDatabase;
}

// ============================================================
// VALIDATE USER ID
// ============================================================
//
// UID comes from Firebase Authentication middleware.
//
// This service does not accept a UID supplied by Flutter
// independently.
// ============================================================

function validateUserId(
  userId
) {
  if (
    !userId ||
    typeof userId !==
      "string"
  ) {
    throw new Error(
      "Authenticated user required."
    );
  }

  const cleanUserId =
    userId.trim();

  if (!cleanUserId) {
    throw new Error(
      "Authenticated user required."
    );
  }

  return cleanUserId;
}

// ============================================================
// NORMALIZE SIGNAL CODE
// ============================================================
//
// Current Saint Crypto signal-code format:
//
//     XXXXXXXXXXXX
//
// Exactly 12 uppercase letters/numbers.
// No apostrophe.
// No spaces.
// No dash.
// No underscore.
//
// Signal codes are generated server-side by
// firebase_manager.js.
//
// ============================================================

function normalizeSignalCode(
  code
) {
  if (
    !code ||
    typeof code !==
      "string"
  ) {
    return "";
  }

  const normalized =
    code.trim().toUpperCase();

  if (
    !/^[A-Z0-9]{12}$/.test(
      normalized
    )
  ) {
    return "";
  }

  return normalized;
}

// ============================================================
// GET PAYOUT FOR CAPITAL
// ============================================================
//
// This is retained for compatibility with the previous
// payout-tier configuration.
//
// IMPORTANT:
//
// firebase_manager.js is now responsible for creating the
// signal and normally stores the actual reward in:
//
//     signal.profit
//
// Therefore redemption uses signal.profit first.
//
// The tier calculation is only a fallback when an older
// signal record does not contain a profit value.
// ============================================================

function getPayoutForCapital(
  capital
) {
  const amount =
    parseFloat(capital) || 0;

  if (
    amount >= 500
  ) {
    return PAYOUT_TIER_500;
  }

  if (
    amount >= 200
  ) {
    return PAYOUT_TIER_200;
  }

  if (
    amount >= 100
  ) {
    return PAYOUT_TIER_100;
  }

  return 0;
}

// ============================================================
// GET USER QUALIFYING CAPITAL
// ============================================================
//
// qualifying_capital is the authoritative tier field.
// locked_principal is the compatibility fallback for existing
// accounts that do not have qualifying_capital yet.
//
// IMPORTANT:
// Current balance and earned profit are NOT used to upgrade a
// user's payout tier. A $100 account remains on the $2 tier even
// after its balance grows above $200 from signal profits.
// ============================================================

function getUserQualifyingCapital(
  userData
) {
  const explicitCapital =
    parseFloat(
      userData?.qualifying_capital
    );

  if (
    Number.isFinite(
      explicitCapital
    ) &&
    explicitCapital >= 0
  ) {
    return explicitCapital;
  }

  const lockedPrincipal =
    parseFloat(
      userData?.locked_principal ||
        0
    );

  return Number.isFinite(
    lockedPrincipal
  )
    ? Math.max(0, lockedPrincipal)
    : 0;
}

// ============================================================
// CHECK ACCOUNT FREEZE
// ============================================================
//
// Checks:
//
// 1. Global trading freeze in RTDB
// 2. Individual Firestore account freeze
//
// Fail secure if the freeze check itself fails.
// ============================================================

async function isAccountFrozen(
  userId
) {
  const cleanUserId =
    validateUserId(
      userId
    );

  try {
    // --------------------------------------------------------
    // GLOBAL TRADING FREEZE
    // --------------------------------------------------------

    const rtdb =
      getRealtimeDatabaseInstance();

    if (rtdb) {
      try {
        const globalFreezeSnapshot =
          await rtdb
            .ref(
              "system_control/trading_frozen"
            )
            .once(
              "value"
            );

        if (
          globalFreezeSnapshot.val() ===
          true
        ) {
          console.warn(
            "🧊 Global trading freeze is active."
          );

          return true;
        }
      } catch (error) {
        console.error(
          "⚠️ Global trading freeze check failed:",
          error.message
        );

        // Fail secure.
        return true;
      }
    }

    // --------------------------------------------------------
    // USER ACCOUNT FREEZE
    // --------------------------------------------------------

    const db =
      getFirestoreInstance();

    const userSnapshot =
      await db
        .collection("users")
        .doc(cleanUserId)
        .get();

    if (
      !userSnapshot.exists
    ) {
      // User absence is handled separately by redemption.
      return false;
    }

    const userData =
      userSnapshot.data() ||
      {};

    const accountStatus =
      String(
        userData.status || ""
      )
        .trim()
        .toUpperCase();

    if (
      userData.is_frozen ===
        true ||
      [
        "FROZEN",
        "PAUSED",
        "SUSPENDED",
      ].includes(
        accountStatus
      )
    ) {
      console.warn(
        `🧊 Account ${cleanUserId} is frozen.`
      );

      return true;
    }

    return false;
  } catch (error) {
    console.error(
      `⚠️ Account freeze verification failed for ${cleanUserId}:`,
      error.message
    );

    // Financial operation:
    // fail secure.
    return true;
  }
}

// ============================================================
// CONVERT FIRESTORE DATE
// ============================================================

function convertFirestoreDate(
  value
) {
  if (!value) {
    return null;
  }

  try {
    if (
      typeof value.toDate ===
      "function"
    ) {
      return value.toDate();
    }

    if (
      value instanceof Date
    ) {
      return value;
    }

    const converted =
      new Date(value);

    if (
      Number.isNaN(
        converted.getTime()
      )
    ) {
      return null;
    }

    return converted;
  } catch (error) {
    return null;
  }
}

// ============================================================
// CHECK SIGNAL EXPIRY
// ============================================================
//
// firebase_manager.js stores:
//
//     expires_at
//
// This service also supports:
//
//     expiresAt
//
// for compatibility with older records.
// ============================================================

function getSignalExpiry(
  signal
) {
  if (!signal) {
    return null;
  }

  return convertFirestoreDate(
    signal.expires_at ||
      signal.expiresAt
  );
}

// ============================================================
// MARK SIGNAL EXPIRED
// ============================================================
//
// Firestore is the authoritative signal database.
//
// RTDB is only the Flutter/live-data copy.
//
// If RTDB update fails, Firestore remains authoritative.
// ============================================================

async function markSignalExpired(
  signalRef,
  signalCode
) {
  const db =
    getFirestoreInstance();

  try {
    await signalRef.set(
      {
        active: false,

        status:
          "EXPIRED",

        expired_at:
          FieldValue.serverTimestamp(),

        updated_at:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );
  } catch (error) {
    console.error(
      `⚠️ Failed marking signal ${signalCode} expired:`,
      error.message
    );
  }

  // ----------------------------------------------------------
  // RTDB COPY
  // ----------------------------------------------------------

  const rtdb =
    getRealtimeDatabaseInstance();

  if (!rtdb) {
    return;
  }

  try {
    await rtdb
      .ref(
        `signals/${signalCode}`
      )
      .update({
        active: false,

        status:
          "EXPIRED",

        expired_at:
          new Date().toISOString(),

        updated_at:
          Date.now(),
      });
  } catch (error) {
    console.error(
      `⚠️ Failed updating expired signal ${signalCode} in RTDB:`,
      error.message
    );
  }
}

// ============================================================
// GET ONE SIGNAL
// ============================================================
//
// Internal helper.
// ============================================================

async function getSignal(
  signalCode
) {
  const db =
    getFirestoreInstance();

  const cleanCode =
    normalizeSignalCode(
      signalCode
    );

  if (!cleanCode) {
    return null;
  }

  const signalRef =
    db
      .collection("signals")
      .doc(cleanCode);

  const snapshot =
    await signalRef.get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    ref:
      signalRef,

    data:
      snapshot.data() || {},
  };
}

// ============================================================
// GET ACTIVE SIGNALS
// ============================================================
//
// Used by index.js.
//
// Supported aliases:
//
// getSignals()
// getActiveSignals()
// getUserSignals()
//
// These all return the currently available signals.
//
// No sensitive redemption information is exposed.
// ============================================================

async function getSignals(
  userId = null,
  options = {}
) {
  const db =
    getFirestoreInstance();

  const requestedLimit =
    parseInt(
      options?.limit ||
        options?.pageSize ||
        "20",
      10
    );

  const safeLimit =
    Math.min(
      Math.max(
        Number.isFinite(
          requestedLimit
        )
          ? requestedLimit
          : 20,
        1
      ),
      50
    );

  // Signals are shared, but the payout amount is user-specific.
  // Resolve the authenticated user's qualifying capital once for
  // this response so the Flutter signal screen does not display a
  // misleading global/default profit amount.
  let userTierReward = null;
  if (userId) {
    const cleanUserId =
      validateUserId(userId);
    const userSnapshot =
      await db
        .collection("users")
        .doc(cleanUserId)
        .get();

    if (userSnapshot.exists) {
      const userData =
        userSnapshot.data() || {};
      const qualifyingCapital =
        getUserQualifyingCapital(
          userData
        );
      const tierReward =
        getPayoutForCapital(
          qualifyingCapital
        );

      if (tierReward > 0) {
        userTierReward =
          roundMoney(
            tierReward,
            4
          );
      }
    }
  }

  const snapshot =
    await db
      .collection("signals")
      .where(
        "active",
        "==",
        true
      )
      .orderBy(
        "created_at",
        "desc"
      )
      .limit(
        safeLimit
      )
      .get();

  const signals = [];

  const now =
    Date.now();

  for (
    const doc of snapshot.docs
  ) {
    const data =
      doc.data() || {};

    const expiresAt =
      getSignalExpiry(
        data
      );

    // --------------------------------------------------------
    // Automatically hide expired signals.
    // --------------------------------------------------------

    if (
      expiresAt &&
      now >=
        expiresAt.getTime()
    ) {
      await markSignalExpired(
        doc.ref,
        doc.id
      );

      continue;
    }

    signals.push({
      code:
        data.code ||
        doc.id,

      // Never expose the signal's global/default profit when an
      // authenticated user has a qualifying capital tier.
      profit:
        userTierReward ??
        roundMoney(
          data.profit ??
            data.profitGenerated ??
            0,
          4
        ),

      symbol:
        data.symbol ||
        SIGNAL_DEFAULT_SYMBOL,

      session:
        data.session ||
        null,

      status:
        data.status ||
        "UNKNOWN",

      active:
        data.active === true,

      created_at:
        data.created_at ||
        data.createdAt ||
        null,

      expires_at:
        data.expires_at ||
        data.expiresAt ||
        null,
    });
  }

  return {
    success: true,

    signals,
  };
}

// ============================================================
// ALIASES FOR index.js COMPATIBILITY
// ============================================================

async function getActiveSignals(
  userId,
  options
) {
  return getSignals(
    userId,
    options
  );
}

async function getUserSignals(
  userId,
  options
) {
  return getSignals(
    userId,
    options
  );
}

// ============================================================
// GET SIGNAL STATUS
// ============================================================
//
// Useful for Flutter or debugging.
//
// Does NOT expose:
// - redeemedBy
// - internal user information
// - redemption records
// ============================================================

async function getSignalStatus(
  signalCode,
  userId = null
) {
  const cleanCode =
    normalizeSignalCode(
      signalCode
    );

  if (!cleanCode) {
    return {
      success: false,

      status:
        "INVALID_CODE",

      message:
        "Signal code is required.",
    };
  }

  const result =
    await getSignal(
      cleanCode
    );

  if (!result) {
    return {
      success: false,

      status:
        "NOT_FOUND",

      message:
        "Signal code not found.",
    };
  }

  const {
    ref,
    data,
  } = result;

  let statusProfit =
    roundMoney(
      data.profit ??
        data.profitGenerated ??
        0,
      4
    );

  if (userId) {
    const db =
      getFirestoreInstance();
    const cleanUserId =
      validateUserId(userId);
    const userSnapshot =
      await db
        .collection("users")
        .doc(cleanUserId)
        .get();

    if (userSnapshot.exists) {
      const userData =
        userSnapshot.data() || {};
      const qualifyingCapital =
        getUserQualifyingCapital(
          userData
        );
      const tierReward =
        getPayoutForCapital(
          qualifyingCapital
        );

      if (tierReward > 0) {
        statusProfit =
          roundMoney(
            tierReward,
            4
          );
      }
    }
  }

  const expiresAt =
    getSignalExpiry(
      data
    );

  // ----------------------------------------------------------
  // EXPIRED
  // ----------------------------------------------------------

  if (
    expiresAt &&
    Date.now() >=
      expiresAt.getTime()
  ) {
    await markSignalExpired(
      ref,
      cleanCode
    );

    return {
      success: false,

      status:
        "EXPIRED",

      message:
        "This signal code has expired.",
    };
  }

  return {
    success: true,

    code:
      data.code ||
      cleanCode,

    profit:
      statusProfit,

    symbol:
      data.symbol ||
      SIGNAL_DEFAULT_SYMBOL,

    session:
      data.session ||
      null,

    status:
      data.status ||
      "UNKNOWN",

    active:
      data.active === true,

    expires_at:
      data.expires_at ||
      data.expiresAt ||
      null,

    created_at:
      data.created_at ||
      data.createdAt ||
      null,
  };
}

// ============================================================
// GET USER REDEMPTION
// ============================================================
//
// Used internally to make the service idempotent.
//
// Document:
//
// signal_redemptions/{uid}_{code}
// ============================================================

async function getExistingRedemption(
  userId,
  code
) {
  const db =
    getFirestoreInstance();

  const redemptionId =
    `${userId}_${code}`;

  const redemptionRef =
    db
      .collection(
        "signal_redemptions"
      )
      .doc(
        redemptionId
      );

  const snapshot =
    await redemptionRef.get();

  if (!snapshot.exists) {
    return null;
  }

  return {
    ref:
      redemptionRef,

    data:
      snapshot.data() ||
      {},
  };
}

// ============================================================
// REDEEM SIGNAL
//
// POST /api/signals/redeem
//
// index.js calls:
//
// redeemSignal(req.uid, req.body)
//
// Flutter sends:
//
// {
//   "code": "8FQ2M7KX91ZT"
// }
//
// UID comes ONLY from:
//
//     req.uid
//
// ============================================================

async function redeemSignal(
  userId,
  body
) {
  const cleanUserId =
    validateUserId(
      userId
    );

  // ----------------------------------------------------------
  // INPUT
  // ----------------------------------------------------------

  let submittedCode = "";

  if (
    typeof body ===
    "string"
  ) {
    submittedCode =
      body;
  } else if (
    body &&
    typeof body ===
      "object"
  ) {
    submittedCode =
      body.code ||
      body.signalCode ||
      body.signal_code ||
      "";
  }

  const cleanCode =
    normalizeSignalCode(
      submittedCode
    );

  if (!cleanCode) {
    return {
      success: false,

      status:
        "INVALID_CODE",

      message:
        "Please enter a valid signal code.",
    };
  }

  // ----------------------------------------------------------
  // ACCOUNT FREEZE
  // ----------------------------------------------------------

  if (
    await isAccountFrozen(
      cleanUserId
    )
  ) {
    return {
      success: false,

      status:
        "ACCOUNT_RESTRICTED",

      message:
        "Account validation failed or account is frozen.",
    };
  }

  const db =
    getFirestoreInstance();

  const signalRef =
    db
      .collection("signals")
      .doc(cleanCode);

  const userRef =
    db
      .collection("users")
      .doc(cleanUserId);

  const redemptionRef =
    db
      .collection(
        "signal_redemptions"
      )
      .doc(
        `${cleanUserId}_${cleanCode}`
      );

  // ----------------------------------------------------------
  // VARIABLES RETURNED AFTER TRANSACTION
  // ----------------------------------------------------------

  let rewardAmount = 0;

  let oldBalance = 0;

  let newBalance = 0;

  let oldTradeBalance = 0;

  let newTradeBalance = 0;

  let signalSymbol =
    SIGNAL_DEFAULT_SYMBOL;

  let signalSession = null;

  let signalProfit = 0;

  let orderId = "";
  let payoutAt = null;

  try {
    // ========================================================
    // ATOMIC TRANSACTION
    // ========================================================

    await db.runTransaction(
      async (
        transaction
      ) => {
        // ----------------------------------------------------
        // READ SIGNAL
        // ----------------------------------------------------

        const signalSnapshot =
          await transaction.get(
            signalRef
          );

        // ----------------------------------------------------
        // READ USER
        // ----------------------------------------------------

        const userSnapshot =
          await transaction.get(
            userRef
          );

        // ----------------------------------------------------
        // READ REDEMPTION
        // ----------------------------------------------------

        const redemptionSnapshot =
          await transaction.get(
            redemptionRef
          );

        // ----------------------------------------------------
        // USER MUST EXIST
        // ----------------------------------------------------

        if (
          !userSnapshot.exists
        ) {
          throw new Error(
            "USER_NOT_FOUND"
          );
        }

        // ----------------------------------------------------
        // SIGNAL MUST EXIST
        // ----------------------------------------------------

        if (
          !signalSnapshot.exists
        ) {
          throw new Error(
            "SIGNAL_NOT_FOUND"
          );
        }

        // ----------------------------------------------------
        // GLOBAL/USER FREEZE
        // ----------------------------------------------------

        const userData =
          userSnapshot.data() ||
          {};

        if (
          userData.is_frozen ===
            true ||
          [
            "FROZEN",
            "PAUSED",
            "SUSPENDED",
          ].includes(
            String(
              userData.status ||
                ""
            )
              .trim()
              .toUpperCase()
          )
        ) {
          throw new Error(
            "ACCOUNT_FROZEN"
          );
        }

        // ----------------------------------------------------
        // REDEMPTION ALREADY EXISTS
        // ----------------------------------------------------

        if (
          redemptionSnapshot.exists
        ) {
          throw new Error(
            "SIGNAL_ALREADY_REDEEMED"
          );
        }

        const signalData =
          signalSnapshot.data() ||
          {};

        // ----------------------------------------------------
        // SIGNAL STATUS
        // ----------------------------------------------------

        if (
          signalData.active !==
          true
        ) {
          throw new Error(
            "SIGNAL_INACTIVE"
          );
        }

        if (
          String(
            signalData.status ||
              ""
          ).toUpperCase() !==
          "PROFIT_VERIFIED"
        ) {
          throw new Error(
            "SIGNAL_NOT_VERIFIED"
          );
        }

        // ----------------------------------------------------
        // EXPIRY
        // ----------------------------------------------------

        const expiresAt =
          getSignalExpiry(
            signalData
          );

        if (
          expiresAt &&
          Date.now() >=
            expiresAt.getTime()
        ) {
          throw new Error(
            "SIGNAL_EXPIRED"
          );
        }

        // ----------------------------------------------------
        // USER-SPECIFIC REWARD
        // ----------------------------------------------------
        //
        // The signal may carry a global/default profit value, but
        // it MUST NOT determine this user's payout.
        //
        // Qualification is based on qualifying_capital, with
        // locked_principal as the compatibility fallback.
        // Current balance and earned signal profit never promote
        // a user to a higher tier.
        //
        // $100-$199.99  -> $2
        // $200-$499.99  -> $3
        // $500+         -> $4
        // ----------------------------------------------------

        const qualifyingCapital =
          getUserQualifyingCapital(
            userData
          );

        rewardAmount =
          roundMoney(
            getPayoutForCapital(
              qualifyingCapital
            ),
            4
          );

        if (
          rewardAmount <= 0
        ) {
          throw new Error(
            "CAPITAL_NOT_QUALIFIED"
          );
        }

        // ----------------------------------------------------
        // CURRENT BALANCE
        // ----------------------------------------------------

        oldBalance =
          parseFloat(
            userData.usdt_balance ||
              0
          );

        if (
          !Number.isFinite(
            oldBalance
          ) ||
          oldBalance < 0
        ) {
          throw new Error(
            "INVALID_BALANCE"
          );
        }

        // ----------------------------------------------------
        // LOCKED / QUALIFYING CAPITAL
        // ----------------------------------------------------


        // ----------------------------------------------------
        // MINIMUM CAPITAL / BALANCE
        // ----------------------------------------------------
        //
        // We preserve your existing rule:
        // user must have at least $100 balance.
        // ----------------------------------------------------

        if (
          oldBalance <
          PAYOUT_MINIMUM_CAPITAL
        ) {
          throw new Error(
            "MINIMUM_BALANCE_REQUIRED"
          );
        }

        // ----------------------------------------------------
        // QUALIFYING CAPITAL CHECK
        // ----------------------------------------------------
        // Use the same authoritative qualifying capital that
        // determined the user's payout tier above.
        //
        // This avoids relying on an undefined/local
        // lockedPrincipal variable and keeps the qualification
        // check consistent with the payout calculation.
        // ----------------------------------------------------

        if (
          qualifyingCapital > 0 &&
          qualifyingCapital <
            PAYOUT_MINIMUM_CAPITAL
        ) {
          throw new Error(
            "CAPITAL_NOT_QUALIFIED"
          );
        }

        // ----------------------------------------------------
        // BALANCES OBJECT
        // ----------------------------------------------------

        const balances = {
          ...(userData.balances ||
            {}),
        };

        // ----------------------------------------------------
        // INITIALIZE MISSING LEDGER ACCOUNTS
        // ----------------------------------------------------

        if (
          balances.exchange ===
          undefined
        ) {
          balances.exchange =
            oldBalance;
        }

        if (
          balances.trade ===
          undefined
        ) {
          balances.trade = 0;
        }

        if (
          balances.perpetual ===
          undefined
        ) {
          balances.perpetual = 0;
        }

        if (
          balances.withdraw ===
          undefined
        ) {
          balances.withdraw = 0;
        }

        // ----------------------------------------------------
        // CURRENT TRADE BALANCE
        // ----------------------------------------------------

        oldTradeBalance =
          parseFloat(
            balances.trade || 0
          );

        if (
          !Number.isFinite(
            oldTradeBalance
          ) ||
          oldTradeBalance < 0
        ) {
          oldTradeBalance = 0;
        }

        // ----------------------------------------------------
        // ----------------------------------------------------
        // CREATE COPY TRADING ORDER
        //
        // IMPORTANT:
        // The user's balance is NOT changed here.
        // The order remains PENDING until the server settlement
        // processor reaches payoutAt (approximately 7 minutes).
        // ----------------------------------------------------

        orderId =
          db.collection("copy_trading_orders")
            .doc().id;

        const globalOrderRef =
          db.collection("copy_trading_orders")
            .doc(orderId);

        const userOrderRef =
          userRef.collection("orders")
            .doc(orderId);

        const payoutAtMs =
          Date.now() +
          COPY_TRADING_SETTLEMENT_MS;

        payoutAt =
          new Date(payoutAtMs);

        transaction.set(
          globalOrderRef,
          {
            orderId,
            userId:
              cleanUserId,
            user_id:
              cleanUserId,
            code:
              cleanCode,
            type:
              "COPY_TRADING",
            pair:
              signalData.symbol ||
              SIGNAL_DEFAULT_SYMBOL,
            symbol:
              signalData.symbol ||
              SIGNAL_DEFAULT_SYMBOL,
            session:
              signalData.session ||
              null,
            amount:
              roundMoney(
                rewardAmount,
                4
              ),
            profit:
              roundMoney(
                rewardAmount,
                4
              ),
            reward:
              roundMoney(
                rewardAmount,
                4
              ),
            rateOfReturn:
              "SETTLEMENT",
            source:
              "signal",
            status:
              "PENDING",
            settlementStatus:
              "PENDING",
            createdAt:
              FieldValue.serverTimestamp(),
            acceptedAt:
              FieldValue.serverTimestamp(),
            payoutAt:
              payoutAt,
          }
        );

        transaction.set(
          userOrderRef,
          {
            orderId,
            userId:
              cleanUserId,
            code:
              cleanCode,
            type:
              "COPY_TRADING",
            pair:
              signalData.symbol ||
              SIGNAL_DEFAULT_SYMBOL,
            symbol:
              signalData.symbol ||
              SIGNAL_DEFAULT_SYMBOL,
            session:
              signalData.session ||
              null,
            amount:
              roundMoney(
                rewardAmount,
                4
              ),
            profit:
              roundMoney(
                rewardAmount,
                4
              ),
            reward:
              roundMoney(
                rewardAmount,
                4
              ),
            rateOfReturn:
              "SETTLEMENT",
            source:
              "signal",
            status:
              "PENDING",
            settlementStatus:
              "PENDING",
            createdAt:
              FieldValue.serverTimestamp(),
            acceptedAt:
              FieldValue.serverTimestamp(),
            payoutAt:
              payoutAt,
          }
        );

        // The unique redemption document reserves the code immediately,
        // preventing duplicate Copy Trading orders for the same user/code.
        transaction.set(
          redemptionRef,
          {
            redemptionId:
              redemptionRef.id,

            userId:
              cleanUserId,

            user_id:
              cleanUserId,

            code:
              cleanCode,

            reward:
              roundMoney(
                rewardAmount,
                4
              ),

            symbol:
              signalData.symbol ||
              SIGNAL_DEFAULT_SYMBOL,

            session:
              signalData.session ||
              null,

            signalProfit:
              roundMoney(
                rewardAmount,
                4
              ),

            qualifyingCapital:
              roundMoney(
                qualifyingCapital,
                4
              ),

            payoutTier:
              roundMoney(
                rewardAmount,
                4
              ),

            balanceBefore:
              oldBalance,

            balanceAfter:
              oldBalance,

            source:
              "signal",

            orderId,

            status:
              "PENDING",

            acceptedAt:
              FieldValue.serverTimestamp(),

            payoutAt:
              payoutAt,

            createdAt:
              FieldValue.serverTimestamp(),
          }
        );

        // One signal code is shared by eligible users.
        // The user/code redemption record prevents this user from
        // submitting the same code more than once.

        signalSymbol =
          signalData.symbol ||
          SIGNAL_DEFAULT_SYMBOL;

        signalSession =
          signalData.session ||
          null;

        signalProfit =
          rewardAmount;

        // Balance is unchanged until settlement.
        newBalance =
          oldBalance;

        newTradeBalance =
          oldTradeBalance;
      }
    );

    // ========================================================
    // RTDB STATUS SYNC
    // ========================================================
    //
    // Firestore remains authoritative.
    // The balance is intentionally unchanged until settlement.
    // Flutter can use this status to show that the order is pending.
    // ========================================================

    const rtdb =
      getRealtimeDatabaseInstance();

    if (rtdb) {
      try {
        await rtdb
          .ref(
            `users/${cleanUserId}`
          )
          .update({
            last_signal_reward:
              rewardAmount,

            last_signal_code:
              cleanCode,

            last_signal_status:
              "PENDING_SETTLEMENT",

            last_signal_payout_at:
              payoutAt
                ? payoutAt.toISOString()
                : null,

            last_updated:
              Date.now(),
          });
      } catch (rtdbError) {
        console.error(
          `⚠️ Copy Trading order accepted but RTDB status sync failed for ${cleanUserId}:`,
          rtdbError.message
        );
      }
    }

    // ========================================================
    // COPY TRADING ACCEPTED
    // ========================================================

    console.log(
      `Copy Trading order accepted for ${cleanUserId}: ${cleanCode} | Settlement in ${COPY_TRADING_SETTLEMENT_MINUTES} minutes | Order ${orderId}`
    );

    return {
      success: true,

      status:
        "PENDING_SETTLEMENT",

      message:
        `Copy Trading order accepted. Settlement will be completed in approximately ${COPY_TRADING_SETTLEMENT_MINUTES} minutes.`,

      code:
        cleanCode,

      orderId,

      reward:
        roundMoney(
          rewardAmount,
          4
        ),

      new_balance:
        roundMoney(
          oldBalance,
          4
        ),

      payoutAt:
        payoutAt
          ? payoutAt.toISOString()
          : null,

      settlementMinutes:
        COPY_TRADING_SETTLEMENT_MINUTES,

      symbol:
        signalSymbol,

      session:
        signalSession,
    };

  } catch (error) {
    // ========================================================
    // EXPECTED ERRORS
    // ========================================================

    switch (
      error.message
    ) {
      case "USER_NOT_FOUND":
        return {
          success: false,

          status:
            "USER_NOT_FOUND",

          message:
            "User account not found.",
        };

      case "SIGNAL_NOT_FOUND":
        return {
          success: false,

          status:
            "NOT_FOUND",

          message:
            "Invalid signal code.",
        };

      case "SIGNAL_ALREADY_REDEEMED":
        return {
          success: false,

          status:
            "ALREADY_REDEEMED",

          message:
            "This Copy Trading Code has already been submitted for settlement.",
        };

      case "SIGNAL_INACTIVE":
        return {
          success: false,

          status:
            "INACTIVE",

          message:
            "This signal is no longer active.",
        };

      case "SIGNAL_NOT_VERIFIED":
        return {
          success: false,

          status:
            "NOT_VERIFIED",

          message:
            "This signal is not verified.",
        };

      case "SIGNAL_EXPIRED":
        // Best-effort expiry update outside transaction.
        await markSignalExpired(
          signalRef,
          cleanCode
        );

        return {
          success: false,

          status:
            "EXPIRED",

          message:
            "This signal code has expired.",
        };

      case "ACCOUNT_FROZEN":
        return {
          success: false,

          status:
            "ACCOUNT_RESTRICTED",

          message:
            "Account is frozen. Signal redemption is restricted.",
        };

      case "INVALID_BALANCE":
        return {
          success: false,

          status:
            "INVALID_BALANCE",

          message:
            "Your account balance is invalid. Please contact support.",
        };

      case "MINIMUM_BALANCE_REQUIRED":
        return {
          success: false,

          status:
            "MINIMUM_BALANCE",

          message:
            `Minimum $${PAYOUT_MINIMUM_CAPITAL.toFixed(
              2
            )} USDT balance is required to redeem a signal.`,
        };

      case "CAPITAL_NOT_QUALIFIED":
        return {
          success: false,

          status:
            "CAPITAL_NOT_QUALIFIED",

          message:
            `Minimum qualifying capital is $${PAYOUT_MINIMUM_CAPITAL.toFixed(
              2
            )} USDT.`,
        };

      default:
        console.error(
          `❌ Signal redemption error for ${cleanUserId}:`,
          error
        );

        return {
          success: false,

          status:
            "REDEMPTION_FAILED",

          message:
            "Redemption failed. Please try again.",
        };
    }
  }
}


// ============================================================
// COPY TRADING SETTLEMENT PROCESSOR
//
// Pending Copy Trading orders are settled by the server.
// The Flutter client cannot accelerate, cancel, or self-credit
// the payout by changing a local timer.
// ============================================================

async function settlePendingCopyTradingOrders() {
  const db = getFirestoreInstance();

  const snapshot = await db
    .collection("copy_trading_orders")
    .where("status", "==", "PENDING")
    .limit(100)
    .get();

  if (snapshot.empty) {
    return;
  }

  const now = Date.now();

  for (const orderDoc of snapshot.docs) {
    try {
      const orderData = orderDoc.data() || {};
      const payoutAtValue = orderData.payoutAt;

      let payoutAtMs = 0;

      if (
        payoutAtValue &&
        typeof payoutAtValue.toDate === "function"
      ) {
        payoutAtMs = payoutAtValue
          .toDate()
          .getTime();
      } else if (payoutAtValue instanceof Date) {
        payoutAtMs = payoutAtValue.getTime();
      } else if (typeof payoutAtValue === "string") {
        const parsed = Date.parse(payoutAtValue);
        payoutAtMs = Number.isFinite(parsed) ? parsed : 0;
      } else if (typeof payoutAtValue === "number") {
        payoutAtMs = payoutAtValue;
      }

      if (!payoutAtMs || payoutAtMs > now) {
        continue;
      }

      const orderRef = orderDoc.ref;
      const userId =
        String(
          orderData.userId ||
          orderData.user_id ||
          ""
        ).trim();

      const code =
        String(
          orderData.code ||
          ""
        ).trim()
        .toUpperCase();

      if (!userId || !code) {
        continue;
      }

      const userRef =
        db.collection("users").doc(userId);

      const userOrderRef =
        userRef
          .collection("orders")
          .doc(orderDoc.id);

      const redemptionRef =
        db.collection("signal_redemptions")
          .doc(`${userId}_${code}`);

      let settlement = null;

      await db.runTransaction(
        async (transaction) => {
          const freshOrder =
            await transaction.get(orderRef);

          if (!freshOrder.exists) {
            return;
          }

          const freshOrderData =
            freshOrder.data() || {};

          if (
            String(
              freshOrderData.status || ""
            ).toUpperCase() !== "PENDING"
          ) {
            return;
          }

          const freshUser =
            await transaction.get(userRef);

          if (!freshUser.exists) {
            throw new Error("USER_NOT_FOUND");
          }

          const userData =
            freshUser.data() || {};

          const oldBalance =
            Number(
              userData.usdt_balance || 0
            );

          const rewardAmount =
            roundMoney(
              Number(
                freshOrderData.reward ||
                freshOrderData.profit ||
                freshOrderData.amount ||
                0
              ),
              4
            );

          if (
            !Number.isFinite(oldBalance) ||
            oldBalance < 0
          ) {
            throw new Error(
              "INVALID_BALANCE"
            );
          }

          if (
            !Number.isFinite(rewardAmount) ||
            rewardAmount <= 0
          ) {
            throw new Error(
              "INVALID_SETTLEMENT_AMOUNT"
            );
          }

          const balances = {
            ...(userData.balances || {}),
          };

          if (
            balances.exchange === undefined
          ) {
            balances.exchange =
              oldBalance;
          }

          if (
            balances.trade === undefined
          ) {
            balances.trade = 0;
          }

          if (
            balances.perpetual === undefined
          ) {
            balances.perpetual = 0;
          }

          if (
            balances.withdraw === undefined
          ) {
            balances.withdraw = 0;
          }

          const oldTradeBalance =
            Number(
              balances.trade || 0
            );

          const newBalance =
            roundMoney(
              oldBalance +
              rewardAmount,
              4
            );

          const newTradeBalance =
            roundMoney(
              oldTradeBalance +
              rewardAmount,
              4
            );

          balances.trade =
            newTradeBalance;

          const completedAt =
            FieldValue.serverTimestamp();

          transaction.update(
            userRef,
            {
              usdt_balance:
                newBalance,

              balances,

              last_signal_reward:
                rewardAmount,

              last_signal_code:
                code,

              last_signal_status:
                "COMPLETED",

              last_signal_at:
                completedAt,

              last_updated:
                completedAt,
            }
          );

          transaction.set(
            orderRef,
            {
              status:
                "COMPLETED",

              settlementStatus:
                "COMPLETED",

              balanceBefore:
                oldBalance,

              balanceAfter:
                newBalance,

              tradeBalanceBefore:
                oldTradeBalance,

              tradeBalanceAfter:
                newTradeBalance,

              completedAt,

              updatedAt:
                completedAt,
            },
            {
              merge: true,
            }
          );

          transaction.set(
            userOrderRef,
            {
              status:
                "COMPLETED",

              settlementStatus:
                "COMPLETED",

              balanceBefore:
                oldBalance,

              balanceAfter:
                newBalance,

              tradeBalanceBefore:
                oldTradeBalance,

              tradeBalanceAfter:
                newTradeBalance,

              completedAt,

              updatedAt:
                completedAt,
            },
            {
              merge: true,
            }
          );

          transaction.set(
            redemptionRef,
            {
              status:
                "COMPLETED",

              redeemedAt:
                completedAt,

              settledAt:
                completedAt,

              balanceBefore:
                oldBalance,

              balanceAfter:
                newBalance,

              tradeBalanceBefore:
                oldTradeBalance,

              tradeBalanceAfter:
                newTradeBalance,

              updatedAt:
                completedAt,
            },
            {
              merge: true,
            }
          );

          settlement = {
            rewardAmount,
            newBalance,
          };
        }
      );

      if (
        settlement &&
        realtimeDatabase
      ) {
        try {
          await realtimeDatabase
            .ref(
              `users/${userId}`
            )
            .update({
              usdt_balance:
                settlement.newBalance,

              last_signal_reward:
                settlement.rewardAmount,

              last_signal_code:
                code,

              last_signal_status:
                "COMPLETED",

              last_signal_at:
                Date.now(),

              last_updated:
                Date.now(),
            });
        } catch (rtdbError) {
          console.error(
            `⚠️ Copy Trading settlement completed in Firestore but RTDB sync failed for ${userId}:`,
            rtdbError.message
          );
        }

        console.log(
          `Copy Trading settlement completed for ${userId}: ${code} +$${settlement.rewardAmount.toFixed(2)} USDT`
        );
      }
    } catch (error) {
      console.error(
        `⚠️ Copy Trading settlement failed for order ${orderDoc.id}:`,
        error.message || error
      );
    }
  }
}

let copyTradingSettlementProcessorStarted = false;

function startCopyTradingSettlementProcessor() {
  if (copyTradingSettlementProcessorStarted) {
    return;
  }

  copyTradingSettlementProcessorStarted = true;

  setInterval(
    () => {
      settlePendingCopyTradingOrders()
        .catch((error) => {
          console.error(
            "⚠️ Copy Trading settlement processor error:",
            error.message || error
          );
        });
    },
    COPY_TRADING_SETTLEMENT_INTERVAL_MS
  );

  settlePendingCopyTradingOrders()
    .catch((error) => {
      console.error(
        "⚠️ Initial Copy Trading settlement scan failed:",
        error.message || error
      );
    });

  console.log(
    `Copy Trading settlement processor started. Interval: ${COPY_TRADING_SETTLEMENT_INTERVAL_MS / 1000}s`
  );
}

startCopyTradingSettlementProcessor();

// ============================================================
// COMPATIBILITY ALIASES
// ============================================================
//
// index.js currently searches for:
//
// redeemSignal
// redeemCode
// claimSignal
// redeem
//
// Expose aliases so the existing index.js can work without
// changing the endpoint logic immediately.
// ============================================================

async function redeemCode(
  userId,
  body
) {
  return redeemSignal(
    userId,
    body
  );
}

async function claimSignal(
  userId,
  body
) {
  return redeemSignal(
    userId,
    body
  );
}

async function redeem(
  userId,
  body
) {
  return redeemSignal(
    userId,
    body
  );
}

// ============================================================
// GET SINGLE USER REDEMPTIONS
// ============================================================
//
// Optional helper for future Flutter history screen.
// ============================================================

async function getUserRedemptions(
  userId,
  limit = 50
) {
  const cleanUserId =
    validateUserId(
      userId
    );

  const db =
    getFirestoreInstance();

  const safeLimit =
    Math.min(
      Math.max(
        parseInt(
          limit,
          10
        ) || 50,
        1
      ),
      100
    );

  const snapshot =
    await db
      .collection(
        "signal_redemptions"
      )
      .where(
        "userId",
        "==",
        cleanUserId
      )
      .orderBy(
        "createdAt",
        "desc"
      )
      .limit(
        safeLimit
      )
      .get();

  const redemptions = [];

  snapshot.forEach(
    (doc) => {
      redemptions.push({
        id:
          doc.id,

        ...doc.data(),
      });
    }
  );

  return {
    success: true,

    redemptions,
  };
}

// ============================================================
// EXPORTS
// ============================================================
//
// NO:
// - generateSignalCode
// - createAndReleaseSignal
// - createSignal
// - Telegram
// - scheduler
//
// Those belong exclusively to firebase_manager.js.
// ============================================================

module.exports = {
  // Firebase

  getFirestoreInstance,

  getRealtimeDatabaseInstance,

  // Validation

  validateUserId,

  normalizeSignalCode,

  // Account

  isAccountFrozen,

  // Payout compatibility

  getPayoutForCapital,

  // Signal reading

  getSignal,

  getSignals,

  getActiveSignals,

  getUserSignals,

  getSignalStatus,

  // Redemption

  redeemSignal,

  redeemCode,

  claimSignal,

  redeem,

  // Redemption history

  getUserRedemptions,
};