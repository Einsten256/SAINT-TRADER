"use strict";

// ============================================================
// SAINT CRYPTO TRADE ENGINE
// services/withdrawal.js
//
// WITHDRAWAL SERVICE
//
// IMPORTANT:
// - No Express routes here.
// - No Firebase initialization here.
// - No UID hardcoding.
// - UID always comes from Firebase authentication.
// - User funds are reserved before Bybit submission.
// - Failed submissions restore the reserved funds.
// - Failed Bybit withdrawals are automatically refunded.
// ============================================================

require("dotenv").config();

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { RestClientV5 } = require("bybit-api");

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

// ============================================================
// FIRESTORE
// ============================================================

let firestore;

try {
  firestore = getFirestore();
} catch (error) {
  console.error(
    "❌ withdrawal.js: Firestore unavailable:",
    error.message
  );
}

// ============================================================
// HELPERS
// ============================================================

function env(...names) {
  for (const name of names) {
    const value = process.env[name];

    if (
      value !== undefined &&
      String(value).trim() !== ""
    ) {
      return String(value).trim();
    }
  }

  return "";
}

function num(value, fallback) {
  const n = Number.parseFloat(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function int(value, fallback) {
  const n = Number.parseInt(
    value,
    10
  );

  return Number.isFinite(n)
    ? n
    : fallback;
}

function roundMoney(
  value,
  decimals = 4
) {
  const factor =
    10 ** decimals;

  return (
    Math.round(
      (Number(value) || 0) *
        factor
    ) / factor
  );
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ============================================================
// WITHDRAWAL CONFIGURATION
// ============================================================

const WITHDRAW_COIN =
  env(
    "WITHDRAWAL_COIN",
    "WITHDRAW_COIN"
  ) || "USDT";

const WITHDRAW_CHAIN =
  (
    env(
      "WITHDRAWAL_CHAIN",
      "WITHDRAW_CHAIN"
    ) || "TRX"
  ).toUpperCase();

const WITHDRAW_ACCOUNT_TYPE =
  (
    env(
      "BYBIT_WITHDRAWAL_ACCOUNT_TYPE",
      "BYBIT_WITHDRAW_ACCOUNT_TYPE"
    ) || "FUND"
  ).toUpperCase();

const WITHDRAW_MINIMUM =
  num(
    env(
      "MIN_WITHDRAWAL_AMOUNT",
      "WITHDRAW_MINIMUM"
    ),
    2
  );

const WITHDRAW_MAXIMUM =
  num(
    env(
      "MAX_WITHDRAWAL_AMOUNT",
      "WITHDRAW_MAXIMUM"
    ),
    100000
  );

// ============================================================
// MASTER WITHDRAWAL FEE
//
// User requests $100
// 5% fee = $5
// User receives $95
// ============================================================

const WITHDRAW_FEE_PERCENT = 5;

// ============================================================
// BYBIT CONFIGURATION
// ============================================================

const BYBIT_API_KEY =
  env("BYBIT_API_KEY");

const BYBIT_API_SECRET =
  env("BYBIT_API_SECRET");

const BYBIT_TESTNET =
  String(
    process.env.BYBIT_TESTNET ||
      "false"
  ).toLowerCase() ===
  "true";

const BYBIT_RECV_WINDOW =
  int(
    process.env.BYBIT_RECV_WINDOW,
    10000
  );

const BYBIT_TIMEOUT_MS =
  int(
    process.env.BYBIT_TIMEOUT_MS,
    30000
  );

const BYBIT_RETRY_ATTEMPTS =
  Math.max(
    1,
    int(
      process.env.BYBIT_RETRY_ATTEMPTS,
      3
    )
  );

const BYBIT_RETRY_DELAY =
  Math.max(
    1,
    int(
      process.env.BYBIT_RETRY_DELAY,
      2
    )
  );

// ============================================================
// BYBIT CLIENT
// ============================================================

const bybitClient =
  new RestClientV5({
    key:
      BYBIT_API_KEY,

    secret:
      BYBIT_API_SECRET,

    testnet:
      BYBIT_TESTNET,

    recv_window:
      BYBIT_RECV_WINDOW,
  });

// ============================================================
// BYBIT REQUEST WRAPPER
// ============================================================

async function bybitRequest(
  operation,
  label
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <=
      BYBIT_RETRY_ATTEMPTS;
    attempt++
  ) {
    try {
      return await Promise.race([
        operation(),

        new Promise(
          (_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    `${label} timed out after ${BYBIT_TIMEOUT_MS}ms.`
                  )
                ),
              BYBIT_TIMEOUT_MS
            );
          }
        ),
      ]);
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
          BYBIT_RETRY_DELAY *
            1000
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
// TRON ADDRESS VALIDATION
// ============================================================

function validTron(
  address
) {
  return (
    typeof address ===
      "string" &&
    /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(
      address.trim()
    )
  );
}

// ============================================================
// BALANCE NORMALIZATION
// ============================================================

function balancesOf(
  data = {}
) {
  const main =
    Number(
      data.usdt_balance ||
        0
    );

  const balances =
    data.balances || {};

  return {
    exchange:
      roundMoney(
        balances.exchange ??
          main
      ),

    trade:
      roundMoney(
        balances.trade ??
          0
      ),

    perpetual:
      roundMoney(
        balances.perpetual ??
          0
      ),

    withdraw:
      roundMoney(
        balances.withdraw ??
          0
      ),
  };
}

// ============================================================
// RESERVE WITHDRAWAL
// ============================================================

async function reserveWithdrawal(
  userId,
  amount
) {
  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  let result = null;

  const userRef =
    firestore
      .collection("users")
      .doc(userId);

  await firestore.runTransaction(
    async (transaction) => {
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
        userDoc.data();

      if (
        user.is_frozen ===
          true ||
        user.status ===
          "FROZEN"
      ) {
        throw new Error(
          "Your account is currently restricted."
        );
      }

      const balance =
        Number(
          user.usdt_balance ||
            0
        );

      const locked =
        Number(
          user.locked_principal ||
            0
        );

      const withdrawable =
        Math.max(
          0,
          balance - locked
        );

      const withdrawalWallet =
        String(
          user.withdrawal_wallet_address ||
            ""
        ).trim();

      if (
        user.withdrawal_wallet_locked !== true ||
        !validTron(withdrawalWallet)
      ) {
        throw new Error(
          "Please register your withdrawal wallet before requesting a withdrawal."
        );
      }

      const balances =
        balancesOf(user);

      // The user can withdraw only what has already
      // been staged in the Withdraw account.
      if (
        amount >
        withdrawable
      ) {
        throw new Error(
          `Your available withdrawable balance is $${withdrawable.toFixed(2)} USDT.`
        );
      }

      if (
        amount >
        balances.withdraw
      ) {
        throw new Error(
          `Your Withdraw balance is $${balances.withdraw.toFixed(2)} USDT. Move available funds from Trade to Withdraw before requesting a withdrawal.`
        );
      }

      // --------------------------------------------------------
      // 5% withdrawal fee
      // --------------------------------------------------------

      const fee =
        roundMoney(
          amount *
            (WITHDRAW_FEE_PERCENT /
              100)
        );

      const net =
        roundMoney(
          amount - fee
        );

      if (net <= 0) {
        throw new Error(
          "The withdrawal amount is too small after the withdrawal fee."
        );
      }



      // --------------------------------------------------------
      // Withdrawals may ONLY consume funds staged in Withdraw.
      //
      // Exchange is never used as a fallback.
      // Trade -> Withdraw must happen first through /transfer.
      // --------------------------------------------------------

      if (
        balances.withdraw <
        amount
      ) {
        throw new Error(
          `Your Withdraw balance is $${balances.withdraw.toFixed(2)} USDT. Move available funds from Trade to Withdraw before requesting a withdrawal.`
        );
      }

      balances.withdraw =
        roundMoney(
          balances.withdraw -
            amount
        );

      // --------------------------------------------------------
      // Create withdrawal record.
      // --------------------------------------------------------

      const withdrawalRef =
        firestore
          .collection(
            "withdrawals"
          )
          .doc();

      transaction.set(
        withdrawalRef,
        {
          withdrawalId:
            withdrawalRef.id,

          userId,

          grossAmount:
            amount,

          feeDeducted:
            fee,

          feePercent:
            WITHDRAW_FEE_PERCENT,

          netPayout:
            net,

          status:
            "UNDER_REVIEW",

          fundsReserved:
            true,

          fundsRestored:
            false,

          currency:
            "USDT",

          destinationAddress:
            withdrawalWallet,

          destinationNetwork:
            "TRC20",

          coin:
            WITHDRAW_COIN,

          chain:
            WITHDRAW_CHAIN,

          approvalStatus:
            "UNDER_REVIEW",

          createdAt:
            FieldValue.serverTimestamp(),

          requestedAt:
            FieldValue.serverTimestamp(),
        }
      );

      // --------------------------------------------------------
      // Update user balance.
      // --------------------------------------------------------

      transaction.set(
        userRef,
        {
          usdt_balance:
            roundMoney(
              balance -
                amount
            ),

          balances,

          updatedAt:
            FieldValue.serverTimestamp(),

          last_updated:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      // --------------------------------------------------------
      // Ledger entry.
      // --------------------------------------------------------

      const ledgerRef =
        firestore
          .collection(
            "ledger_transactions"
          )
          .doc();

      transaction.set(
        ledgerRef,
        {
          ledgerTransactionId:
            ledgerRef.id,

          userId,

          type:
            "WITHDRAWAL_RESERVE",

          direction:
            "DEBIT",

          amount,

          currency:
            "USDT",

          source:
            "BYBIT_WITHDRAWAL",

          withdrawalId:
            withdrawalRef.id,

          feeDeducted:
            fee,

          feePercent:
            WITHDRAW_FEE_PERCENT,

          netPayout:
            net,

          createdAt:
            FieldValue.serverTimestamp(),
        }
      );

      result = {
        withdrawalId:
          withdrawalRef.id,

        grossAmount:
          amount,

        feeDeducted:
          fee,

        feePercent:
          WITHDRAW_FEE_PERCENT,

        netPayout:
          net,

        destinationAddress:
          withdrawalWallet,
      };
    }
  );

  return result;
}// ============================================================
// RESTORE WITHDRAWAL
//
// Used when Bybit rejects the request or later marks it failed.
// Reserved funds are restored to Withdraw, not Exchange.
//
// IMPORTANT:
// fundsRestored prevents double refunds.
// ============================================================

async function restoreWithdrawal(
  withdrawalId,
  reason
) {
  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  const withdrawalRef =
    firestore
      .collection("withdrawals")
      .doc(withdrawalId);

  await firestore.runTransaction(
    async (transaction) => {
      const withdrawalDoc =
        await transaction.get(
          withdrawalRef
        );

      if (!withdrawalDoc.exists) {
        return;
      }

      const withdrawal =
        withdrawalDoc.data();

      if (
        withdrawal.fundsRestored ===
          true ||
        withdrawal.fundsReserved !==
          true
      ) {
        return;
      }

      const userRef =
        firestore
          .collection("users")
          .doc(
            withdrawal.userId
          );

      const userDoc =
        await transaction.get(
          userRef
        );

      if (!userDoc.exists) {
        throw new Error(
          "User account could not be found while restoring funds."
        );
      }

      const user =
        userDoc.data();

      const amount =
        Number(
          withdrawal.grossAmount ||
            0
        );

      const balances =
        balancesOf(user);

      balances.withdraw =
        roundMoney(
          balances.withdraw +
            amount
        );

      transaction.set(
        userRef,
        {
          usdt_balance:
            roundMoney(
              Number(
                user.usdt_balance ||
                  0
              ) + amount
            ),

          balances,

          updatedAt:
            FieldValue.serverTimestamp(),

          last_updated:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      transaction.set(
        withdrawalRef,
        {
          fundsRestored:
            true,

          status:
            "FAILED",

          failureReason:
            reason ||
            "Withdrawal failed.",

          failedAt:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      const ledgerRef =
        firestore
          .collection(
            "ledger_transactions"
          )
          .doc();

      transaction.set(
        ledgerRef,
        {
          ledgerTransactionId:
            ledgerRef.id,

          userId:
            withdrawal.userId,

          type:
            "WITHDRAWAL_REFUND",

          direction:
            "CREDIT",

          amount,

          currency:
            "USDT",

          source:
            "BYBIT_WITHDRAWAL_FAILURE",

          withdrawalId,

          reason:
            reason ||
            "Withdrawal failed.",

          createdAt:
            FieldValue.serverTimestamp(),
        }
      );
    }
  );
}

// ============================================================
// RESOLVE THE EXACT BYBIT CHAIN IDENTIFIER
//
// Bybit exposes both `chain` and `chainType`. The withdrawal API
// requires the exact `chain` value. We therefore resolve it from
// Bybit instead of assuming that TRC20/TRX are interchangeable.
// ============================================================

async function resolveBybitWithdrawalChain() {
  const configured = String(WITHDRAW_CHAIN || "TRX")
    .trim()
    .toUpperCase();

  const response = await bybitRequest(
    () => bybitClient.getCoinInfo(WITHDRAW_COIN),
    "Bybit coin information"
  );

  if (!response || response.retCode !== 0) {
    throw new Error(
      response?.retMsg ||
        `Unable to read Bybit ${WITHDRAW_COIN} chain information.`
    );
  }

  const rows = Array.isArray(response.result?.rows)
    ? response.result.rows
    : [];

  const coinRow = rows.find(
    (row) =>
      String(row?.coin || "").toUpperCase() ===
      WITHDRAW_COIN.toUpperCase()
  );

  const chains = Array.isArray(coinRow?.chains)
    ? coinRow.chains
    : [];

  if (!chains.length) {
    throw new Error(
      `Bybit returned no withdrawal chains for ${WITHDRAW_COIN}.`
    );
  }

  const aliases = new Set([
    configured,
    configured === "TRC20" ? "TRX" : configured,
    configured === "TRX" ? "TRC20" : configured,
  ]);

  const match = chains.find((chain) => {
    const chainValue = String(chain?.chain || "")
      .trim()
      .toUpperCase();
    const chainType = String(chain?.chainType || "")
      .trim()
      .toUpperCase();

    return aliases.has(chainValue) || aliases.has(chainType);
  });

  if (!match) {
    const available = chains
      .map((chain) =>
        `${chain?.chain || "?"} (${chain?.chainType || "?"})`
      )
      .join(", ");

    throw new Error(
      `Withdrawal chain ${configured} is not available for ${WITHDRAW_COIN} on Bybit. Available chains: ${available}.`
    );
  }

  if (String(match.chainWithdraw) === "0") {
    throw new Error(
      `Bybit has temporarily suspended ${WITHDRAW_COIN} withdrawals on ${match.chain || match.chainType}.`
    );
  }

  const exactChain = String(match.chain || "").trim();

  if (!exactChain) {
    throw new Error(
      `Bybit did not provide a valid withdrawal chain identifier for ${WITHDRAW_COIN}.`
    );
  }

  console.log(
    `[WITHDRAWAL] Bybit chain resolved: configured=${configured}, chain=${exactChain}, chainType=${match.chainType || ""}`
  );

  return {
    chain: exactChain,
    chainType: String(match.chainType || ""),
    withdrawMin: Number(match.withdrawMin || 0),
    withdrawFee: String(match.withdrawFee || ""),
  };
}

// ============================================================
// RESOLVE DESTINATION FROM BYBIT ADDRESS BOOK
//
// Bybit requires an exact address-book match for on-chain
// withdrawals when forceChain is 0 or 1.
// This check happens BEFORE reserving user funds.
// ============================================================

async function resolveBybitDestination(address) {
  const chainInfo =
    await resolveBybitWithdrawalChain();

  const response =
    await bybitRequest(
      () =>
        bybitClient.getWithdrawalAddressList({
          coin: WITHDRAW_COIN,
          chain: chainInfo.chain,
          limit: 100,
        }),
      "Bybit withdrawal address book"
    );

  if (!response || response.retCode !== 0) {
    const error = new Error(
      response?.retMsg ||
        "Unable to check the Bybit withdrawal address book."
    );
    error.bybitRetCode = response?.retCode;
    throw error;
  }

  const rows = Array.isArray(response.result?.rows)
    ? response.result.rows
    : [];

  // Bybit address matching is case-sensitive.
  const match = rows.find(
    (row) =>
      String(row?.address || "") === address &&
      String(row?.chain || "").toUpperCase() ===
        chainInfo.chain.toUpperCase()
  );

  if (!match) {
    const error = new Error(
      `This withdrawal address is not registered in your Bybit address book for ${chainInfo.chain}. Add the exact address with the ${chainInfo.chainType || chainInfo.chain} network in Bybit first.`
    );
    error.code = "ADDRESS_NOT_IN_BYBIT_BOOK";
    error.bybitRetCode = 131002;
    throw error;
  }

  const tag =
    String(match.tag || "").trim();

  console.log(
    `[WITHDRAWAL] Bybit address-book match: address=${address}, chain=${match.chain}, tag=${tag ? "present" : "none"}`
  );

  return {
    address: String(match.address),
    chain: String(match.chain),
    chainType: String(match.chainType || chainInfo.chainType || ""),
    tag: tag || null,
    withdrawMin: chainInfo.withdrawMin,
    withdrawFee: chainInfo.withdrawFee,
  };
}

// ============================================================
// SUBMIT WITHDRAWAL TO BYBIT
// ============================================================

async function submitBybitWithdrawal(
  destination,
  amount,
  requestId
) {
  if (
    !BYBIT_API_KEY ||
    !BYBIT_API_SECRET
  ) {
    throw new Error(
      "Bybit withdrawal credentials are not configured."
    );
  }

  const chainInfo = destination;

  const numericAmount =
    Number(amount);

  if (
    Number.isFinite(chainInfo.withdrawMin) &&
    chainInfo.withdrawMin > 0 &&
    numericAmount < chainInfo.withdrawMin
  ) {
    throw new Error(
      `Bybit minimum withdrawal for ${WITHDRAW_COIN} on ${chainInfo.chain} is ${chainInfo.withdrawMin} USDT.`
    );
  }

  console.log(
    `[WITHDRAWAL] Submitting to Bybit: coin=${WITHDRAW_COIN}, chain=${chainInfo.chain}, amount=${numericAmount}, forceChain=1`
  );

  const response =
    await bybitRequest(
      () =>
        bybitClient.submitWithdrawal(
          {
            coin:
              WITHDRAW_COIN,

            // Use the exact chain/address returned by Bybit.
            chain:
              chainInfo.chain,

            address:
              chainInfo.address,

            // Only send tag when the address-book entry has one.
            ...(chainInfo.tag
              ? { tag: chainInfo.tag }
              : {}),

            amount:
              String(numericAmount),

            timestamp:
              Date.now(),

            forceChain:
              1,

            accountType:
              WITHDRAW_ACCOUNT_TYPE,

            requestId,

            // Saint Crypto already calculates its own 5% fee.
            // The amount sent here is the net payout.
            feeType:
              0,
          }
        ),

      "Bybit withdrawal request"
    );

  if (
    !response ||
    response.retCode !== 0
  ) {
    const error =
      new Error(
        response?.retMsg ||
          "Bybit rejected the withdrawal."
      );

    error.bybitRetCode =
      response?.retCode;

    throw error;
  }

  if (
    !response.result?.id
  ) {
    throw new Error(
      "Bybit did not return a withdrawal ID."
    );
  }

  return {
    withdrawalId:
      response.result.id,

    chain:
      chainInfo.chain,

    chainType:
      chainInfo.chainType,

    response,
  };
}


// ============================================================
// ADMIN APPROVAL -> IMMEDIATE BYBIT SUBMISSION
//
// Telegram APPROVE is the only approval step.
// The user never confirms again.
// ============================================================

async function approveAndSubmitWithdrawal(
  withdrawalId,
  telegramUser = {}
) {
  if (!firestore) {
    throw new Error("Database service is unavailable.");
  }

  const withdrawalRef =
    firestore.collection("withdrawals").doc(withdrawalId);

  const initialSnapshot =
    await withdrawalRef.get();

  if (!initialSnapshot.exists) {
    throw new Error("Withdrawal record not found.");
  }

  const current =
    initialSnapshot.data() || {};

  if (
    String(current.status || "").toUpperCase() !==
    "UNDER_REVIEW"
  ) {
    throw new Error(
      `This withdrawal is already ${String(current.status || "UNKNOWN").toUpperCase()}.`
    );
  }

  const userId =
    String(current.userId || "").trim();

  if (!userId) {
    throw new Error("Withdrawal has no associated user.");
  }

  const userRef =
    firestore.collection("users").doc(userId);

  const userDoc =
    await userRef.get();

  if (!userDoc.exists) {
    throw new Error("User account could not be found.");
  }

  const user =
    userDoc.data() || {};

  if (
    user.is_frozen === true ||
    user.status === "FROZEN"
  ) {
    throw new Error("The user's account is currently restricted.");
  }

  const lockedAddress =
    String(
      user.withdrawal_wallet_address ||
        ""
    ).trim();

  if (
    user.withdrawal_wallet_locked !== true ||
    !validTron(lockedAddress)
  ) {
    throw new Error(
      "The user's locked withdrawal wallet is missing or invalid."
    );
  }

  if (
    String(current.destinationAddress || "").trim() !==
    lockedAddress
  ) {
    throw new Error(
      "Withdrawal wallet does not match the user's locked wallet."
    );
  }

  // This is intentionally checked only at admin approval time.
  // A normal user withdrawal request never contacts Bybit.
  const destination =
    await resolveBybitDestination(lockedAddress);

  const requestId =
    String(
      current.bybitRequestId ||
        crypto.randomBytes(12).toString("hex")
    );

  // Claim atomically. A second Telegram click cannot submit
  // the same withdrawal.
  await firestore.runTransaction(
    async (transaction) => {
      const doc =
        await transaction.get(withdrawalRef);

      if (!doc.exists) {
        throw new Error("Withdrawal record not found.");
      }

      const data =
        doc.data() || {};

      if (
        String(data.status || "").toUpperCase() !==
        "UNDER_REVIEW"
      ) {
        throw new Error(
          `This withdrawal is already ${String(data.status || "UNKNOWN").toUpperCase()}.`
        );
      }

      transaction.set(
        withdrawalRef,
        {
          status: "SUBMITTING",
          approvalStatus: "APPROVED",
          approvedAt:
            FieldValue.serverTimestamp(),
          approvedByTelegramUserId:
            String(telegramUser.id || ""),
          approvedByTelegramUsername:
            String(telegramUser.username || ""),
          bybitRequestId: requestId,
          submissionStartedAt:
            FieldValue.serverTimestamp(),
          updatedAt:
            FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  );

  try {
    const result =
      await submitBybitWithdrawal(
        destination,
        Number(current.netPayout || 0),
        requestId
      );

    await withdrawalRef.set(
      {
        status: "PROCESSING",
        approvalStatus: "APPROVED",
        bybitWithdrawalId:
          result.withdrawalId,
        bybitRequestId: requestId,
        destinationAddress: lockedAddress,
        destinationNetwork: "TRC20",
        coin: WITHDRAW_COIN,
        chain: result.chain || destination.chain,
        chainType:
          result.chainType || destination.chainType || "",
        bybitSubmittedAt:
          FieldValue.serverTimestamp(),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      success: true,
      status: "PROCESSING",
      withdrawalId,
      bybitWithdrawalId:
        result.withdrawalId,
      grossAmount:
        Number(current.grossAmount || 0),
      feeDeducted:
        Number(current.feeDeducted || 0),
      netPayout:
        Number(current.netPayout || 0),
      destinationAddress:
        lockedAddress,
    };
  } catch (error) {
    await restoreWithdrawal(
      withdrawalId,
      error.message
    );

    throw new Error(
      `Bybit withdrawal submission failed. ${error.message}`
    );
  }
}

// ============================================================
// GET BYBIT WITHDRAWAL STATUS
// ============================================================

async function getBybitWithdrawal(
  withdrawalId
) {
  const response =
    await bybitRequest(
      () =>
        bybitClient.getWithdrawalRecords(
          {
            coin:
              WITHDRAW_COIN,

            withdrawType:
              0,

            withdrawID:
              withdrawalId,

            limit:
              50,
          }
        ),

      "Bybit withdrawal status"
    );

  if (
    !response ||
    response.retCode !== 0
  ) {
    throw new Error(
      response?.retMsg ||
        "Unable to query Bybit withdrawal status."
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
        ) ===
        String(
          withdrawalId
        )
    ) || null
  );
}

// ============================================================
// REQUEST WITHDRAWAL
//
// Called directly by routes.js:
//
// requestWithdrawal(req.uid, req.body)
// ============================================================

async function requestWithdrawal(
  userId,
  body = {}
) {
  if (!firestore) {
    return {
      success: false,
      status: "FAILED",
      code: "DATABASE_UNAVAILABLE",
      message: "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

  if (!userId || typeof userId !== "string") {
    return {
      success: false,
      status: "FAILED",
      code: "AUTH_REQUIRED",
      message: "Your account could not be verified.",
      httpStatus: 401,
    };
  }

  const amount =
    Number.parseFloat(body.amount);

  const password =
    String(
      body.password ||
        body.fundPassword ||
        body.fundPin ||
        ""
    ).trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      success: false,
      status: "FAILED",
      code: "INVALID_WITHDRAWAL_AMOUNT",
      message: "Please enter a valid withdrawal amount.",
      httpStatus: 400,
    };
  }

  if (!password) {
    return {
      success: false,
      status: "FAILED",
      code: "FUND_PIN_REQUIRED",
      message: "Please enter your Fund PIN.",
      httpStatus: 400,
    };
  }

  if (amount < WITHDRAW_MINIMUM) {
    return {
      success: false,
      status: "FAILED",
      code: "WITHDRAWAL_TOO_SMALL",
      message:
        `The minimum withdrawal is ${WITHDRAW_MINIMUM.toFixed(2)} USDT.`,
      httpStatus: 400,
    };
  }

  if (amount > WITHDRAW_MAXIMUM) {
    return {
      success: false,
      status: "FAILED",
      code: "WITHDRAWAL_TOO_LARGE",
      message:
        `The maximum withdrawal is ${WITHDRAW_MAXIMUM.toFixed(2)} USDT.`,
      httpStatus: 400,
    };
  }

  let reserved = null;

  try {
    const userRef =
      firestore.collection("users").doc(userId);

    const userDoc =
      await userRef.get();

    if (!userDoc.exists) {
      throw new Error(
        "Your account record could not be found."
      );
    }

    const user =
      userDoc.data() || {};

    if (
      user.is_frozen === true ||
      user.status === "FROZEN"
    ) {
      throw new Error(
        "Your account is currently restricted."
      );
    }

    if (!user.fundPasswordHash) {
      throw new Error(
        "You have not created a Fund PIN yet. Please create one in Security Center."
      );
    }

    const valid =
      await bcrypt.compare(
        password,
        user.fundPasswordHash
      );

    if (!valid) {
      return {
        success: false,
        status: "FAILED",
        code: "WRONG_FUND_PIN",
        message:
          "Incorrect Fund PIN. Please check it and try again.",
        httpStatus: 400,
      };
    }

    const config =
      await firestore
        .collection("system_config")
        .doc("withdrawals")
        .get()
        .catch(() => null);

    if (
      config?.exists &&
      config.data()?.frozen === true
    ) {
      throw new Error(
        "Withdrawals are temporarily suspended. Please try again later."
      );
    }

    // reserveWithdrawal:
    // - verifies the ONE locked withdrawal wallet
    // - consumes only Withdraw balance
    // - creates UNDER_REVIEW
    // - does NOT contact Bybit
    reserved =
      await reserveWithdrawal(
        userId,
        amount
      );

    return {
      success: true,
      status: "UNDER_REVIEW",
      code: "WITHDRAWAL_UNDER_REVIEW",
      message:
        "Your withdrawal request has been received and is under review.",
      withdrawalId:
        reserved.withdrawalId,
      grossAmount:
        reserved.grossAmount,
      feeDeducted:
        reserved.feeDeducted,
      feePercent:
        reserved.feePercent,
      netPayout:
        reserved.netPayout,
      destinationAddress:
        reserved.destinationAddress,
      destinationNetwork:
        "TRC20",
      httpStatus: 200,
    };
  } catch (error) {
    console.error(
      "❌ Withdrawal request:",
      error.message
    );

    if (reserved?.withdrawalId) {
      try {
        await restoreWithdrawal(
          reserved.withdrawalId,
          error.message
        );
      } catch (restoreError) {
        console.error(
          "❌ Withdrawal refund failed:",
          restoreError.message
        );
      }
    }

    return {
      success: false,
      status: "FAILED",
      code: "WITHDRAWAL_FAILED",
      message:
        error.message ||
        "We couldn't process your withdrawal. Please try again.",
      withdrawalId:
        reserved?.withdrawalId || "",
      httpStatus: 400,
    };
  }
}

// ============================================================
// 14. PROCESS ONE WITHDRAWAL
//
// Called by the automatic monitor.
// ============================================================

async function processWithdrawal(
  doc
) {
  if (!doc) {
    return {
      checked: false,
      completed: false,
      failed: false,
    };
  }

  const withdrawal =
    typeof doc.data ===
      "function"
      ? doc.data()
      : doc;

  const withdrawalId =
    withdrawal.withdrawalId ||
    doc.id;

  if (
    !withdrawalId
  ) {
    return {
      checked: false,
      completed: false,
      failed: false,
    };
  }

  if (
    withdrawal.status !==
    "PROCESSING"
  ) {
    return {
      checked: false,
      completed: false,
      failed: false,
    };
  }

  const bybitWithdrawalId =
    withdrawal.bybitWithdrawalId;

  if (
    !bybitWithdrawalId
  ) {
    return {
      checked: true,
      completed: false,
      failed: false,
      error:
        "Bybit withdrawal ID is missing.",
    };
  }

  try {
    // ----------------------------------------------------------
    // Ask Bybit for current withdrawal status.
    // ----------------------------------------------------------

    const status =
      await getBybitWithdrawal(
        bybitWithdrawalId
      );

    if (!status) {
      return {
        checked: true,
        completed: false,
        failed: false,
      };
    }

    const bybitStatus =
      String(
        status.status ||
          ""
      ).toLowerCase();

    const txid =
      status.txID ||
      status.txid ||
      "";

    // ----------------------------------------------------------
    // SUCCESS / COMPLETED
    // ----------------------------------------------------------

    const completedStatuses = [
      "success",
      "completed",
      "complete",
      "finished",
    ];

    if (
      completedStatuses.includes(
        bybitStatus
      )
    ) {
      await firestore
        .collection(
          "withdrawals"
        )
        .doc(
          withdrawalId
        )
        .set(
          {
            status:
              "COMPLETED",

            bybitStatus:
              status.status ||
              "SUCCESS",

            txid,

            completedAt:
              FieldValue.serverTimestamp(),

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );

      return {
        checked: true,
        completed: true,
        failed: false,
      };
    }

    // ----------------------------------------------------------
    // FAILED STATUSES
    // ----------------------------------------------------------

    const failedStatuses = [
      "fail",
      "failed",
      "cancel",
      "cancelled",
      "canceled",
      "reject",
      "rejected",
    ];

    if (
      failedStatuses.includes(
        bybitStatus
      )
    ) {
      const reason =
        status.failReason ||
        status.failureReason ||
        status.remark ||
        `Bybit withdrawal status: ${status.status}`;

      await restoreWithdrawal(
        withdrawalId,
        reason
      );

      await firestore
        .collection(
          "withdrawals"
        )
        .doc(
          withdrawalId
        )
        .set(
          {
            bybitStatus:
              status.status ||
              "FAILED",

            updatedAt:
              FieldValue.serverTimestamp(),
          },
          {
            merge: true,
          }
        );

      return {
        checked: true,
        completed: false,
        failed: true,
      };
    }

    // ----------------------------------------------------------
    // STILL PROCESSING
    // ----------------------------------------------------------

    await firestore
      .collection(
        "withdrawals"
      )
      .doc(
        withdrawalId
      )
      .set(
        {
          bybitStatus:
            status.status ||
            "PROCESSING",

          txid,

          updatedAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

    return {
      checked: true,
      completed: false,
      failed: false,
    };
  } catch (error) {
    console.error(
      `❌ Failed to monitor withdrawal ${withdrawalId}:`,
      error.message
    );

    return {
      checked: true,
      completed: false,
      failed: false,
      error:
        error.message,
    };
  }
}

// ============================================================
// 15. AUTOMATIC WITHDRAWAL MONITOR
// ============================================================

let monitorRunning =
  false;

async function monitorPendingWithdrawals() {
  if (
    monitorRunning ||
    !firestore
  ) {
    return {
      checked: 0,
      updated: 0,
      completed: 0,
      failed: 0,
    };
  }

  monitorRunning =
    true;

  const summary = {
    checked: 0,
    updated: 0,
    completed: 0,
    failed: 0,
  };

  try {
    const snapshot =
      await firestore
        .collection(
          "withdrawals"
        )
        .where(
          "status",
          "==",
          "PROCESSING"
        )
        .limit(50)
        .get();

    for (
      const doc of
        snapshot.docs
    ) {
      const result =
        await processWithdrawal(
          doc
        );

      if (
        result?.checked
      ) {
        summary.checked++;
      }

      if (
        result?.completed
      ) {
        summary.completed++;
        summary.updated++;
      }

      if (
        result?.failed
      ) {
        summary.failed++;
        summary.updated++;
      }
    }

    return summary;
  } catch (error) {
    console.error(
      "❌ Withdrawal monitor:",
      error.message
    );

    return {
      ...summary,
      error:
        error.message,
    };
  } finally {
    monitorRunning =
      false;
  }
}

// ------------------------------------------------------------
// Compatibility alias.
// ------------------------------------------------------------

const monitorWithdrawals =
  monitorPendingWithdrawals;

// ============================================================
// 16. WITHDRAWAL MONITOR START / STOP
//
// The master index.js can call these directly.
// This removes the need for the fallback timer in index.js.
// ============================================================

let monitorTimer = null;

function startMonitor(intervalMinutes = 1) {
  const minutes = Number(intervalMinutes);

  const intervalMs =
    Number.isFinite(minutes) && minutes > 0
      ? minutes * 60 * 1000
      : 60 * 1000;

  if (monitorTimer) {
    console.log("ℹ️ Withdrawal monitor already running.");
    return monitorTimer;
  }

  console.log(
    `⏰ Withdrawal monitor: every ${
      intervalMs / 60000
    } minute(s).`
  );

  // Run one check immediately.
  monitorPendingWithdrawals()
    .then((summary) => {
      console.log("💸 Withdrawal monitor:", summary);
    })
    .catch((error) => {
      console.error(
        "❌ Initial withdrawal monitor failed:",
        error.message
      );
    });

  monitorTimer = setInterval(async () => {
    try {
      const summary =
        await monitorPendingWithdrawals();

      console.log(
        "💸 Withdrawal monitor:",
        summary
      );
    } catch (error) {
      console.error(
        "❌ Withdrawal monitor interval failed:",
        error.message
      );
    }
  }, intervalMs);

  return monitorTimer;
}

function stopMonitor() {
  if (!monitorTimer) {
    return;
  }

  clearInterval(monitorTimer);
  monitorTimer = null;

  console.log(
    "🛑 Withdrawal monitor stopped."
  );
}

// ============================================================
// 16. WITHDRAWAL STATUS
// ============================================================

async function getWithdrawalStatus(
  userId,
  withdrawalId
) {
  if (!firestore) {
    return {
      success: false,

      status:
        "ERROR",

      code:
        "DATABASE_UNAVAILABLE",

      message:
        "Our account database is temporarily unavailable.",

      httpStatus:
        503,
    };
  }

  if (
    !withdrawalId
  ) {
    return {
      success: false,

      status:
        "ERROR",

      code:
        "WITHDRAWAL_ID_REQUIRED",

      message:
        "Withdrawal ID is required.",

      httpStatus:
        400,
    };
  }

  const doc =
    await firestore
      .collection(
        "withdrawals"
      )
      .doc(
        withdrawalId
      )
      .get();

  if (!doc.exists) {
    return {
      success: false,

      status:
        "NOT_FOUND",

      code:
        "WITHDRAWAL_NOT_FOUND",

      message:
        "We couldn't find that withdrawal request.",

      httpStatus:
        404,
    };
  }

  const data =
    doc.data();

  // ----------------------------------------------------------
  // Security:
  // A user can only view their own withdrawal.
  // ----------------------------------------------------------

  if (
    data.userId !==
    userId
  ) {
    return {
      success: false,

      status:
        "FORBIDDEN",

      code:
        "WITHDRAWAL_ACCESS_DENIED",

      message:
        "You do not have permission to view this withdrawal.",

      httpStatus:
        403,
    };
  }

  let message =
    "Your withdrawal is being processed.";

  if (
    data.status ===
    "RESERVED"
  ) {
    message =
      "Your withdrawal request has been received and your funds are reserved.";
  }

  if (
    data.status ===
    "PROCESSING"
  ) {
    message =
      "Your withdrawal is being processed.";
  }

  if (
    data.status ===
    "COMPLETED"
  ) {
    message =
      "Your withdrawal has been completed successfully.";
  }

  if (
    data.status ===
    "FAILED"
  ) {
    message =
      data.failureReason ||
      "Your withdrawal failed and the reserved funds have been returned to your account.";
  }

  return {
    success:
      data.status ===
      "COMPLETED",

    status:
      data.status,

    message,

    withdrawalId,

    grossAmount:
      data.grossAmount,

    feeDeducted:
      data.feeDeducted,

    feePercent:
      data.feePercent ||
      WITHDRAW_FEE_PERCENT,

    netPayout:
      data.netPayout,

    txid:
      data.txid ||
      "",

    destinationAddress:
      data.destinationAddress ||
      "",

    bybitWithdrawalId:
      data.bybitWithdrawalId ||
      "",

    bybitStatus:
      data.bybitStatus ||
      "",

    httpStatus:
      200,
  };
}

// ============================================================
// 17. WITHDRAWAL HISTORY
// ============================================================

async function getWithdrawalHistory(
  userId
) {
  if (!firestore) {
    return {
      success: false,

      code:
        "DATABASE_UNAVAILABLE",

      message:
        "Our account database is temporarily unavailable.",

      httpStatus:
        503,
    };
  }

  if (
    !userId ||
    typeof userId !==
      "string"
  ) {
    return {
      success: false,

      code:
        "AUTH_REQUIRED",

      message:
        "Your account could not be verified.",

      httpStatus:
        401,
    };
  }

  const snapshot =
    await firestore
      .collection(
        "withdrawals"
      )
      .where(
        "userId",
        "==",
        userId
      )
      .limit(50)
      .get();

  const withdrawals =
    snapshot.docs.map(
      (doc) => ({
        withdrawalId:
          doc.id,

        ...doc.data(),
      })
    );

  // ----------------------------------------------------------
  // Newest first.
  // ----------------------------------------------------------

  withdrawals.sort(
    (a, b) => {
      const aTime =
        a.createdAt
          ?.toMillis?.() ||
        0;

      const bTime =
        b.createdAt
          ?.toMillis?.() ||
        0;

      return (
        bTime -
        aTime
      );
    }
  );

  return {
    success: true,

    withdrawals,

    httpStatus:
      200,
  };
}

// ============================================================
// 18. SERVICE CONFIGURATION
// ============================================================

function getConfig() {
  return {
    coin:
      WITHDRAW_COIN,

    chain:
      WITHDRAW_CHAIN,

    accountType:
      WITHDRAW_ACCOUNT_TYPE,

    minimum:
      WITHDRAW_MINIMUM,

    maximum:
      WITHDRAW_MAXIMUM,

    feePercent:
      WITHDRAW_FEE_PERCENT,

    bybitConfigured:
      Boolean(
        BYBIT_API_KEY &&
        BYBIT_API_SECRET
      ),

    testnet:
      BYBIT_TESTNET,
  };
}

// ============================================================
// 19. EXPORTS
//
// These names are intentionally aligned with routes.js/index.js.
// ============================================================

module.exports = {
  requestWithdrawal,

  getWithdrawalHistory,

  getWithdrawalStatus,

  monitorPendingWithdrawals,

  monitorWithdrawals,

  startMonitor,

  stopMonitor,

  reserveWithdrawal,

  restoreWithdrawal,

  submitBybitWithdrawal,

  getBybitWithdrawal,

  // Telegram admin approval -> immediate Bybit submission.
  approveAndSubmitWithdrawal,

  processWithdrawal,

  getConfig,
};