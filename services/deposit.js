"use strict";

// ============================================================
// SAINT CRYPTO TRADE ENGINE
// services/deposit.js
//
// DEPOSIT SERVICE
//
// Responsibilities:
// - Accept Flutter deposit submission
// - Validate amount / network / address / TXID
// - Prevent duplicate TXIDs
// - Verify deposit on the TRON blockchain
// - Create pending deposit records
// - Automatically monitor pending deposits
// - Atomically credit the user's Firestore ledger
// - Prevent double-crediting
// - Return deposit status/history information
//
// IMPORTANT:
// - No Express routes in this file.
// - No Firebase initialization in this file.
// - UID always comes from Firebase authentication.
// - Flutter does NOT control the UID.
// ============================================================

require("dotenv").config();

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

// The central ledger is the only authority that mutates user balances.
// This service only verifies and records deposits, then delegates the
// atomic credit operation to services/ledger.js.
const ledger = require("./ledger");

// ============================================================
// 1. FIRESTORE
// ============================================================

let firestore = null;

try {
  firestore = getFirestore();
  console.log("🟢 deposit.js: Firestore READY");
} catch (error) {
  console.error(
    "❌ deposit.js: Firestore unavailable:",
    error.message
  );
}

// ============================================================
// 2. HELPERS
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

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function roundMoney(value, decimals = 4) {
  const factor = 10 ** decimals;

  return (
    Math.round(
      (Number(value) || 0) * factor
    ) / factor
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================================
// 3. DEPOSIT CONFIGURATION
// ============================================================

const DEPOSIT_COIN =
  env("DEPOSIT_COIN") || "USDT";

const DEPOSIT_CHAIN =
  (
    env("DEPOSIT_CHAIN") || "TRX"
  ).toUpperCase();

const DEPOSIT_MINIMUM = 100;

const CENTRAL_DEPOSIT_ADDRESS =
  env(
    "CENTRAL_DEPOSIT_ADDRESS",
    "DEPOSIT_ADDRESS"
  ) ||
  "TKeND3TnF2L1J7LUjatwrGoxLXP9AH5wZw";

// ============================================================
// 4. TRON NETWORK CONFIGURATION
// ============================================================

const TRONGRID_BASE_URL =
  (
    env("TRONGRID_BASE_URL") ||
    "https://api.trongrid.io"
  ).replace(/\/+$/, "");

const TRONGRID_API_KEY =
  env("TRONGRID_API_KEY");

// Mainnet Tether USD (USDT) TRC-20 contract.
const USDT_TRC20_CONTRACT =
  env("USDT_TRC20_CONTRACT") ||
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const USDT_TRC20_CONTRACT_HEX =
  "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

const USDT_DECIMALS = 6;
const TRC20_TRANSFER_SELECTOR = "a9059cbb";

const TRON_REQUEST_TIMEOUT_MS =
  Math.max(
    5000,
    int(
      env(
        "TRON_REQUEST_TIMEOUT_MS"
      ),
      15000
    )
  );

const TRON_RETRY_ATTEMPTS =
  Math.max(
    1,
    int(
      env(
        "TRON_RETRY_ATTEMPTS"
      ),
      3
    )
  );

const TRON_RETRY_DELAY =
  Math.max(
    1,
    int(
      env(
        "TRON_RETRY_DELAY"
      ),
      2
    )
  );

// ============================================================
// 5. MONITOR CONFIGURATION
// ============================================================

const DEPOSIT_MONITOR_MINUTES =
  Math.max(
    1,
    int(
      env(
        "DEPOSIT_MONITOR_MINUTES"
      ),
      1
    )
  );

let depositMonitorInterval = null;
let depositMonitorRunning = false;

// ============================================================
// 6. TRON HTTP HELPERS
// ============================================================

async function tronRequest(
  path,
  body,
  label
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= TRON_RETRY_ATTEMPTS;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        TRON_REQUEST_TIMEOUT_MS
      );

    try {
      const headers = {
        "Content-Type":
          "application/json",
      };

      if (TRONGRID_API_KEY) {
        headers[
          "TRON-PRO-API-KEY"
        ] =
          TRONGRID_API_KEY;
      }

      const response =
        await fetch(
          `${TRONGRID_BASE_URL}${path}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          }
        );

      let data = null;

      try {
        data =
          await response.json();
      } catch (_) {
        data = null;
      }

      if (!response.ok) {
        throw new Error(
          `${label} returned HTTP ${response.status}.`
        );
      }

      return data || {};
    } catch (error) {
      lastError = error;

      console.warn(
        `⚠️ ${label} attempt ${attempt}/${TRON_RETRY_ATTEMPTS}: ${error.message}`
      );

      if (
        attempt <
        TRON_RETRY_ATTEMPTS
      ) {
        await sleep(
          TRON_RETRY_DELAY * 1000
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw (
    lastError ||
    new Error(
      `${label} failed.`
    )
  );
}

function normalizeTronHex(value) {
  const raw =
    String(value || "")
      .toLowerCase()
      .replace(/^0x/, "");

  if (
    raw.startsWith("41") &&
    raw.length === 42
  ) {
    return raw;
  }

  if (
    /^[0-9a-f]{40}$/.test(raw)
  ) {
    return `41${raw}`;
  }

  return raw;
}

function tronBase58Decode(address) {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let value = 0n;

  for (const char of String(address || "")) {
    const index =
      alphabet.indexOf(char);

    if (index < 0) {
      throw new Error(
        "Invalid TRON address."
      );
    }

    value =
      value * 58n +
      BigInt(index);
  }

  let hex =
    value.toString(16);

  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  let leadingZeros = 0;

  for (
    const char of String(address || "")
  ) {
    if (char !== "1") break;
    leadingZeros++;
  }

  return Buffer.concat([
    Buffer.alloc(leadingZeros),
    Buffer.from(hex, "hex"),
  ]);
}

function tronAddressToHex(address) {
  const decoded =
    tronBase58Decode(
      String(address || "").trim()
    );

  if (decoded.length !== 25) {
    throw new Error(
      "Invalid TRON address length."
    );
  }

  const payload =
    decoded.subarray(0, 21);

  const checksum =
    decoded.subarray(21, 25);

  const first =
    require("crypto")
      .createHash("sha256")
      .update(payload)
      .digest();

  const second =
    require("crypto")
      .createHash("sha256")
      .update(first)
      .digest();

  if (
    !second
      .subarray(0, 4)
      .equals(checksum)
  ) {
    throw new Error(
      "Invalid TRON address checksum."
    );
  }

  return payload.toString("hex");
}

function validTron(address) {
  try {
    const normalized =
      String(address || "").trim();

    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(normalized)) {
      return false;
    }

    tronAddressToHex(normalized);
    return true;
  } catch (_) {
    return false;
  }
}

function decodeTrc20Transfer(
  transaction
) {
  const contracts =
    transaction
      ?.raw_data
      ?.contract;

  if (
    !Array.isArray(contracts) ||
    contracts.length !== 1
  ) {
    return null;
  }

  const contract = contracts[0];

  if (
    !contract ||
    contract.type !==
      "TriggerSmartContract"
  ) {
    return null;
  }

  const parameter =
    contract.parameter?.value ||
    {};

  const contractHex =
    normalizeTronHex(
      parameter.contract_address
    );

  const data =
    String(
      parameter.data || ""
    ).toLowerCase();

  if (
    !data.startsWith(
      TRC20_TRANSFER_SELECTOR
    ) ||
    data.length <
      8 + 64 + 64
  ) {
    return null;
  }

  const recipientWord =
    data.slice(8, 72);

  const amountWord =
    data.slice(72, 136);

  if (
    !/^[0-9a-f]{64}$/.test(
      recipientWord
    ) ||
    !/^[0-9a-f]{64}$/.test(
      amountWord
    )
  ) {
    return null;
  }

  return {
    contractHex,
    recipientHex:
      `41${recipientWord.slice(-40)}`,
    amountUnits:
      BigInt(`0x${amountWord}`),
  };
}

function verifyUsdtTransferEvent(
  receipt,
  expectedRecipientHex,
  expectedAmountUnits
) {
  const logs = Array.isArray(receipt?.log)
    ? receipt.log
    : [];

  const TRANSFER_EVENT_TOPIC =
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  const expectedContractNoPrefix =
    USDT_TRC20_CONTRACT_HEX.slice(2).toLowerCase();

  return logs.some((log = {}) => {
    const address = String(log.address || "")
      .replace(/^0x/, "")
      .toLowerCase();

    const topics = Array.isArray(log.topics)
      ? log.topics.map((topic) => String(topic || "").toLowerCase())
      : [];

    const valueHex = String(log.data || "").toLowerCase().replace(/^0x/, "");

    if (address !== expectedContractNoPrefix) return false;
    if (topics[0] !== TRANSFER_EVENT_TOPIC) return false;
    if (!/^[0-9a-f]{64}$/.test(valueHex)) return false;

    const recipientTopic = topics[2] || "";
    const normalizedRecipient =
      recipientTopic.length === 64
        ? `41${recipientTopic.slice(-40)}`
        : "";

    if (normalizedRecipient !== expectedRecipientHex) return false;

    try {
      return BigInt(`0x${valueHex}`) === expectedAmountUnits;
    } catch (_) {
      return false;
    }
  });
}

function expectedAmountUnits(
  amount
) {
  const numeric =
    Number(amount);

  if (
    !Number.isFinite(numeric) ||
    numeric <= 0
  ) {
    return 0n;
  }

  return BigInt(
    Math.round(
      numeric *
        10 ** USDT_DECIMALS
    )
  );
}

// ============================================================
// 7. VALIDATION HELPERS
// ============================================================

function normalizeTxid(txid) {
  return String(txid || "").trim();
}

function normalizeAddress(address) {
  return String(address || "").trim();
}

function validTxid(txid) {
  return /^[a-fA-F0-9]{64}$/.test(txid);
}

// ============================================================
// 8. FIND CONFIRMED TRON USDT DEPOSIT
//
// A deposit is considered final only when:
// - the transaction exists in the solidified TRON view;
// - the transaction is a TriggerSmartContract;
// - it calls the mainnet USDT TRC-20 contract;
// - it encodes transfer(address,uint256);
// - the recipient is exactly the Saint Crypto deposit wallet;
// - the amount matches exactly at 6 decimals;
// - the solidified receipt reports SUCCESS.
//
// No Bybit API is used.
// ============================================================

async function findConfirmedDeposit(
  txid,
  expectedAmount
) {
  const cleanTxid =
    normalizeTxid(txid);

  if (!cleanTxid) {
    return null;
  }

  if (!validTxid(cleanTxid)) {
    throw new Error(
      "The transaction ID format is invalid."
    );
  }

  const expected =
    Number(expectedAmount);

  if (
    !Number.isFinite(expected) ||
    expected <= 0
  ) {
    return null;
  }

  if (
    !validTron(
      CENTRAL_DEPOSIT_ADDRESS
    )
  ) {
    throw new Error(
      "Saint Crypto deposit address is invalid."
    );
  }

  const expectedRecipientHex =
    tronAddressToHex(
      CENTRAL_DEPOSIT_ADDRESS
    );

  const expectedContractHex =
    normalizeTronHex(
      USDT_TRC20_CONTRACT_HEX
    );

  const expectedUnits =
    expectedAmountUnits(
      expected
    );

  const transaction =
    await tronRequest(
      "/walletsolidity/gettransactionbyid",
      {
        value: cleanTxid,
      },
      "TRON transaction lookup"
    );

  if (
    !transaction ||
    !transaction.raw_data
  ) {
    return null;
  }

  const transfer =
    decodeTrc20Transfer(
      transaction
    );

  if (!transfer) {
    return null;
  }

  if (
    transfer.contractHex !==
    expectedContractHex
  ) {
    throw new Error(
      `TXID uses a different TRC-20 contract. Expected USDT contract ${USDT_TRC20_CONTRACT}.`
    );
  }

  if (
    transfer.recipientHex !==
    expectedRecipientHex
  ) {
    return null;
  }

  if (
    transfer.amountUnits !==
    expectedUnits
  ) {
    return null;
  }

  const receipt =
    await tronRequest(
      "/walletsolidity/gettransactioninfobyid",
      {
        value: cleanTxid,
      },
      "TRON transaction receipt"
    );

  const receiptResult =
    String(
      receipt?.receipt?.result || ""
    ).toUpperCase();

  if (
    !receipt?.blockNumber ||
    receiptResult !== "SUCCESS"
  ) {
    return null;
  }

  if (
    !verifyUsdtTransferEvent(
      receipt,
      expectedRecipientHex,
      expectedUnits
    )
  ) {
    return null;
  }

  const blockTimestamp =
    Number(
      receipt.blockTimeStamp ||
      transaction.block_timestamp ||
      0
    );

  return {
    id: null,
    txID: cleanTxid,
    amount: expected,
    chain: DEPOSIT_CHAIN,
    toAddress:
      CENTRAL_DEPOSIT_ADDRESS,
    status: 3,
    successAt:
      blockTimestamp > 0
        ? new Date(blockTimestamp).toISOString()
        : null,
    tokenContract:
      USDT_TRC20_CONTRACT,
    verificationSource:
      "TRON_SOLIDITYNODE",
  };
}

// ============================================================
// 10. ATOMIC LEDGER CREDIT
//
// Deposit verification remains here, but balance mutation is delegated
// to the central ledger so there is only one credit implementation.
// ============================================================

// ============================================================
// 11. CREATE PENDING DEPOSIT
// ============================================================

async function createDepositRecord(
  userId,
  txid,
  amount
) {
  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  const ref =
    firestore
      .collection("deposits")
      .doc();

  await ref.set({
    depositId: ref.id,

    userId,

    txid,

    txHash: txid,

    amount:
      roundMoney(amount),

    coin:
      DEPOSIT_COIN,

    chain:
      DEPOSIT_CHAIN,

    network:
      "TRC20",

    depositAddress:
      CENTRAL_DEPOSIT_ADDRESS,

    status:
      "PENDING",

    creditedToLedger:
      false,

    createdAt:
      FieldValue.serverTimestamp(),

    requestedAt:
      FieldValue.serverTimestamp(),

    lastCheckedAt:
      FieldValue.serverTimestamp(),
  });

  return ref;
}

// ============================================================
// 13. FIND EXISTING TXID
// ============================================================

async function findExistingDeposit(
  txid
) {
  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  const snapshot =
    await firestore
      .collection("deposits")
      .where(
        "txid",
        "==",
        txid
      )
      .limit(1)
      .get();

  if (snapshot.empty) {
    return null;
  }

  const doc =
    snapshot.docs[0];

  return {
    id: doc.id,
    ...doc.data(),
  };
}

// ============================================================
// 14. SUBMIT DEPOSIT
// ============================================================

async function submitDeposit(
  userId,
  body = {}
) {
  if (!firestore) {
    return {
      success: false,
      status: "ERROR",
      code:
        "DATABASE_UNAVAILABLE",
      message:
        "Our account database is temporarily unavailable. Please try again shortly.",
      httpStatus: 503,
    };
  }

  if (
    !userId ||
    typeof userId !== "string"
  ) {
    return {
      success: false,
      status: "ERROR",
      code:
        "AUTH_REQUIRED",
      message:
        "Your account could not be verified.",
      httpStatus: 401,
    };
  }

  const amount =
    Number.parseFloat(
      body.amount ??
        body.depositAmount ??
        body.usdtAmount
    );

  const txid =
    normalizeTxid(
      body.txid ??
        body.txID ??
        body.transactionId ??
        body.transactionHash ??
        body.txHash
    );

  const network =
    String(
      body.network ??
        body.chain ??
        "TRC20"
    )
      .trim()
      .toUpperCase();

  const suppliedAddress =
    normalizeAddress(
      body.depositAddress ??
        body.address ??
        body.walletAddress
    );

  if (
    !Number.isFinite(amount) ||
    amount < DEPOSIT_MINIMUM
  ) {
    return {
      success: false,
      status:
        "INVALID_AMOUNT",
      code:
        "DEPOSIT_TOO_SMALL",
      message:
        `Minimum deposit is $${DEPOSIT_MINIMUM.toFixed(
          2
        )} USDT.`,
      httpStatus: 400,
    };
  }

  if (!txid) {
    return {
      success: false,
      status:
        "TXID_REQUIRED",
      code:
        "TXID_REQUIRED",
      message:
        "Please enter your blockchain transaction ID (TXID).",
      httpStatus: 400,
    };
  }

  if (!validTxid(txid)) {
    return {
      success: false,
      status:
        "INVALID_TXID",
      code:
        "INVALID_TXID",
      message:
        "The transaction ID format is invalid. Please enter the complete TRON transaction ID.",
      httpStatus: 400,
    };
  }

  if (
    network !== "TRC20" &&
    network !== "TRX"
  ) {
    return {
      success: false,
      status:
        "INVALID_NETWORK",
      code:
        "INVALID_NETWORK",
      message:
        "Only TRC-20 USDT deposits are supported.",
      httpStatus: 400,
    };
  }

  if (
    suppliedAddress &&
    suppliedAddress !==
      CENTRAL_DEPOSIT_ADDRESS
  ) {
    return {
      success: false,
      status:
        "INVALID_DEPOSIT_ADDRESS",
      code:
        "INVALID_DEPOSIT_ADDRESS",
      message:
        "The submitted deposit address does not match the Saint Crypto deposit address.",
      httpStatus: 400,
    };
  }

  try {
    const userRef =
      firestore
        .collection("users")
        .doc(userId);

    const userDoc =
      await userRef.get();

    if (!userDoc.exists) {
      return {
        success: false,
        status:
          "USER_NOT_FOUND",
        code:
          "USER_NOT_FOUND",
        message:
          "User account not found.",
        httpStatus: 404,
      };
    }

    const user =
      userDoc.data();

    if (
      user.is_frozen === true ||
      user.status === "FROZEN"
    ) {
      return {
        success: false,
        status:
          "FROZEN",
        code:
          "ACCOUNT_FROZEN",
        message:
          "Your account is currently restricted.",
        httpStatus: 403,
      };
    }

    const duplicate =
      await findExistingDeposit(
        txid
      );

    if (duplicate) {
      if (
        duplicate.userId !==
        userId
      ) {
        return {
          success: false,
          status:
            "TXID_ALREADY_CLAIMED",
          code:
            "TXID_ALREADY_CLAIMED",
          message:
            "This transaction ID has already been submitted by another account.",
          httpStatus: 409,
        };
      }

      if (
        duplicate.status ===
          "COMPLETED" &&
        duplicate.creditedToLedger ===
          true
      ) {
        return {
          success: true,
          status:
            "COMPLETED",
          code:
            "ALREADY_CREDITED",
          depositId:
            duplicate.id,
          amount:
            duplicate.amount,
          message:
            "This deposit has already been verified and credited to your account.",
          httpStatus: 200,
        };
      }

      return {
        success: false,
        status:
          "PENDING",
        code:
          "DEPOSIT_ALREADY_SUBMITTED",
        depositId:
          duplicate.id,
        amount:
          duplicate.amount,
        message:
          "This deposit has already been submitted and is awaiting confirmation.",
        httpStatus: 200,
      };
    }

    let record = null;

    try {
      record =
        await findConfirmedDeposit(
          txid,
          amount
        );
    } catch (error) {
      console.warn(
        "⚠️ Immediate TRON deposit check:",
        error.message
      );
    }

    const depositRef =
      await createDepositRecord(
        userId,
        txid,
        amount
      );

    if (!record) {
      return {
        success: false,
        status:
          "PENDING",
        code:
          "DEPOSIT_PENDING",
        depositId:
          depositRef.id,
        amount:
          roundMoney(amount),
        message:
          "Deposit submitted successfully. Waiting for real TRON confirmation.",
        httpStatus: 200,
      };
    }

    await depositRef.set(
      {
        status:
          "VERIFYING",

        verificationSource:
          record.verificationSource || "TRON_SOLIDITYNODE",

        blockchainTransactionId:
          record.txID || txid,

        tokenContract:
          record.tokenContract || USDT_TRC20_CONTRACT,

        lastCheckedAt:
          FieldValue.serverTimestamp(),

        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );

    await creditDepositToLedger(
      depositRef.id,
      userId,
      amount,
      record
    );

    return {
      success: true,
      status:
        "COMPLETED",
      code:
        "DEPOSIT_COMPLETED",
      depositId:
        depositRef.id,
      amount:
        roundMoney(amount),
      message:
        `Deposit of $${roundMoney(
          amount
        ).toFixed(
          2
        )} USDT verified and credited to your Saint Crypto ledger.`,
      httpStatus: 200,
    };
  } catch (error) {
    console.error(
      "❌ Deposit submission:",
      error.message
    );

    return {
      success: false,
      status:
        "ERROR",
      code:
        "DEPOSIT_PROCESSING_FAILED",
      message:
        error.message ||
        "Deposit processing failed. Please try again.",
      httpStatus: 400,
    };
  }
}

// ============================================================
// 15. PROCESS ONE PENDING DEPOSIT
// ============================================================

async function processDeposit(doc) {
  const data = doc.data();

  if (!data) {
    return {
      skipped: true,
    };
  }

  if (
    ["COMPLETED", "FAILED"].includes(
      data.status
    )
  ) {
    return {
      skipped: true,
    };
  }

  const txid =
    normalizeTxid(data.txid);

  const amount =
    Number(data.amount || 0);

  const userId =
    data.userId;

  if (
    !txid ||
    !userId ||
    amount <= 0
  ) {
    await doc.ref.set(
      {
        status:
          "FAILED",

        failureReason:
          "Deposit record is incomplete.",

        failedAt:
          FieldValue.serverTimestamp(),

        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );

    return {
      failed: true,
    };
  }

  try {
    const record =
      await findConfirmedDeposit(
        txid,
        amount
      );

    if (!record) {
      await doc.ref.set(
        {
          status:
            "PENDING",

          lastCheckedAt:
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
        pending: true,
      };
    }

    await doc.ref.set(
      {
        status:
          "VERIFYING",

        verificationSource:
          record.verificationSource || "TRON_SOLIDITYNODE",

        blockchainTransactionId:
          record.txID || txid,

        tokenContract:
          record.tokenContract || USDT_TRC20_CONTRACT,

        lastCheckedAt:
          FieldValue.serverTimestamp(),

        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );

    const result =
      await creditDepositToLedger(
        doc.id,
        userId,
        amount,
        record
      );

    console.log(
      `✅ Deposit credited: ${txid} | $${amount.toFixed(
        2
      )} USDT | user ${userId}`
    );

    return {
      checked: true,
      completed: true,
      alreadyCredited:
        result.alreadyCredited,
      depositId: doc.id,
    };
  } catch (error) {
    console.error(
      `❌ Deposit monitor ${txid}:`,
      error.message
    );

    await doc.ref.set(
      {
        status:
          "PENDING",

        lastCheckedAt:
          FieldValue.serverTimestamp(),

        lastError:
          error.message,

        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );

    return {
      checked: true,
      pending: true,
      error:
        error.message,
      depositId:
        doc.id,
    };
  }
}

// ============================================================
// 16. MONITOR PENDING DEPOSITS
// ============================================================

async function monitorPendingDeposits() {
  if (
    depositMonitorRunning ||
    !firestore
  ) {
    return {
      checked: 0,
      completed: 0,
      pending: 0,
      failed: 0,
    };
  }

  depositMonitorRunning = true;

  const summary = {
    checked: 0,
    completed: 0,
    pending: 0,
    failed: 0,
  };

  try {
    const snapshot =
      await firestore
        .collection("deposits")
        .where(
          "status",
          "==",
          "PENDING"
        )
        .limit(50)
        .get();

    for (
      const doc of snapshot.docs
    ) {
      const result =
        await processDeposit(
          doc
        );

      if (result?.checked) {
        summary.checked++;
      }

      if (result?.completed) {
        summary.completed++;
      }

      if (result?.pending) {
        summary.pending++;
      }

      if (result?.failed) {
        summary.failed++;
      }
    }

    return summary;
  } catch (error) {
    console.error(
      "❌ Pending deposit monitor:",
      error.message
    );

    return {
      ...summary,
      error:
        error.message,
    };
  } finally {
    depositMonitorRunning = false;
  }
}

// ============================================================
// 17. MONITOR COMPATIBILITY
// ============================================================

function startMonitor() {
  if (depositMonitorInterval) {
    console.log(
      "ℹ️ Deposit monitor already running."
    );

    return {
      started: false,
      running: true,
    };
  }

  const intervalMs =
    DEPOSIT_MONITOR_MINUTES *
    60 *
    1000;

  console.log(
    `🔄 Deposit monitor starting: every ${DEPOSIT_MONITOR_MINUTES} minute(s).`
  );

  monitorPendingDeposits()
    .then((summary) => {
      console.log(
        "📥 Initial deposit monitor:",
        summary
      );
    })
    .catch((error) => {
      console.error(
        "❌ Initial deposit monitor:",
        error.message
      );
    });

  depositMonitorInterval =
    setInterval(
      async () => {
        try {
          const summary =
            await monitorPendingDeposits();

          if (
            summary.checked > 0 ||
            summary.completed > 0 ||
            summary.failed > 0
          ) {
            console.log(
              "📥 Deposit monitor:",
              summary
            );
          }
        } catch (error) {
          console.error(
            "❌ Scheduled deposit monitor:",
            error.message
          );
        }
      },
      intervalMs
    );

  return {
    started: true,
    running: true,
    intervalMinutes:
      DEPOSIT_MONITOR_MINUTES,
  };
}

function stopMonitor() {
  if (!depositMonitorInterval) {
    return {
      stopped: false,
      running: false,
    };
  }

  clearInterval(
    depositMonitorInterval
  );

  depositMonitorInterval = null;

  console.log(
    "🛑 Deposit monitor stopped."
  );

  return {
    stopped: true,
    running: false,
  };
}

async function runMonitorNow() {
  return monitorPendingDeposits();
}

const monitorDeposits =
  monitorPendingDeposits;

// ============================================================
// 18. DEPOSIT STATUS
// ============================================================

async function getDepositStatus(
  userId,
  depositId
) {
  if (!firestore) {
    return {
      success: false,
      status: "ERROR",
      code:
        "DATABASE_UNAVAILABLE",
      message:
        "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

  if (!depositId) {
    return {
      success: false,
      status: "ERROR",
      code:
        "DEPOSIT_ID_REQUIRED",
      message:
        "Deposit ID is required.",
      httpStatus: 400,
    };
  }

  const doc =
    await firestore
      .collection("deposits")
      .doc(depositId)
      .get();

  if (!doc.exists) {
    return {
      success: false,
      status:
        "NOT_FOUND",
      code:
        "DEPOSIT_NOT_FOUND",
      message:
        "We couldn't find that deposit request.",
      httpStatus: 404,
    };
  }

  const data =
    doc.data();

  if (
    data.userId !== userId
  ) {
    return {
      success: false,
      status:
        "FORBIDDEN",
      code:
        "DEPOSIT_ACCESS_DENIED",
      message:
        "You do not have permission to view this deposit.",
      httpStatus: 403,
    };
  }

  let message =
    "Your deposit is waiting for blockchain confirmation.";

  if (data.status === "VERIFYING") {
    message =
      "Your deposit is being verified.";
  }

  if (data.status === "COMPLETED") {
    message =
      "Your deposit has been verified and credited successfully.";
  }

  if (data.status === "FAILED") {
    message =
      data.failureReason ||
      "Your deposit could not be processed.";
  }

  return {
    success:
      data.status === "COMPLETED",

    status:
      data.status,

    message,

    depositId,

    amount:
      data.amount,

    currency:
      data.coin || "USDT",

    coin:
      data.coin || "USDT",

    chain:
      data.chain || "TRX",

    network:
      data.network || "TRC20",

    txid:
      data.txid || "",

    txHash:
      data.txHash ||
      data.txid ||
      "",

    depositAddress:
      data.depositAddress ||
      CENTRAL_DEPOSIT_ADDRESS,

    creditedToLedger:
      data.creditedToLedger === true,

    ledgerCreditAmount:
      data.ledgerCreditAmount || 0,

    bybitDepositId:
      data.bybitDepositId || "",

    blockchainTransactionId:
      data.blockchainTransactionId || data.txid || "",

    tokenContract:
      data.tokenContract || USDT_TRC20_CONTRACT,

    verificationSource:
      data.verificationSource || "TRON_SOLIDITYNODE",

    verifiedAt:
      data.verifiedAt || null,

    httpStatus: 200,
  };
}

// ============================================================
// 19. DEPOSIT HISTORY
// ============================================================

async function getDepositHistory(
  userId,
  limit = 50
) {
  if (!firestore) {
    return {
      success: false,
      status: "ERROR",
      code:
        "DATABASE_UNAVAILABLE",
      message:
        "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

  const safeLimit =
    Math.min(
      100,
      Math.max(
        1,
        int(limit, 50)
      )
    );

  const snapshot =
    await firestore
      .collection("deposits")
      .where(
        "userId",
        "==",
        userId
      )
      .limit(safeLimit)
      .get();

  const deposits =
    snapshot.docs.map(
      (doc) => ({
        depositId:
          doc.id,

        ...doc.data(),
      })
    );

  deposits.sort(
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
    deposits,
    httpStatus: 200,
  };
}

// ============================================================
// 20. CONFIG
// ============================================================

function getConfig() {
  return {
    coin:
      DEPOSIT_COIN,

    chain:
      DEPOSIT_CHAIN,

    network:
      "TRC20",

    minimum:
      DEPOSIT_MINIMUM,

    depositAddress:
      CENTRAL_DEPOSIT_ADDRESS,

    tronGridConfigured:
      Boolean(
        TRONGRID_BASE_URL
      ),

    tokenContract:
      USDT_TRC20_CONTRACT,

    monitorMinutes:
      DEPOSIT_MONITOR_MINUTES,

    monitorRunning:
      Boolean(
        depositMonitorInterval
      ),
  };
}

// ============================================================
// 21. EXPORTS
// ============================================================

module.exports = {
  submitDeposit,

  getDepositStatus,

  getDepositHistory,

  monitorPendingDeposits,

  monitorDeposits,

  processDeposit,

  findConfirmedDeposit,

  creditDepositToLedger,

  getConfig,

  startMonitor,

  stopMonitor,

  runMonitorNow,
};

console.log(
  "✅ services/deposit.js loaded successfully."
);