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

      max: 300,

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
        String(
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
}
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


