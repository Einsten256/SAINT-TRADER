// ============================================================
// SAINT CRYPTO TRADE ENGINE
// index.js
// ============================================================
//
// MASTER ENTRY POINT
//
// STRUCTURE:
//
// BACKEND/
// â”œâ”€â”€ index.js
// â”œâ”€â”€ firebase_manager.js
// â””â”€â”€ services/
//     â”œâ”€â”€ kendrick.js
//     â”œâ”€â”€ config.js
//     â”œâ”€â”€ bybit.js
//     â”œâ”€â”€ ledger.js
//     â”œâ”€â”€ deposit.js
//     â”œâ”€â”€ signal.js
//     â”œâ”€â”€ withdrawal.js
//     â””â”€â”€ routes/
//         â”œâ”€â”€ auth.js
//         â”œâ”€â”€ deposits.js
//         â”œâ”€â”€ kendrick.js
//         â”œâ”€â”€ signal.js
//         â””â”€â”€ withdrawal.js
//
// ============================================================
// FINAL AUDIT NOTE:
// Business Manager recharge mutations now pass the canonical
// deposit-service arguments (adminId, reason) instead of objects
// that the service would otherwise store incorrectly.
// ============================================================

"use strict";

require("dotenv").config();

// ============================================================
// 1. CORE MODULES
// ============================================================

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

// ============================================================
// 2. OPTIONAL RATE LIMITER
// ============================================================

let rateLimit = null;

try {
  rateLimit = require("express-rate-limit");

  console.log(
    "âœ… express-rate-limit loaded."
  );
} catch (error) {
  console.warn(
    "âš ï¸ express-rate-limit is not installed. Rate limiting disabled."
  );
}

// ============================================================
// 3. FIREBASE ADMIN
// ============================================================

const {
  initializeApp,
  getApps,
  getApp,
  cert,
  applicationDefault,
} = require("firebase-admin/app");

const {
  getFirestore,
} = require("firebase-admin/firestore");

const {
  getAuth,
} = require("firebase-admin/auth");

const {
  getDatabase,
} = require("firebase-admin/database");

// ============================================================
// 4. CONFIGURATION
// ============================================================

const PORT = Number(
  process.env.PORT || 3000
);

const HOST =
  process.env.HOST ||
  "0.0.0.0";

const NODE_ENV =
  process.env.NODE_ENV ||
  "development";

const SERVICE_NAME =
  process.env.SERVICE_NAME ||
  "Saint Crypto Trade Engine";

const API_PREFIX =
  String(
    process.env.API_PREFIX ||
      "/api"
  ).replace(
    /\/$/,
    ""
  );

const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://kendrick-alph-mobile-default-rtdb.firebaseio.com/";

const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(
    __dirname,
    "serviceAccountKey.json"
  );

// ============================================================
function saintAdminSerialize(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(saintAdminSerialize);
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = saintAdminSerialize(item);
    }
    return out;
  }

  return value;
}

function saintAdminNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
// 5. FIREBASE STATE
// ============================================================

let firebaseApp = null;
let firestore = null;
let auth = null;
let realtimeDb = null;
let firebaseReady = false;

// ============================================================
// 6. FIREBASE CREDENTIAL LOADER
// ============================================================

function loadFirebaseCredential() {

  // ----------------------------------------------------------
  // OPTION 1
  // FIREBASE_SERVICE_ACCOUNT_JSON
  // ----------------------------------------------------------

  const json =
    String(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
        ""
    ).trim();

  if (json) {

    try {

      const serviceAccount =
        JSON.parse(
          json
        );

      if (
        !serviceAccount.project_id &&
        !serviceAccount.projectId
      ) {

        throw new Error(
          "Firebase service account JSON is missing project_id."
        );
      }

      return cert(
        serviceAccount
      );

    } catch (error) {

      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`
      );
    }
  }

  // ----------------------------------------------------------
  // OPTION 2
  // INDIVIDUAL ENVIRONMENT VARIABLES
  // ----------------------------------------------------------

  const projectId =
    String(
      process.env.FIREBASE_PROJECT_ID ||
        ""
    ).trim();

  const clientEmail =
    String(
      process.env.FIREBASE_CLIENT_EMAIL ||
        ""
    ).trim();

  let privateKey =
    String(
      process.env.FIREBASE_PRIVATE_KEY ||
        ""
    );

  if (
    projectId &&
    clientEmail &&
    privateKey
  ) {

    privateKey =
      privateKey
        .replace(
          /\\n/g,
          "\n"
        )
        .trim();

    return cert({
      projectId,
      clientEmail,
      privateKey,
    });
  }

  // ----------------------------------------------------------
  // OPTION 3
  // GOOGLE APPLICATION CREDENTIALS
  // ----------------------------------------------------------

  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  ) {

    return applicationDefault();
  }

  // ----------------------------------------------------------
  // OPTION 4
  // LOCAL SERVICE ACCOUNT FILE
  // ----------------------------------------------------------

  if (
    fs.existsSync(
      SERVICE_ACCOUNT_PATH
    )
  ) {

    try {

      const serviceAccount =
        JSON.parse(
          fs.readFileSync(
            SERVICE_ACCOUNT_PATH,
            "utf8"
          )
        );

      return cert(
        serviceAccount
      );

    } catch (error) {

      throw new Error(
        `Could not load Firebase service account file: ${error.message}`
      );
    }
  }

  // ----------------------------------------------------------
  // NOTHING FOUND
  // ----------------------------------------------------------

  throw new Error(
    "Firebase credentials were not found. Set FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS, or provide serviceAccountKey.json."
  );
}

// ============================================================
// 7. FIREBASE INITIALIZATION
// ============================================================

function initializeFirebase() {

  try {

    // --------------------------------------------------------
    // CHECK FIREBASE ADMIN
    // --------------------------------------------------------

    if (
      typeof initializeApp !==
      "function"
    ) {

      throw new Error(
        "firebase-admin is installed incorrectly or is incompatible."
      );
    }

    // --------------------------------------------------------
    // REUSE EXISTING FIREBASE APP
    // --------------------------------------------------------

    if (
      getApps().length > 0
    ) {

      firebaseApp =
        getApp();

      firestore =
        getFirestore(
          firebaseApp
        );

      auth =
        getAuth(
          firebaseApp
        );

      try {

        if (
          FIREBASE_DATABASE_URL
        ) {

          realtimeDb =
            getDatabase(
              firebaseApp
            );
        }

      } catch (error) {

        console.warn(
          "âš ï¸ Firebase RTDB unavailable:",
          error.message
        );

        realtimeDb =
          null;
      }

      firebaseReady =
        true;

      console.log(
        "ðŸ”¥ Reusing existing Firebase Admin app."
      );

      console.log(
        "ðŸŸ¢ Firestore: READY"
      );

      console.log(
        `ðŸŸ¢ RTDB: ${
          realtimeDb
            ? "READY"
            : "UNAVAILABLE"
        }`
      );

      return;
    }

    // --------------------------------------------------------
    // LOAD CREDENTIAL
    // --------------------------------------------------------

    const credential =
      loadFirebaseCredential();

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

    // --------------------------------------------------------
    // FIRESTORE
    // --------------------------------------------------------

    firestore =
      getFirestore(
        firebaseApp
      );

    // --------------------------------------------------------
    // AUTH
    // --------------------------------------------------------

    auth =
      getAuth(
        firebaseApp
      );

    // --------------------------------------------------------
    // RTDB
    // --------------------------------------------------------

    try {

      if (
        FIREBASE_DATABASE_URL
      ) {

        realtimeDb =
          getDatabase(
            firebaseApp
          );
      }

    } catch (error) {

      console.warn(
        "âš ï¸ Firebase RTDB unavailable:",
        error.message
      );

      realtimeDb =
        null;
    }

    // --------------------------------------------------------
    // READY
    // --------------------------------------------------------

    firebaseReady =
      true;

    console.log(
      "============================================================"
    );

    console.log(
      "ðŸ”¥ FIREBASE INITIALIZATION"
    );

    console.log(
      "============================================================"
    );

    console.log(
      "âœ… Firebase Admin initialized successfully."
    );

    console.log(
      "ðŸŸ¢ Firestore: READY"
    );

    console.log(
      `ðŸŸ¢ RTDB: ${
        realtimeDb
          ? "READY"
          : "UNAVAILABLE"
      }`
    );

    console.log(
      "============================================================"
    );

  } catch (error) {

    console.error(
      "============================================================"
    );

    console.error(
      "âŒ FIREBASE INITIALIZATION FAILED"
    );

    console.error(
      "============================================================"
    );

    console.error(
      error.stack ||
        error.message
    );

    throw error;
  }
}

// ============================================================
// 8. INITIALIZE FIREBASE
// ============================================================

try {

  initializeFirebase();

} catch (error) {

  process.exit(1);
}

// ============================================================
// 9. EXPRESS APPLICATION
// ============================================================

const app =
  express();

app.disable(
  "x-powered-by"
);

app.set(
  "trust proxy",
  1
);

// ============================================================
// 10. BODY PARSING
// ============================================================

app.use(
  express.json({
    limit: "2mb",
  })
);


const TELEGRAM_WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "";

app.post("/api/telegram/webhook", async (req, res) => {
  console.log("[telegram webhook] REQUEST RECEIVED", { updateId: req.body?.update_id, hasCallback: Boolean(req.body?.callback_query), callbackData: req.body?.callback_query?.data });
  try {
    if (
      TELEGRAM_WEBHOOK_SECRET &&
      req.get("X-Telegram-Bot-Api-Secret-Token") !==
        TELEGRAM_WEBHOOK_SECRET
    ) {
      return res.sendStatus(403);
    }

    const bot =
      typeof telegramRecharge?.getBot === "function"
        ? telegramRecharge.getBot()
        : null;

    if (!bot || typeof bot.handleUpdate !== "function") {
      console.error(
        "[telegram webhook] Bot is not ready."
      );
      return res.sendStatus(503);
    }

    await bot.handleUpdate(req.body);

    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "[telegram webhook] Update handling failed:",
      error?.stack || error
    );
    return res.sendStatus(500);
  }
});
app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb",
  })
);

// ============================================================
// 11. CORS
// ============================================================
//
// IMPORTANT:
//
// Flutter Web can run on changing localhost ports:
//
// http://localhost:50000
// http://localhost:52357
// http://localhost:53265
// etc.
//
// We therefore DO NOT hard-code a localhost port.
//
// This configuration reflects the requesting Origin.
//
// That means Flutter Web can communicate with the backend
// without failing because Flutter changed its development port.
//
// Also supports Firebase Hosting.
//
// ============================================================

// ------------------------------------------------------------
// KNOWN PRODUCTION ORIGINS
// ------------------------------------------------------------

const knownProductionOrigins = [
  "https://kendrick-alph-mobile.web.app",
  "https://kendrick-alph-mobile.firebaseapp.com",
  process.env.FRONTEND_URL,
]
  .filter(
    (value) =>
      value &&
      String(value).trim().length > 0
  )
  .map(
    (value) =>
      String(value)
        .trim()
        .replace(
          /\/$/,
          ""
        )
  );

// ------------------------------------------------------------
// NORMALIZE ORIGIN
// ------------------------------------------------------------

function normalizeOrigin(
  origin
) {

  if (!origin) {
    return "";
  }

  return String(
    origin
  )
    .trim()
    .replace(
      /\/$/,
      ""
    );
}

// ------------------------------------------------------------
// CHECK ORIGIN
// ------------------------------------------------------------

function isAllowedOrigin(
  origin
) {

  // Non-browser requests.
  if (!origin) {
    return true;
  }

  const normalized =
    normalizeOrigin(
      origin
    );

  // ----------------------------------------------------------
  // LOCALHOST
  // ----------------------------------------------------------

  if (
    /^http:\/\/localhost(?::\d+)?$/i.test(
      normalized
    )
  ) {

    return true;
  }

  // ----------------------------------------------------------
  // LOOPBACK
  // ----------------------------------------------------------

  if (
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(
      normalized
    )
  ) {

    return true;
  }

  // ----------------------------------------------------------
  // FIREBASE HOSTING
  // ----------------------------------------------------------

  if (
    knownProductionOrigins.includes(
      normalized
    )
  ) {

    return true;
  }

  // ----------------------------------------------------------
  // FIREBASE APP HOSTING / OTHER HTTPS FRONTENDS
  // ----------------------------------------------------------

  if (
    /^https:\/\/[a-z0-9-]+\.web\.app$/i.test(
      normalized
    )
  ) {

    return true;
  }

  if (
    /^https:\/\/[a-z0-9-]+\.firebaseapp\.com$/i.test(
      normalized
    )
  ) {

    return true;
  }

  // ----------------------------------------------------------
  // RENDER / OTHER FRONTEND
  // ----------------------------------------------------------
  //
  // If FRONTEND_URL is configured it was already checked
  // above.
  //
  // ----------------------------------------------------------

  return false;
}

// ============================================================
// 12. CORS OPTIONS
// ============================================================

const corsOptions = {

  // ----------------------------------------------------------
  // DYNAMIC ORIGIN
  // ----------------------------------------------------------
  //
  // Reflect the requesting browser origin instead of relying
  // only on a fixed allow-list. This is compatible with
  // credentials:true and works with both Firebase Hosting
  // domains plus local Flutter Web development.
  //
  origin:
    function (
      origin,
      callback
    ) {

      // ------------------------------------------------------
      // NON-BROWSER REQUESTS
      // ------------------------------------------------------

      if (!origin) {
        return callback(
          null,
          true
        );
      }

      const normalized =
        normalizeOrigin(
          origin
        );

      // ------------------------------------------------------
      // ALLOWED ORIGIN
      // ------------------------------------------------------

      if (
        isAllowedOrigin(
          normalized
        )
      ) {

        return callback(
          null,
          true
        );
      }

      // ------------------------------------------------------
      // EXTRA FIREBASE DOMAINS
      // ------------------------------------------------------
      //
      // Explicitly accept the two Saint Crypto Firebase
      // Hosting domains even if another normalization step
      // is introduced later.
      //

      if (
        normalized ===
          "https://kendrick-alph-mobile.web.app" ||
        normalized ===
          "https://kendrick-alph-mobile.firebaseapp.com"
      ) {

        return callback(
          null,
          true
        );
      }

      // ------------------------------------------------------
      // REJECT
      // ------------------------------------------------------

      console.warn(
        "âš ï¸ CORS blocked origin:",
        origin
      );

      const error =
        new Error(
          "CORS policy restriction: unauthorized origin."
        );

      error.statusCode =
        403;

      return callback(
        error
      );
    },

  // ----------------------------------------------------------
  // CREDENTIALS
  // ----------------------------------------------------------

  credentials:
    true,

  // ----------------------------------------------------------
  // METHODS
  // ----------------------------------------------------------

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "HEAD",
  ],

  // ----------------------------------------------------------
  // HEADERS
  // ----------------------------------------------------------

  allowedHeaders: [
    "Origin",
    "Content-Type",
    "Accept",
    "Authorization",
    "X-Requested-With",
    "X-Firebase-AppCheck",
    "Cache-Control",
    "Pragma",
  ],

  // ----------------------------------------------------------
  // EXPOSED HEADERS
  // ----------------------------------------------------------

  exposedHeaders: [
    "Content-Length",
    "Content-Type",
  ],

  // ----------------------------------------------------------
  // PREFLIGHT
  // ----------------------------------------------------------

  optionsSuccessStatus:
    204,
};

// ============================================================
// 13. APPLY CORS IMMEDIATELY
// ============================================================
//
// MUST BE BEFORE:
//
// - rate limiting
// - authentication
// - routes
//
// ============================================================

app.use(
  cors(
    corsOptions
  )
);

// ============================================================
// 14. EXPLICIT PREFLIGHT
// ============================================================
//
// Express 5 safe regex.
//
// Every browser OPTIONS request receives CORS handling.
//
// ============================================================

app.options(
  /.*/,
  cors(
    corsOptions
  )
);

// ============================================================
// 15. GLOBAL RATE LIMIT
// ============================================================

if (rateLimit) {

  app.use(
    rateLimit({
      windowMs:
        15 * 60 * 1000,

      max:
        300,

      standardHeaders:
        true,

      legacyHeaders:
        false,

      message: {

        success:
          false,

        message:
          "Too many requests, try again later.",
      },
    })
  );
}

// ============================================================
// 16. STRICT RATE LIMIT
// ============================================================

const strictLimiter =
  rateLimit
    ? rateLimit({

        windowMs:
          15 * 60 * 1000,

        max: 20,

        standardHeaders:
          true,

        legacyHeaders:
          false,

        message: {

          success:
            false,

          message:
            "Too many attempts, slow down.",
        },
      })

    : (
        req,
        res,
        next
      ) => {

        next();
      };

// ============================================================
// 17. REQUEST LOGGER
// ============================================================

app.use(
  (
    req,
    res,
    next
  ) => {

    const started =
      Date.now();

    res.on(
      "finish",
      () => {

        console.log(
          `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`
        );
      }
    );

    next();
  }
);

// ============================================================
// 18. FIRESTORE CHECK
// ============================================================

function verifyFirestore(
  req,
  res,
  next
) {

  if (!firestore) {

    return res
      .status(503)
      .json({

        success:
          false,

        code:
          "DATABASE_UNAVAILABLE",

        message:
          "Database service unavailable.",
      });
  }

  next();
}

// ============================================================
// 19. AUTH CONFIGURATION
// ============================================================

const ALLOW_LEGACY_USER_ID = [
  "1",
  "true",
  "yes",
  "on",
].includes(
  String(
    process.env.ALLOW_LEGACY_USER_ID ??
      "true"
  ).toLowerCase()
);

// ============================================================
// 20. RESOLVE UID
// ============================================================

async function resolveUid(
  req
) {

  const authorization =
    req.headers.authorization;

  // ----------------------------------------------------------
  // FIREBASE BEARER TOKEN
  // ----------------------------------------------------------

  if (
    authorization &&
    /^Bearer\s+/i.test(
      authorization
    )
  ) {

    if (!auth) {

      throw new Error(
        "Authentication service unavailable."
      );
    }

    const token =
      authorization
        .replace(
          /^Bearer\s+/i,
          ""
        )
        .trim();

    if (!token) {

      throw new Error(
        "Firebase authentication token is empty."
      );
    }

    const decoded =
      await auth.verifyIdToken(
        token
      );

    if (
      !decoded ||
      !decoded.uid
    ) {

      throw new Error(
        "Firebase authentication token does not contain a valid UID."
      );
    }

    return decoded.uid;
  }

  // ----------------------------------------------------------
  // LEGACY USER ID
  // ----------------------------------------------------------

  if (
    ALLOW_LEGACY_USER_ID
  ) {

    const supplied =
      String(
        req.body?.userId ||
          req.query?.userId ||
          req.params?.userId ||
          ""
      ).trim();

    if (
      supplied
    ) {

      return supplied;
    }
  }

  throw new Error(
    "Unauthorized: Firebase auth token or userId is required."
  );
}

// ============================================================
// 21. AUTH MIDDLEWARE
// ============================================================

async function verifyAuth(
  req,
  res,
  next
) {

  try {

    req.uid =
      await resolveUid(
        req
      );

    return next();

  } catch (error) {

    console.error(
      "âŒ Authentication error:",
      error.message
    );

    return res
      .status(401)
      .json({

        success:
          false,

        code:
          "AUTH_REQUIRED",

        message:
          error.message ||
          "Unauthorized.",
      });
  }
}

// ============================================================
// 22. LOAD SERVICES
// ============================================================

let kendrick = null;
let config = null;
let bybit = null;
let ledger = null;
let deposit = null;
let signal = null;
let withdrawal = null;
let telegramWithdrawal = null;
let telegramRecharge = null;
let withdrawalWallet = null;
let scheduler = null;

try {

  // ----------------------------------------------------------
  // KENDRICK
  // ----------------------------------------------------------

  kendrick =
    require("./services/kendrick");

  // ----------------------------------------------------------
  // NEW CONFIGURATION
  // ----------------------------------------------------------

  config =
    require("./services/config");

  // ----------------------------------------------------------
  // BYBIT
  // ----------------------------------------------------------
  //
  // Kept for the existing market/trading engine.
  // It is NOT used for the new recharge/withdrawal system.
  //

  bybit =
    require("./services/bybit");

  // ----------------------------------------------------------
  // LEDGER
  // ----------------------------------------------------------

  ledger =
    require("./services/ledger");

  // ----------------------------------------------------------
  // MOBILE MONEY RECHARGE
  // ----------------------------------------------------------

  deposit =
    require("./services/deposit");

  // ----------------------------------------------------------
  // DAILY SIGNAL
  // ----------------------------------------------------------

  signal =
    require("./services/signal");

  // ----------------------------------------------------------
  // MOBILE MONEY WITHDRAWAL
  // ----------------------------------------------------------

  withdrawal =
    require("./services/withdrawal");

  // ----------------------------------------------------------
  // TELEGRAM WITHDRAWAL APPROVAL
  // ----------------------------------------------------------

  telegramWithdrawal =
    require("./services/telegram_withdrawal");

  // ----------------------------------------------------------
  // TELEGRAM RECHARGE APPROVAL
  // ----------------------------------------------------------

  telegramRecharge =
    require("./services/telegram_recharge");

  // ----------------------------------------------------------
  // MOBILE MONEY WITHDRAWAL PROFILE
  // ----------------------------------------------------------

  withdrawalWallet =
    require("./services/withdrawal_wallet");

  // ----------------------------------------------------------
  // NEW 9PM EAT SCHEDULER
  // ----------------------------------------------------------

  scheduler =
    require("./services/scheduler");

  console.log(
    "âœ… All Saint Crypto financial services loaded."
  );

} catch (error) {

  console.error(
    "âŒ Service loading failed:"
  );

  console.error(
    error.stack ||
      error.message
  );

  process.exit(1);
}

// ============================================================
// 23. SERVICE REGISTRY
// ============================================================

const serviceRegistry = {

  kendrick,

  config,

  bybit,

  ledger,

  deposit,

  signal,

  withdrawal,

  telegramWithdrawal,

  telegramRecharge,

  withdrawalWallet,

  scheduler,
};

// ============================================================
// 24. SERVICE DIAGNOSTICS
// ============================================================

console.log(
  "============================================================"
);

console.log(
  "ðŸ” SERVICE EXPORT CHECK"
);

console.log(
  `Kendrick: ${kendrick ? "READY" : "MISSING"}`
);

console.log(
  `Config: ${config ? "READY" : "MISSING"}`
);

console.log(
  `Bybit market engine: ${bybit ? "READY" : "MISSING"}`
);

console.log(
  `Ledger: ${ledger ? "READY" : "MISSING"}`
);

console.log(
  `Mobile Money recharge: ${deposit ? "READY" : "MISSING"}`
);

console.log(
  `Daily signal: ${signal ? "READY" : "MISSING"}`
);

console.log(
  `Mobile Money withdrawal: ${withdrawal ? "READY" : "MISSING"}`
);

console.log(
  `Telegram withdrawal: ${
    telegramWithdrawal ? "READY" : "MISSING"
  }`
);

console.log(
  `Telegram recharge: ${
    telegramRecharge ? "READY" : "MISSING"
  }`
);

console.log(
  `Withdrawal profile: ${
    withdrawalWallet ? "READY" : "MISSING"
  }`
);

console.log(
  `9PM EAT scheduler: ${
    scheduler ? "READY" : "MISSING"
  }`
);

console.log(
  "------------------------------------------------------------"
);

console.log(
  `Signal processor: ${
    typeof signal?.startSignalPayoutProcessor
  }`
);

console.log(
  `Signal scheduler: ${
    typeof scheduler?.startScheduler
  }`
);

console.log(
  `Recharge Telegram: ${
    typeof telegramRecharge?.startTelegramRechargeBot
  }`
);

console.log(
  `Withdrawal Telegram: ${
    typeof telegramWithdrawal?.startTelegramWithdrawalBot
  }`
);

console.log(
  "============================================================"
);

// ============================================================
// 25. ROUTE DEPENDENCIES
// ============================================================

const routeDeps = {

  firestore,

  auth,

  realtimeDb,

  verifyAuth,

  verifyFirestore,

  strictLimiter,

  services:
    serviceRegistry,
};

// ============================================================
// 26. ROUTE LOADER
// ============================================================
//
// Supports BOTH:
//   1. Existing createRouter(routeDeps) modules.
//   2. New direct Express routers.
//
// This lets the financial migration remain additive and avoids
// breaking the existing Saint Crypto user/Kendrick routes.
//

function mountRoute(
  routePath,
  routeName,
  directMountPath = null
) {

  try {

    const routeModule =
      require(routePath);

    // ----------------------------------------------------------
    // EXISTING ROUTE STYLE
    // ----------------------------------------------------------

    if (
      routeModule &&
      typeof routeModule.createRouter ===
        "function"
    ) {

      const router =
        routeModule.createRouter(
          routeDeps
        );

      if (
        !router ||
        typeof router.use !==
          "function"
      ) {

        console.error(
          `âŒ ${routeName} returned an invalid Express router.`
        );

        return false;
      }

      app.use(router);

      console.log(
        `âœ… Route loaded: ${routeName}`
      );

      return true;
    }

    // ----------------------------------------------------------
    // DIRECT EXPRESS ROUTER STYLE
    // ----------------------------------------------------------

    const directRouter =
      routeModule?.router &&
      typeof routeModule.router.use ===
        "function"
        ? routeModule.router
        : (
            routeModule &&
            typeof routeModule.use ===
              "function"
              ? routeModule
              : null
          );

    if (
      directRouter &&
      directMountPath
    ) {

      app.use(
        `${API_PREFIX}${directMountPath}`,
        directRouter
      );

      console.log(
        `âœ… Route loaded: ${routeName} -> ${API_PREFIX}${directMountPath}`
      );

      return true;
    }

    console.error(
      `âŒ ${routeName} is not a supported route module.`
    );

    return false;

  } catch (error) {

    console.error(
      `âŒ Failed to load ${routeName}:`
    );

    console.error(
      error.stack ||
        error.message
    );

    return false;
  }
}

// ============================================================
// PUBLIC SYSTEM ENDPOINTS
// MUST COME BEFORE AUTHENTICATED ROUTERS
// ============================================================

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    service: SERVICE_NAME,
    status: "ONLINE",
    message: "Saint Crypto Trade Engine is online.",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", healthHandler);

app.get(`${API_PREFIX}/health`, healthHandler);

// ============================================================
// 27. ROUTES
// ============================================================

// Existing Kendrick route.
// Keep its original createRouter contract intact.
mountRoute(
  "./services/routes/kendrick",
  "Kendrick",
  "/kendrick"
);

// Existing/new authentication wrapper.
mountRoute(
  "./services/routes/auth",
  "Auth",
  "/auth"
);

// New Mobile Money recharge routes.
//
// deposits.js exports createRouter(routeDeps) and its paths are
// relative (/config, /submit, /history, etc.). Therefore it must
// be mounted explicitly under /api/deposits.
try {
  const depositsRouter =
    require("./services/routes/deposits").createRouter(
      routeDeps
    );

  if (
    !depositsRouter ||
    typeof depositsRouter.use !== "function"
  ) {
    throw new Error(
      "Mobile Money Deposits returned an invalid Express router."
    );
  }

  app.use(
    `${API_PREFIX}/deposits`,
    depositsRouter
  );

  console.log(
    `âœ… Route loaded: Mobile Money Deposits -> ${API_PREFIX}/deposits`
  );
} catch (error) {
  console.error(
    "âŒ Failed to load Mobile Money Deposits:",
    error.stack || error.message
  );
}

// New daily signal routes.
//
// signal.js exports createRouter(routeDeps) and its paths are
// relative (/active, /status, /redeem, etc.). Therefore it must
// be mounted explicitly under /api/signals.
try {
  const signalsRouter =
    require("./services/routes/signal").createRouter(
      routeDeps
    );

  if (
    !signalsRouter ||
    typeof signalsRouter.use !== "function"
  ) {
    throw new Error(
      "Signals returned an invalid Express router."
    );
  }

  app.use(
    `${API_PREFIX}/signals`,
    signalsRouter
  );

  console.log(
    `âœ… Route loaded: Signals -> ${API_PREFIX}/signals`
  );
} catch (error) {
  console.error(
    "âŒ Failed to load Signals:",
    error.stack || error.message
  );
}

// New Mobile Money withdrawal routes.
//
// KEEP mountRoute() here. The current withdrawal route module
// already owns its /api/withdrawals/... paths.
mountRoute(
  "./services/routes/withdrawal",
  "Withdrawals",
  "/withdrawals"
);

// Authenticated ledger balance endpoint.
//
// Flutter calls GET /api/balance. This endpoint uses the new
// Saint Crypto ledger and returns locked trading capital plus
// withdrawable payout balance.
app.get(
  `${API_PREFIX}/balance`,
  verifyAuth,
  verifyFirestore,
  async (req, res) => {
    try {
      if (
        !ledger ||
        typeof ledger.getBalance !== "function"
      ) {
        return res.status(503).json({
          success: false,
          code: "LEDGER_UNAVAILABLE",
          message: "Ledger service is unavailable.",
        });
      }

      const result =
        await ledger.getBalance(req.uid);

      return res.status(200).json(
        result
      );
    } catch (error) {
      console.error(
        "âŒ Balance request failed:",
        error.stack || error.message
      );

      return res.status(500).json({
        success: false,
        code: "BALANCE_FETCH_FAILED",
        message:
          NODE_ENV === "production"
            ? "Unable to load account balance."
            : error.message ||
              "Unable to load account balance.",
      });
    }
  }
);

// Compatibility withdrawal identity routes.
mountRoute(
  "./services/routes/withdrawal_wallet",
  "Withdrawal Wallet / Mobile Money Profile",
  "/withdrawal-wallet"
);

// Safe frontend configuration.
mountRoute(
  "./services/routes/config",
  "Public Configuration",
  "/config"
);

console.log(
  "â„¹ï¸ Transfer route remains handled by routes/kendrick.js."
);

// ============================================================
// 28. TRANSFER
// ============================================================
//
// Transfer is handled by:
//
// services/routes/kendrick.js
//
// DO NOT LOAD:
//
// services/routes/transfer.js
//
// ============================================================

console.log(
  "â„¹ï¸ Transfer route handled by routes/kendrick.js."
);

// ============================================================
// 29. FAVICON
// ============================================================

app.get(
  "/favicon.ico",
  (
    req,
    res
  ) => {

    res
      .status(204)
      .end();
  }
);

// ============================================================
// 30. ROOT
// ============================================================

app.get(
  "/",
  (
    req,
    res
  ) => {

    res.json({

      success:
        true,

      service:
        SERVICE_NAME,

      status:
        "ONLINE",

      message:
        "Saint Crypto Trade Engine is online.",

      timestamp:
        new Date().toISOString(),
    });
  }
);

// ============================================================
// 31. HEALTH CHECK
// ============================================================

function healthHandler(
  req,
  res
) {

  return res.json({

    success:
      true,

    service:
      SERVICE_NAME,

    environment:
      NODE_ENV,

    status:
      "ONLINE",

    firebase:
      firebaseReady,

    firestore:
      Boolean(
        firestore
      ),

    realtimeDb:
      Boolean(
        realtimeDb
      ),

    services: {

      kendrick:
        Boolean(
          kendrick
        ),

      config:
        Boolean(
          config
        ),

      bybit:
        Boolean(
          bybit
        ),

      ledger:
        Boolean(
          ledger
        ),

      deposit:
        Boolean(
          deposit
        ),

      signal:
        Boolean(
          signal
        ),

      withdrawal:
        Boolean(
          withdrawal
        ),

      telegramWithdrawal:
        Boolean(
          telegramWithdrawal
        ),

      telegramRecharge:
        Boolean(
          telegramRecharge
        ),

      scheduler:
        Boolean(
          scheduler
        ),

      signalPayoutProcessor:
        Boolean(
          signal &&
          typeof signal.startSignalPayoutProcessor ===
            "function"
        ),
    },

    timestamp:
      new Date().toISOString(),
  });
}

app.get(
  "/health",
  healthHandler
);

app.get(
  `${API_PREFIX}/health`,
  healthHandler
);

// ============================================================
// 32. CORS TEST
// ============================================================
// Browser/Flutter can call:
//
// GET /api/cors-test
//
// Also returns the exact Origin received by the backend.
// ============================================================

app.get(
  `${API_PREFIX}/cors-test`,
  (
    req,
    res
  ) => {

    const origin =
      req.headers.origin ||
      null;

    return res.json({

      success:
        true,

      message:
        "CORS endpoint is working.",

      origin,

      normalizedOrigin:
        normalizeOrigin(
          origin
        ),

      allowed:
        isAllowedOrigin(
          origin
        ),

      backend:
        SERVICE_NAME,

      timestamp:
        new Date().toISOString(),
    });
  }
);
// ============================================================
// 33. FIREBASE MANAGER
// ============================================================

let firebaseManager =
  null;

try {

  firebaseManager =
    require(
      "./firebase_manager"
    );

  console.log(
    "âœ… firebase_manager.js loaded."
  );

  if (
    typeof firebaseManager.getManagerStatus ===
    "function"
  ) {

    console.log(
      "ðŸŸ¢ Firebase manager status:"
    );

    try {

      console.log(
        firebaseManager.getManagerStatus()
      );

    } catch (error) {

      console.warn(
        "âš ï¸ Could not read Firebase manager status:",
        error.message
      );
    }
  }

} catch (error) {

  console.error(
    "âŒ firebase_manager.js could not be loaded:"
  );

  console.error(
    error.stack ||
      error.message
  );
}

// ============================================================
// 33A. MANUAL SIGNAL TEST ROUTE
// ============================================================
// Creates exactly one signal for controlled testing.
// Protected by a private environment key.
// Does NOT change the normal Monday-Friday 9PM EAT scheduler.
// Remove this route after testing is complete.
// ============================================================

app.post(
  `${API_PREFIX}/dev/signal-now`,
  async (req, res) => {
    try {
      const manualSignalEnabled =
        String(
          process.env.ENABLE_MANUAL_SIGNAL_TEST ||
            "false"
        ).toLowerCase() === "true";

      if (!manualSignalEnabled) {
        return res.status(404).json({
          success: false,
          code: "NOT_FOUND",
          message: "Manual signal testing is disabled.",
        });
      }

      const suppliedKey =
        String(
          req.headers["x-saint-test-key"] || ""
        ).trim();

      const configuredKey =
        String(
          process.env.MANUAL_SIGNAL_TEST_KEY || ""
        ).trim();

      if (
        !configuredKey ||
        !suppliedKey ||
        suppliedKey !== configuredKey
      ) {
        return res.status(401).json({
          success: false,
          code: "UNAUTHORIZED",
          message: "Invalid test key.",
        });
      }

      if (
        !firebaseManager ||
        typeof firebaseManager.generateSignalNow !==
          "function"
      ) {
        return res.status(503).json({
          success: false,
          code: "SIGNAL_SERVICE_UNAVAILABLE",
          message: "Signal manager is unavailable.",
        });
      }

      const sessionLabel =
        Strin
      g(
          req.body?.session ||
            req.body?.sessionLabel ||
            "MANUAL TEST"
        )
          .trim()
          .substring(0, 100) ||
        "MANUAL TEST";

      console.log(
        `ðŸ§ª Manual signal test requested: ${sessionLabel}`
      );

      const result =
        await firebaseManager.generateSignalNow(
          sessionLabel
        );

      return res.status(201).json({
        success: true,
        message: "Manual signal created successfully.",
        signal: result,
      });

    } catch (error) {
      console.error(
        "âŒ Manual signal test failed:",
        error.stack || error.message
      );

      return res.status(500).json({
        success: false,
        code: "MANUAL_SIGNAL_FAILED",
        message:
          NODE_ENV === "production"
            ? "Unable to create manual signal."
            : error.message ||
              "Unable to create manual signal.",
      });
    }
  }
);

// ============================================================
// 33B. BUSINESS MANAGER ADMIN API
// ============================================================
//
// Private desktop-admin endpoints.
//
// The Business Manager uses one server-side key. Financial mutations
// are delegated to the same service functions used by Telegram so
// there is only ONE source of truth for ledger changes.
//
// NEW FINANCIAL MODEL:
//   - recharge approval -> locked trading capital
//   - signal payout -> payout balance
//   - withdrawal approval -> manual Mobile Money disbursement
//   - withdrawal rejection -> payout funds restored
//
// No USDT/TRON/TXID workflow exists here.
//

function requireBusinessManagerAdmin(
  req,
  res,
  next
) {

  const configuredKey =
    String(
      process.env.SAINT_CRYPTO_INTERNAL_ADMIN_KEY ||
        process.env.MANUAL_SIGNAL_TEST_KEY ||
        ""
    ).trim();

  const suppliedKey =
    String(
      req.headers["x-saint-admin-key"] ||
        req.headers["x-saint-test-key"] ||
        ""
    ).trim();

  if (
    !configuredKey ||
    !suppliedKey ||
    suppliedKey !== configuredKey
  ) {

    return res.status(401).json({
      success: false,
      code: "ADMIN_UNAUTHORIZED",
      message:
        "Business Manager admin authorization failed.",
    });
  }

  return next();
}


// ============================================================
// SAINT ADMIN — FIREBASE MASTER ACCOUNT GUARD
// ============================================================

async function requireSaintAdmin(req, res, next) {
  try {
    await verifyAuth(req, res, async () => {
      const configuredUid = String(
        process.env.SAINT_ADMIN_UID || ""
      ).trim();

      if (!configuredUid) {
        return res.status(503).json({
          success: false,
          code: "SAINT_ADMIN_NOT_CONFIGURED",
          message: "SAINT ADMIN UID is not configured."
        });
      }

      if (!req.uid || req.uid !== configuredUid) {
        return res.status(403).json({
          success: false,
          code: "SAINT_ADMIN_FORBIDDEN",
          message: "SAINT ADMIN access denied."
        });
      }

      return next();
    });
  } catch (error) {
    console.error("[SAINT ADMIN AUTH]", error);

    return res.status(401).json({
      success: false,
      code: "SAINT_ADMIN_UNAUTHORIZED",
      message: "SAINT ADMIN authentication failed."
    });
  }
}// ============================================================
// SAINT ADMIN — USERS
// ============================================================

app.get(
  `${API_PREFIX}/admin/users`,
  requireSaintAdmin,
  verifyFirestore,
  async (req, res) => {
    try {
      const snapshot = await saintAdminCachedRead("admin:users", () => firestore.collection("users").get());

      const users = [];

      snapshot.forEach((doc) => {
        const data = doc.data() || {};

        const email =
          data.email ||
          data.user_email ||
          "No Email";

        const phone =
          data.phone_number ||
          data.phone ||
          "No Phone";

        const balance =
          Number(
            data.usdt_balance ??
            data.balance ??
            0
          ) || 0;

        const locked =
          Number(
            data.locked_principal ??
            0
          ) || 0;

        const status =
          String(
            data.status || ""
          ).toUpperCase();

        const isFrozen =
          Boolean(data.is_frozen) ||
          [
            "FROZEN",
            "PAUSED",
            "SUSPENDED",
          ].includes(status);

        const serialized = {
          id: doc.id,
          ...data,
          email,
          phone,
          balance,
          locked,
          is_frozen: isFrozen,
        };

        Object.keys(serialized).forEach((key) => {
          const value = serialized[key];

          if (
            value &&
            typeof value.toDate === "function"
          ) {
            serialized[key] =
              value.toDate().toISOString();
          } else if (
            value &&
            typeof value.toISOString === "function"
          ) {
            serialized[key] =
              value.toISOString();
          }
        });

        users.push(serialized);
      });

      const depositedUsers =
        users.filter(
          (user) =>
            Number(user.balance) > 0 ||
            Number(user.locked) > 0
        ).length;

      return res.status(200).json({
        success: true,

        users,

        stats: {
          total_joined: users.length,
          deposited_users: depositedUsers,
        },

        timestamp:
          new Date().toISOString(),
      });

    } catch (error) {

      console.error(
        "❌ SAINT ADMIN users load failed:",
        error.stack || error.message
      );

      return res.status(500).json({
        success: false,

        code:
          "ADMIN_USERS_FETCH_FAILED",

        message:
          NODE_ENV === "production"
            ? "Unable to load Saint Crypto users."
            : error.message ||
              "Unable to load Saint Crypto users.",

        users: [],

        stats: {
          total_joined: 0,
          deposited_users: 0,
        },
      });
    }
  }
);

// ============================================================
// END SAINT ADMIN — USERS
// ============================================================
// ============================================================
// SAINT ADMIN — OVERVIEW
// ============================================================

app.get(
  `${API_PREFIX}/admin/overview`,
  requireSaintAdmin,
  verifyFirestore,
  async (req, res) => {
    const toNumber = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) {
          return number;
        }
      }
      return 0;
    };

    const upper = (value) =>
      String(value ?? '')
        .trim()
        .toUpperCase();

    try {
      const [
        usersSnapshot,
        rechargesSnapshot,
        withdrawalsSnapshot,
        redemptionsSnapshot,
      ] = await Promise.all([
        saintAdminCachedRead("admin:users", () => firestore.collection("users").get()),
        saintAdminCachedRead("admin:recharges:overview", () => firestore.collection("recharges").get()),
        saintAdminCachedRead("admin:withdrawals:overview", () => firestore.collection("withdrawals").get()),
        saintAdminCachedRead("admin:redemptions:overview", () => firestore.collection("signal_redemptions").get()),
      ]);

      let totalUsers = 0;
      let depositedUsers = 0;
      let totalLockedCapital = 0;
      let totalPayoutBalance = 0;

      usersSnapshot.forEach((doc) => {
        const user = doc.data() || {};

        totalUsers += 1;

        const lockedCapital = Math.max(
          0,
          toNumber(
            user.locked_trading_capital_ugx,
            user.locked_principal,
            user.locked
          )
        );

        const payoutBalance = Math.max(
          0,
          toNumber(
            user.payout_balance_ugx,
            user.withdrawable_profit_ugx,
            user.payout_balance
          )
        );

        const legacyBalance = Math.max(
          0,
          toNumber(
            user.total_balance_ugx,
            user.totalBalanceUgx,
            user.usdt_balance,
            user.balance
          )
        );

        totalLockedCapital += lockedCapital;
        totalPayoutBalance += payoutBalance;

        if (
          lockedCapital > 0 ||
          payoutBalance > 0 ||
          legacyBalance > 0
        ) {
          depositedUsers += 1;
        }
      });

      const pendingRechargeStatuses = new Set([
        'PENDING_ADMIN_REVIEW',
        'PENDING',
        'UNDER_REVIEW',
      ]);

      let pendingDeposits = 0;
      let pendingDepositAmount = 0;

      rechargesSnapshot.forEach((doc) => {
        const recharge = doc.data() || {};
        const status = upper(
          recharge.status || recharge.approvalStatus
        );

        if (!pendingRechargeStatuses.has(status)) {
          return;
        }

        pendingDeposits += 1;
        pendingDepositAmount += Math.max(
          0,
          toNumber(
            recharge.amount_ugx,
            recharge.amount,
            recharge.requested_amount_ugx,
            recharge.requestedAmount,
            recharge.rechargeAmount
          )
        );
      });

      const pendingWithdrawalStatuses = new Set([
        'UNDER_REVIEW',
        'PROCESSING',
        'PENDING_ADMIN_REVIEW',
        'PENDING',
      ]);

      let pendingWithdrawals = 0;
      let pendingWithdrawalAmount = 0;

      withdrawalsSnapshot.forEach((doc) => {
        const withdrawal = doc.data() || {};
        const status = upper(
          withdrawal.status || withdrawal.approvalStatus
        );

        if (!pendingWithdrawalStatuses.has(status)) {
          return;
        }

        pendingWithdrawals += 1;
        pendingWithdrawalAmount += Math.max(
          0,
          toNumber(
            withdrawal.grossAmount,
            withdrawal.amount,
            withdrawal.amount_ugx,
            withdrawal.requestedAmount
          )
        );
      });

      let rewardsCredited = 0;

      redemptionsSnapshot.forEach((doc) => {
        const redemption = doc.data() || {};
        const status = upper(redemption.status);
        const settlementStatus = upper(
          redemption.settlementStatus
        );

        if (
          status !== 'COMPLETED' &&
          settlementStatus !== 'COMPLETED'
        ) {
          return;
        }

        rewardsCredited += Math.max(
          0,
          toNumber(
            redemption.reward,
            redemption.signalProfit,
            redemption.profit,
            redemption.amount
          )
        );
      });

      let tradingFrozen = false;
      let withdrawalsFrozen = false;

      if (realtimeDb) {
        try {
          const [tradingSnapshot, withdrawalsSnapshot] =
            await Promise.all([
              realtimeDb
                .ref('system_control/trading_frozen')
                .once('value'),
              realtimeDb
                .ref('system_control/withdrawals_frozen')
                .once('value'),
            ]);

          tradingFrozen = tradingSnapshot.val() === true;
          withdrawalsFrozen =
            withdrawalsSnapshot.val() === true;
        } catch (error) {
          console.warn(
            '[SAINT ADMIN OVERVIEW] Control status read failed:',
            error.message
          );
        }
      }

      return res.json({
        success: true,
        stats: {
          total_users: totalUsers,
          deposited_users: depositedUsers,
          pending_deposits: pendingDeposits,
          pending_deposit_amount_ugx: Math.round(
            pendingDepositAmount
          ),
          pending_withdrawals: pendingWithdrawals,
          pending_withdrawal_amount_ugx: Math.round(
            pendingWithdrawalAmount
          ),
          total_locked_capital_ugx: Math.round(
            totalLockedCapital
          ),
          total_payout_balance_ugx: Math.round(
            totalPayoutBalance
          ),
          rewards_credited_ugx: Math.round(
            rewardsCredited
          ),
        },
        controls: {
          trading_frozen: tradingFrozen,
          withdrawals_frozen: withdrawalsFrozen,
        },
        services: {
          firebase: firebaseReady === true,
          firestore: Boolean(firestore),
          realtime_database: Boolean(realtimeDb),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        '[SAINT ADMIN OVERVIEW]',
        error.stack || error.message
      );

      return res.status(500).json({
        success: false,
        code: 'SAINT_ADMIN_OVERVIEW_FAILED',
        message: 'Unable to load SAINT ADMIN overview.',
      });
    }
  }
);

// ------------------------------------------------------------
// GENERATE DAILY SIGNAL MANUALLY
// ------------------------------------------------------------

app.post(
  `${API_PREFIX}/admin/business-manager/signals/generate`,
  requireBusinessManagerAdmin,
  async (req, res) => {

    try {

      if (
        !signal ||
        typeof signal.createSignal !==
          "function"
      ) {

        return res.status(503).json({
          success: false,
          code: "SIGNAL_SERVICE_UNAVAILABLE",
          message:
            "Signal service is unavailable.",
        });
      }

      const force =
        String(
          req.body?.force || "false"
        ).toLowerCase() === "true";

      const result =
        await signal.createSignal({
          force,
        });

      return res.status(201).json({
        success: true,
        message:
          "Signal created successfully.",
        signal: result,
      });

    } catch (error) {

      console.error(
        "âŒ Business Manager signal generation failed:",
        error.stack || error.message
      );

      return res.status(400).json({
        success: false,
        code:
          "BUSINESS_MANAGER_SIGNAL_FAILED",
        message:
          error.message ||
          "Unable to create the signal.",
      });
    }
  }
);

// ------------------------------------------------------------
// RECHARGE APPROVAL
// ------------------------------------------------------------

app.post(
  `${API_PREFIX}/admin/business-manager/recharges/:rechargeId/approve`,
  requireBusinessManagerAdmin,
  async (req, res) => {

    try {

      if (
        !deposit ||
        typeof deposit.approveRecharge !==
          "function"
      ) {

        return res.status(503).json({
          success: false,
          code: "RECHARGE_SERVICE_UNAVAILABLE",
          message:
            "Recharge service is unavailable.",
        });
      }

      const rechargeId =
        String(
          req.params.rechargeId || ""
        ).trim();

      if (!rechargeId) {

        return res.status(400).json({
          success: false,
          code: "RECHARGE_ID_REQUIRED",
          message:
            "Recharge ID is required.",
        });
      }

      const result =
        await deposit.approveRecharge(
          rechargeId,
          "BUSINESS_MANAGER"
        );

      return res.status(200).json({
        success: true,
        message:
          "Recharge approved and locked trading capital credited.",
        recharge: result,
      });

    } catch (error) {

      console.error(
        "âŒ Business Manager recharge approval failed:",
        error.stack || error.message
      );

      return res.status(400).json({
        success: false,
        code:
          "BUSINESS_MANAGER_RECHARGE_APPROVAL_FAILED",
        message:
          error.message ||
          "Unable to approve this recharge.",
      });
    }
  }
);

app.post(
  `${API_PREFIX}/admin/business-manager/recharges/:rechargeId/reject`,
  requireBusinessManagerAdmin,
  async (req, res) => {

    try {

      if (
        !deposit ||
        typeof deposit.rejectRecharge !==
          "function"
      ) {

        return res.status(503).json({
          success: false,
          code: "RECHARGE_SERVICE_UNAVAILABLE",
          message:
            "Recharge service is unavailable.",
        });
      }

      const rechargeId =
        String(
          req.params.rechargeId || ""
        ).trim();

      const reason =
        String(
          req.body?.reason ||
            "Recharge rejected by Business Manager administrator."
        )
          .trim()
          .substring(0, 500);

      if (!rechargeId) {

        return res.status(400).json({
          success: false,
          code: "RECHARGE_ID_REQUIRED",
          message:
            "Recharge ID is required.",
        });
      }

      const result =
        await deposit.rejectRecharge(
          rechargeId,
          "BUSINESS_MANAGER",
          reason
        );

      return res.status(200).json({
        success: true,
        message:
          "Recharge rejected. No ledger credit was made.",
        recharge: result,
      });

    } catch (error) {

      console.error(
        "âŒ Business Manager recharge rejection failed:",
        error.stack || error.message
      );

      return res.status(400).json({
        success: false,
        code:
          "BUSINESS_MANAGER_RECHARGE_REJECTION_FAILED",
        message:
          error.message ||
          "Unable to reject this recharge.",
      });
    }
  }
);

// ------------------------------------------------------------
// WITHDRAWAL APPROVAL / MANUAL DISBURSEMENT CONFIRMATION
// ------------------------------------------------------------

app.post(
  `${API_PREFIX}/admin/business-manager/withdrawals/:withdrawalId/approve`,
  requireBusinessManagerAdmin,
  async (req, res) => {

    try {

      if (
        !withdrawal ||
        typeof withdrawal.approveAndDisburseWithdrawal !==
          "function"
      ) {

        return res.status(503).json({
          success: false,
          code:
            "WITHDRAWAL_SERVICE_UNAVAILABLE",
          message:
            "Withdrawal service is unavailable.",
        });
      }

      const withdrawalId =
        String(
          req.params.withdrawalId || ""
        ).trim();

      if (!withdrawalId) {

        return res.status(400).json({
          success: false,
          code: "WITHDRAWAL_ID_REQUIRED",
          message:
            "Withdrawal ID is required.",
        });
      }

      const paymentReference =
        String(
          req.body?.paymentReference ||
            `MANUAL_MM_${Date.now()}`
        )
          .trim()
          .substring(0, 200);

      const result =
        await withdrawal.approveAndDisburseWithdrawal(
          withdrawalId,
          {
            paymentReference,
            adminId:
              "BUSINESS_MANAGER",
            adminUsername:
              "Kendrick Saint",
          }
        );

      return res.status(200).json({
        success: true,
        message:
          "Withdrawal marked DISBURSED after manual Mobile Money payment confirmation.",
        withdrawal: result,
      });

    } catch (error) {

      console.error(
        "âŒ Business Manager withdrawal approval failed:",
        error.stack || error.message
      );

      return res.status(400).json({
        success: false,
        code:
          "BUSINESS_MANAGER_WITHDRAWAL_APPROVAL_FAILED",
        message:
          error.message ||
          "Unable to approve this withdrawal.",
      });
    }
  }
);

// ------------------------------------------------------------
// WITHDRAWAL REJECTION
// ------------------------------------------------------------

app.post(
  `${API_PREFIX}/admin/business-manager/withdrawals/:withdrawalId/reject`,
  requireBusinessManagerAdmin,
  async (req, res) => {

    try {

      if (
        !withdrawal ||
        typeof withdrawal.rejectWithdrawal !==
          "function"
      ) {

        return res.status(503).json({
          success: false,
          code:
            "WITHDRAWAL_SERVICE_UNAVAILABLE",
          message:
            "Withdrawal service is unavailable.",
        });
      }

      const withdrawalId =
        String(
          req.params.withdrawalId || ""
        ).trim();

      if (!withdrawalId) {

        return res.status(400).json({
          success: false,
          code: "WITHDRAWAL_ID_REQUIRED",
          message:
            "Withdrawal ID is required.",
        });
      }

      const reason =
        String(
          req.body?.reason ||
            req.body?.note ||
            "Withdrawal rejected by Business Manager administrator."
        )
          .trim()
          .substring(0, 500);

      const result =
        await withdrawal.rejectWithdrawal(
          withdrawalId,
          reason
        );

      return res.status(200).json({
        success: true,
        message:
          "Withdrawal rejected and reserved funds restored.",
        withdrawal: result,
      });

    } catch (error) {

      console.error(
        "âŒ Business Manager withdrawal rejection failed:",
        error.stack || error.message
      );

      return res.status(400).json({
        success: false,
        code:
          "BUSINESS_MANAGER_WITHDRAWAL_REJECTION_FAILED",
        message:
          error.message ||
          "Unable to reject this withdrawal.",
      });
    }
  }
);

// ============================================================
// 34. NEW FINANCIAL PROCESSORS
// ============================================================
//
// IMPORTANT:
// The old crypto deposit monitor and blockchain withdrawal monitor are
// intentionally NOT started anymore.
//
// Recharge is manually approved by Telegram/Business Manager.
// Withdrawal is manually paid through Mobile Money.
// Signal payouts are processed durably from Firestore.
//

function startFinancialProcessors() {

  // ----------------------------------------------------------
  // SIGNAL PAYOUT PROCESSOR
  // ----------------------------------------------------------

  if (
    signal &&
    typeof signal.startSignalPayoutProcessor ===
      "function"
  ) {

    try {

      signal.startSignalPayoutProcessor();

      console.log(
        "âœ… Signal payout processor started."
      );

    } catch (error) {

      console.error(
        "âŒ Signal payout processor failed:",
        error.message
      );
    }

  } else {

    console.error(
      "âŒ Signal payout processor unavailable."
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM RECHARGE APPROVAL
  // ----------------------------------------------------------

  if (
    telegramRecharge &&
    typeof telegramRecharge.startTelegramRechargeBot ===
      "function"
  ) {

    try {

      void telegramRecharge.startTelegramRechargeBot()
        .then((result) => {

          console.log(
            "ðŸ“± Telegram recharge bot:",
            result
          );

          // ONE Telegram bot token = ONE polling connection.
          // Recharge owns the polling connection; withdrawal attaches
          // its callback handlers to the same bot instance.
          if (
            telegramWithdrawal &&
            typeof telegramWithdrawal.startTelegramWithdrawalBot ===
              "function"
          ) {
            const sharedBot =
              typeof telegramRecharge.getBot ===
                "function"
                ? telegramRecharge.getBot()
                : null;

            return telegramWithdrawal.startTelegramWithdrawalBot(
              sharedBot
            );
          }

          return null;

        })
        .then((result) => {

          if (result) {
            console.log(
              "ðŸ“± Telegram withdrawal bot:",
              result
            );
          }

        })
        .catch((error) => {

          console.error(
            "âŒ Telegram financial bot startup failed:",
            error.message
          );

        });

    } catch (error) {

      console.error(
        "âŒ Telegram recharge startup failed:",
        error.message
      );
    }

  } else {

    console.error(
      "âŒ Telegram recharge service unavailable."
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM WITHDRAWAL APPROVAL
  // Handlers are attached to the shared recharge bot above.
  // ----------------------------------------------------------


  // ----------------------------------------------------------
  // 9PM EAT SIGNAL SCHEDULER
  // ----------------------------------------------------------

  if (
    scheduler &&
    typeof scheduler.startScheduler ===
      "function"
  ) {

    try {

      scheduler.startScheduler();

      console.log(
        "âœ… Signal scheduler started: Monday-Friday 9:00 PM EAT."
      );

    } catch (error) {

      console.error(
        "âŒ Signal scheduler failed:",
        error.message
      );
    }

  } else {

    console.error(
      "âŒ New signal scheduler unavailable."
    );
  }
}

function stopFinancialProcessors() {

  // ----------------------------------------------------------
  // SIGNAL PROCESSOR
  // ----------------------------------------------------------

  try {

    if (
      signal &&
      typeof signal.stopSignalPayoutProcessor ===
        "function"
    ) {

      signal.stopSignalPayoutProcessor();

      console.log(
        "ðŸ›‘ Signal payout processor stopped."
      );
    }

  } catch (error) {

    console.warn(
      "âš ï¸ Signal processor shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // SIGNAL SCHEDULER
  // ----------------------------------------------------------

  try {

    if (
      scheduler &&
      typeof scheduler.stopScheduler ===
        "function"
    ) {

      scheduler.stopScheduler();

      console.log(
        "ðŸ›‘ Signal scheduler stopped."
      );
    }

  } catch (error) {

    console.warn(
      "âš ï¸ Signal scheduler shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM RECHARGE
  // ----------------------------------------------------------

  try {

    if (
      telegramRecharge &&
      typeof telegramRecharge.stopTelegramRechargeBot ===
        "function"
    ) {

      void telegramRecharge.stopTelegramRechargeBot();

      console.log(
        "ðŸ›‘ Telegram recharge bot stopped."
      );
    }

  } catch (error) {

    console.warn(
      "âš ï¸ Telegram recharge shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM WITHDRAWAL
  // ----------------------------------------------------------

  try {

    if (
      telegramWithdrawal &&
      typeof telegramWithdrawal.stopTelegramWithdrawalBot ===
        "function"
    ) {

      void telegramWithdrawal.stopTelegramWithdrawalBot();

      console.log(
        "ðŸ›‘ Telegram withdrawal bot stopped."
      );
    }

  } catch (error) {

    console.warn(
      "âš ï¸ Telegram withdrawal shutdown:",
      error.message
    );
  }
}

// ============================================================
// 41. MARKET SYNC
// ============================================================

function startMarketSync() {

  if (
    !bybit
  ) {

    console.warn(
      "âš ï¸ Bybit service unavailable."
    );

    return false;
  }

  if (
    typeof bybit.startMarketSync !==
    "function"
  ) {

    console.warn(
      "âš ï¸ bybit.startMarketSync() unavailable."
    );

    return false;
  }

  try {

    const started =
      bybit.startMarketSync();

    if (!started) {

      console.log(
        "â„¹ï¸ Bybit market synchronization is disabled."
      );

      return false;
    }

    console.log(
      "âœ… Bybit market synchronization started."
    );

    return true;

  } catch (error) {

    console.error(
      "âŒ Market synchronization failed:",
      error.message
    );

    return false;
  }
}

// ============================================================
// 42. BYBIT PRIVATE WEBSOCKET
// ============================================================

async function startBybitWebSocket() {

  if (
    !bybit
  ) {

    console.warn(
      "âš ï¸ Bybit service unavailable."
    );

    return false;
  }

  if (
    typeof bybit.connectPrivateWebSocket !==
    "function"
  ) {

    console.warn(
      "âš ï¸ Bybit private WebSocket unavailable."
    );

    return false;
  }

  try {

    const connected =
      await bybit.connectPrivateWebSocket();

    if (!connected) {

      console.log(
        "â„¹ï¸ Bybit private WebSocket is disabled."
      );

      return false;
    }

    console.log(
      "âœ… Bybit private WebSocket connected."
    );

    return true;

  } catch (error) {

    console.warn(
      "âš ï¸ Bybit WebSocket startup:",
      error.message
    );

    return false;
  }
}

// ============================================================
// SAINT_ADMIN_FINAL_V2
// Complete SAINT ADMIN API layer. Inserted before app.listen().
// Existing Saint Crypto routes/services remain untouched.

const saintAdminFirestoreCache = new Map();

async function saintAdminCachedRead(key, loader, ttlMs = 10000) {
  const now = Date.now();
  const existing = saintAdminFirestoreCache.get(key);
  if (existing && existing.expiresAt > now) return existing.value;
  if (existing && existing.promise) return existing.promise;
  const promise = Promise.resolve().then(loader);
  saintAdminFirestoreCache.set(key, { promise, expiresAt: now + ttlMs });
  try {
    const value = await promise;
    saintAdminFirestoreCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  } catch (error) {
    saintAdminFirestoreCache.delete(key);
    throw error;
  }
}

// ----- finance queues -----
app.get(
  API_PREFIX + "/admin/finance/recharges",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const snap = await saintAdminCachedRead("admin:recharges:300", () => firestore.collection("recharges").limit(300).get());
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const all = req.query.all === "true";
      const recharges = all ? rows : rows.filter(x =>
        ["PENDING_ADMIN_REVIEW", "PENDING"].includes(
          String(x.status || "").toUpperCase()
        )
      );
      return res.json({ success: true, count: recharges.length, recharges });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "ADMIN_RECHARGES_FAILED", message: e.message
      });
    }
  }
);

app.get(
  API_PREFIX + "/admin/finance/withdrawals",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const snap = await saintAdminCachedRead("admin:withdrawals:300", () => firestore.collection("withdrawals").limit(300).get());
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const all = req.query.all === "true";
      const withdrawals = all ? rows : rows.filter(x =>
        ["UNDER_REVIEW", "PENDING", "PENDING_ADMIN_REVIEW", "AWAITING_PAYMENT", "PROCESSING"]
          .includes(String(x.status || "").toUpperCase())
      );
      return res.json({ success: true, count: withdrawals.length, withdrawals });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "ADMIN_WITHDRAWALS_FAILED", message: e.message
      });
    }
  }
);

// ----- recharge approval -----
app.post(
  API_PREFIX + "/admin/finance/recharges/:rechargeId/approve",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.rechargeId || "").trim();
      if (!id) return res.status(400).json({
        success: false, message: "Recharge ID is required."
      });
      if (!deposit || typeof deposit.approveRecharge !== "function") {
        return res.status(503).json({
          success: false, code: "RECHARGE_SERVICE_UNAVAILABLE"
        });
      }
      const result = await deposit.approveRecharge(id, req.uid);
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "RECHARGE_APPROVED", target: id,
        details: result, createdAt: new Date()
      });
      return res.json({ success: true, message: "Recharge approved.", recharge: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "RECHARGE_APPROVAL_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/finance/recharges/:rechargeId/reject",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.rechargeId || "").trim();
      const reason = String(req.body && req.body.reason || "Rejected by SAINT ADMIN.")
        .trim().slice(0, 500);
      if (!id) return res.status(400).json({
        success: false, message: "Recharge ID is required."
      });
      if (!deposit || typeof deposit.rejectRecharge !== "function") {
        return res.status(503).json({
          success: false, code: "RECHARGE_SERVICE_UNAVAILABLE"
        });
      }
      const result = await deposit.rejectRecharge(id, req.uid, reason);
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "RECHARGE_REJECTED", target: id,
        details: { reason, result }, createdAt: new Date()
      });
      return res.json({ success: true, message: "Recharge rejected.", recharge: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "RECHARGE_REJECTION_FAILED", message: e.message
      });
    }
  }
);

// ----- withdrawal approval / rejection -----
app.post(
  API_PREFIX + "/admin/finance/withdrawals/:withdrawalId/approve",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.withdrawalId || "").trim();
      if (!id) return res.status(400).json({
        success: false, message: "Withdrawal ID is required."
      });
      if (!withdrawal || typeof withdrawal.approveAndDisburseWithdrawal !== "function") {
        return res.status(503).json({
          success: false, code: "WITHDRAWAL_SERVICE_UNAVAILABLE"
        });
      }
      const result = await withdrawal.approveAndDisburseWithdrawal({
        withdrawalId: id,
        paymentReference: String(req.body && req.body.paymentReference ||
          "SAINT_ADMIN_MM_" + Date.now()).trim(),
        adminId: req.uid,
        adminNote: String(req.body && req.body.adminNote || "").trim().slice(0, 500)
      });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "WITHDRAWAL_APPROVED", target: id,
        details: result, createdAt: new Date()
      });
      return res.json({ success: true, withdrawal: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "WITHDRAWAL_APPROVAL_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/finance/withdrawals/:withdrawalId/reject",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.withdrawalId || "").trim();
      const reason = String(req.body && req.body.reason || "Rejected by SAINT ADMIN.")
        .trim().slice(0, 500);
      if (!id) return res.status(400).json({
        success: false, message: "Withdrawal ID is required."
      });
      if (!withdrawal || typeof withdrawal.rejectWithdrawal !== "function") {
        return res.status(503).json({
          success: false, code: "WITHDRAWAL_SERVICE_UNAVAILABLE"
        });
      }
      const result = await withdrawal.rejectWithdrawal({
        withdrawalId: id,
        adminId: req.uid,
        reason
      });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "WITHDRAWAL_REJECTED", target: id,
        details: { reason, result }, createdAt: new Date()
      });
      return res.json({ success: true, withdrawal: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "WITHDRAWAL_REJECTION_FAILED", message: e.message
      });
    }
  }
);

// ----- user detail / freeze -----
app.get(
  API_PREFIX + "/admin/users/:userId",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.userId || "").trim();
      const doc = await firestore.collection("users").doc(id).get();
      if (!doc.exists) return res.status(404).json({
        success: false, code: "USER_NOT_FOUND"
      });
      const read = async name => {
        const snap = await firestore.collection(name).limit(300).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(x => String(x.userId || x.uid || "") === id);
      };
      const [recharges, withdrawals, signals] = await Promise.all([
        read("recharges"), read("withdrawals"), read("signal_redemptions")
      ]);
      return res.json({
        success: true,
        user: { id: doc.id, ...doc.data() },
        recharges, withdrawals, signalHistory: signals
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "USER_DETAIL_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/users/:userId/freeze",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.userId || "").trim();
      await firestore.collection("users").doc(id).set({
        is_frozen: true,
        status: "FROZEN",
        freezeReason: String(req.body && req.body.reason || "Frozen by SAINT ADMIN.")
          .slice(0, 500),
        updatedAt: new Date()
      }, { merge: true });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "USER_FROZEN", target: id,
        details: req.body || {}, createdAt: new Date()
      });
      return res.json({ success: true, message: "User frozen." });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "USER_FREEZE_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/users/:userId/unfreeze",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.userId || "").trim();
      await firestore.collection("users").doc(id).set({
        is_frozen: false, status: "ACTIVE", freezeReason: null, updatedAt: new Date()
      }, { merge: true });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "USER_UNFROZEN", target: id,
        details: {}, createdAt: new Date()
      });
      return res.json({ success: true, message: "User unfrozen." });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "USER_UNFREEZE_FAILED", message: e.message
      });
    }
  }
);



// ===== ADMIN USER CONTROL CENTER V1 =====
// Safe, read-only customer control snapshot.
//
// V1 intentionally reads ONLY the customer's users document.
// Historical financial totals will be added later using the
// canonical ledger transaction types after they are verified.
//
// This route does NOT modify:
// - customer money
// - locked trading capital
// - payout balance
// - login credentials
// - Fund PIN
// - withdrawals
// - recharges

app.get(
  API_PREFIX + "/admin/users/:userId/control",
  requireSaintAdmin,
  verifyFirestore,
  async (req, res) => {
    const userId = String(req.params.userId || "").trim();

    if (!userId) {
      return res.status(400).json({
        success: false,
        code: "USER_ID_REQUIRED",
        message: "User ID is required."
      });
    }

    try {
      const userRef = db.collection("users").doc(userId);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({
          success: false,
          code: "USER_NOT_FOUND",
          message: "Customer account was not found."
        });
      }

      const user = userSnap.data() || {};

      const lockedTradingCapitalUgx =
        Number(user.locked_trading_capital_ugx) || 0;

      const payoutBalanceUgx =
        Number(user.payout_balance_ugx) || 0;

      return res.json({
        success: true,

        user: {
          id: userSnap.id,
          uid: user.uid || userSnap.id,

          name:
            user.name ||
            user.displayName ||
            null,

          email:
            user.email ||
            null,

          phone:
            user.phone ||
            user.phoneNumber ||
            null,

          status:
            user.status ||
            null,

          is_frozen:
            user.is_frozen === true,

          freezeReason:
            user.freezeReason ||
            null,

          createdAt:
            user.createdAt ||
            user.created_at ||
            null,

          updatedAt:
            user.updatedAt ||
            user.updated_at ||
            null,

          lastLoginAt:
            user.lastLoginAt ||
            user.last_login_at ||
            null,

          hasFundPassword:
            Boolean(
              user.hasFundPassword ||
              user.fundPasswordHash
            ),

          lockedTradingCapitalUgx:
            Math.max(0, lockedTradingCapitalUgx),

          payoutBalanceUgx:
            Math.max(0, payoutBalanceUgx),

          currency: "UGX"
        }
      });

    } catch (error) {
      console.error(
        "[ADMIN USER CONTROL] Failed:",
        error?.stack || error
      );

      return res.status(500).json({
        success: false,
        code: "ADMIN_USER_CONTROL_FAILED",
        message: "Failed to load customer control information."
      });
    }
  }
);


// ===== ADMIN USER SECURITY ACTIONS V1 =====
// Admin-only customer security actions.
// These routes do not edit customer balances or ledger money.
// Every successful security action creates an admin audit record.

// ------------------------------------------------------------
// ADMIN RESET FUND PIN
// POST /api/admin/users/:userId/security/reset-fund-pin
// Body: { "newPin": "123456", "reason": "..." }
// ------------------------------------------------------------
app.post(
  API_PREFIX + "/admin/users/:userId/security/reset-fund-pin",
  requireSaintAdmin,
  verifyFirestore,
  async (req, res) => {
    try {
      const userId = String(req.params.userId || "").trim();
      const newPin = String(req.body?.newPin || "").trim();
      const reason = String(
        req.body?.reason || "Fund PIN reset by SAINT ADMIN."
      ).trim().slice(0, 500);

      if (!userId) {
        return res.status(400).json({
          success: false,
          code: "USER_ID_REQUIRED",
          message: "User ID is required."
        });
      }

      if (!/^\d{6}$/.test(newPin)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_FUND_PIN",
          message: "Fund PIN must contain exactly 6 digits."
        });
      }

      const userRef = firestore.collection("users").doc(userId);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({
          success: false,
          code: "USER_NOT_FOUND",
          message: "Customer account was not found."
        });
      }

      if (
        !kendrick ||
        typeof kendrick.saveFundPassword !== "function"
      ) {
        return res.status(503).json({
          success: false,
          code: "FUND_PIN_SERVICE_UNAVAILABLE",
          message: "Fund PIN service is unavailable."
        });
      }

      await kendrick.saveFundPassword(userRef, newPin);

      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid || null,
        action: "ADMIN_FUND_PIN_RESET",
        target: userId,
        details: {
          reason,
          forcedByAdmin: true
        },
        createdAt: new Date()
      });

      return res.json({
        success: true,
        message: "Customer Fund PIN reset successfully.",
        userId
      });
    } catch (error) {
      console.error(
        "[ADMIN FUND PIN RESET] Failed:",
        error?.stack || error
      );

      return res.status(500).json({
        success: false,
        code: "ADMIN_FUND_PIN_RESET_FAILED",
        message: "Failed to reset customer Fund PIN."
      });
    }
  }
);

// ------------------------------------------------------------
// ADMIN GENERATE LOGIN PASSWORD RESET LINK
// POST /api/admin/users/:userId/security/login-reset-link
// The Firebase Admin SDK generates the official reset link.
// It does not directly send email from this backend.
// ------------------------------------------------------------
app.post(
  API_PREFIX + "/admin/users/:userId/security/login-reset-link",
  requireSaintAdmin,
  verifyFirestore,
  async (req, res) => {
    try {
      const userId = String(req.params.userId || "").trim();
      const reason = String(
        req.body?.reason || "Login password reset requested by SAINT ADMIN."
      ).trim().slice(0, 500);

      if (!userId) {
        return res.status(400).json({
          success: false,
          code: "USER_ID_REQUIRED",
          message: "User ID is required."
        });
      }

      const userRef = firestore.collection("users").doc(userId);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        return res.status(404).json({
          success: false,
          code: "USER_NOT_FOUND",
          message: "Customer account was not found."
        });
      }

      const user = userSnap.data() || {};
      const email = String(
        user.email || user.emailAddress || ""
      ).trim();

      if (!email) {
        return res.status(400).json({
          success: false,
          code: "USER_EMAIL_MISSING",
          message: "Customer does not have an email address."
        });
      }

      if (!auth || typeof auth.generatePasswordResetLink !== "function") {
        return res.status(503).json({
          success: false,
          code: "AUTH_SERVICE_UNAVAILABLE",
          message: "Firebase Authentication service is unavailable."
        });
      }

      // Firebase Admin generates the official reset URL.
      // The Control Room can present/copy this link for the customer.
      const resetLink = await auth.generatePasswordResetLink(email);

      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid || null,
        action: "ADMIN_LOGIN_PASSWORD_RESET_LINK_GENERATED",
        target: userId,
        details: {
          reason,
          email,
          method: "FIREBASE_ADMIN_GENERATE_PASSWORD_RESET_LINK"
        },
        createdAt: new Date()
      });

      return res.json({
        success: true,
        message: "Login password reset link generated successfully.",
        userId,
        email,
        resetLink
      });
    } catch (error) {
      console.error(
        "[ADMIN LOGIN PASSWORD RESET] Failed:",
        error?.stack || error
      );

      return res.status(500).json({
        success: false,
        code: "ADMIN_LOGIN_PASSWORD_RESET_FAILED",
        message: "Failed to generate login password reset link."
      });
    }
  }
);


  // ===== ADMIN FINANCIAL CONTROL V1 =====
  // Read-only customer financial snapshot.
  //
  // This endpoint NEVER changes customer money.
  // It reads the current user balances and the canonical ledger.
  //
  // Canonical ledger types used:
  // RECHARGE_CREDIT
  // SIGNAL_PAYOUT
  // ADMIN_LOCKED_CAPITAL_CREDIT
  // ADMIN_LOCKED_CAPITAL_DEBIT
  // ADMIN_PAYOUT_CREDIT
  // ADMIN_PAYOUT_DEBIT

  app.get(
    API_PREFIX + "/admin/users/:userId/financial",
    requireSaintAdmin,
    verifyFirestore,
    async (req, res) => {
      try {
        const userId = String(req.params.userId || "").trim();

        if (!userId) {
          return res.status(400).json({
            success: false,
            code: "USER_ID_REQUIRED",
            message: "User ID is required."
          });
        }

        const userRef = firestore.collection("users").doc(userId);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
          return res.status(404).json({
            success: false,
            code: "USER_NOT_FOUND",
            message: "Customer account was not found."
          });
        }

        const user = userSnap.data() || {};

        const lockedTradingCapitalUgx = Math.max(
          0,
          Number(user.locked_trading_capital_ugx) || 0
        );

        const payoutBalanceUgx = Math.max(
          0,
          Number(user.payout_balance_ugx) || 0
        );

        // Query only the canonical ledger for this customer.
        // Cache the read briefly to reduce repeated Firestore reads
        // when the Admin Control Room refreshes the same customer.
        const ledgerSnap = await saintAdminCachedRead(
          `admin:user-financial-ledger:${userId}`,
          () =>
            firestore
              .collection("ledger_transactions")
              .where("userId", "==", userId)
              .get(),
          10000
        );

        const totals = {
          totalRechargeCreditUgx: 0,
          totalSignalPayoutUgx: 0,
          totalAdminCapitalCreditUgx: 0,
          totalAdminCapitalDebitUgx: 0,
          totalAdminPayoutCreditUgx: 0,
          totalAdminPayoutDebitUgx: 0
        };

        const typeCounts = {
          RECHARGE_CREDIT: 0,
          SIGNAL_PAYOUT: 0,
          ADMIN_LOCKED_CAPITAL_CREDIT: 0,
          ADMIN_LOCKED_CAPITAL_DEBIT: 0,
          ADMIN_PAYOUT_CREDIT: 0,
          ADMIN_PAYOUT_DEBIT: 0
        };

        for (const doc of ledgerSnap.docs) {
          const entry = doc.data() || {};
          const amount = Math.max(
            0,
            Number(entry.amountUgx ?? entry.amount) || 0
          );

          switch (String(entry.type || "").trim()) {
            case "RECHARGE_CREDIT":
              totals.totalRechargeCreditUgx += amount;
              typeCounts.RECHARGE_CREDIT += 1;
              break;

            case "SIGNAL_PAYOUT":
              totals.totalSignalPayoutUgx += amount;
              typeCounts.SIGNAL_PAYOUT += 1;
              break;

            case "ADMIN_LOCKED_CAPITAL_CREDIT":
              totals.totalAdminCapitalCreditUgx += amount;
              typeCounts.ADMIN_LOCKED_CAPITAL_CREDIT += 1;
              break;

            case "ADMIN_LOCKED_CAPITAL_DEBIT":
              totals.totalAdminCapitalDebitUgx += amount;
              typeCounts.ADMIN_LOCKED_CAPITAL_DEBIT += 1;
              break;

            case "ADMIN_PAYOUT_CREDIT":
              totals.totalAdminPayoutCreditUgx += amount;
              typeCounts.ADMIN_PAYOUT_CREDIT += 1;
              break;

            case "ADMIN_PAYOUT_DEBIT":
              totals.totalAdminPayoutDebitUgx += amount;
              typeCounts.ADMIN_PAYOUT_DEBIT += 1;
              break;

            default:
              break;
          }
        }

        return res.json({
          success: true,
          currency: "UGX",

          user: {
            id: userSnap.id,
            uid: user.uid || userSnap.id,
            name: user.name || user.displayName || null,
            email: user.email || null,
            phone: user.phone || user.phoneNumber || null
          },

          balances: {
            lockedTradingCapitalUgx,
            payoutBalanceUgx,
            withdrawableBalanceUgx: payoutBalanceUgx
          },

          ledgerTotals: totals,

          ledgerSummary: {
            totalEntries: ledgerSnap.size,
            typeCounts
          }
        });
      } catch (error) {
        console.error(
          "[ADMIN FINANCIAL CONTROL] Failed:",
          error?.stack || error
        );

        return res.status(500).json({
          success: false,
          code: "ADMIN_FINANCIAL_CONTROL_FAILED",
          message: "Failed to load customer financial information."
        });
      }
    }
  );

// ----- system controls -----
app.get(
  API_PREFIX + "/admin/system/status",
  requireSaintAdmin,
  async (req, res) => {
    try {
      let c = {};
      if (realtimeDb) {
        const snap = await realtimeDb.ref("system_control").once("value");
        c = snap.val() || {};
      }

      let signalStatus = null;
      let schedulerStatus = null;

      try {
        if (signal && typeof signal.getStatus === "function") {
          signalStatus = await signal.getStatus();
        }
      } catch (error) {
        signalStatus = {
          success: false,
          error: error.message,
        };
      }

      try {
        if (scheduler && typeof scheduler.getStatus === "function") {
          schedulerStatus = await scheduler.getStatus();
        }
      } catch (error) {
        schedulerStatus = {
          success: false,
          error: error.message,
        };
      }

      return res.json({
        success: true,
        backend: "ONLINE",
        firebase: Boolean(firebaseReady),
        firestore: Boolean(firestore),
        realtimeDb: Boolean(realtimeDb),
        tradingFrozen: c.trading_frozen === true,
        withdrawalsFrozen: c.withdrawals_frozen === true,
        rechargeFrozen: c.recharge_frozen === true,
        signalFrozen: c.signal_frozen === true,
        maintenance: c.maintenance === true,
        announcement: String(c.announcement || ""),
        signal: signalStatus,
        scheduler: schedulerStatus,
        updatedAt: c.updatedAt || null,
        updatedBy: c.updatedBy || null,
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SYSTEM_STATUS_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/system/control",
  requireSaintAdmin,
  async (req, res) => {
    try {
      if (!realtimeDb) return res.status(503).json({
        success: false, message: "Realtime Database unavailable."
      });

      const body = req.body || {};
      const u = {
        updatedAt: new Date().toISOString(),
        updatedBy: req.uid,
      };

      if (typeof body.tradingFrozen === "boolean")
        u.trading_frozen = body.tradingFrozen;
      if (typeof body.withdrawalsFrozen === "boolean")
        u.withdrawals_frozen = body.withdrawalsFrozen;
      if (typeof body.rechargeFrozen === "boolean")
        u.recharge_frozen = body.rechargeFrozen;
      if (typeof body.signalFrozen === "boolean")
        u.signal_frozen = body.signalFrozen;
      if (typeof body.maintenance === "boolean")
        u.maintenance = body.maintenance;
      if (body.announcement !== undefined)
        u.announcement = String(body.announcement || "").slice(0, 1000);

      const mutableKeys = [
        "trading_frozen",
        "withdrawals_frozen",
        "recharge_frozen",
        "signal_frozen",
        "maintenance",
        "announcement",
      ];

      const changed = mutableKeys.filter((key) =>
        Object.prototype.hasOwnProperty.call(u, key)
      );

      if (changed.length === 0) {
        return res.status(400).json({
          success: false,
          code: "NO_CONTROL_CHANGE",
          message: "No supported system control was supplied.",
        });
      }

      await realtimeDb.ref("system_control").update(u);

      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid,
        action: "SYSTEM_CONTROL_UPDATE",
        target: "system_control",
        details: u,
        createdAt: new Date(),
      });

      return res.json({
        success: true,
        controls: u,
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SYSTEM_CONTROL_FAILED", message: e.message
      });
    }
  }
);

// ----- payout balance adjustment (rewards / deductions) -----
app.post(
  API_PREFIX + "/admin/finance/adjust-balance",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const userId = String(
        req.body?.userId ||
        req.body?.uid ||
        ""
      ).trim();

      const amountUgx = Number(
        req.body?.amountUgx ??
        req.body?.amount ??
        0
      );

      const action = String(
        req.body?.action ||
        "CREDIT"
      )
        .trim()
        .toUpperCase();

      const reason = String(
        req.body?.reason ||
        ""
      )
        .trim()
        .slice(0, 500);

      if (!userId) {
        return res.status(400).json({
          success: false,
          code: "USER_ID_REQUIRED",
          message: "User ID is required.",
        });
      }

      const roundedAmount = Math.round(
        amountUgx
      );

      if (
        !Number.isSafeInteger(
          roundedAmount
        ) ||
        roundedAmount <= 0
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_AMOUNT",
          message:
            "Enter a valid positive UGX amount.",
        });
      }

      if (
        action !== "CREDIT" &&
        action !== "DEDUCT"
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ACTION",
          message:
            "Action must be CREDIT or DEDUCT.",
        });
      }

      if (!reason) {
        return res.status(400).json({
          success: false,
          code: "REASON_REQUIRED",
          message:
            "A reason is required.",
        });
      }

      if (
        !ledger ||
        typeof ledger.adjustPayoutBalance !==
          "function"
      ) {
        return res.status(503).json({
          success: false,
          code:
            "LEDGER_ADJUSTMENT_UNAVAILABLE",
          message:
            "Ledger adjustment service is unavailable.",
        });
      }

      const result =
        await ledger.adjustPayoutBalance({
          userId,
          amountUgx: roundedAmount,
          direction:
            action === "CREDIT"
              ? "CREDIT"
              : "DEBIT",
          adminId: req.uid,
          reason,
        });

      await firestore
        .collection("admin_audit_logs")
        .add({
          adminUid: req.uid,
          action:
            action === "CREDIT"
              ? "PAYOUT_BALANCE_CREDITED"
              : "PAYOUT_BALANCE_DEDUCTED",
          target: userId,
          details: {
            reason,
            result,
          },
          createdAt: new Date(),
        });

      return res.json({
        success: true,
        message:
          action === "CREDIT"
            ? "Payout balance credited."
            : "Payout balance deducted.",
        adjustment: result,
      });
    } catch (e) {
      return res.status(400).json({
        success: false,
        code:
          "PAYOUT_BALANCE_ADJUSTMENT_FAILED",
        message: e.message,
      });
    }
  }
);
// ----- ledger history for SAINT ADMIN -----
app.get(
  API_PREFIX + "/admin/finance/ledger",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const rawLimit = Number.parseInt(String(req.query.limit || "300"), 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 500)
        : 300;

      const snap = await saintAdminCachedRead(
        "admin:ledger:" + limit,
        () => firestore.collection("ledger_transactions").limit(limit).get()
      );

      const transactions = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      transactions.sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || 0;
        const bTime = b.createdAt?.toMillis?.() || 0;
        return bTime - aTime;
      });

      return res.json({
        success: true,
        count: transactions.length,
        transactions,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "ADMIN_LEDGER_FAILED",
        message: e.message,
      });
    }
  }
);
// ----- audit -----
app.get(
  API_PREFIX + "/admin/audit",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const parsedLimit = Number.parseInt(
        String(req.query.limit || "300"),
        10
      );

      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 1000)
        : 300;

      const actionFilter = String(
        req.query.action || ""
      ).trim().toUpperCase();

      const adminFilter = String(
        req.query.adminUid || ""
      ).trim();

      const targetFilter = String(
        req.query.target || ""
      ).trim();

      const auditLimit = Math.max(limit, 300);
      const snap = await saintAdminCachedRead(
        "admin:audit:" + auditLimit,
        () => firestore.collection("admin_audit_logs").limit(auditLimit).get()
      );

      const toMillis = (value) => {
        if (!value) return 0;

        if (
          value &&
          typeof value.toMillis === "function"
        ) {
          return value.toMillis();
        }

        if (value instanceof Date) {
          return value.getTime();
        }

        const parsed = Date.parse(
          String(value)
        );

        return Number.isFinite(parsed)
          ? parsed
          : 0;
      };

      let logs = snap.docs
        .map((d) => ({
          id: d.id,
          ...d.data(),
        }))
        .sort(
          (a, b) =>
            toMillis(b.createdAt) -
            toMillis(a.createdAt)
        );

      if (actionFilter) {
        logs = logs.filter(
          (x) =>
            String(x.action || "")
              .toUpperCase() ===
            actionFilter
        );
      }

      if (adminFilter) {
        logs = logs.filter(
          (x) =>
            String(x.adminUid || "") ===
            adminFilter
        );
      }

      if (targetFilter) {
        logs = logs.filter(
          (x) =>
            String(x.target || "") ===
            targetFilter
        );
      }

      logs = logs.slice(0, limit);

      return res.json({
        success: true,
        count: logs.length,
        filters: {
          action: actionFilter || null,
          adminUid: adminFilter || null,
          target: targetFilter || null,
        },
        logs,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "AUDIT_FAILED",
        message: e.message,
      });
    }
  }
);

// ----- signals -----// ----- signals -----
app.get(
  API_PREFIX + "/admin/signals",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const rawLimit = Number.parseInt(String(req.query.limit || "200"), 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 500)
        : 200;

      const snap = await saintAdminCachedRead("admin:signals:" + limit, () => firestore.collection("signals").limit(limit).get());
      const signals = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      signals.sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || Date.parse(a.createdAt || "") || 0;
        const bTime = b.createdAt?.toMillis?.() || Date.parse(b.createdAt || "") || 0;
        return bTime - aTime;
      });

      return res.json({
        success: true,
        count: signals.length,
        signals,
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SIGNALS_FAILED", message: e.message
      });
    }
  }
);

app.get(
  API_PREFIX + "/admin/signals/status",
  requireSaintAdmin,
  async (req, res) => {
    try {
      let signalStatus = {
        success: false,
        error: "Signal service unavailable.",
      };
      let schedulerStatus = {
        success: false,
        error: "Scheduler unavailable.",
      };

      if (signal && typeof signal.getStatus === "function") {
        signalStatus = await signal.getStatus();
      }

      if (scheduler && typeof scheduler.getStatus === "function") {
        schedulerStatus = await scheduler.getStatus();
      }

      return res.json({
        success: true,
        signal: signalStatus,
        scheduler: schedulerStatus,
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SIGNAL_STATUS_FAILED", message: e.message
      });
    }
  }
);

app.get(
  API_PREFIX + "/admin/signals/redemptions",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const rawLimit = Number.parseInt(String(req.query.limit || "300"), 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 500)
        : 300;

      const userId = String(req.query.userId || "").trim();
      const requestedStatus = String(req.query.status || "").trim().toUpperCase();

      const snap = await saintAdminCachedRead(
        "admin:redemptions:" + limit,
        () => firestore.collection("signal_redemptions").limit(limit).get()
      );

      let redemptions = snap.docs.map(d => ({
        id: d.id,
        redemptionId: d.id,
        ...d.data(),
      }));

      if (userId) {
        redemptions = redemptions.filter(x =>
          String(x.userId || x.uid || "") === userId
        );
      }

      if (requestedStatus) {
        redemptions = redemptions.filter(x =>
          String(x.status || "").toUpperCase() === requestedStatus
        );
      }

      redemptions.sort((a, b) => {
        const aTime = a.createdAt?.toMillis?.() || Date.parse(a.createdAt || "") || 0;
        const bTime = b.createdAt?.toMillis?.() || Date.parse(b.createdAt || "") || 0;
        return bTime - aTime;
      });

      return res.json({
        success: true,
        count: redemptions.length,
        redemptions,
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SIGNAL_REDEMPTIONS_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/signals/generate",
  requireSaintAdmin,
  async (req, res) => {
    try {
      if (!signal || typeof signal.createSignal !== "function") {
        return res.status(503).json({
          success: false,
          code: "SIGNAL_SERVICE_UNAVAILABLE",
          message: "Signal service is unavailable.",
        });
      }

      const session = String(
        req.body?.session ||
        "SAINT ADMIN MANUAL"
      ).trim().slice(0, 80);

      const result = await signal.createSignal({
        force: true,
        createdBy: req.uid,
        session,
      });

      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid,
        action: result?.alreadyExists
          ? "SIGNAL_GENERATION_ALREADY_EXISTS"
          : "SIGNAL_GENERATED_MANUALLY",
        target: result?.signal?.code || null,
        details: {
          session,
          result,
        },
        createdAt: new Date(),
      });

      return res.status(result?.alreadyExists ? 200 : 201).json({
        success: true,
        alreadyExists: result?.alreadyExists === true,
        message: result?.alreadyExists
          ? "Today's signal already exists."
          : "Signal created successfully.",
        signal: result?.signal || result,
      });
    } catch (e) {
      return res.status(400).json({
        success: false,
        code: "SIGNAL_GENERATION_FAILED",
        message: e.message,
      });
    }
  }
);

// ----- reports -----
app.get(
  API_PREFIX + "/admin/reports",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const parsedLimit = Number.parseInt(
        String(req.query.limit || "1000"),
        10
      );

      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 100), 3000)
        : 1000;

      const period = String(
        req.query.period || "all"
      )
        .trim()
        .toLowerCase();

      if (
        ![
          "all",
          "today",
          "week",
          "month",
        ].includes(period)
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_REPORT_PERIOD",
          message:
            "period must be all, today, week, or month.",
        });
      }

      const now = new Date();
      let fromMs = null;
      let toMs = now.getTime();

      if (req.query.from) {
        const parsed = Date.parse(
          String(req.query.from)
        );

        if (!Number.isFinite(parsed)) {
          return res.status(400).json({
            success: false,
            code: "INVALID_REPORT_FROM",
            message:
              "The from date is invalid.",
          });
        }

        fromMs = parsed;
      }

      if (req.query.to) {
        const parsed = Date.parse(
          String(req.query.to)
        );

        if (!Number.isFinite(parsed)) {
          return res.status(400).json({
            success: false,
            code: "INVALID_REPORT_TO",
            message:
              "The to date is invalid.",
          });
        }

        toMs = parsed;
      }

      if (
        req.query.from &&
        req.query.to &&
        fromMs > toMs
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_REPORT_RANGE",
          message:
            "The from date cannot be after the to date.",
        });
      }

      if (
        !req.query.from &&
        !req.query.to
      ) {
        if (period === "today") {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          fromMs = d.getTime();
        } else if (period === "week") {
          const d = new Date();
          const day = d.getDay();
          const mondayOffset =
            day === 0
              ? -6
              : 1 - day;

          d.setDate(
            d.getDate() +
              mondayOffset
          );

          d.setHours(0, 0, 0, 0);
          fromMs = d.getTime();
        } else if (period === "month") {
          const d = new Date(
            now.getFullYear(),
            now.getMonth(),
            1
          );

          fromMs = d.getTime();
        }
      }

      const [
        usersSnapshot,
        rechargesSnapshot,
        withdrawalsSnapshot,
        rewardsSnapshot,
      ] = await Promise.all([
        firestore
          .collection("users")
          .limit(limit)
          .get(),

        firestore
          .collection("recharges")
          .limit(limit)
          .get(),

        firestore
          .collection("withdrawals")
          .limit(limit)
          .get(),

        firestore
          .collection("signal_redemptions")
          .limit(limit)
          .get(),
      ]);

      const toMillis = (value) => {
        if (!value) return 0;

        if (
          value &&
          typeof value.toMillis === "function"
        ) {
          return value.toMillis();
        }

        if (value instanceof Date) {
          return value.getTime();
        }

        const parsed = Date.parse(
          String(value)
        );

        return Number.isFinite(parsed)
          ? parsed
          : 0;
      };

      const inRange = (row) => {
        if (
          period === "all" &&
          fromMs === null &&
          !req.query.from &&
          !req.query.to
        ) {
          return true;
        }

        const created =
          toMillis(row.createdAt) ||
          toMillis(row.created_at) ||
          toMillis(row.updatedAt) ||
          toMillis(row.updated_at);

        if (!created) {
          return false;
        }

        if (
          fromMs !== null &&
          created < fromMs
        ) {
          return false;
        }

        if (
          toMs !== null &&
          created > toMs
        ) {
          return false;
        }

        return true;
      };

      const num = (...values) => {
        for (const value of values) {
          const number = Number(value);

          if (Number.isFinite(number)) {
            return number;
          }
        }

        return 0;
      };

      const users =
        usersSnapshot.docs.map(
          (d) => d.data()
        );

      const recharges =
        rechargesSnapshot.docs
          .map((d) => d.data())
          .filter(inRange);

      const withdrawals =
        withdrawalsSnapshot.docs
          .map((d) => d.data())
          .filter(inRange);

      const rewards =
        rewardsSnapshot.docs
          .map((d) => d.data())
          .filter(inRange);

      const approvedRecharges =
        recharges.filter(
          (x) =>
            String(
              x.status || ""
            ).toUpperCase() ===
            "APPROVED"
        );

      const paidWithdrawals =
        withdrawals.filter(
          (x) =>
            [
              "PAID",
              "DISBURSED",
              "COMPLETED",
            ].includes(
              String(
                x.status || ""
              ).toUpperCase()
            )
        );

      const completedRewards =
        rewards.filter((x) => {
          const status = String(
            x.status || ""
          ).toUpperCase();

          const settlementStatus =
            String(
              x.settlementStatus || ""
            ).toUpperCase();

          return (
            status === "COMPLETED" ||
            settlementStatus ===
              "COMPLETED"
          );
        });

      return res.json({
        success: true,

        period: {
          name: period,

          from:
            fromMs !== null
              ? new Date(
                  fromMs
                ).toISOString()
              : null,

          to:
            toMs !== null
              ? new Date(
                  toMs
                ).toISOString()
              : null,
        },

        users: {
          total:
            users.length,

          frozen:
            users.filter(
              (x) =>
                x.is_frozen === true
            ).length,

          active:
            users.filter(
              (x) =>
                x.is_frozen !== true
            ).length,
        },

        finance: {
          rechargeCount:
            recharges.length,

          approvedRechargeCount:
            approvedRecharges.length,

          approvedRechargeUgx:
            Math.round(
              approvedRecharges.reduce(
                (sum, x) =>
                  sum +
                  num(
                    x.amountUgx,
                    x.amount_ugx,
                    x.amount
                  ),
                0
              )
            ),

          withdrawalCount:
            withdrawals.length,

          paidWithdrawalCount:
            paidWithdrawals.length,

          paidWithdrawalUgx:
            Math.round(
              paidWithdrawals.reduce(
                (sum, x) =>
                  sum +
                  num(
                    x.netAmountUgx,
                    x.netPayout,
                    x.amountUgx,
                    x.amount_ugx,
                    x.amount
                  ),
                0
              )
            ),

          completedRewardCount:
            completedRewards.length,

          rewardsCreditedUgx:
            Math.round(
              completedRewards.reduce(
                (sum, x) =>
                  sum +
                  num(
                    x.rewardUgx,
                    x.reward,
                    x.signalProfit,
                    x.profit,
                    x.amount
                  ),
                0
              )
            ),
        },

        generatedAt:
          new Date().toISOString(),
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        code: "REPORTS_FAILED",
        message: e.message,
      });
    }
  }
);

// MT5 integration disconnected.
// The former MT5 registry, command queue, heartbeat, and acknowledgement routes were removed.

// MT5 integration is intentionally disconnected.
// Reject legacy MT5 traffic without touching Firestore.
app.use(`${API_PREFIX}/mt5`, (req, res) => {
  return res.status(410).json({
    success: false,
    code: "MT5_DISCONNECTED",
    message: "MT5 integration has been disconnected from Saint Crypto."
  });
});

// 43. 404 HANDLER
// ============================================================

app.use(
  (
    req,
    res
  ) => {

    return res
      .status(404)
      .json({

        success:
          false,

        code:
          "NOT_FOUND",

        message:
          "Endpoint not found.",

        method:
          req.method,

        path:
          req.originalUrl,
      });
  }
);

// ============================================================
// 44. GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "âŒ GLOBAL ERROR:",
      error.stack ||
        error.message ||
        error
    );

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

    if (
      error &&
      (
        error.message ===
          "CORS policy restriction: unauthorized origin." ||
        String(
          error.message ||
            ""
        ).toLowerCase().includes(
          "cors"
        )
      )
    ) {

      return res
        .status(403)
        .json({

          success:
            false,

          code:
            "CORS_REJECTED",

          message:
            "Request origin is not allowed.",

          origin:
            req.headers.origin ||
            null,
        });
    }

    // --------------------------------------------------------
    // INVALID JSON
    // --------------------------------------------------------

    if (
      error &&
      error.type ===
        "entity.parse.failed"
    ) {

      return res
        .status(400)
        .json({

          success:
            false,

          code:
            "INVALID_JSON",

          message:
            "Invalid JSON request body.",
        });
    }

    // --------------------------------------------------------
    // DEFAULT
    // --------------------------------------------------------

    return res
      .status(
        error?.statusCode ||
          error?.status ||
          500
      )
      .json({

        success:
          false,

        code:
          "INTERNAL_SERVER_ERROR",

        message:
          NODE_ENV ===
            "production"
            ? "Internal server error."
            : (
                error?.message ||
                "Internal server error."
              ),
      });
  }
);

// ============================================================
// 45. SERVER
// ============================================================


/* ============================================================
   ADMIN LOCKED TRADING CAPITAL ADJUSTMENT
   Separate from payout-balance adjustment.
   ============================================================ */

app.post(
  `${API_PREFIX}/admin/finance/adjust-capital`,
  requireSaintAdmin,
  async (req, res) => {
    try {
      const userId = String(
        req.body?.userId ||
        req.body?.uid ||
        ""
      ).trim();

      const amountUgx = Number(
        req.body?.amountUgx ??
        req.body?.amount ??
        0
      );

      const action = String(
        req.body?.action ||
        "CREDIT"
      )
        .trim()
        .toUpperCase();

      const reason = String(
        req.body?.reason ||
        ""
      )
        .trim()
        .slice(0, 500);

      if (!userId) {
        return res.status(400).json({
          success: false,
          code: "USER_ID_REQUIRED",
          message: "User ID is required.",
        });
      }

      const roundedAmount =
        Math.round(
          amountUgx
        );

      if (
        !Number.isSafeInteger(
          roundedAmount
        ) ||
        roundedAmount <= 0
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_AMOUNT",
          message:
            "Enter a valid positive UGX amount.",
        });
      }

      if (
        action !== "CREDIT" &&
        action !== "DEDUCT"
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ACTION",
          message:
            "Action must be CREDIT or DEDUCT.",
        });
      }

      if (!reason) {
        return res.status(400).json({
          success: false,
          code: "REASON_REQUIRED",
          message:
            "A reason is required.",
        });
      }

      if (
        !ledger ||
        typeof ledger.adjustLockedTradingCapital !==
          "function"
      ) {
        return res.status(503).json({
          success: false,
          code:
            "LOCKED_CAPITAL_ADJUSTMENT_UNAVAILABLE",
          message:
            "Locked-capital adjustment service is unavailable.",
        });
      }

      const adjustmentId =
        String(
          req.body?.adjustmentId ||
          ""
        ).trim() || null;

      const result =
        await ledger.adjustLockedTradingCapital({
          userId,
          amountUgx:
            roundedAmount,
          direction:
            action === "CREDIT"
              ? "CREDIT"
              : "DEBIT",
          adminId:
            req.uid,
          reason,
          adjustmentId,
        });

      if (firestore) {
        await firestore
          .collection(
            "admin_audit_logs"
          )
          .add({
            adminUid:
              req.uid,
            action:
              action === "CREDIT"
                ? "LOCKED_CAPITAL_CREDITED"
                : "LOCKED_CAPITAL_DEDUCTED",
            target:
              userId,
            details: {
              reason,
              result,
            },
            createdAt:
              new Date(),
          });
      }

      return res.json({
        success: true,
        message:
          action === "CREDIT"
            ? "Locked trading capital credited."
            : "Locked trading capital deducted.",
        adjustment:
          result,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        code:
          "LOCKED_CAPITAL_ADJUSTMENT_FAILED",
        message:
          error.message,
      });
    }
  }
);
const server =
  app.listen(
    PORT,
    HOST,
    async () => {

      console.log("");

      console.log(
        "============================================================"
      );

      console.log(
        "ðŸš€ SAINT CRYPTO TRADE ENGINE"
      );

      console.log(
        "============================================================"
      );

      console.log(
        `ðŸŒ Server: ${HOST}:${PORT}`
      );

      console.log(
        `ðŸŒ Environment: ${NODE_ENV}`
      );

      console.log(
        `ðŸŒ API Prefix: ${API_PREFIX}`
      );

      console.log(
        `ðŸ”¥ Firebase: ${
          firebaseReady
            ? "READY"
            : "NOT READY"
        }`
      );

      console.log(
        `ðŸ”¥ Firestore: ${
          firestore
            ? "READY"
            : "UNAVAILABLE"
        }`
      );

      console.log(
        `ðŸ”¥ RTDB: ${
          realtimeDb
            ? "READY"
            : "UNAVAILABLE"
        }`
      );

      // --------------------------------------------------------
      // CORS DIAGNOSTICS
      // --------------------------------------------------------

      console.log(
        "============================================================"
      );

      console.log(
        "ðŸŒ CORS CONFIGURATION"
      );

      console.log(
        "============================================================"
      );

      console.log(
        "âœ… localhost:<ANY PORT>"
      );

      console.log(
        "âœ… 127.0.0.1:<ANY PORT>"
      );

      console.log(
        "âœ… *.web.app"
      );

      console.log(
        "âœ… *.firebaseapp.com"
      );

      for (
        const origin of
        knownProductionOrigins
      ) {

        console.log(
          `âœ… ${origin}`
        );
      }

      console.log(
        "============================================================"
      );

      // --------------------------------------------------------
      // NEW FINANCIAL CONFIGURATION
      // --------------------------------------------------------

      try {

        const publicConfig =
          typeof config?.getPublicConfig ===
            "function"
            ? config.getPublicConfig()
            : null;

        console.log(
          `ðŸ’° Signal reward: ${
            publicConfig?.signals?.rewardUgx ??
            20000
          } UGX`
        );

        console.log(
          `â° Signal schedule: ${
            publicConfig?.signals?.time ??
            "21:00"
          } ${
            publicConfig?.signals?.timezone ??
            "Africa/Kampala"
          }`
        );

        console.log(
          `â³ Signal processing: ${
            publicConfig?.signals?.processingMinutes ??
            7
          } minute(s)`
        );

        console.log(
          `ðŸ“¥ Mobile Money recharge: ${
            publicConfig?.financial?.recharge?.enabled
              ? "ENABLED"
              : "DISABLED"
          }`
        );

        console.log(
          `ðŸ’¸ Mobile Money withdrawal: ${
            publicConfig?.financial?.withdrawal?.enabled
              ? "ENABLED"
              : "DISABLED"
          }`
        );

        console.log(
          `ðŸ’³ Withdrawal fee: ${
            publicConfig?.financial?.withdrawal?.feePercent ??
            5
          }%`
        );

      } catch (error) {

        console.warn(
          "âš ï¸ Could not read public financial configuration:",
          error.message
        );
      }

      // --------------------------------------------------------
      // NEW FINANCIAL PROCESSORS
      // --------------------------------------------------------

      startFinancialProcessors();

// --------------------------------------------------------
      // MARKET SYNC
      // --------------------------------------------------------

      startMarketSync();

      // --------------------------------------------------------
      // TELEGRAM WITHDRAWAL APPROVAL
      // --------------------------------------------------------

      if (
        telegramWithdrawal &&
        typeof telegramWithdrawal.startTelegramWithdrawalApproval ===
          "function"
      ) {

        try {

          telegramWithdrawal.startTelegramWithdrawalApproval();

          console.log(
            "âœ… Telegram withdrawal approval started."
          );

        } catch (error) {

          console.error(
            "âŒ Telegram withdrawal approval failed:",
            error.message
          );
        }

      }

      console.log(
        `ðŸ’¸ Mobile Money withdrawal service: ${
          withdrawal ? "READY" : "UNAVAILABLE"
        }`
      );

      console.log(
        `ðŸ“± Telegram recharge approvals: ${
          telegramRecharge ? "READY" : "UNAVAILABLE"
        }`
      );

      console.log(
        `ðŸ“± Telegram withdrawal approvals: ${
          telegramWithdrawal ? "READY" : "UNAVAILABLE"
        }`
      );

      // --------------------------------------------------------
      // BACKEND READY
      // --------------------------------------------------------

      console.log(
        "============================================================"
      );

      console.log(
        "ðŸŸ¢ SAINT CRYPTO BACKEND READY"
      );

      console.log(
        "============================================================"
      );

      // --------------------------------------------------------
      // TELEGRAM ONLINE ALERT
      // --------------------------------------------------------

      if (
        firebaseManager &&
        typeof firebaseManager.sendBackendOnlineAlert ===
          "function"
      ) {

        try {

          const sent =
            await firebaseManager.sendBackendOnlineAlert();

          if (
            sent
          ) {

            console.log(
              "ðŸ“± SAINT CRYPTO BACKEND IS ONLINE alert sent to Telegram."
            );

          } else {

            console.error(
              "âŒ SAINT CRYPTO BACKEND ONLINE alert was not delivered."
            );
          }

        } catch (error) {

          console.error(
            "âŒ Backend ONLINE Telegram alert failed:",
            error.message
          );
        }

      } else {

        console.error(
          "âŒ Telegram ONLINE alert unavailable because firebase_manager.js does not expose sendBackendOnlineAlert()."
        );
      }
    }
  );

// ============================================================
// 46. GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown =
  false;

async function shutdown(
  signalName
) {

  if (
    shuttingDown
  ) {

    return;
  }

  shuttingDown =
    true;

  console.log(
    `ðŸ§¹ ${signalName} received. Shutting down...`
  );

  // ----------------------------------------------------------
  // NEW FINANCIAL PROCESSORS
  // ----------------------------------------------------------

  try {

    stopFinancialProcessors();

  } catch (error) {

    console.warn(
      "âš ï¸ Financial processor shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // MARKET SYNC
  // ----------------------------------------------------------

  try {

    if (
      bybit &&
      typeof bybit.stopMarketSync ===
        "function"
    ) {

      bybit.stopMarketSync();

      console.log(
        "ðŸ›‘ Market synchronization stopped."
      );
    }

  } catch (error) {

    console.warn(
      "âš ï¸ Market sync shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // BYBIT WEBSOCKET
  // ----------------------------------------------------------

  try {

    if (
      bybit &&
      typeof bybit.closePrivateWebSocket ===
        "function"
    ) {

      await Promise.resolve(
        bybit.closePrivateWebSocket()
      );

      console.log(
        "ðŸ›‘ Bybit WebSocket closed."
      );
    }

  } catch (error) {

    console.warn(
      "âš ï¸ Bybit WebSocket shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // FIREBASE MANAGER
  // ----------------------------------------------------------

  try {

    if (
      firebaseManager &&
      typeof firebaseManager.shutdown ===
        "function"
    ) {

      await firebaseManager.shutdown();

      console.log(
        "ðŸ›‘ Firebase manager stopped."
      );
    }

  } catch (error) {

    console.warn(
      "âš ï¸ Firebase manager shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // HTTP SERVER
  // ----------------------------------------------------------

  try {

    server.close(
      () => {

        console.log(
          "ðŸ›‘ HTTP server closed."
        );

        process.exit(
          0
        );
      }
    );

  } catch (error) {

    console.error(
      "âŒ HTTP server shutdown:",
      error.message
    );

    process.exit(
      1
    );
  }

  // ----------------------------------------------------------
  // FORCE EXIT
  // ----------------------------------------------------------

  setTimeout(
    () => {

      console.error(
        "âš ï¸ Forced shutdown after timeout."
      );

      process.exit(
        1
      );

    },
    5000
  ).unref();
}

// ============================================================
// 47. PROCESS SIGNALS
// ============================================================

process.on(
  "SIGINT",
  () => {

    shutdown(
      "SIGINT"
    );
  }
);

process.on(
  "SIGTERM",
  () => {

    shutdown(
      "SIGTERM"
    );
  }
);

// ============================================================
// 48. UNHANDLED REJECTION
// ============================================================

process.on(
  "unhandledRejection",
  (reason) => {

    console.error(
      "âŒ Unhandled Promise Rejection:"
    );

    console.error(
      reason
    );
  }
);

// ============================================================
// 49. UNCAUGHT EXCEPTION
// ============================================================

process.on(
  "uncaughtException",
  (error) => {

    console.error(
      "âŒ Uncaught Exception:"
    );

    console.error(
      error.stack ||
        error.message
    );
  }
);

// ============================================================
// 50. EXPORTS
// ============================================================

module.exports = {

  app,

  firestore,

  auth,

  realtimeDb,

  serviceRegistry,

  server,
};


