"use strict";

// ============================================================
// SAINT CRYPTO TRADE ENGINE
// services/bybit.js
//
// FIXED BYBIT SERVICE
//
// RESPONSIBILITIES:
// - Bybit REST API
// - Deposit verification
// - Withdrawal submission
// - Withdrawal status
// - Live market prices
// - Market price synchronization
// - Market sentiment synchronization
// - Private Bybit WebSocket
//
// IMPORTANT:
// This file does NOT import configuration from kendrick.js.
// Configuration comes directly from process.env.
// ============================================================

require("dotenv").config();

const crypto = require("crypto");
const WebSocket = require("ws");

// node-cron is optional.
// The service can still load if it is not installed.
let cron = null;

try {
  cron = require("node-cron");
} catch (error) {
  console.warn(
    "⚠️ node-cron is not installed. Automatic market sync disabled."
  );
}

// Bybit SDK
const {
  RestClientV5,
} = require("bybit-api");

// Firebase Admin
const {
  getFirestore,
} = require("firebase-admin/firestore");

const {
  getDatabase,
} = require("firebase-admin/database");

// ============================================================
// 1. ENVIRONMENT HELPERS
// ============================================================

function env(name, fallback = "") {
  const value = process.env[name];

  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value).trim();
}

function num(name, fallback) {
  const value = Number.parseFloat(
    process.env[name]
  );

  return Number.isFinite(value)
    ? value
    : fallback;
}

function bool(name, fallback = false) {
  const value = env(name, "");

  if (!value) {
    return fallback;
  }

  return [
    "true",
    "1",
    "yes",
    "on",
  ].includes(
    value.toLowerCase()
  );
}

// ============================================================
// 2. BYBIT CONFIGURATION
// ============================================================

const BYBIT_API_KEY =
  env("BYBIT_API_KEY");

const BYBIT_API_SECRET =
  env("BYBIT_API_SECRET");

const BYBIT_TESTNET =
  bool("BYBIT_TESTNET", false);

const BYBIT_RECV_WINDOW =
  num(
    "BYBIT_RECV_WINDOW",
    5000
  );

const BYBIT_TIMEOUT_MS =
  num(
    "BYBIT_TIMEOUT_MS",
    15000
  );

const BYBIT_RETRY_ATTEMPTS =
  Math.max(
    1,
    Math.floor(
      num(
        "BYBIT_RETRY_ATTEMPTS",
        3
      )
    )
  );

const BYBIT_RETRY_DELAY =
  num(
    "BYBIT_RETRY_DELAY",
    2
  );

// ============================================================
// 3. DEPOSIT CONFIGURATION
// ============================================================

const DEPOSIT_COIN =
  env(
    "DEPOSIT_COIN",
    "USDT"
  );

const DEPOSIT_CHAIN =
  env(
    "DEPOSIT_CHAIN",
    "TRX"
  );

const CENTRAL_DEPOSIT_ADDRESS =
  env(
    "CENTRAL_DEPOSIT_ADDRESS",
    ""
  );

// ============================================================
// 4. WITHDRAWAL CONFIGURATION
// ============================================================

const WITHDRAW_COIN =
  env(
    "WITHDRAW_COIN",
    "USDT"
  );

const WITHDRAW_CHAIN =
  env(
    "WITHDRAW_CHAIN",
    "TRX"
  );

const WITHDRAW_ACCOUNT_TYPE =
  env(
    "WITHDRAW_ACCOUNT",
    env(
      "WITHDRAW_ACCOUNT_TYPE",
      "FUND"
    )
  );

// ============================================================
// ============================================================
// BYBIT DIAGNOSTIC
// ============================================================

function printBybitDiagnostic() {
  const safeKey =
    BYBIT_API_KEY
      ? `${BYBIT_API_KEY.slice(0, 4)}********${BYBIT_API_KEY.slice(-4)}`
      : "<MISSING>";

  console.log("");
  console.log("============================================================");
  console.log("[BYBIT DIAGNOSTIC] REST CONFIGURATION");
  console.log("============================================================");
  console.log(
    `[BYBIT DIAGNOSTIC] TESTNET: ${BYBIT_TESTNET}`
  );
  console.log(
    `[BYBIT DIAGNOSTIC] API KEY: ${safeKey}`
  );
  console.log(
    `[BYBIT DIAGNOSTIC] API SECRET: ${
      BYBIT_API_SECRET ? "<LOADED>" : "<MISSING>"
    }`
  );
  console.log(
    `[BYBIT DIAGNOSTIC] WITHDRAW COIN: ${WITHDRAW_COIN}`
  );
  console.log(
    `[BYBIT DIAGNOSTIC] WITHDRAW CHAIN: ${WITHDRAW_CHAIN}`
  );
  console.log(
    `[BYBIT DIAGNOSTIC] ACCOUNT TYPE: ${WITHDRAW_ACCOUNT_TYPE}`
  );
  console.log("============================================================");
  console.log("");
}

printBybitDiagnostic();

// 5. INTERNAL HELPERS
// ============================================================

function roundMoney(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.round(
    number * 100000000
  ) / 100000000;
}

function sleep(seconds) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        Math.max(
          0,
          Number(seconds) * 1000
        )
      )
  );
}

// ============================================================
// 6. FIREBASE HELPERS
// ============================================================

function firestore() {
  return getFirestore();
}

function realtimeDatabase() {
  try {
    return getDatabase();
  } catch (error) {
    console.warn(
      "⚠️ Firebase RTDB unavailable:",
      error.message
    );

    return null;
  }
}

// ============================================================
// 7. BYBIT CLIENT
// ============================================================

const client =
  new RestClientV5({
    key: BYBIT_API_KEY,
    secret: BYBIT_API_SECRET,
    testnet: BYBIT_TESTNET,
    recv_window:
      BYBIT_RECV_WINDOW,
  });

// ============================================================
// 8. STATE
// ============================================================

let ws = null;

let pingTimer = null;

let reconnectTimer = null;

let marketTask = null;

// ============================================================
// 9. CONFIGURATION STATUS
// ============================================================

function isBybitConfigured() {
  return Boolean(
    BYBIT_API_KEY &&
    BYBIT_API_SECRET
  );
}

// ============================================================
// 10. SAFE BYBIT REQUEST
// ============================================================

async function request(
  operation,
  label = "Bybit request"
) {
  if (!isBybitConfigured()) {
    throw new Error(
      "Bybit credentials are not configured."
    );
  }

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= BYBIT_RETRY_ATTEMPTS;
    attempt++
  ) {
    try {
      const timeoutPromise =
        new Promise(
          (_, reject) => {
            setTimeout(
              () => {
                reject(
                  new Error(
                    `${label} timed out after ${BYBIT_TIMEOUT_MS}ms`
                  )
                );
              },
              BYBIT_TIMEOUT_MS
            );
          }
        );

      const result =
        await Promise.race([
          operation(),
          timeoutPromise,
        ]);

      return result;
    } catch (error) {
      lastError = error;

      console.warn(
        `⚠️ ${label} attempt ${attempt}/${BYBIT_RETRY_ATTEMPTS}: ${error.message}`
      );

      if (
        attempt <
        BYBIT_RETRY_ATTEMPTS
      ) {
        await sleep(
          BYBIT_RETRY_DELAY
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      `${label} failed.`
    )
  );
}

// ============================================================
// 10A. SAFE PUBLIC BYBIT REQUEST
// ============================================================
// Bybit market ticker endpoints are public. They must NOT require
// API credentials or pass through the private-auth configuration
// gate used by request().
async function publicRequest(
  operation,
  label = "Bybit public request"
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= BYBIT_RETRY_ATTEMPTS;
    attempt++
  ) {
    try {
      const timeoutPromise =
        new Promise(
          (_, reject) => {
            setTimeout(
              () => {
                reject(
                  new Error(
                    `${label} timed out after ${BYBIT_TIMEOUT_MS}ms`
                  )
                );
              },
              BYBIT_TIMEOUT_MS
            );
          }
        );

      const result =
        await Promise.race([
          operation(),
          timeoutPromise,
        ]);

      return result;
    } catch (error) {
      lastError = error;

      console.warn(
        `⚠️ ${label} attempt ${attempt}/${BYBIT_RETRY_ATTEMPTS}: ${error.message}`
      );

      if (
        attempt <
        BYBIT_RETRY_ATTEMPTS
      ) {
        await sleep(
          BYBIT_RETRY_DELAY
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      `${label} failed.`
    )
  );
}

// ============================================================
// 11. DEPOSIT RECORDS
// ============================================================

async function getDepositRecords(
  txid
) {
  const transactionId =
    String(
      txid || ""
    ).trim();

  if (!transactionId) {
    throw new Error(
      "Transaction ID is required."
    );
  }

  return request(
    () =>
      client.getDepositRecords({
        coin: DEPOSIT_COIN,
        txID: transactionId,
        limit: 50,
      }),
    "Deposit verification"
  );
}

// ============================================================
// 12. FIND CONFIRMED DEPOSIT
// ============================================================

async function findConfirmedDeposit(
  txid,
  expectedAmount
) {
  const transactionId =
    String(
      txid || ""
    ).trim();

  const amount =
    Number(expectedAmount);

  if (!transactionId) {
    throw new Error(
      "Transaction ID is required."
    );
  }

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "A valid deposit amount is required."
    );
  }

  const response =
    await getDepositRecords(
      transactionId
    );

  if (
    !response ||
    response.retCode !== 0
  ) {
    throw new Error(
      "We could not verify this transaction with the payment network yet."
    );
  }

  const rows =
    response.result?.rows ||
    [];

  const expectedTx =
    transactionId.toLowerCase();

  const expectedChain =
    DEPOSIT_CHAIN
      .toUpperCase();

  const expectedAddress =
    CENTRAL_DEPOSIT_ADDRESS;

  const match =
    rows.find(
      (row) => {
        const rowTx =
          String(
            row.txID || ""
          )
            .trim()
            .toLowerCase();

        const rowAmount =
          Number(
            row.amount || 0
          );

        const rowChain =
          String(
            row.chain || ""
          )
            .trim()
            .toUpperCase();

        const rowAddress =
          String(
            row.toAddress || ""
          ).trim();

        const amountMatches =
          Math.abs(
            rowAmount -
              amount
          ) < 0.01;

        const txMatches =
          rowTx ===
          expectedTx;

        const chainMatches =
          rowChain ===
            "TRX" ||
          rowChain ===
            "TRC20" ||
          (
            expectedChain &&
            rowChain ===
              expectedChain
          );

        const statusMatches =
          Number(
            row.status
          ) === 3;

        const addressMatches =
          !expectedAddress ||
          rowAddress ===
            expectedAddress;

        return (
          txMatches &&
          amountMatches &&
          chainMatches &&
          statusMatches &&
          addressMatches
        );
      }
    );

  return match || null;
}

// ============================================================
// 13. SUBMIT WITHDRAWAL
// ============================================================

async function submitWithdrawal(
  address,
  amount,
  requestId
) {
  const destination =
    String(
      address || ""
    ).trim();

  const withdrawalAmount =
    Number(amount);

  const clientRequestId =
    String(
      requestId ||
        `saint-${Date.now()}-${crypto
          .randomBytes(8)
          .toString("hex")}`
    ).trim();

  if (!destination) {
    throw new Error(
      "Withdrawal address is required."
    );
  }

  if (
    !Number.isFinite(
      withdrawalAmount
    ) ||
    withdrawalAmount <= 0
  ) {
    throw new Error(
      "Invalid withdrawal amount."
    );
  }

  const response =
    await request(
      () =>
        client.submitWithdrawal({
          coin: WITHDRAW_COIN,
          chain: WITHDRAW_CHAIN,
          address: destination,
          amount:
            String(
              withdrawalAmount
            ),
          timestamp:
            Date.now(),
          forceChain: 1,
          accountType:
            WITHDRAW_ACCOUNT_TYPE,
          requestId:
            clientRequestId,
          feeType: 0,
        }),
      "Withdrawal request"
    );

  if (
    !response ||
    response.retCode !== 0
  ) {
    throw new Error(
      response?.retMsg ||
        "The payment network rejected the withdrawal request."
    );
  }

  const withdrawalId =
    response.result?.id;

  if (!withdrawalId) {
    throw new Error(
      "The payment network did not return a withdrawal reference."
    );
  }

  return {
    withdrawalId,
    response,
  };
}

// ============================================================
// 14. GET WITHDRAWAL
// ============================================================

async function getWithdrawal(
  withdrawalId
) {
  const id =
    String(
      withdrawalId || ""
    ).trim();

  if (!id) {
    throw new Error(
      "Withdrawal ID is required."
    );
  }

  const response =
    await request(
      () =>
        client.getWithdrawalRecords({
          coin: WITHDRAW_COIN,
          withdrawType: 0,
          withdrawID: id,
          limit: 50,
        }),
      "Withdrawal status"
    );

  if (
    !response ||
    response.retCode !== 0
  ) {
    throw new Error(
      "We couldn't check the payment network for the withdrawal status."
    );
  }

  const rows =
    response.result?.rows ||
    [];

  return (
    rows.find(
      (row) =>
        String(
          row.withdrawId
        ) === id
    ) ||
    null
  );
}

// ============================================================
// 15. GET TICKER
// ============================================================

async function getTickerData(
  symbol,
  category = "spot"
) {
  const cleanSymbol =
    String(
      symbol || ""
    )
      .trim()
      .toUpperCase();

  if (!cleanSymbol) {
    throw new Error(
      "Symbol is required."
    );
  }

  const response =
    await publicRequest(
      () =>
        client.getTickers({
          category,
          symbol: cleanSymbol,
        }),
      `Bybit public ticker ${cleanSymbol}`
    );

  const ticker =
    response?.result?.list?.[0] || {};

  const price = Number(ticker.lastPrice || 0);

  const price24hPcnt =
    Number(ticker.price24hPcnt || 0);

  return {
    symbol: cleanSymbol,
    price,
    change24h: Number.isFinite(price24hPcnt)
      ? price24hPcnt * 100
      : 0,
    raw: ticker,
  };
}

async function getTicker(
  symbol,
  category = "spot"
) {
  const ticker =
    await getTickerData(symbol, category);

  return ticker.price;
}

// ============================================================
// 16. SYNC ONE MARKET PRICE
// ============================================================

const MARKET_HISTORY_LIMIT = 120;

async function syncMarketPrice(
  symbol,
  displaySymbol,
  category = "spot"
) {
  if (!isBybitConfigured()) {
    return null;
  }

  try {
    const ticker =
      await getTickerData(
        symbol,
        category
      );

    const price = Number(ticker.price);

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return null;
    }

    const now = new Date();
    const updatedAt = now.toISOString();
    const change24h = Number.isFinite(ticker.change24h)
      ? Number(ticker.change24h.toFixed(4))
      : 0;

    const payload = {
      symbol:
        displaySymbol ||
        symbol,
      price:
        roundMoney(price),
      change24h,
      priceChangePercent: change24h,
      updatedAt,
    };

    // Firestore — authoritative latest ticker snapshot.
    await firestore()
      .collection(
        "market_prices"
      )
      .doc(symbol)
      .set(
        payload,
        {
          merge: true,
        }
      );

    // RTDB — Flutter reads live market data from here.
    const db = realtimeDatabase();

    if (db) {
      const marketRef = db.ref(
        `market_prices/${symbol}`
      );

      await marketRef.set(payload);

      // Rolling real-price history for the live chart.
      const historyRef = marketRef.child("history");
      const historySnap = await historyRef.once("value");
      const existing = historySnap.val() || {};

      const nextKey = String(Date.now());
      existing[nextKey] = {
        price: roundMoney(price),
        timestamp: now.getTime(),
      };

      const entries = Object.entries(existing)
        .sort((a, b) => {
          const ta = Number(a[1]?.timestamp || 0);
          const tb = Number(b[1]?.timestamp || 0);
          return ta - tb;
        });

      const trimmed = entries.slice(-MARKET_HISTORY_LIMIT);
      const trimmedObject = Object.fromEntries(trimmed);

      await historyRef.set(trimmedObject);
    }

    console.log(
      `📈 Market sync ${symbol}: ${payload.price} | 24h ${payload.change24h}%`
    );

    return payload;
  } catch (error) {
    console.warn(
      `⚠️ Market sync ${symbol}:`,
      error.message
    );

    return null;
  }
}

// ============================================================
// 17. SYNC MARKETS
// ============================================================

const LIVE_MARKETS = [
  ["BTCUSDT", "BTC/USDT", "spot"],
  ["ETHUSDT", "ETH/USDT", "spot"],
  ["ADAUSDT", "ADA/USDT", "spot"],
  ["BCHUSDT", "BCH/USDT", "spot"],
  ["DASHUSDT", "DASH/USDT", "spot"],
  ["DOGEUSDT", "DOGE/USDT", "spot"],
];

async function syncMarkets() {
  if (!isBybitConfigured()) {
    return false;
  }

  for (const [symbol, displaySymbol, category] of LIVE_MARKETS) {
    await syncMarketPrice(
      symbol,
      displaySymbol,
      category
    );
  }

  return true;
}

// ============================================================
// 18. MARKET SENTIMENT
// ============================================================
//
// This does NOT fabricate a market signal.
// It synchronizes configured CALL/PUT percentages.
// ============================================================

async function syncSentiment() {
  const db =
    realtimeDatabase();

  if (!db) {
    return false;
  }

  try {
    const call =
      num(
        "BTC_CALL_PERCENTAGE",
        50
      );

    const put =
      num(
        "BTC_PUT_PERCENTAGE",
        50
      );

    await db
      .ref(
        "market_sentiment/BTCUSDT"
      )
      .set({
        call_percentage:
          call,
        put_percentage:
          put,
        updatedAt:
          new Date().toISOString(),
      });

    return true;
  } catch (error) {
    console.warn(
      "⚠️ Sentiment sync:",
      error.message
    );

    return false;
  }
}

// ============================================================
// 19. START MARKET SYNC
// ============================================================

const MARKET_SYNC_INTERVAL_MS = 5000;

function startMarketSync() {
  if (marketTask) {
    return;
  }

  console.log(
    `🟢 Bybit live market synchronization started: every ${MARKET_SYNC_INTERVAL_MS / 1000} seconds.`
  );

  // Immediate first sync.
  syncMarkets().catch(
    (error) =>
      console.warn(
        "⚠️ Initial market sync:",
        error.message
      )
  );

  syncSentiment().catch(
    (error) =>
      console.warn(
        "⚠️ Initial sentiment sync:",
        error.message
      )
  );

  marketTask = setInterval(() => {
    syncMarkets().catch(
      (error) =>
        console.warn(
          "⚠️ Scheduled market sync:",
          error.message
        )
    );

    syncSentiment().catch(
      (error) =>
        console.warn(
          "⚠️ Scheduled sentiment sync:",
          error.message
        )
    );
  }, MARKET_SYNC_INTERVAL_MS);
}

// ============================================================
// 20. STOP MARKET SYNC
// ============================================================

function stopMarketSync() {
  if (!marketTask) {
    return;
  }

  try {
    clearInterval(marketTask);
  } catch (_) {}

  marketTask = null;

  console.log(
    "🛑 Bybit market synchronization stopped."
  );
}

// ============================================================
// 21. PRIVATE WEBSOCKET
// ============================================================

async function connectPrivateWebSocket() {
  if (!isBybitConfigured()) {
    console.warn(
      "⚠️ Private Bybit WebSocket not started: credentials missing."
    );

    return;
  }

  if (
    ws &&
    ws.readyState ===
      WebSocket.OPEN
  ) {
    return;
  }

  const url =
    BYBIT_TESTNET
      ? "wss://stream-testnet.bybit.com/v5/private"
      : "wss://stream.bybit.com/v5/private";

  try {
    ws =
      new WebSocket(
        url
      );

    ws.on(
      "open",
      () => {
        try {
          const expires =
            Date.now() +
            10000;

          const signature =
            crypto
              .createHmac(
                "sha256",
                BYBIT_API_SECRET
              )
              .update(
                `GET/realtime${expires}`
              )
              .digest(
                "hex"
              );

          ws.send(
            JSON.stringify({
              op: "auth",
              args: [
                BYBIT_API_KEY,
                expires,
                signature,
              ],
            })
          );

          if (pingTimer) {
            clearInterval(
              pingTimer
            );
          }

          pingTimer =
            setInterval(
              () => {
                if (
                  ws &&
                  ws.readyState ===
                    WebSocket.OPEN
                ) {
                  try {
                    ws.send(
                      JSON.stringify({
                        op: "ping",
                      })
                    );
                  } catch (_) {}
                }
              },
              20000
            );

          console.log(
            "🟢 Bybit private WebSocket connected."
          );
        } catch (error) {
          console.warn(
            "⚠️ WebSocket authentication error:",
            error.message
          );
        }
      }
    );

    ws.on(
      "message",
      (raw) => {
        try {
          const message =
            JSON.parse(
              raw.toString()
            );

          if (
            message.op ===
              "auth" &&
            message.success
          ) {
            console.log(
              "✅ Bybit WebSocket authenticated."
            );

            ws.send(
              JSON.stringify({
                op: "subscribe",
                args: [
                  "wallet",
                ],
              })
            );
          }

          // Wallet updates can be consumed
          // by another service later.
          if (
            message.topic ===
            "wallet"
          ) {
            // Intentionally no automatic
            // ledger mutation here.
            //
            // External Bybit wallet state must
            // never silently overwrite the
            // Saint Crypto internal ledger.
          }
        } catch (error) {
          console.warn(
            "⚠️ WebSocket parse error:",
            error.message
          );
        }
      }
    );

    ws.on(
      "error",
      (error) => {
        console.warn(
          "⚠️ Bybit WebSocket error:",
          error.message
        );
      }
    );

    ws.on(
      "close",
      () => {
        if (pingTimer) {
          clearInterval(
            pingTimer
          );

          pingTimer = null;
        }

        ws = null;

        if (
          !reconnectTimer
        ) {
          reconnectTimer =
            setTimeout(
              () => {
                reconnectTimer =
                  null;

                connectPrivateWebSocket()
                  .catch(
                    () => {}
                  );
              },
              3000
            );
        }
      }
    );
  } catch (error) {
    console.warn(
      "⚠️ Could not create Bybit WebSocket:",
      error.message
    );

    ws = null;
  }
}

// ============================================================
// 22. CLOSE PRIVATE WEBSOCKET
// ============================================================

function closePrivateWebSocket() {
  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer = null;
  }

  if (pingTimer) {
    clearInterval(
      pingTimer
    );

    pingTimer = null;
  }

  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch (_) {}

    ws = null;
  }

  console.log(
    "🛑 Bybit private WebSocket closed."
  );
}

// ============================================================
// 23. SERVICE STATUS
// ============================================================

function getConfig() {
  return {
    configured:
      isBybitConfigured(),

    testnet:
      BYBIT_TESTNET,

    depositCoin:
      DEPOSIT_COIN,

    depositChain:
      DEPOSIT_CHAIN,

    withdrawalCoin:
      WITHDRAW_COIN,

    withdrawalChain:
      WITHDRAW_CHAIN,

    withdrawalAccount:
      WITHDRAW_ACCOUNT_TYPE,

    timeoutMs:
      BYBIT_TIMEOUT_MS,

    retryAttempts:
      BYBIT_RETRY_ATTEMPTS,
  };
}

// ============================================================
// 24. EXPORTS
// ============================================================

module.exports = {
  // Client
  client,

  // Configuration
  isBybitConfigured,
  getConfig,

  // REST request helper
  request,

  // Deposits
  getDepositRecords,
  findConfirmedDeposit,

  // Withdrawals
  submitWithdrawal,
  getWithdrawal,

  // Market
  getTicker,
  getTickerData,
  syncMarketPrice,
  syncMarkets,
  syncSentiment,

  // Market worker
  startMarketSync,
  stopMarketSync,

  // WebSocket
  connectPrivateWebSocket,
  closePrivateWebSocket,
};