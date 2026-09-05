// ============================================================
// SAINT CRYPTO TRADE ENGINE
// firebase_manager.js
//
// FIREBASE + SIGNAL MANAGER
//
// RESPONSIBILITIES:
// - Initialize/reuse Firebase Admin
// - Firestore connection
// - Realtime Database connection
// - Generate signal codes
// - Create scheduled signals
// - Save signals to Firestore
// - Push signals to Firebase RTDB
// - Maintain live_signal for Flutter Home/Trade
// - Maintain latest_signal for Flutter compatibility
// - Send signal to Telegram
// - Send backend ONLINE alert to Telegram
// - Expire live signals
// - User balance synchronization
// - Account freeze checks
// - Withdrawal freeze checks
//
// DOES NOT:
// - Trade on MT5
// - Connect to MT5
// - Execute trades
// - Generate trading indicators
// - Redeem signal codes
//
// SIGNAL REDEMPTION:
// services/signal.js
//
// MT5 TRADING:
// Manual
// ============================================================

"use strict";

// ============================================================
// 0. DEPENDENCIES
// ============================================================

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
  String(
    process.env.FIREBASE_DATABASE_URL || ""
  ).trim();

const TELEGRAM_BOT_TOKEN =
  String(
    process.env.TELEGRAM_BOT_TOKEN || ""
  ).trim();

const TELEGRAM_CHAT_ID =
  String(
    process.env.TELEGRAM_CHAT_ID || ""
  ).trim();

const SIGNAL_PROFIT =
  Number(
    process.env.SIGNAL_PROFIT || "2.00"
  );

const SIGNAL_EXPIRY_MINUTES =
  Number(
    process.env.SIGNAL_EXPIRY_MINUTES || "20"
  );

const SIGNAL_TIMEZONE =
  String(
    process.env.SIGNAL_TIMEZONE ||
      "Africa/Kampala"
  ).trim();

const SIGNAL_DEFAULT_SYMBOL =
  String(
    process.env.SIGNAL_DEFAULT_SYMBOL ||
      "XAUUSD"
  )
    .trim()
    .toUpperCase();

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
    // --------------------------------------------------------
    // REUSE FIREBASE INITIALIZED BY index.js
    // --------------------------------------------------------

    if (getApps().length > 0) {
      firebaseApp = getApp();

      firestoreDb =
        getFirebaseFirestore(
          firebaseApp
        );

      if (FIREBASE_DATABASE_URL) {
        try {
          realtimeDb =
            getFirebaseDatabase(
              firebaseApp
            );
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

      console.log(
        "🟢 Firestore connected."
      );

      console.log(
        `🟢 RTDB: ${
          realtimeDb
            ? "READY"
            : "UNAVAILABLE"
        }`
      );

      return {
        app: firebaseApp,
        firestore: firestoreDb,
        realtime: realtimeDb,
      };
    }

    // --------------------------------------------------------
    // SAFETY FALLBACK
    // --------------------------------------------------------

    let credential = null;

    const json =
      String(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
          ""
      ).trim();

    if (json) {
      try {
        const serviceAccount =
          JSON.parse(json);

        credential =
          cert(
            serviceAccount
          );

        console.log(
          "✅ Firebase manager using FIREBASE_SERVICE_ACCOUNT_JSON."
        );
      } catch (error) {
        throw new Error(
          `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`
        );
      }
    }

    // --------------------------------------------------------
    // INDIVIDUAL ENVIRONMENT VARIABLES
    // --------------------------------------------------------

    else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      credential =
        cert({
          projectId:
            process.env.FIREBASE_PROJECT_ID,

          clientEmail:
            process.env.FIREBASE_CLIENT_EMAIL,

          privateKey:
            String(
              process.env.FIREBASE_PRIVATE_KEY
            ).replace(
              /\\n/g,
              "\n"
            ),
        });

      console.log(
        "✅ Firebase manager using individual environment variables."
      );
    }

    // --------------------------------------------------------
    // GOOGLE APPLICATION DEFAULT
    // --------------------------------------------------------

    else if (
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    ) {
      credential =
        applicationDefault();

      console.log(
        "✅ Firebase manager using application default credentials."
      );
    }

    // --------------------------------------------------------
    // LOCAL SERVICE ACCOUNT
    // --------------------------------------------------------

    else {
      const fs =
        require("fs");

      const path =
        require("path");

      const serviceAccountPath =
        path.join(
          __dirname,
          "serviceAccountKey.json"
        );

      if (
        fs.existsSync(
          serviceAccountPath
        )
      ) {
        const serviceAccount =
          JSON.parse(
            fs.readFileSync(
              serviceAccountPath,
              "utf8"
            )
          );

        credential =
          cert(
            serviceAccount
          );

        console.log(
          "✅ Firebase manager using serviceAccountKey.json."
        );
      }
    }

    // --------------------------------------------------------
    // NO CREDENTIAL
    // --------------------------------------------------------

    if (!credential) {
      throw new Error(
        "Firebase credentials were not found."
      );
    }

    // --------------------------------------------------------
    // FIREBASE OPTIONS
    // --------------------------------------------------------

    const options = {
      credential,
    };

    if (
      FIREBASE_DATABASE_URL
    ) {
      options.databaseURL =
        FIREBASE_DATABASE_URL;
    }

    // --------------------------------------------------------
    // INITIALIZE
    // --------------------------------------------------------

    firebaseApp =
      initializeApp(
        options
      );

    firestoreDb =
      getFirebaseFirestore(
        firebaseApp
      );

    if (
      FIREBASE_DATABASE_URL
    ) {
      try {
        realtimeDb =
          getFirebaseDatabase(
            firebaseApp
          );
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

    console.log(
      "🟢 Firestore connected."
    );

    console.log(
      `🟢 RTDB: ${
        realtimeDb
          ? "READY"
          : "UNAVAILABLE"
      }`
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
// 4. INITIALIZE IMMEDIATELY
// ============================================================

initializeFirebase();

// ============================================================
// 5. FIRESTORE GETTER
// ============================================================
//
// IMPORTANT:
// The imported Firebase function is named:
//
//     getFirebaseFirestore
//
// The backend-compatible exported function remains:
//
//     getFirestore
//
// This prevents the duplicate identifier error.
// ============================================================

function getFirestoreDb() {
  if (!firestoreDb) {
    initializeFirebase();
  }

  if (!firestoreDb) {
    throw new Error(
      "Firestore is unavailable."
    );
  }

  return firestoreDb;
}

// ============================================================
// 6. RTDB GETTER
// ============================================================

function getRealtimeDatabase() {
  if (
    !realtimeDb &&
    FIREBASE_DATABASE_URL
  ) {
    initializeFirebase();
  }

  return realtimeDb;
}

// ============================================================
// 7. USER ID VALIDATION
// ============================================================

function validateUserId(
  userId
) {
  if (
    !userId ||
    typeof userId !== "string"
  ) {
    return false;
  }

  const clean =
    userId.trim();

  if (!clean) {
    return false;
  }

  return /^[a-zA-Z0-9_-]{3,128}$/.test(
    clean
  );
}

// ============================================================
// 8. SIGNAL CODE NORMALIZATION
// ============================================================

function normalizeSignalCode(
  code
) {
  if (
    !code ||
    typeof code !== "string"
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
// 9. SIGNAL CODE GENERATOR
// ============================================================

function generateSignalCode() {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  let code = "";

  for (
    let i = 0;
    i < 12;
    i++
  ) {
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

// ============================================================
// 10. KAMPALA TIME
// ============================================================

function getKampalaTimeParts() {
  const now =
    new Date();

  const formatter =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          SIGNAL_TIMEZONE,

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",

        hourCycle:
          "h23",
      }
    );

  const parts =
    formatter.formatToParts(
      now
    );

  const values = {};

  for (
    const part of parts
  ) {
    if (
      part.type !==
      "literal"
    ) {
      values[
        part.type
      ] =
        part.value;
    }
  }

  return {
    date:
      `${values.year}-${values.month}-${values.day}`,

    time:
      `${values.hour}:${values.minute}`,

    hour:
      Number(
        values.hour
      ),

    minute:
      Number(
        values.minute
      ),

    second:
      Number(
        values.second
      ),
  };
}

// ============================================================
// 11. SCHEDULED SESSIONS
// ============================================================

const scheduledSessions = {
  "19:00":
    "7:00 PM EAT",

  "21:00":
    "9:00 PM EAT",

  "23:00":
    "11:00 PM EAT",
};

// ============================================================
// 12. TELEGRAM
// ============================================================

async function sendTelegramAlert(
  message
) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.error(
      "❌ Telegram credentials are missing."
    );

    console.error(
      "⚠️ Required: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID."
    );

    return false;
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response =
      await fetch(
        url,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              chat_id:
                TELEGRAM_CHAT_ID,

              text:
                message,

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
        "📱 Telegram message sent successfully."
      );

      return true;
    }

    console.error(
      "❌ Telegram API error:",
      data.description ||
        "Unknown Telegram error"
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

// ============================================================
// 13. BACKEND ONLINE ALERT
// ============================================================

async function sendBackendOnlineAlert() {
  const message =
    "🟢 *SAINT CRYPTO BACKEND IS ONLINE* ✝️⚡";

  const sent =
    await sendTelegramAlert(
      message
    );

  if (sent) {
    console.log(
      "🟢 Backend ONLINE alert sent to Telegram."
    );
  } else {
    console.error(
      "❌ Backend ONLINE alert could not be sent to Telegram."
    );
  }

  return sent;
}

// ============================================================
// 13A. TELEGRAM SIGNAL SEND CLAIM
// ============================================================

async function sendSignalTelegramOnce(signalCode, message) {
  const db = getFirestoreDb();
  const cleanCode = normalizeSignalCode(signalCode);

  if (!cleanCode) {
    return false;
  }

  const ref = db.collection("signals").doc(cleanCode);

  const claimed = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      return false;
    }

    const data = snapshot.data() || {};

    if (data.telegramClaimed === true || data.telegramSent === true) {
      return false;
    }

    transaction.update(ref, {
      telegramClaimed: true,
      telegramClaimedAt: FieldValue.serverTimestamp(),
    });

    return true;
  });

  if (!claimed) {
    return false;
  }

  const sent = await sendTelegramAlert(message);

  if (sent) {
    await ref.set({
      telegramSent: true,
      telegramSentAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } else {
    await ref.set({
      telegramSendFailed: true,
      telegramSendFailedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return sent;
}

// ============================================================
// 14. TELEGRAM SIGNAL MESSAGE
// ============================================================

function buildTelegramMessage(
  code,
  session,
  profit,
  symbol
) {
  return (
    `🎟️ *NEW TRADE SIGNAL RELEASED*\n\n` +

    `🔹 *Session:* \`${session}\`\n` +

    `🔹 *Asset:* \`${symbol}\`\n` +

    `💵 *Verified Profit:* \`+$${profit.toFixed(
      2
    )} USDT\`\n` +

    `🔑 *Claim Code:* \`${code}\`\n\n` +

    `⏰ *Expires in:* ${SIGNAL_EXPIRY_MINUTES} minutes\n\n` +

    `⚡ *Redeem this code in the Saint Crypto app.*`
  );
}

// ============================================================
// 15. CREATE AND RELEASE SIGNAL
// ============================================================

async function createAndReleaseSignal(
  sessionLabel = "MANUAL"
) {
  const db =
    getFirestoreDb();

  const rtdb =
    getRealtimeDatabase();

  const profit =
    Number(
      SIGNAL_PROFIT
    );

  if (
    !Number.isFinite(
      profit
    ) ||
    profit <= 0
  ) {
    throw new Error(
      "SIGNAL_PROFIT must be greater than zero."
    );
  }

  const expiryMinutes =
    Number(
      SIGNAL_EXPIRY_MINUTES
    );

  if (
    !Number.isFinite(
      expiryMinutes
    ) ||
    expiryMinutes <= 0
  ) {
    throw new Error(
      "SIGNAL_EXPIRY_MINUTES must be greater than zero."
    );
  }

  let code = "";

  for (
    let attempt = 0;
    attempt < 20;
    attempt++
  ) {
    const candidate =
      generateSignalCode();

    const existing =
      await db
        .collection(
          "signals"
        )
        .doc(
          candidate
        )
        .get();

    if (
      !existing.exists
    ) {
      code =
        candidate;

      break;
    }
  }

  if (!code) {
    throw new Error(
      "Unable to generate a unique signal code."
    );
  }

  const now =
    new Date();

  const expiresAt =
    new Date(
      now.getTime() +
        expiryMinutes *
          60 *
          1000
    );

  const createdTimestamp =
    Timestamp.fromDate(
      now
    );

  const expiresTimestamp =
    Timestamp.fromDate(
      expiresAt
    );

  const signalData = {
    code,

    profit,

    symbol:
      SIGNAL_DEFAULT_SYMBOL,

    session:
      sessionLabel,

    status:
      "PROFIT_VERIFIED",

    active:
      true,

    isRedeemed:
      false,

    created_at:
      createdTimestamp,

    expires_at:
      expiresTimestamp,

    createdAt:
      createdTimestamp,

    expiresAt:
      expiresTimestamp,
  };

  console.log("");

  console.log(
    "============================================================"
  );

  console.log(
    "🎟️ SAINT CRYPTO SIGNAL RELEASE"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `⏰ Session: ${sessionLabel}`
  );

  console.log(
    `🎟️ Code: ${code}`
  );

  console.log(
    `💰 Profit: $${profit.toFixed(
      2
    )} USDT`
  );

  console.log(
    `📊 Symbol: ${SIGNAL_DEFAULT_SYMBOL}`
  );

  console.log(
    `⏳ Expires: ${expiresAt.toISOString()}`
  );

  console.log(
    "============================================================"
  );

  await db
    .collection(
      "signals"
    )
    .doc(
      code
    )
    .set(
      signalData
    );

  console.log(
    `✅ Signal ${code} saved to Firestore.`
  );

  let liveSignalWritten =
    false;

  if (rtdb) {
    const liveSignal = {
      code,

      profit,

      symbol:
        SIGNAL_DEFAULT_SYMBOL,

      session:
        sessionLabel,

      status:
        "PROFIT_VERIFIED",

      active:
        true,

      created_at:
        now.toISOString(),

      expires_at:
        expiresAt.toISOString(),

      timestamp:
        Date.now(),
    };

    try {
      await rtdb
        .ref(
          `signals/${code}`
        )
        .set(
          liveSignal
        );

      await rtdb
        .ref(
          "live_signal"
        )
        .set(
          liveSignal
        );

      await rtdb
        .ref(
          "latest_signal"
        )
        .set(
          liveSignal
        );

      liveSignalWritten =
        true;

      console.log(
        `🟢 Signal ${code} pushed live to Firebase RTDB.`
      );
    } catch (error) {
      console.error(
        "❌ RTDB signal write failed:",
        error.message
      );
    }
  } else {
    console.error(
      "❌ RTDB unavailable."
    );
  }

  const telegramMessage =
    buildTelegramMessage(
      code,
      sessionLabel,
      profit,
      SIGNAL_DEFAULT_SYMBOL
    );

  const telegramSent =
    await sendSignalTelegramOnce(
      code,
      telegramMessage
    );

  console.log(
    `📱 Telegram delivery: ${
      telegramSent
        ? "SUCCESS"
        : "FAILED"
    }`
  );

  return {
    success:
      true,

    code,

    profit,

    symbol:
      SIGNAL_DEFAULT_SYMBOL,

    session:
      sessionLabel,

    createdAt:
      now.toISOString(),

    expiresAt:
      expiresAt.toISOString(),

    telegramSent,

    live:
      liveSignalWritten,
  };
}

// ============================================================
// 16. EXPIRE SIGNAL
// ============================================================

async function expireSignal(
  signalCode
) {
  const cleanCode =
    normalizeSignalCode(
      signalCode
    );

  if (!cleanCode) {
    return false;
  }

  const db =
    getFirestoreDb();

  const rtdb =
    getRealtimeDatabase();

  const signalRef =
    db
      .collection(
        "signals"
      )
      .doc(
        cleanCode
      );

  const snapshot =
    await signalRef.get();

  if (
    !snapshot.exists
  ) {
    return false;
  }

  const currentData = snapshot.data() || {};

  if (
    currentData.active === false ||
    String(currentData.status || "").toUpperCase() === "EXPIRED"
  ) {
    return false;
  }

  await signalRef.set(
    {
      active:
        false,

      status:
        "EXPIRED",

      expired_at:
        FieldValue.serverTimestamp(),

      updated_at:
        FieldValue.serverTimestamp(),
    },
    {
      merge:
        true,
    }
  );

  if (rtdb) {
    try {
      await rtdb
        .ref(
          `signals/${cleanCode}`
        )
        .update({
          active:
            false,

          status:
            "EXPIRED",

          expired_at:
            new Date().toISOString(),

          updated_at:
            Date.now(),
        });

      const liveSnapshot =
        await rtdb
          .ref(
            "live_signal"
          )
          .once(
            "value"
          );

      const liveData =
        liveSnapshot.val();

      if (
        liveData &&
        normalizeSignalCode(
          liveData.code
        ) ===
          cleanCode
      ) {
        await rtdb
          .ref(
            "live_signal"
          )
          .update({
            active:
              false,

            status:
              "EXPIRED",

            expired_at:
              new Date().toISOString(),

            timestamp:
              Date.now(),
          });
      }

      const latestSnapshot =
        await rtdb
          .ref(
            "latest_signal"
          )
          .once(
            "value"
          );

      const latestData =
        latestSnapshot.val();

      if (
        latestData &&
        normalizeSignalCode(
          latestData.code
        ) ===
          cleanCode
      ) {
        await rtdb
          .ref(
            "latest_signal"
          )
          .update({
            active:
              false,

            status:
              "EXPIRED",

            expired_at:
              new Date().toISOString(),

            timestamp:
              Date.now(),
          });
      }
    } catch (error) {
      console.error(
        `⚠️ RTDB expiry update failed for ${cleanCode}:`,
        error.message
      );
    }
  }

  console.log(
    `⏳ Signal ${cleanCode} expired.`
  );

  return true;
}

// ============================================================
// 17. CHECK LIVE SIGNAL EXPIRY
// ============================================================

async function checkLiveSignalExpiry() {
  const rtdb =
    getRealtimeDatabase();

  if (!rtdb) {
    return;
  }

  try {
    const snapshot =
      await rtdb
        .ref(
          "live_signal"
        )
        .once(
          "value"
        );

    const signal =
      snapshot.val();

    if (
      !signal ||
      !signal.code ||
      !signal.expires_at
    ) {
      return;
    }

    const expiry =
      new Date(
        signal.expires_at
      );

    if (
      Number.isNaN(
        expiry.getTime()
      )
    ) {
      return;
    }

    if (
      Date.now() >=
      expiry.getTime()
    ) {
      await expireSignal(
        signal.code
      );
    }
  } catch (error) {
    console.error(
      "⚠️ Live signal expiry check failed:",
      error.message
    );
  }
}

// ============================================================
// 18. SCHEDULER STATE
// ============================================================

let lastTriggeredSession =
  "";

let schedulerStarted =
  false;

let schedulerInterval =
  null;

// ============================================================
// 18A. DISTRIBUTED SCHEDULER LOCK
// ============================================================

function schedulerLockId(sessionKey) {
  return String(sessionKey).replace(/[^A-Z0-9_-]/gi, "_");
}

async function claimScheduledSession(sessionKey, sessionLabel) {
  const db = getFirestoreDb();
  const ref = db.collection("signal_scheduler_locks").doc(schedulerLockId(sessionKey));

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);

    if (snapshot.exists) {
      const data = snapshot.data() || {};
      const status = String(data.status || "").toUpperCase();

      if (status !== "FAILED") {
        return false;
      }
    }

    transaction.set(ref, {
      sessionKey,
      sessionLabel,
      status: "CLAIMED",
      claimedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return true;
  });
}

async function completeScheduledSession(sessionKey, signalCode) {
  const db = getFirestoreDb();
  await db.collection("signal_scheduler_locks").doc(schedulerLockId(sessionKey)).set({
    status: "COMPLETED",
    signalCode,
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function failScheduledSession(sessionKey, error) {
  const db = getFirestoreDb();
  await db.collection("signal_scheduler_locks").doc(schedulerLockId(sessionKey)).set({
    status: "FAILED",
    error: String(error?.message || error || "Unknown error").substring(0, 1000),
    failedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ============================================================
// 19. SCHEDULER CHECK
// ============================================================

async function checkAndTriggerScheduledSignals() {
  await checkLiveSignalExpiry();

  const time =
    getKampalaTimeParts();

  const sessionLabel =
    scheduledSessions[
      time.time
    ];

  if (!sessionLabel) {
    return;
  }

  const sessionKey =
    `${time.date}_${time.time}`;

  if (
    lastTriggeredSession ===
    sessionKey
  ) {
    return;
  }

  const claimed = await claimScheduledSession(
    sessionKey,
    sessionLabel
  );

  if (!claimed) {
    lastTriggeredSession = sessionKey;
    return;
  }

  lastTriggeredSession =
    sessionKey;

  console.log(
    `⏰ Scheduler triggered: ${sessionLabel}`
  );

  try {
    const result =
      await createAndReleaseSignal(
        sessionLabel
      );

    await completeScheduledSession(
      sessionKey,
      result.code
    );

    console.log(
      `✅ Scheduled signal ${result.code} released.`
    );
  } catch (error) {
    console.error(
      "❌ Scheduled signal creation failed:",
      error.message
    );

    await failScheduledSession(
      sessionKey,
      error
    ).catch((lockError) => {
      console.error(
        "❌ Failed to update scheduler lock:",
        lockError.message
      );
    });

    lastTriggeredSession =
      "";
  }
}

// ============================================================
// 20. START SIGNAL SCHEDULER
// ============================================================

function startSignalScheduler() {
  if (
    schedulerStarted
  ) {
    console.log(
      "⚠️ Signal scheduler already running."
    );

    return;
  }

  schedulerStarted =
    true;

  console.log("");

  console.log(
    "============================================================"
  );

  console.log(
    "⏰ SAINT CRYPTO SIGNAL SCHEDULER"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `📍 Timezone: ${SIGNAL_TIMEZONE}`
  );

  console.log(
    "🕖 Sessions: 19:00 / 21:00 / 23:00 EAT"
  );

  console.log(
    `💰 Signal profit: $${SIGNAL_PROFIT.toFixed(
      2
    )} USDT`
  );

  console.log(
    `⏳ Signal expiry: ${SIGNAL_EXPIRY_MINUTES} minutes`
  );

  console.log(
    `📊 Symbol: ${SIGNAL_DEFAULT_SYMBOL}`
  );

  console.log(
    `📱 Telegram: ${
      TELEGRAM_BOT_TOKEN &&
      TELEGRAM_CHAT_ID
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    }`
  );

  console.log(
    `🟢 RTDB: ${
      realtimeDb
        ? "READY"
        : "UNAVAILABLE"
    }`
  );

  console.log(
    "============================================================"
  );

  checkAndTriggerScheduledSignals()
    .catch(
      (error) => {
        console.error(
          "❌ Initial scheduler check failed:",
          error.message
        );
      }
    );

  schedulerInterval =
    setInterval(
      () => {
        checkAndTriggerScheduledSignals()
          .catch(
            (error) => {
              console.error(
                "❌ Scheduler loop error:",
                error.message
              );
            }
          );
      },
      5000
    );

  console.log(
    "✅ Signal scheduler is RUNNING."
  );
}

// ============================================================
// 21. STOP SIGNAL SCHEDULER
// ============================================================

function stopSignalScheduler() {
  if (
    schedulerInterval
  ) {
    clearInterval(
      schedulerInterval
    );

    schedulerInterval =
      null;
  }

  schedulerStarted =
    false;

  console.log(
    "🛑 Signal scheduler stopped."
  );
}

// ============================================================
// 22. MANUAL SIGNAL
// ============================================================

async function generateSignalNow(
  sessionLabel = "MANUAL"
) {
  return createAndReleaseSignal(
    sessionLabel
  );
}

// ============================================================
// 23. GET USER BALANCE
// ============================================================

async function getUserBalance(
  userId
) {
  if (
    !validateUserId(
      userId
    )
  ) {
    throw new Error(
      "Invalid user ID."
    );
  }

  const db =
    getFirestoreDb();

  const snapshot =
    await db
      .collection(
        "users"
      )
      .doc(
        userId
      )
      .get();

  if (
    !snapshot.exists
  ) {
    throw new Error(
      "User record not found."
    );
  }

  const data =
    snapshot.data() ||
    {};

  return Number(
    data.usdt_balance ||
      0
  );
}

// ============================================================
// 24. SYNC USER BALANCE TO RTDB
// ============================================================

async function syncUserBalanceToRTDB(
  userId,
  balance
) {
  if (
    !validateUserId(
      userId
    )
  ) {
    return false;
  }

  const rtdb =
    getRealtimeDatabase();

  if (!rtdb) {
    return false;
  }

  const numericBalance =
    Number(
      balance
    );

  if (
    !Number.isFinite(
      numericBalance
    )
  ) {
    return false;
  }

  try {
    await rtdb
      .ref(
        `users/${userId}`
      )
      .update({
        usdt_balance:
          Number(
            numericBalance.toFixed(
              4
            )
          ),

        last_updated:
          Date.now(),
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
// 25. ACCOUNT FREEZE CHECK
// ============================================================

async function isAccountFrozen(
  userId
) {
  if (
    !validateUserId(
      userId
    )
  ) {
    return true;
  }

  try {
    const rtdb =
      getRealtimeDatabase();

    if (rtdb) {
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
    }

    const db =
      getFirestoreDb();

    const userSnapshot =
      await db
        .collection(
          "users"
        )
        .doc(
          userId
        )
        .get();

    if (
      !userSnapshot.exists
    ) {
      return false;
    }

    const userData =
      userSnapshot.data() ||
      {};

    const status =
      String(
        userData.status ||
          ""
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
        status
      )
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

    return true;
  }
}

// ============================================================
// 26. WITHDRAWAL FREEZE
// ============================================================

async function areWithdrawalsFrozen() {
  const rtdb =
    getRealtimeDatabase();

  if (!rtdb) {
    return false;
  }

  try {
    const snapshot =
      await rtdb
        .ref(
          "system_control/withdrawals_frozen"
        )
        .once(
          "value"
        );

    return (
      snapshot.val() ===
      true
    );
  } catch (error) {
    console.error(
      "⚠️ Withdrawal freeze check failed:",
      error.message
    );

    return true;
  }
}

// ============================================================
// 27. MANAGER STATUS
// ============================================================

function getManagerStatus() {
  return {
    firebase:
      !!firebaseApp,

    firestore:
      !!firestoreDb,

    realtimeDatabase:
      !!realtimeDb,

    scheduler:
      schedulerStarted,

    telegram:
      !!(
        TELEGRAM_BOT_TOKEN &&
        TELEGRAM_CHAT_ID
      ),

    timezone:
      SIGNAL_TIMEZONE,

    signalProfit:
      SIGNAL_PROFIT,

    signalExpiryMinutes:
      SIGNAL_EXPIRY_MINUTES,

    symbol:
      SIGNAL_DEFAULT_SYMBOL,

    sessions:
      scheduledSessions,
  };
}

// ============================================================
// 28. SHUTDOWN
// ============================================================

async function shutdown() {
  stopSignalScheduler();

  console.log(
    "🧹 firebase_manager.js shutdown complete."
  );
}

// ============================================================
// 29. EXPORTS
// ============================================================

module.exports = {
  initializeFirebase,

  // Keep the existing backend API name.
  getFirestore:
    getFirestoreDb,

  getRealtimeDatabase,

  validateUserId,

  normalizeSignalCode,

  generateSignalCode,

  createAndReleaseSignal,

  generateSignalNow,

  expireSignal,

  checkLiveSignalExpiry,

  checkAndTriggerScheduledSignals,

  startSignalScheduler,

  stopSignalScheduler,

  getUserBalance,

  syncUserBalanceToRTDB,

  isAccountFrozen,

  areWithdrawalsFrozen,

  sendTelegramAlert,

  sendSignalTelegramOnce,

  sendBackendOnlineAlert,

  getManagerStatus,

  shutdown,
};

console.log(
  "✅ firebase_manager.js loaded successfully."
);