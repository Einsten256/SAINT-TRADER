/**
 * SAINT CRYPTO
 * FILE: services/signal.js
 *
 * FINAL DAILY SIGNAL SERVICE
 *
 * RULES
 * ------------------------------------------------------------
 * - Monday-Friday only.
 * - One signal per Kampala date.
 * - Scheduled at 21:00 Africa/Kampala.
 * - Exactly 12 uppercase alphanumeric characters.
 * - Fixed reward: UGX 20,000.
 * - User must have qualifying locked trading capital.
 * - One redemption per user per daily signal.
 * - Redemption is PROCESSING for 7 minutes.
 * - Server-side processor credits payout_balance_ugx.
 * - Locked trading capital is never consumed by the payout.
 *
 * TELEGRAM
 * ------------------------------------------------------------
 * This file owns the DAILY SIGNAL announcement.
 * The old USD/USDT/20-minute signal message is intentionally gone.
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
   CONFIG
   ============================================================ */

const SIGNAL_REWARD_UGX = Math.max(
  1,
  Math.round(
    Number(
      process.env.SIGNAL_REWARD_UGX ??
        process.env.SIGNAL_PAYOUT_UGX ??
        20000
    ) || 20000
  )
);

const SIGNAL_PROCESSING_MINUTES = Math.max(
  1,
  Math.round(
    Number(
      process.env.SIGNAL_PROCESSING_MINUTES ?? 7
    ) || 7
  )
);

// New architecture uses a long-lived daily code.
// IMPORTANT: do not read the old SIGNAL_EXPIRY_MINUTES env var,
// because the previous system used a 20-minute USDT signal expiry.
// Optional new variable: SIGNAL_CODE_EXPIRY_MINUTES.
const SIGNAL_EXPIRY_MINUTES = Math.max(
  SIGNAL_PROCESSING_MINUTES + 1,
  Math.round(
    Number(
      process.env.SIGNAL_CODE_EXPIRY_MINUTES ?? 1440
    ) || 1440
  )
);

const SIGNAL_TIMEZONE =
  String(
    process.env.SIGNAL_TIMEZONE ||
      "Africa/Kampala"
  ).trim();

const SIGNAL_TIME =
  String(
    process.env.SIGNAL_TIME || "21:00"
  ).trim();

const MIN_LOCKED_CAPITAL_UGX = Math.max(
  1,
  Math.round(
    Number(
      process.env.SIGNAL_MIN_LOCKED_CAPITAL_UGX ?? 1
    ) || 1
  )
);

const SIGNAL_SYMBOL =
  String(
    process.env.SIGNAL_DEFAULT_SYMBOL ||
      "XAUUSD"
  ).trim().toUpperCase();

const TELEGRAM_BOT_TOKEN =
  String(
    process.env.TELEGRAM_BOT_TOKEN || ""
  ).trim();

const TELEGRAM_CHAT_ID =
  String(
    process.env.TELEGRAM_CHAT_ID || ""
  ).trim();

const SIGNAL_COLLECTION = "signals";
const DAILY_COLLECTION = "signal_daily";
const REDEMPTION_COLLECTION = "signal_redemptions";
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
  if (
    !userId ||
    typeof userId !== "string"
  ) {
    throw new Error(
      "Invalid user account."
    );
  }

  const uid = userId.trim();

  if (!uid) {
    throw new Error(
      "Invalid user account."
    );
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

function generateSignalCode() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let code = "";

  for (let i = 0; i < 12; i += 1) {
    code += alphabet[
      crypto.randomInt(
        0,
        alphabet.length
      )
    ];
  }

  return code;
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

function isFrozen(user) {
  return (
    user?.is_frozen === true ||
    ["FROZEN", "PAUSED", "SUSPENDED"].includes(
      String(user?.status || "")
        .trim()
        .toUpperCase()
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
        weekday: "short",
        hourCycle: "h23",
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
    date:
      `${get("year")}-${get("month")}-${get("day")}`,
    time:
      `${get("hour")}:${get("minute")}`,
  };
}

function isWeekday(parts) {
  return [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
  ].includes(parts.weekday);
}

function timestampAfterMinutes(minutes) {
  return Timestamp.fromDate(
    new Date(
      Date.now() +
        Math.max(0, Number(minutes) || 0) *
          60 *
          1000
    )
  );
}

function toMillis(value) {
  if (!value) return 0;

  if (
    typeof value.toMillis === "function"
  ) {
    return value.toMillis();
  }

  if (
    typeof value.toDate === "function"
  ) {
    return value.toDate().getTime();
  }

  const date =
    new Date(value);

  return Number.isNaN(
    date.getTime()
  )
    ? 0
    : date.getTime();
}

/* ============================================================
   TELEGRAM
   ============================================================ */

function buildTelegramSignalMessage(
  code,
  createdAt = new Date()
) {
  const kampala =
    getKampalaParts(createdAt);

  return (
    "🎟️ *SAINT CRYPTO DAILY SIGNAL*\n\n" +
    `🕘 *Time:* \`${SIGNAL_TIME} EAT\`\n` +
    "📅 *Schedule:* `Monday-Friday`\n" +
    `💰 *Reward:* \`UGX ${SIGNAL_REWARD_UGX.toLocaleString()}\`\n` +
    `🔑 *Signal Code:* \`${code}\`\n\n` +
    `⏳ *Processing:* ${SIGNAL_PROCESSING_MINUTES} minutes\n` +
    "👤 *Eligibility:* qualifying locked trading capital\n\n" +
    "⚡ *Redeem the code in the SAINT CRYPTO app.*"
  );
}

async function sendTelegramSignal(
  code,
  createdAt = new Date()
) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.warn(
      "⚠️ Daily signal created but Telegram credentials are not configured."
    );

    return false;
  }

  const message =
    buildTelegramSignalMessage(
      code,
      createdAt
    );

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response =
      await fetch(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            chat_id:
              TELEGRAM_CHAT_ID,
            text: message,
            parse_mode:
              "Markdown",
          }),
        }
      );

    const data =
      await response.json();

    if (
      response.ok &&
      data.ok === true
    ) {
      console.log(
        `📱 Daily signal ${code} sent to Telegram.`
      );

      return true;
    }

    console.error(
      "❌ Daily signal Telegram error:",
      data.description ||
        "Unknown Telegram error"
    );

    return false;
  } catch (error) {
    console.error(
      "❌ Daily signal Telegram request failed:",
      error.message
    );

    return false;
  }
}

/* ============================================================
   CREATE SIGNAL
   ============================================================ */

async function createSignal({
  session = "9:00 PM EAT",
  force = false,
  createdBy = "SCHEDULER",
} = {}) {
  requireFirestore();

  const now = new Date();
  const kampala =
    getKampalaParts(now);

  if (!force) {
    if (!isWeekday(kampala)) {
      throw new Error(
        "Daily signals are generated Monday-Friday only."
      );
    }

    if (
      `${String(kampala.hour).padStart(2, "0")}:` +
        `${String(kampala.minute).padStart(2, "0")}` !==
      SIGNAL_TIME
    ) {
      throw new Error(
        `Signal generation is scheduled for ${SIGNAL_TIME} EAT.`
      );
    }
  }

  const dailyRef =
    firestore
      .collection(DAILY_COLLECTION)
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

  let code = "";

  for (
    let attempt = 0;
    attempt < 20;
    attempt += 1
  ) {
    const candidate =
      generateSignalCode();

    const candidateRef =
      firestore
        .collection(SIGNAL_COLLECTION)
        .doc(candidate);

    const candidateDoc =
      await candidateRef.get();

    if (!candidateDoc.exists) {
      code = candidate;
      break;
    }
  }

  if (!code) {
    throw new Error(
      "Unable to generate a unique signal code."
    );
  }

  const signalRef =
    firestore
      .collection(SIGNAL_COLLECTION)
      .doc(code);

  const expiresAt =
    timestampAfterMinutes(
      SIGNAL_EXPIRY_MINUTES
    );

  let created = false;

  try {
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
          {
            code,

            rewardUgx:
              SIGNAL_REWARD_UGX,

            profit:
              SIGNAL_REWARD_UGX,

            currency:
              "UGX",

            symbol:
              SIGNAL_SYMBOL,

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

            expiryMinutes:
              SIGNAL_EXPIRY_MINUTES,

            createdBy,

            createdAt:
              FieldValue.serverTimestamp(),

            created_at:
              FieldValue.serverTimestamp(),

            expiresAt,

            expires_at:
              expiresAt,

            telegramSent:
              false,

            telegramSentAt:
              null,

            updatedAt:
              FieldValue.serverTimestamp(),
          }
        );

        transaction.create(
          dailyRef,
          {
            date:
              kampala.date,

            signalCode:
              code,

            rewardUgx:
              SIGNAL_REWARD_UGX,

            timezone:
              SIGNAL_TIMEZONE,

            scheduledTime:
              SIGNAL_TIME,

            createdAt:
              FieldValue.serverTimestamp(),
          }
        );

        created = true;
      }
    );
  } catch (error) {
    if (
      error.message ===
      "A daily signal has already been created."
    ) {
      const retry =
        await dailyRef.get();

      if (
        retry.exists &&
        retry.data()?.signalCode
      ) {
        const existingCode =
          retry.data().signalCode;

        const existing =
          await firestore
            .collection(SIGNAL_COLLECTION)
            .doc(existingCode)
            .get();

        if (existing.exists) {
          return {
            success: true,
            alreadyExists: true,
            signal: {
              code: existingCode,
              ...existing.data(),
            },
          };
        }
      }
    }

    throw error;
  }

  if (!created) {
    throw new Error(
      "Daily signal was not created."
    );
  }

  const telegramSent =
    await sendTelegramSignal(
      code,
      now
    );

  await signalRef.set(
    {
      telegramSent,
      telegramSentAt:
        telegramSent
          ? FieldValue.serverTimestamp()
          : null,
      telegramDeliveryStatus:
        telegramSent
          ? "SENT"
          : "FAILED",
      updatedAt:
        FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log("");
  console.log(
    "============================================================"
  );
  console.log(
    "🎟️ SAINT CRYPTO DAILY SIGNAL"
  );
  console.log(
    "============================================================"
  );
  console.log(
    `📅 Date: ${kampala.date}`
  );
  console.log(
    `🕘 Time: ${SIGNAL_TIME} EAT`
  );
  console.log(
    `🔑 Code: ${code}`
  );
  console.log(
    `💰 Reward: UGX ${SIGNAL_REWARD_UGX.toLocaleString()}`
  );
  console.log(
    `⏳ Processing: ${SIGNAL_PROCESSING_MINUTES} minutes`
  );
  console.log(
    `📱 Telegram: ${telegramSent ? "SENT" : "FAILED"}`
  );
  console.log(
    "============================================================"
  );

  return {
    success: true,
    alreadyExists: false,
    telegramSent,
    signal: {
      code,
      rewardUgx:
        SIGNAL_REWARD_UGX,
      currency: "UGX",
      symbol:
        SIGNAL_SYMBOL,
      session,
      status:
        "PROFIT_VERIFIED",
      active: true,
      processingMinutes:
        SIGNAL_PROCESSING_MINUTES,
      expiryMinutes:
        SIGNAL_EXPIRY_MINUTES,
      createdAt:
        now.toISOString(),
    },
  };
}

/* ============================================================
   READ SIGNALS
   ============================================================ */

async function getActiveSignal() {
  requireFirestore();

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

  const now =
    Date.now();

  const active =
    snapshot.docs
      .map((doc) => ({
        code: doc.id,
        ...doc.data(),
      }))
      .filter((signal) => {
        const expiry =
          toMillis(
            signal.expiresAt ||
              signal.expires_at
          );

        return (
          !expiry ||
          expiry > now
        );
      })
      .sort(
        (a, b) =>
          toMillis(
            b.createdAt
          ) -
          toMillis(
            a.createdAt
          )
      );

  return {
    success: true,
    signal:
      active[0] || null,
    rewardUgx:
      SIGNAL_REWARD_UGX,
    currency:
      "UGX",
  };
}

async function getSignal(code) {
  requireFirestore();

  const clean =
    normalizeSignalCode(code);

  const snapshot =
    await firestore
      .collection(SIGNAL_COLLECTION)
      .doc(clean)
      .get();

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
   REDEEM
   ============================================================ */

async function redeemSignal(
  userId,
  body = {}
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  const code =
    normalizeSignalCode(
      body.code ??
        body.signalCode ??
        body.signal_code
    );

  const signalRef =
    firestore
      .collection(SIGNAL_COLLECTION)
      .doc(code);

  const userRef =
    firestore
      .collection(USERS_COLLECTION)
      .doc(uid);

  const redemptionId =
    `${uid}_${code}`;

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

      if (redemptionDoc.exists) {
        const existing =
          redemptionDoc.data() || {};

        result = {
          success: true,
          alreadyRedeemed: true,
          redemptionId,
          signalCode: code,
          status:
            existing.status ||
            "PROCESSING",
          rewardUgx:
            existing.rewardUgx ??
            SIGNAL_REWARD_UGX,
          currency: "UGX",
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

      const expiry =
        toMillis(
          signal.expiresAt ||
            signal.expires_at
        );

      if (
        expiry &&
        expiry <= Date.now()
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

      const creditAt =
        timestampAfterMinutes(
          SIGNAL_PROCESSING_MINUTES
        );

      transaction.create(
        redemptionRef,
        {
          redemptionId,

          userId:
            uid,

          signalCode:
            code,

          code,

          rewardUgx:
            SIGNAL_REWARD_UGX,

          currency:
            "UGX",

          lockedTradingCapitalUgx:
            lockedCapital,

          status:
            "PROCESSING",

          creditedToLedger:
            false,

          creditAt,

          processingMinutes:
            SIGNAL_PROCESSING_MINUTES,

          processingStartedAt:
            FieldValue.serverTimestamp(),

          createdAt:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp(),
        }
      );

      result = {
        success: true,
        alreadyRedeemed: false,
        redemptionId,
        signalCode: code,
        status:
          "PROCESSING",
        rewardUgx:
          SIGNAL_REWARD_UGX,
        currency:
          "UGX",
        processingMinutes:
          SIGNAL_PROCESSING_MINUTES,
        creditAt,
      };
    }
  );

  return result;
}

/* ============================================================
   PAYOUT PROCESSOR
   ============================================================ */

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
    redemption.status ===
      "CREDITED" &&
    redemption.creditedToLedger ===
      true
  ) {
    return {
      success: true,
      alreadyCredited: true,
      redemptionId,
      status:
        "CREDITED",
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
      `Redemption cannot be processed from status ${redemption.status || "UNKNOWN"}.`
    );
  }

  const creditAt =
    toMillis(
      redemption.creditAt
    );

  if (
    creditAt &&
    creditAt > Date.now()
  ) {
    return {
      success: true,
      ready: false,
      redemptionId,
      status:
        "PROCESSING",
      creditAt:
        redemption.creditAt,
    };
  }

  const amountUgx =
    Math.round(
      Number(
        redemption.rewardUgx ??
          SIGNAL_REWARD_UGX
      ) || SIGNAL_REWARD_UGX
    );

  const result =
    await ledger.creditSignalPayoutToLedger(
      {
        redemptionId,
        userId:
          redemption.userId,
        amountUgx,
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

  await ref.set(
    {
      status:
        "CREDITED",
      creditedToLedger:
        true,
      creditedAmountUgx:
        amountUgx,
      creditedAt:
        FieldValue.serverTimestamp(),
      updatedAt:
        FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: true,
    ready: true,
    alreadyCredited:
      Boolean(
        result?.alreadyCredited
      ),
    redemptionId,
    userId:
      redemption.userId,
    status:
      "CREDITED",
    amountUgx,
  };
}

async function processDueSignalRedemptions(
  limit = 100
) {
  requireFirestore();

  const count =
    Math.min(
      Math.max(
        Number.parseInt(
          limit,
          10
        ) || 100,
        1
      ),
      250
    );

  const now =
    Timestamp.now();

  /*
   * IMPORTANT:
   * Query only by creditAt so this lookup uses a single-field
   * Firestore index. Do not combine status + creditAt here because
   * that requires a composite index.
   *
   * We filter the redemption status in memory before processing.
   * processSignalRedemption() performs the final status/idempotency
   * checks inside Firestore, so duplicate processing remains safe.
   */
  const snapshot =
    await firestore
      .collection(
        REDEMPTION_COLLECTION
      )
      .where(
        "creditAt",
        "<=",
        now
      )
      .limit(count)
      .get();

  const dueDocs =
    snapshot.docs.filter((doc) => {
      const data =
        doc.data() || {};

      return (
        String(data.status || "").toUpperCase() ===
        "PROCESSING"
      );
    });

  const results = [];

  for (const doc of dueDocs) {
    try {
      results.push(
        await processSignalRedemption(
          doc.id
        )
      );
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

  const run =
    async () => {
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
    intervalMs:
      interval,
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

  payoutProcessorTimer = null;

  return {
    success: true,
    stopped: true,
  };
}

/* ============================================================
   REDEMPTION READS
   ============================================================ */

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

  const snapshot =
    await firestore
      .collection(
        REDEMPTION_COLLECTION
      )
      .doc(redemptionId)
      .get();

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

async function getRedemptionHistory(
  userId,
  limit = 50
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  const count =
    Math.min(
      Math.max(
        Number.parseInt(
          limit,
          10
        ) || 50,
        1
      ),
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
    (a, b) =>
      toMillis(
        b.createdAt
      ) -
      toMillis(
        a.createdAt
      )
  );

  return {
    success: true,
    redemptions:
      records,
  };
}

async function getStatus() {
  return {
    success: true,
    currency:
      "UGX",
    rewardUgx:
      SIGNAL_REWARD_UGX,
    processingMinutes:
      SIGNAL_PROCESSING_MINUTES,
    expiryMinutes:
      SIGNAL_EXPIRY_MINUTES,
    signalTime:
      SIGNAL_TIME,
    timezone:
      SIGNAL_TIMEZONE,
    weekdaysOnly:
      true,
    minimumLockedCapitalUgx:
      MIN_LOCKED_CAPITAL_UGX,
    processorRunning:
      Boolean(
        payoutProcessorTimer
      ),
    telegramConfigured:
      Boolean(
        TELEGRAM_BOT_TOKEN &&
        TELEGRAM_CHAT_ID
      ),
  };
}

/* ============================================================
   EXPORTS
   ============================================================ */

module.exports = {
  SIGNAL_REWARD_UGX,
  SIGNAL_PROCESSING_MINUTES,
  SIGNAL_EXPIRY_MINUTES,
  SIGNAL_TIMEZONE,
  SIGNAL_TIME,
  MIN_LOCKED_CAPITAL_UGX,

  generateSignalCode,
  normalizeSignalCode,

  getKampalaParts,
  isWeekday,

  buildTelegramSignalMessage,
  sendTelegramSignal,

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
