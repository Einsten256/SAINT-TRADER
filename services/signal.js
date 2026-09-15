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
// - Atomically credit user balance
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

      profit:
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
  signalCode
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
        // REWARD
        // ----------------------------------------------------
        //
        // PRIMARY SOURCE:
        //
        // firebase_manager.js
        // stores signal.profit
        //
        // FALLBACK:
        //
        // Older signal records may contain
        // profitGenerated.
        //
        // LAST FALLBACK:
        //
        // payout tier.
        // ----------------------------------------------------

        const storedProfit =
          parseFloat(
            signalData.profit
          );

        const generatedProfit =
          parseFloat(
            signalData.profitGenerated
          );

        if (
          Number.isFinite(
            storedProfit
          ) &&
          storedProfit > 0
        ) {
          rewardAmount =
            roundMoney(
              storedProfit,
              4
            );
        } else if (
          Number.isFinite(
            generatedProfit
          ) &&
          generatedProfit > 0
        ) {
          rewardAmount =
            roundMoney(
              generatedProfit,
              4
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

        const lockedPrincipal =
          parseFloat(
            userData.locked_principal ||
              0
          );

        // ----------------------------------------------------
        // FALLBACK PAYOUT
        // ----------------------------------------------------

        if (
          rewardAmount <= 0
        ) {
          rewardAmount =
            roundMoney(
              getPayoutForCapital(
                lockedPrincipal
              ),
              4
            );
        }

        if (
          rewardAmount <= 0
        ) {
          throw new Error(
            "CAPITAL_NOT_QUALIFIED"
          );
        }

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
        // IF locked_principal IS USED FOR QUALIFICATION,
        // ALSO ENSURE THE USER MEETS THE REQUIRED CAPITAL.
        // ----------------------------------------------------

        if (
          lockedPrincipal > 0 &&
          lockedPrincipal <
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
        // UPDATED BALANCES
        // ----------------------------------------------------

        newBalance =
          roundMoney(
            oldBalance +
              rewardAmount,
            4
          );

        newTradeBalance =
          roundMoney(
            oldTradeBalance +
              rewardAmount,
            4
          );

        // ----------------------------------------------------
        // KEEP EXCHANGE BALANCE CONSISTENT
        // ----------------------------------------------------
        //
        // IMPORTANT:
        //
        // Signal reward is credited to trade.
        //
        // usdt_balance is the primary overall balance.
        //
        // Therefore:
        //
        // usdt_balance += reward
        // balances.trade += reward
        //
        // balances.exchange is NOT increased separately,
        // otherwise the internal account totals would double
        // count the reward.
        // ----------------------------------------------------

        balances.trade =
          newTradeBalance;

        // ----------------------------------------------------
        // UPDATE USER
        // ----------------------------------------------------

        transaction.update(
          userRef,
          {
            usdt_balance:
              newBalance,

            balances,

            last_signal_reward:
              rewardAmount,

            last_signal_code:
              cleanCode,

            last_signal_at:
              FieldValue.serverTimestamp(),

            last_updated:
              FieldValue.serverTimestamp(),
          }
        );

        // ----------------------------------------------------
        // CREATE REDEMPTION RECORD
        // ----------------------------------------------------

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
              rewardAmount,

            symbol:
              signalData.symbol ||
              SIGNAL_DEFAULT_SYMBOL,

            session:
              signalData.session ||
              null,

            signalProfit:
              rewardAmount,

            balanceBefore:
              oldBalance,

            balanceAfter:
              newBalance,

            tradeBalanceBefore:
              oldTradeBalance,

            tradeBalanceAfter:
              newTradeBalance,

            source:
              "signal",

            status:
              "completed",

            redeemedAt:
              FieldValue.serverTimestamp(),

            createdAt:
              FieldValue.serverTimestamp(),
          }
        );

        // ----------------------------------------------------
        // MARK SIGNAL AS REDEEMED
        // ----------------------------------------------------

        transaction.update(
          signalRef,
          {
            active:
              false,

            isRedeemed:
              true,

            status:
              "REDEEMED",

            redeemedBy:
              cleanUserId,

            redeemedReward:
              rewardAmount,

            redeemedAt:
              FieldValue.serverTimestamp(),

            updated_at:
              FieldValue.serverTimestamp(),
          }
        );

        // ----------------------------------------------------
        // RETURN SIGNAL INFORMATION
        // ----------------------------------------------------

        signalSymbol =
          signalData.symbol ||
          SIGNAL_DEFAULT_SYMBOL;

        signalSession =
          signalData.session ||
          null;

        signalProfit =
          rewardAmount;
      }
    );

    // ========================================================
    // RTDB USER SYNC
    // ========================================================
    //
    // Firestore is authoritative.
    //
    // RTDB is synchronized for Flutter.
    //
    // Failure here does NOT reverse the Firestore transaction.
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
            usdt_balance:
              newBalance,

            last_signal_reward:
              rewardAmount,

            last_signal_code:
              cleanCode,

            last_signal_at:
              Date.now(),

            last_updated:
              Date.now(),
          });
      } catch (rtdbError) {
        console.error(
          `⚠️ Firestore signal redemption succeeded but RTDB sync failed for ${cleanUserId}:`,
          rtdbError.message
        );
      }
    }

    // ========================================================
    // SUCCESS
    // ========================================================

    console.log(
      `💰 Signal ${cleanCode} redeemed by ${cleanUserId}: +$${rewardAmount.toFixed(
        2
      )}`
    );

    return {
      success: true,

      status:
        "REDEEMED",

      message:
        `Claimed $${rewardAmount.toFixed(
          2
        )} USDT successfully.`,

      code:
        cleanCode,

      reward:
        roundMoney(
          rewardAmount,
          4
        ),

      new_balance:
        roundMoney(
          newBalance,
          4
        ),

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
            "Signal code has already been redeemed.",
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