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
// ├── index.js
// ├── firebase_manager.js
// └── services/
//     ├── kendrick.js
//     ├── config.js
//     ├── bybit.js
//     ├── ledger.js
//     ├── deposit.js
//     ├── signal.js
//     ├── withdrawal.js
//     └── routes/
//         ├── auth.js
//         ├── deposits.js
//         ├── kendrick.js
//         ├── signal.js
//         └── withdrawal.js
//
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
    "✅ express-rate-limit loaded."
  );
} catch (error) {
  console.warn(
    "⚠️ express-rate-limit is not installed. Rate limiting disabled."
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
          "⚠️ Firebase RTDB unavailable:",
          error.message
        );

        realtimeDb =
          null;
      }

      firebaseReady =
        true;

      console.log(
        "🔥 Reusing existing Firebase Admin app."
      );

      console.log(
        "🟢 Firestore: READY"
      );

      console.log(
        `🟢 RTDB: ${
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
        "⚠️ Firebase RTDB unavailable:",
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
      "🔥 FIREBASE INITIALIZATION"
    );

    console.log(
      "============================================================"
    );

    console.log(
      "✅ Firebase Admin initialized successfully."
    );

    console.log(
      "🟢 Firestore: READY"
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

  } catch (error) {

    console.error(
      "============================================================"
    );

    console.error(
      "❌ FIREBASE INITIALIZATION FAILED"
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
        "⚠️ CORS blocked origin:",
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
      "❌ Authentication error:",
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
let withdrawalWallet = null;

try {

  // ----------------------------------------------------------
  // KENDRICK
  // ----------------------------------------------------------

  kendrick =
    require(
      "./services/kendrick"
    );

  // ----------------------------------------------------------
  // CONFIG
  // ----------------------------------------------------------

  config =
    require(
      "./services/config"
    );

  // ----------------------------------------------------------
  // BYBIT
  // ----------------------------------------------------------

  bybit =
    require(
      "./services/bybit"
    );

  // ----------------------------------------------------------
  // LEDGER
  // ----------------------------------------------------------

  ledger =
    require(
      "./services/ledger"
    );

  // ----------------------------------------------------------
  // DEPOSIT
  // ----------------------------------------------------------

  deposit =
    require(
      "./services/deposit"
    );

  // ----------------------------------------------------------
  // SIGNAL
  // ----------------------------------------------------------

  signal =
    require(
      "./services/signal"
    );

  // ----------------------------------------------------------
  // WITHDRAWAL
  // ----------------------------------------------------------

  withdrawal =
    require(
      "./services/withdrawal"
    );

  telegramWithdrawal =
    require(
      "./services/telegram_withdrawal"
    );

  withdrawalWallet =
    require(
      "./services/withdrawal_wallet"
    );

  console.log(
    "✅ All services loaded."
  );

} catch (error) {

  console.error(
    "❌ Service loading failed:"
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
  withdrawalWallet,
};

// ============================================================
// 24. SERVICE DIAGNOSTICS
// ============================================================

console.log(
  "============================================================"
);

console.log(
  "🔍 SERVICE EXPORT CHECK"
);

console.log(
  `Kendrick: ${
    kendrick
      ? "READY"
      : "MISSING"
  }`
);

console.log(
  `Config: ${
    config
      ? "READY"
      : "MISSING"
  }`
);

console.log(
  `Bybit: ${
    bybit
      ? "READY"
      : "MISSING"
  }`
);

console.log(
  `Ledger: ${
    ledger
      ? "READY"
      : "MISSING"
  }`
);

console.log(
  `Deposit: ${
    deposit
      ? "READY"
      : "MISSING"
  }`
);

console.log(
  `Signal: ${
    signal
      ? "READY"
      : "MISSING"
  }`
);

console.log(
  `Withdrawal: ${
    withdrawal
      ? "READY"
      : "MISSING"
  }`
);

console.log(
  "------------------------------------------------------------"
);

console.log(
  `Deposit submitDeposit: ${
    typeof deposit?.submitDeposit
  }`
);

console.log(
  `Deposit getDepositStatus: ${
    typeof deposit?.getDepositStatus
  }`
);

console.log(
  `Deposit getDepositHistory: ${
    typeof deposit?.getDepositHistory
  }`
);

console.log(
  `Deposit monitorPendingDeposits: ${
    typeof deposit?.monitorPendingDeposits
  }`
);

console.log(
  `Deposit monitorDeposits: ${
    typeof deposit?.monitorDeposits
  }`
);

console.log(
  `Deposit getConfig: ${
    typeof deposit?.getConfig
  }`
);

console.log(
  `Withdrawal requestWithdrawal: ${
    typeof withdrawal?.requestWithdrawal
  }`
);

console.log(
  `Withdrawal startMonitor: ${
    typeof withdrawal?.startMonitor
  }`
);

console.log(
  `Withdrawal stopMonitor: ${
    typeof withdrawal?.stopMonitor
  }`
);

console.log(
  `Withdrawal monitorWithdrawals: ${
    typeof withdrawal?.monitorWithdrawals
  }`
);

console.log(
  `Telegram withdrawal approval: ${
    telegramWithdrawal
      ? "READY"
      : "UNAVAILABLE"
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

function mountRoute(
  routePath,
  routeName
) {

  try {

    const routeModule =
      require(
        routePath
      );

    if (
      !routeModule ||
      typeof routeModule.createRouter !==
        "function"
    ) {

      console.error(
        `❌ ${routeName} does not export createRouter().`
      );

      return false;
    }

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
        `❌ ${routeName} returned an invalid Express router.`
      );

      return false;
    }

    app.use(
      router
    );

    console.log(
      `✅ Route loaded: ${routeName}`
    );

    return true;

  } catch (error) {

    console.error(
      `❌ Failed to load ${routeName}:`
    );

    console.error(
      error.stack ||
        error.message
    );

    return false;
  }
}

// ============================================================
// 27. ROUTES
// ============================================================

mountRoute(
  "./services/routes/kendrick",
  "Kendrick"
);

mountRoute(
  "./services/routes/auth",
  "Auth"
);

mountRoute(
  "./services/routes/deposits",
  "Deposits"
);

mountRoute(
  "./services/routes/signal",
  "Signal"
);

mountRoute(
  "./services/routes/withdrawal",
  "Withdrawal"
);

mountRoute(
  "./services/routes/withdrawal_wallet",
  "Withdrawal Wallet"
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
  "ℹ️ Transfer route handled by routes/kendrick.js."
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
    "✅ firebase_manager.js loaded."
  );

  if (
    typeof firebaseManager.getManagerStatus ===
    "function"
  ) {

    console.log(
      "🟢 Firebase manager status:"
    );

    try {

      console.log(
        firebaseManager.getManagerStatus()
      );

    } catch (error) {

      console.warn(
        "⚠️ Could not read Firebase manager status:",
        error.message
      );
    }
  }

} catch (error) {

  console.error(
    "❌ firebase_manager.js could not be loaded:"
  );

  console.error(
    error.stack ||
      error.message
  );
}

// ============================================================
// 34. DEPOSIT MONITOR STATE
// ============================================================

let depositMonitorTimer =
  null;

let depositMonitorRunning =
  false;

// ============================================================
// 35. RUN DEPOSIT MONITOR
// ============================================================

async function runDepositMonitorNow() {

  if (
    depositMonitorRunning
  ) {

    return;
  }

  if (
    !deposit
  ) {

    console.warn(
      "⚠️ Deposit service unavailable."
    );

    return;
  }

  let monitorFunction =
    null;

  if (
    typeof deposit.monitorPendingDeposits ===
    "function"
  ) {

    monitorFunction =
      deposit.monitorPendingDeposits.bind(
        deposit
      );

  } else if (
    typeof deposit.monitorDeposits ===
    "function"
  ) {

    monitorFunction =
      deposit.monitorDeposits.bind(
        deposit
      );
  }

  if (
    !monitorFunction
  ) {

    console.warn(
      "⚠️ No deposit monitor function is exported."
    );

    return;
  }

  depositMonitorRunning =
    true;

  try {

    const result =
      await monitorFunction();

    console.log(
      "📥 Deposit monitor:",
      result
    );

  } catch (error) {

    console.error(
      "❌ Deposit monitor:",
      error.message
    );

  } finally {

    depositMonitorRunning =
      false;
  }
}

// ============================================================
// 36. START DEPOSIT MONITOR
// ============================================================

function startDepositMonitor() {

  if (
    !deposit
  ) {

    console.warn(
      "⚠️ Deposit service unavailable."
    );

    return false;
  }

  const hasMonitor =
    typeof deposit.monitorPendingDeposits ===
      "function" ||
    typeof deposit.monitorDeposits ===
      "function";

  if (
    !hasMonitor
  ) {

    console.warn(
      "⚠️ No deposit monitor function is exported."
    );

    return false;
  }

  let minutes =
    Number(
      process.env.DEPOSIT_MONITOR_MINUTES ||
        1
    );

  if (
    !Number.isFinite(
      minutes
    ) ||
    minutes < 1
  ) {

    minutes =
      1;
  }

  console.log(
    `⏰ Deposit monitor: every ${minutes} minute(s).`
  );

  // ----------------------------------------------------------
  // IMMEDIATE CHECK
  // ----------------------------------------------------------

  setTimeout(
    () => {

      runDepositMonitorNow();

    },
    5000
  );

  // ----------------------------------------------------------
  // PREVENT DUPLICATES
  // ----------------------------------------------------------

  if (
    depositMonitorTimer
  ) {

    clearInterval(
      depositMonitorTimer
    );
  }

  // ----------------------------------------------------------
  // TIMER
  // ----------------------------------------------------------

  depositMonitorTimer =
    setInterval(
      () => {

        runDepositMonitorNow();

      },
      minutes *
        60 *
        1000
    );

  console.log(
    "✅ Deposit monitor started."
  );

  return true;
}

// ============================================================
// 37. STOP DEPOSIT MONITOR
// ============================================================

function stopDepositMonitor() {

  if (
    depositMonitorTimer
  ) {

    clearInterval(
      depositMonitorTimer
    );

    depositMonitorTimer =
      null;

    console.log(
      "🛑 Deposit monitor stopped."
    );
  }
}

// ============================================================
// 38. WITHDRAWAL MONITOR STATE
// ============================================================

let withdrawalMonitorTimer =
  null;

// ============================================================
// 39. START WITHDRAWAL MONITOR
// ============================================================

function startWithdrawalMonitor() {

  if (
    !withdrawal
  ) {

    console.warn(
      "⚠️ Withdrawal service unavailable."
    );

    return false;
  }

  // ----------------------------------------------------------
  // PREFERRED SERVICE MONITOR
  // ----------------------------------------------------------

  if (
    typeof withdrawal.startMonitor ===
    "function"
  ) {

    try {

      withdrawal.startMonitor();

      console.log(
        "✅ Withdrawal monitor started."
      );

      return true;

    } catch (error) {

      console.error(
        "❌ Withdrawal monitor failed:",
        error.message
      );

      return false;
    }
  }

  // ----------------------------------------------------------
  // FALLBACK
  // ----------------------------------------------------------

  if (
    typeof withdrawal.monitorWithdrawals ===
    "function"
  ) {

    console.warn(
      "⚠️ withdrawal.startMonitor() unavailable; using fallback."
    );

    let minutes =
      Number(
        process.env.WITHDRAWAL_MONITOR_MINUTES ||
          1
      );

    if (
      !Number.isFinite(
        minutes
      ) ||
      minutes < 1
    ) {

      minutes =
        1;
    }

    const run =
      async () => {

        try {

          const result =
            await withdrawal.monitorWithdrawals();

          console.log(
            "💸 Withdrawal monitor:",
            result
          );

        } catch (error) {

          console.error(
            "❌ Withdrawal monitor:",
            error.message
          );
        }
      };

    run();

    if (
      withdrawalMonitorTimer
    ) {

      clearInterval(
        withdrawalMonitorTimer
      );
    }

    withdrawalMonitorTimer =
      setInterval(
        run,
        minutes *
          60 *
          1000
      );

    console.log(
      `✅ Withdrawal monitor fallback started every ${minutes} minute(s).`
    );

    return true;
  }

  console.warn(
    "⚠️ Withdrawal monitoring functions are unavailable."
  );

  return false;
}

// ============================================================
// 40. STOP WITHDRAWAL MONITOR
// ============================================================

function stopWithdrawalMonitor() {

  if (
    withdrawalMonitorTimer
  ) {

    clearInterval(
      withdrawalMonitorTimer
    );

    withdrawalMonitorTimer =
      null;

    console.log(
      "🛑 Withdrawal monitor fallback stopped."
    );
  }

  try {

    if (
      withdrawal &&
      typeof withdrawal.stopMonitor ===
        "function"
    ) {

      withdrawal.stopMonitor();

      console.log(
        "🛑 Withdrawal monitor stopped."
      );
    }

  } catch (error) {

    console.warn(
      "⚠️ Withdrawal monitor shutdown:",
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
      "⚠️ Bybit service unavailable."
    );

    return false;
  }

  if (
    typeof bybit.startMarketSync !==
    "function"
  ) {

    console.warn(
      "⚠️ bybit.startMarketSync() unavailable."
    );

    return false;
  }

  try {

    bybit.startMarketSync();

    console.log(
      "✅ Bybit market synchronization started."
    );

    return true;

  } catch (error) {

    console.error(
      "❌ Market synchronization failed:",
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
      "⚠️ Bybit service unavailable."
    );

    return false;
  }

  if (
    typeof bybit.connectPrivateWebSocket !==
    "function"
  ) {

    console.warn(
      "⚠️ Bybit private WebSocket unavailable."
    );

    return false;
  }

  try {

    await bybit.connectPrivateWebSocket();

    console.log(
      "✅ Bybit private WebSocket connected."
    );

    return true;

  } catch (error) {

    console.warn(
      "⚠️ Bybit WebSocket startup:",
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
      "❌ GLOBAL ERROR:",
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
        "🚀 SAINT CRYPTO TRADE ENGINE"
      );

      console.log(
        "============================================================"
      );

      console.log(
        `🌐 Server: ${HOST}:${PORT}`
      );

      console.log(
        `🌐 Environment: ${NODE_ENV}`
      );

      console.log(
        `🌐 API Prefix: ${API_PREFIX}`
      );

      console.log(
        `🔥 Firebase: ${
          firebaseReady
            ? "READY"
            : "NOT READY"
        }`
      );

      console.log(
        `🔥 Firestore: ${
          firestore
            ? "READY"
            : "UNAVAILABLE"
        }`
      );

      console.log(
        `🔥 RTDB: ${
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
        "🌐 CORS CONFIGURATION"
      );

      console.log(
        "============================================================"
      );

      console.log(
        "✅ localhost:<ANY PORT>"
      );

      console.log(
        "✅ 127.0.0.1:<ANY PORT>"
      );

      console.log(
        "✅ *.web.app"
      );

      console.log(
        "✅ *.firebaseapp.com"
      );

      for (
        const origin of
        knownProductionOrigins
      ) {

        console.log(
          `✅ ${origin}`
        );
      }

      console.log(
        "============================================================"
      );

      // --------------------------------------------------------
      // DEPOSIT CONFIG
      // --------------------------------------------------------

      let depositConfig =
        null;

      try {

        if (
          typeof deposit?.getConfig ===
          "function"
        ) {

          depositConfig =
            deposit.getConfig();
        }

      } catch (error) {

        console.warn(
          "⚠️ Deposit config:",
          error.message
        );
      }

      console.log(
        `📥 Minimum deposit: ${
          depositConfig?.minimum ??
          config?.DEPOSIT_MINIMUM ??
          100
        } USDT`
      );

      console.log(
        `📥 Deposit service: ${
          deposit
            ? "READY"
            : "UNAVAILABLE"
        }`
      );

      // --------------------------------------------------------
      // WITHDRAWAL
      // --------------------------------------------------------

      console.log(
        `💸 Withdrawal service: ${
          withdrawal
            ? "READY"
            : "UNAVAILABLE"
        }`
      );

      console.log(
        `💸 Withdrawal requestWithdrawal: ${
          typeof withdrawal?.requestWithdrawal
        }`
      );

      console.log(
        `💸 Withdrawal startMonitor: ${
          typeof withdrawal?.startMonitor
        }`
      );

      console.log(
        `💸 Withdrawal monitorWithdrawals: ${
          typeof withdrawal?.monitorWithdrawals
        }`
      );

      // --------------------------------------------------------
      // SIGNALS
      // --------------------------------------------------------

      console.log(
        "⏰ Signals: 7PM / 9PM / 11PM EAT"
      );

      console.log(
        "============================================================"
      );

      // --------------------------------------------------------
      // BYBIT WEBSOCKET
      // --------------------------------------------------------

      await startBybitWebSocket();

      // --------------------------------------------------------
      // DEPOSIT MONITOR
      // --------------------------------------------------------

      startDepositMonitor();

      // --------------------------------------------------------
      // WITHDRAWAL MONITOR
      // --------------------------------------------------------

      startWithdrawalMonitor();

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
            "✅ Telegram withdrawal approval started."
          );

        } catch (error) {

          console.error(
            "❌ Telegram withdrawal approval failed:",
            error.message
          );
        }

      }

      // --------------------------------------------------------
      // SIGNAL SCHEDULER
      // --------------------------------------------------------

      if (
        firebaseManager &&
        typeof firebaseManager.startSignalScheduler ===
          "function"
      ) {

        try {

          firebaseManager.startSignalScheduler();

          console.log(
            "✅ Signal scheduler started."
          );

        } catch (error) {

          console.error(
            "❌ Signal scheduler failed:",
            error.message
          );
        }

      } else {

        console.error(
          "❌ Signal scheduler unavailable because firebase_manager.js does not expose startSignalScheduler()."
        );
      }

      // --------------------------------------------------------
      // BACKEND READY
      // --------------------------------------------------------

      console.log(
        "============================================================"
      );

      console.log(
        "🟢 SAINT CRYPTO BACKEND READY"
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
              "📱 SAINT CRYPTO BACKEND IS ONLINE alert sent to Telegram."
            );

          } else {

            console.error(
              "❌ SAINT CRYPTO BACKEND ONLINE alert was not delivered."
            );
          }

        } catch (error) {

          console.error(
            "❌ Backend ONLINE Telegram alert failed:",
            error.message
          );
        }

      } else {

        console.error(
          "❌ Telegram ONLINE alert unavailable because firebase_manager.js does not expose sendBackendOnlineAlert()."
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
    `🧹 ${signalName} received. Shutting down...`
  );

  // ----------------------------------------------------------
  // DEPOSIT
  // ----------------------------------------------------------

  try {

    stopDepositMonitor();

  } catch (error) {

    console.warn(
      "⚠️ Deposit shutdown:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // WITHDRAWAL
  // ----------------------------------------------------------

  try {

    stopWithdrawalMonitor();

  } catch (error) {

    console.warn(
      "⚠️ Withdrawal shutdown:",
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
        "🛑 Market synchronization stopped."
      );
    }

  } catch (error) {

    console.warn(
      "⚠️ Market sync shutdown:",
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
        "🛑 Bybit WebSocket closed."
      );
    }

  } catch (error) {

    console.warn(
      "⚠️ Bybit WebSocket shutdown:",
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
        "🛑 Firebase manager stopped."
      );
    }

  } catch (error) {

    console.warn(
      "⚠️ Firebase manager shutdown:",
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
          "🛑 HTTP server closed."
        );

        process.exit(
          0
        );
      }
    );

  } catch (error) {

    console.error(
      "❌ HTTP server shutdown:",
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
        "⚠️ Forced shutdown after timeout."
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
      "❌ Unhandled Promise Rejection:"
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
      "❌ Uncaught Exception:"
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