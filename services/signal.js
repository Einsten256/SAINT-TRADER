/**
 * SAINT CRYPTO
 * FILE: services/signal.js
 *
 * FINAL DAILY SIGNAL SERVICE
 *
 * BUSINESS RULES
 * ------------------------------------------------------------
 * 1. One signal per weekday.
 * 2. Signal time: 9:00 PM EAT (Africa/Kampala).
 * 3. Monday-Friday only.
 * 4. Signal code is exactly 12 uppercase alphanumeric characters.
 * 5. Fixed reward: UGX 20,000.
 * 6. User must have qualifying locked trading capital.
 * 7. One redemption per user per signal.
 * 8. Redemption enters PROCESSING for approximately 7 minutes.
 * 9. The payout is NOT credited by Flutter.
 * 10. A durable server-side processor calls the ledger after the
 *     processing time.
 * 11. Payout is credited to payout_balance_ugx only.
 * 12. Locked trading capital is never consumed by a signal payout.
 *
 * FIRESTORE
 * ------------------------------------------------------------
 * signals/{signalCode}
 * signal_redemptions/{userId}_{signalCode}
 *
 * This service owns signal redemption state.
 * services/ledger.js owns the actual money movement.
 */

"use strict";

const crypto = require("crypto");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");

const ledger = require("./ledger");

let firestore = null;

try {
  firestore = getFirestore();
} catch (error) {
  console.error(
    "❌ Signal service: Firestore unavailable:",
    error.message
  );
}

/* ============================================================
   CONFIGURATION
   ============================================================ */

const SIGNAL_REWARD_UGX = Math.max(
  1,
  Math.round(
    Number(
      process.env.SIGNAL_REWARD_UGX ??
        process.env.SIGNAL_PROFIT_UGX ??
        20000
    ) || 20000
  )
);

const SIGNAL_PROCESSING_MINUTES = Math.max(
  1,
  Math.round(
    Number(
      process.env.SIGNAL_PROCESSING_MINUTES ??
        7
    ) || 7
  )
);

const SIGNAL_EXPIRY_MINUTES = Math.max(
  SIGNAL_PROCESSING_MINUTES + 1,
  Math.round(
    Number(
      process.env.SIGNAL_EXPIRY_MINUTES ??
        1440
    ) || 1440
  )
);

const SIGNAL_TIMEZONE =
  process.env.SIGNAL_TIMEZONE ||
  "Africa/Kampala";

const SIGNAL_TIME =
  process.env.SIGNAL_TIME ||
  "21:00";

const MIN_LOCKED_CAPITAL_UGX = Math.max(
  0,
  Math.round(
    Number(
      process.env.SIGNAL_MIN_LOCKED_CAPITAL_UGX ??
        1
    ) || 1
  )
);

const SIGNAL_COLLECTION = "signals";
const REDEMPTION_COLLECTION =
  "signal_redemptions";
const USERS_COLLECTION = "users";

/* ============================================================
   HELPERS
   ============================================================ */

function requireFirestore() {
  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }
}

function validateUserId(userId) {
  if (!userId || typeof userId !== "string") {
    throw new Error("Invalid user account.");
  }

  const uid = userId.trim();

  if (!uid) {
    throw new Error("Invalid user account.");
  }

  return uid;
}

function normalizeSignalCode(code) {
  const value = String(code || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{12}$/.test(value)) {
    throw new Error(
      "Signal code must contain exactly 12 characters."
    );
  }

  return value;
}

function isFrozen(user) {
  return (
    user?.is_frozen === true ||
    String(user?.status || "").toUpperCase() === "FROZEN"
  );
}

function lockedCapitalOf(user) {
  return Math.max(
    0,
    Math.round(
      Number(
        user?.locked_trading_capital_ugx ??
          user?.locked_principal_ugx ??
          0
      ) || 0
    )
  );
}

function payoutBalanceOf(user) {
  return Math.max(
    0,
    Math.round(
      Number(
        user?.payout_balance_ugx ?? 0
      ) || 0
    )
  );
}

function getKampalaParts(date = new Date()) {
  const formatter =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: SIGNAL_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      }
    );

  const parts =
    formatter.formatToParts(date);

  const get = (type) =>
    parts.find(
      (part) => part.type === type
    )?.value || "";

  return {
    weekday: get("weekday"),
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

function isWeekday(parts) {
  return (
    parts.weekday === "Mon" ||
    parts.weekday === "Tue" ||
    parts.weekday === "Wed" ||
    parts.weekday === "Thu" ||
    parts.weekday === "Fri"
  );
}

function makeProcessingTimestamp(
  baseDate = new Date()
) {
  return Timestamp.fromDate(
    new Date(
      baseDate.getTime() +
        SIGNAL_PROCESSING_MINUTES *
          60 *
          1000
    )
  );
}

function makeExpiryTimestamp(
  baseDate = new Date()
) {
  return Timestamp.fromDate(
    new Date(
      baseDate.getTime() +
        SIGNAL_EXPIRY_MINUTES *
          60 *
          1000
    )
  );
}

/* ============================================================
   CODE GENERATOR
 * ============================================================ */

function generateSignalCode() {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let code = "";

  for (let i = 0; i < 12; i += 1) {
    code +=
      characters[
        crypto.randomInt(
          0,
          characters.length
        )
      ];
  }

  return code;
}

/* ============================================================
   CREATE SIGNAL
 *
 * Called by firebase_manager.js at 21:00 EAT Monday-Friday.
 *
 * The scheduler may retry, therefore this function is safe
 * against an existing signal for the same Kampala date.
 * ============================================================ */

async function createSignal({
  session = "9:00 PM EAT",
  force = false,
  createdBy = "SCHEDULER",
} = {}) {
  requireFirestore();

  const now = new Date();
  const kampala = getKampalaParts(now);

  if (!force) {
    if (!isWeekday(kampala)) {
      throw new Error(
        "Daily signals are generated Monday-Friday only."
      );
    }

    if (SIGNAL_TIME) {
      const currentTime =
        `${String(kampala.hour).padStart(2, "0")}:` +
        `${String(kampala.minute).padStart(2, "0")}`;

      /*
       * Allow the scheduler a small execution window around
       * 21:00 rather than requiring the exact second.
       */
      if (currentTime !== SIGNAL_TIME) {
        throw new Error(
          `Signal generation is scheduled for ${SIGNAL_TIME} EAT.`
        );
      }
    }
  }

  /*
   * A daily signal document keyed by date gives us an additional
   * durable uniqueness guard.
   */
  const dailyRef = firestore
    .collection("signal_daily")
    .doc(kampala.date);

  const existingDaily =
    await dailyRef.get();

  if (
    existingDaily.exists &&
    existingDaily.data()?.signalCode
  ) {
    const existingCode =
      existingDaily.data().signalCode;

    const existingSignal =
      await firestore
        .collection(SIGNAL_COLLECTION)
        .doc(existingCode)
        .get();

    if (existingSignal.exists) {
      return {
        success: true,
        alreadyExists: true,
        signal: {
          code: existingCode,
          ...existingSignal.data(),
        },
      };
    }
  }

  let signalCode = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate =
      generateSignalCode();

    const ref =
      firestore
        .collection(SIGNAL_COLLECTION)
        .doc(candidate);

    const exists =
      await ref.get();

    if (!exists.exists) {
      signalCode = candidate;
      break;
    }
  }

  if (!signalCode) {
    throw new Error(
      "Unable to generate a unique signal code."
    );
  }

  const signalRef =
    firestore
      .collection(SIGNAL_COLLECTION)
      .doc(signalCode);

  const createdAt =
    FieldValue.serverTimestamp();

  const expiresAt =
    makeExpiryTimestamp(now);

  const signalRecord = {
    code: signalCode,

    rewardUgx:
      SIGNAL_REWARD_UGX,

    profit:
      SIGNAL_REWARD_UGX,

    currency: "UGX",

    symbol:
      process.env.SIGNAL_DEFAULT_SYMBOL ||
      "SAINT",

    session,

    status:
      "PROFIT_VERIFIED",

    active: true,

    isRedeemed: false,

    date:
      kampala.date,

    timezone:
      SIGNAL_TIMEZONE,

    scheduledTime:
      SIGNAL_TIME,

    processingMinutes:
      SIGNAL_PROCESSING_MINUTES,

    createdBy,

    createdAt,
    created_at: createdAt,

    expiresAt,
    expires_at: expiresAt,

    createdAtIso:
      now.toISOString(),

    updatedAt:
      FieldValue.serverTimestamp(),
  };

  /*
   * Transactionally claim the daily date.
   *
   * This prevents two scheduler instances from creating two
   * signals for the same Kampala date.
   */
  await firestore.runTransaction(
    async (transaction) => {
      const dailyDoc =
        await transaction.get(
          dailyRef
        );

      if (
        dailyDoc.exists &&
        dailyDoc.data()?.signalCode
      ) {
        throw new Error(
          "A daily signal has already been created."
        );
      }

      transaction.create(
        signalRef,
        signalRecord
      );

      transaction.create(
        dailyRef,
        {
          date:
            kampala.date,
          signalCode,
          timezone:
            SIGNAL_TIMEZONE,
          scheduledTime:
            SIGNAL_TIME,
          createdAt:
            FieldValue.serverTimestamp(),
        }
      );
    }
  );

  return {
    success: true,
    alreadyExists: false,
    signal: {
      code: signalCode,
      ...signalRecord,
    },
  };
}

/* ============================================================
   GET ACTIVE SIGNAL
 * ============================================================ */

async function getActiveSignal() {
  requireFirestore();

  const now = new Date();

  const snapshot =
    await firestore
      .collection(SIGNAL_COLLECTION)
      .where(
        "active",
        "==",
        true
      )
      .limit(20)
      .get();

  const activeSignals =
    snapshot.docs
      .map((doc) => ({
        code: doc.id,
        ...doc.data(),
      }))
      .filter((signal) => {
        const expires =
          signal.expiresAt
            ?.toDate?.();

        return (
          !expires ||
          expires.getTime() > now.getTime()
        );
      })
      .sort((a, b) => {
        const aTime =
          a.createdAt
            ?.toMillis?.() || 0;

        const bTime =
          b.createdAt
            ?.toMillis?.() || 0;

        return bTime - aTime;
      });

  return {
    success: true,
    signal:
      activeSignals[0] || null,
    rewardUgx:
      SIGNAL_REWARD_UGX,
    currency: "UGX",
  };
}

/* ============================================================
   GET SIGNAL BY CODE
 * ============================================================ */

async function getSignal(code) {
  requireFirestore();

  const signalCode =
    normalizeSignalCode(code);

  const ref =
    firestore
      .collection(SIGNAL_COLLECTION)
      .doc(signalCode);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Signal code could not be found."
    );
  }

  return {
    success: true,
    signal: {
      code: snapshot.id,
      ...snapshot.data(),
    },
  };
}

/* ============================================================
   REDEEM SIGNAL
 *
 * This does NOT credit money.
 *
 * It:
 *   - validates code
 *   - validates user
 *   - validates locked capital
 *   - prevents duplicate redemption
 *   - creates PROCESSING redemption
 *   - sets creditAt approximately 7 minutes ahead
 *
 * The processor later calls:
 *   ledger.creditSignalPayoutToLedger()
 * ============================================================ */

async function redeemSignal(
  userId,
  body = {}
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  const signalCode =
    normalizeSignalCode(
      body.code ??
      body.signalCode ??
      body.signal_code
    );

  const signalRef =
    firestore
      .collection(SIGNAL_COLLECTION)
      .doc(signalCode);

  const userRef =
    firestore
      .collection(USERS_COLLECTION)
      .doc(uid);

  const redemptionId =
    `${uid}_${signalCode}`;

  const redemptionRef =
    firestore
      .collection(REDEMPTION_COLLECTION)
      .doc(redemptionId);

  let result = null;

  await firestore.runTransaction(
    async (transaction) => {
      const signalDoc =
        await transaction.get(
          signalRef
        );

      if (!signalDoc.exists) {
        throw new Error(
          "Signal code is invalid or no longer available."
        );
      }

      const signal =
        signalDoc.data() || {};

      const redemptionDoc =
        await transaction.get(
          redemptionRef
        );

      /*
       * Duplicate protection.
       */
      if (redemptionDoc.exists) {
        const existing =
          redemptionDoc.data() || {};

        result = {
          success: true,
          alreadyRedeemed: true,
          redemptionId,
          status:
            existing.status ||
            "PROCESSING",
          rewardUgx:
            existing.rewardUgx ??
            SIGNAL_REWARD_UGX,
          creditAt:
            existing.creditAt ||
            null,
        };

        return;
      }

      const userDoc =
        await transaction.get(
          userRef
        );

      if (!userDoc.exists) {
        throw new Error(
          "Your account record could not be found."
        );
      }

      const user =
        userDoc.data() || {};

      if (isFrozen(user)) {
        throw new Error(
          "Your account is currently restricted."
        );
      }

      /*
       * Signal must be active and verified.
       */
      if (
        signal.active !== true ||
        String(
          signal.status || ""
        ).toUpperCase() !==
          "PROFIT_VERIFIED"
      ) {
        throw new Error(
          "This signal is not available for redemption."
        );
      }

      /*
       * Expiry protection.
       */
      const expiresAt =
        signal.expiresAt
          ?.toDate?.();

      if (
        expiresAt &&
        expiresAt.getTime() <=
          Date.now()
      ) {
        throw new Error(
          "This signal has expired."
        );
      }

      const lockedCapital =
        lockedCapitalOf(user);

      if (
        lockedCapital <
        MIN_LOCKED_CAPITAL_UGX
      ) {
        throw new Error(
          `Qualifying locked trading capital is required. Minimum: UGX ${MIN_LOCKED_CAPITAL_UGX.toLocaleString()}.`
        );
      }

      const createdAtDate =
        new Date();

      const creditAt =
        makeProcessingTimestamp(
          createdAtDate
        );

      const processingExpiresAt =
        makeExpiryTimestamp(
          createdAtDate
        );

      transaction.create(
        redemptionRef,
        {
          redemptionId,

          userId: uid,

          signalCode,

          code: signalCode,

          rewardUgx:
            SIGNAL_REWARD_UGX,

          currency: "UGX",

          lockedTradingCapitalUgx:
            lockedCapital,

          status:
            "PROCESSING",

          creditedToLedger:
            false,

          creditAt,

          processingStartedAt:
            FieldValue.serverTimestamp(),

          processingMinutes:
            SIGNAL_PROCESSING_MINUTES,

          expiresAt:
            processingExpiresAt,

          createdAt:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp(),
        }
      );

      /*
       * Do not modify payout balance here.
       * Do not modify locked capital here.
       */
      result = {
        success: true,
        alreadyRedeemed: false,
        redemptionId,
        signalCode,
        status: "PROCESSING",
        rewardUgx:
          SIGNAL_REWARD_UGX,
        currency: "UGX",
        processingMinutes:
          SIGNAL_PROCESSING_MINUTES,
        creditAt,
      };
    }
  );

  return result;
}

/* ============================================================
   PROCESS ONE SIGNAL PAYOUT
 *
 * Durable processor entry point.
 *
 * Safe to call repeatedly:
 *   PROCESSING -> CREDITED
 *   CREDITED    -> already credited
 *
 * The ledger transaction performs the atomic balance credit.
 * ============================================================ */

async function processSignalRedemption(
  redemptionId
) {
  requireFirestore();

  if (
    !redemptionId ||
    typeof redemptionId !== "string"
  ) {
    throw new Error(
      "Redemption ID is required."
    );
  }

  const redemptionRef =
    firestore
      .collection(
        REDEMPTION_COLLECTION
      )
      .doc(redemptionId);

  const snapshot =
    await redemptionRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Signal redemption could not be found."
    );
  }

  const redemption =
    snapshot.data() || {};

  if (
    redemption.status ===
      "CREDITED" &&
    redemption.creditedToLedger ===
      true
  ) {
    return {
      success: true,
      alreadyCredited: true,
      redemptionId,
      status: "CREDITED",
      amountUgx:
        redemption.creditedAmountUgx ??
        redemption.rewardUgx ??
        SIGNAL_REWARD_UGX,
    };
  }

  if (
    redemption.status !==
    "PROCESSING"
  ) {
    throw new Error(
      `Redemption cannot be processed from status ${
        redemption.status || "UNKNOWN"
      }.`
    );
  }

  const creditAt =
    redemption.creditAt
      ?.toDate?.();

  if (
    creditAt &&
    creditAt.getTime() >
      Date.now()
  ) {
    return {
      success: true,
      ready: false,
      redemptionId,
      status: "PROCESSING",
      creditAt:
        redemption.creditAt,
    };
  }

  const result =
    await ledger.creditSignalPayoutToLedger(
      {
        redemptionId,
        userId:
          redemption.userId,
        amountUgx:
          redemption.rewardUgx ??
          SIGNAL_REWARD_UGX,
        record: {
          signalCode:
            redemption.signalCode ||
            redemption.code ||
            null,
          processor:
            "SIGNAL_PAYOUT_PROCESSOR",
        },
      }
    );

  return {
    success: true,
    ready: true,
    alreadyCredited:
      result.alreadyCredited,
    redemptionId,
    userId:
      redemption.userId,
    status:
      result.alreadyCredited
        ? "CREDITED"
        : "CREDITED",
    amountUgx:
      redemption.rewardUgx ??
      SIGNAL_REWARD_UGX,
  };
}

/* ============================================================
   PROCESS DUE REDEMPTIONS
 *
 * This is designed to be called repeatedly by a server-side
 * interval or startup recovery process.
 *
 * Because each redemption is idempotent, server restarts do not
 * lose payouts.
 * ============================================================ */

async function processDueSignalRedemptions(
  limit = 100
) {
  requireFirestore();

  let count =
    Number.parseInt(
      limit,
      10
    );

  if (!Number.isFinite(count)) {
    count = 100;
  }

  count = Math.min(
    Math.max(count, 1),
    250
  );

  const now =
    Timestamp.now();

  const snapshot =
    await firestore
      .collection(
        REDEMPTION_COLLECTION
      )
      .where(
        "status",
        "==",
        "PROCESSING"
      )
      .where(
        "creditAt",
        "<=",
        now
      )
      .limit(count)
      .get();

  const results = [];

  for (
    const doc of snapshot.docs
  ) {
    try {
      const result =
        await processSignalRedemption(
          doc.id
        );

      results.push(result);
    } catch (error) {
      console.error(
        `❌ Signal payout ${doc.id}:`,
        error.message
      );

      results.push({
        success: false,
        redemptionId:
          doc.id,
        error:
          error.message,
      });
    }
  }

  return {
    success: true,
    processed:
      results.length,
    results,
  };
}

/* ============================================================
   START DURABLE PAYOUT PROCESSOR
 *
 * Runs every 15 seconds.
 *
 * The processor is intentionally independent from Flutter.
 * A restart simply resumes processing from Firestore.
 * ============================================================ */

let payoutProcessorTimer =
  null;

function startSignalPayoutProcessor({
  intervalMs = 15000,
} = {}) {
  if (payoutProcessorTimer) {
    return {
      success: true,
      alreadyRunning: true,
    };
  }

  const interval =
    Math.max(
      5000,
      Number(intervalMs) ||
        15000
    );

  const run = async () => {
    try {
      await processDueSignalRedemptions(
        100
      );
    } catch (error) {
      console.error(
        "❌ Signal payout processor:",
        error.message
      );
    }
  };

  /*
   * Recover any payouts that became due while the server was
   * offline.
   */
  run();

  payoutProcessorTimer =
    setInterval(
      run,
      interval
    );

  if (
    typeof payoutProcessorTimer.unref ===
    "function"
  ) {
    payoutProcessorTimer.unref();
  }

  console.log(
    `✅ Signal payout processor started (${interval}ms interval).`
  );

  return {
    success: true,
    alreadyRunning: false,
    intervalMs: interval,
  };
}

function stopSignalPayoutProcessor() {
  if (!payoutProcessorTimer) {
    return {
      success: true,
      alreadyStopped: true,
    };
  }

  clearInterval(
    payoutProcessorTimer
  );

  payoutProcessorTimer =
    null;

  return {
    success: true,
    stopped: true,
  };
}

/* ============================================================
   GET REDEMPTION
 * ============================================================ */

async function getRedemption(
  userId,
  redemptionId
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  if (
    !redemptionId ||
    typeof redemptionId !== "string"
  ) {
    throw new Error(
      "Redemption ID is required."
    );
  }

  const ref =
    firestore
      .collection(
        REDEMPTION_COLLECTION
      )
      .doc(redemptionId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Signal redemption could not be found."
    );
  }

  const redemption =
    snapshot.data() || {};

  if (
    redemption.userId !== uid
  ) {
    throw new Error(
      "You are not allowed to view this redemption."
    );
  }

  return {
    success: true,
    redemption: {
      redemptionId:
        snapshot.id,
      ...redemption,
    },
  };
}

/* ============================================================
   USER REDEMPTION HISTORY
 * ============================================================ */

async function getRedemptionHistory(
  userId,
  limit = 50
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  let count =
    Number.parseInt(
      limit,
      10
    );

  if (!Number.isFinite(count)) {
    count = 50;
  }

  count = Math.min(
    Math.max(count, 1),
    100
  );

  const snapshot =
    await firestore
      .collection(
        REDEMPTION_COLLECTION
      )
      .where(
        "userId",
        "==",
        uid
      )
      .limit(count)
      .get();

  const records =
    snapshot.docs.map(
      (doc) => ({
        redemptionId:
          doc.id,
        ...doc.data(),
      })
    );

  records.sort(
    (a, b) => {
      const aTime =
        a.createdAt
          ?.toMillis?.() || 0;

      const bTime =
        b.createdAt
          ?.toMillis?.() || 0;

      return bTime - aTime;
    }
  );

  return {
    success: true,
    redemptions: records,
  };
}

/* ============================================================
   STATUS
 * ============================================================ */

async function getStatus() {
  return {
    success: true,
    currency: "UGX",
    rewardUgx:
      SIGNAL_REWARD_UGX,
    processingMinutes:
      SIGNAL_PROCESSING_MINUTES,
    signalTime:
      SIGNAL_TIME,
    timezone:
      SIGNAL_TIMEZONE,
    weekdaysOnly: true,
    minimumLockedCapitalUgx:
      MIN_LOCKED_CAPITAL_UGX,
    processorRunning:
      Boolean(
        payoutProcessorTimer
      ),
  };
}

/* ============================================================
   EXPORTS
 * ============================================================ */

module.exports = {
  SIGNAL_REWARD_UGX,
  SIGNAL_PROCESSING_MINUTES,
  SIGNAL_EXPIRY_MINUTES,
  SIGNAL_TIMEZONE,
  SIGNAL_TIME,
  MIN_LOCKED_CAPITAL_UGX,

  generateSignalCode,

  getKampalaParts,
  isWeekday,

  createSignal,
  getActiveSignal,
  getSignal,

  redeemSignal,

  processSignalRedemption,
  processDueSignalRedemptions,

  startSignalPayoutProcessor,
  stopSignalPayoutProcessor,

  getRedemption,
  getRedemptionHistory,

  getStatus,
};
