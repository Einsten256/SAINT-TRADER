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
// - User funds are reserved before manual payout approval.
// - Rejected/failed manual payouts restore the reserved funds.
// - Refunds are protected against double-crediting.
// ============================================================

require("dotenv").config();

const bcrypt = require("bcrypt");

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

// Authorized manual payout sender.
// This is the Saint Crypto/Bybit wallet used to send user withdrawals.
// The withdrawal verifier compares the actual TRON transaction sender
// against this address before marking a withdrawal COMPLETED.
const AUTHORIZED_PAYOUT_WALLET =
  String(
    env(
      "AUTHORIZED_PAYOUT_WALLET",
      "WITHDRAWAL_PAYOUT_WALLET"
    ) ||
      "TKeND3TnF2L1J7LUjatwrGoxLXP9AH5wZw"
  ).trim();

// ============================================================
// MASTER WITHDRAWAL FEE
//
// User requests $100
// 5% fee = $5
// User receives $95
// ============================================================

const WITHDRAW_FEE_PERCENT = 5;

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

          // Snapshot the user's username for admin withdrawal handling.
          // UID remains the authoritative user identity.
          username:
            String(
              user.username ||
                user.displayName ||
                ""
            ).trim(),

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
            "MANUAL_USDT_WITHDRAWAL",

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
            "MANUAL_WITHDRAWAL_FAILURE",

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
// MANUAL WITHDRAWAL PAYMENT WORKFLOW
//
// Saint Crypto no longer submits user withdrawals to Bybit.
// APPROVE only moves the withdrawal to AWAITING_PAYMENT.
// The admin manually sends the netPayout to the user's locked
// TRON wallet, then submits the blockchain TXID.
// ============================================================

async function approveAndSubmitWithdrawal(withdrawalId, telegramUser = {}) {
  if (!firestore) throw new Error("Database service is unavailable.");

  const withdrawalRef = firestore.collection("withdrawals").doc(withdrawalId);
  let result = null;

  await firestore.runTransaction(async (transaction) => {
    const doc = await transaction.get(withdrawalRef);
    if (!doc.exists) throw new Error("Withdrawal record not found.");
    const data = doc.data() || {};

    if (String(data.status || "").toUpperCase() !== "UNDER_REVIEW") {
      throw new Error(`This withdrawal is already ${String(data.status || "UNKNOWN").toUpperCase()}.`);
    }

    const userId = String(data.userId || "").trim();
    if (!userId) throw new Error("Withdrawal has no associated user.");

    const userRef = firestore.collection("users").doc(userId);
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) throw new Error("User account could not be found.");
    const user = userDoc.data() || {};

    if (user.is_frozen === true || user.status === "FROZEN") {
      throw new Error("The user's account is currently restricted.");
    }

    const lockedAddress = String(user.withdrawal_wallet_address || "").trim();
    if (user.withdrawal_wallet_locked !== true || !validTron(lockedAddress)) {
      throw new Error("The user's locked withdrawal wallet is missing or invalid.");
    }

    if (String(data.destinationAddress || "").trim() !== lockedAddress) {
      throw new Error("Withdrawal wallet does not match the user's locked wallet.");
    }

    transaction.set(withdrawalRef, {
      status: "AWAITING_PAYMENT",
      approvalStatus: "APPROVED",
      approvedAt: FieldValue.serverTimestamp(),
      approvedByTelegramUserId: String(telegramUser.id || ""),
      approvedByTelegramUsername: String(telegramUser.username || ""),
      paymentNetwork: "TRC20",
      paymentCoin: "USDT",
      paymentAddress: lockedAddress,
      paymentAmount: Number(data.netPayout || 0),
      paymentRequired: true,
      txid: "",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    result = {
      success: true,
      status: "AWAITING_PAYMENT",
      withdrawalId,
      grossAmount: Number(data.grossAmount || 0),
      feeDeducted: Number(data.feeDeducted || 0),
      feePercent: Number(data.feePercent || WITHDRAW_FEE_PERCENT),
      netPayout: Number(data.netPayout || 0),
      destinationAddress: lockedAddress,
      destinationNetwork: "TRC20",
    };
  });

  console.log(`[WITHDRAWAL] Approved for manual payment: ${withdrawalId} send=${result.netPayout} USDT to ${result.destinationAddress}`);
  return result;
}

const approveManualWithdrawal = approveAndSubmitWithdrawal;

async function rejectWithdrawal(withdrawalId, reason = "Withdrawal rejected by administrator.") {
  if (!firestore) throw new Error("Database service is unavailable.");
  const withdrawalRef = firestore.collection("withdrawals").doc(withdrawalId);
  const snapshot = await withdrawalRef.get();
  if (!snapshot.exists) throw new Error("Withdrawal record not found.");
  const data = snapshot.data() || {};
  const status = String(data.status || "").toUpperCase();
  if (status !== "UNDER_REVIEW" && status !== "AWAITING_PAYMENT") {
    throw new Error(`This withdrawal is already ${status || "UNKNOWN"}.`);
  }
  await restoreWithdrawal(withdrawalId, reason);
  return { success: true, status: "FAILED", withdrawalId, reason };
}

function normalizeTxid(value) {
  return String(value || "").trim();
}

const TRON_GRID_BASE_URL =
  (env("TRONGRID_BASE_URL") || "https://api.trongrid.io").replace(/\/$/, "");

const TRONGRID_API_KEY = env("TRONGRID_API_KEY");

// Mainnet Tether USD (USDT) TRC-20 contract.
const USDT_TRC20_CONTRACT =
  env("USDT_TRC20_CONTRACT") ||
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const USDT_TRC20_CONTRACT_HEX =
  "41a614f803b6fd780986a42c78ec9c7f77e6ded13c";

const USDT_DECIMALS = 6;
const TRC20_TRANSFER_SELECTOR = "a9059cbb";

function tronBase58Decode(address) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;

  for (const char of String(address || "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid TRON address.");
    value = value * 58n + BigInt(index);
  }

  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;

  let leadingZeros = 0;
  for (const char of String(address || "")) {
    if (char !== "1") break;
    leadingZeros++;
  }

  return Buffer.concat([
    Buffer.alloc(leadingZeros),
    Buffer.from(hex, "hex"),
  ]);
}

function normalizeTronHex(value) {
  const raw = String(value || "").toLowerCase().replace(/^0x/, "");
  return raw.startsWith("41") ? raw : `41${raw}`;
}

function tronAddressToHex(address) {
  const decoded = tronBase58Decode(String(address || "").trim());
  if (decoded.length !== 25) throw new Error("Invalid TRON address length.");

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21, 25);
  const first = require("crypto").createHash("sha256").update(payload).digest();
  const second = require("crypto").createHash("sha256").update(first).digest();
  if (!second.subarray(0, 4).equals(checksum)) {
    throw new Error("Invalid TRON address checksum.");
  }

  return payload.toString("hex");
}

function decimalToUnits(value, decimals = USDT_DECIMALS) {
  const text = Number(value).toFixed(decimals);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`);
}

async function tronGridPost(path, body) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (TRONGRID_API_KEY) {
    headers["TRON-PRO-API-KEY"] = TRONGRID_API_KEY;
  }

  const response = await fetch(
    `${TRON_GRID_BASE_URL}${path}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }
  );

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      `TRON API ${path} returned HTTP ${response.status}.`
    );
  }

  return data || {};
}

function getTriggerSmartContract(txBody) {
  const contracts =
    txBody?.raw_data?.contract || [];

  if (!Array.isArray(contracts) || contracts.length !== 1) {
    return null;
  }

  const contract = contracts[0];
  if (contract?.type !== "TriggerSmartContract") {
    return null;
  }

  return contract;
}

function decodeTrc20Transfer(contract) {
  const value = contract?.parameter?.value || {};
  const data = String(value.data || "").toLowerCase();

  if (
    !data.startsWith(TRC20_TRANSFER_SELECTOR) ||
    data.length < 8 + 64 + 64
  ) {
    return null;
  }

  const recipientWord = data.slice(8, 72);
  const amountWord = data.slice(72, 136);

  if (!/^[0-9a-f]{64}$/.test(recipientWord)) return null;
  if (!/^[0-9a-f]{64}$/.test(amountWord)) return null;

  const recipientHex = `41${recipientWord.slice(-40)}`;
  const amountUnits = BigInt(`0x${amountWord}`);

  return {
    recipientHex,
    amountUnits,
  };
}

async function fetchTronWithdrawalTransaction(txid) {
  const transaction = await tronGridPost(
    "/wallet/gettransactionbyid",
    { value: txid }
  );

  const receipt = await tronGridPost(
    "/walletsolidity/gettransactioninfobyid",
    { value: txid }
  );

  return { transaction, receipt };
}

async function verifyWithdrawalTxid(
  withdrawalId,
  txid,
  telegramUser = {}
) {
  if (!firestore) throw new Error("Database service is unavailable.");

  const normalizedTxid = normalizeTxid(txid);
  if (!/^[A-Fa-f0-9]{64}$/.test(normalizedTxid)) {
    throw new Error("The TRON TXID must be a 64-character hexadecimal transaction ID.");
  }

  const withdrawalRef = firestore.collection("withdrawals").doc(withdrawalId);
  const snapshot = await withdrawalRef.get();
  if (!snapshot.exists) throw new Error("Withdrawal record not found.");

  const data = snapshot.data() || {};
  const status = String(data.status || "").toUpperCase();

  if (status !== "TXID_SUBMITTED") {
    throw new Error(
      `TXID verification requires TXID_SUBMITTED status, not ${status || "UNKNOWN"}.`
    );
  }

  const destinationAddress = String(
    data.paymentAddress || data.destinationAddress || ""
  ).trim();

  if (!validTron(destinationAddress)) {
    throw new Error("The withdrawal destination wallet is invalid.");
  }

  const expectedRecipientHex = tronAddressToHex(destinationAddress);
  const expectedAmountUnits = decimalToUnits(
    Number(data.paymentAmount ?? data.netPayout ?? 0),
    USDT_DECIMALS
  );

  const { transaction, receipt } =
    await fetchTronWithdrawalTransaction(normalizedTxid);

  if (!transaction || !transaction.raw_data) {
    return {
      success: false,
      verified: false,
      pending: true,
      reason: "TRON has not indexed this transaction yet.",
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  const triggerContract = getTriggerSmartContract(transaction);
  if (!triggerContract) {
    return {
      success: false,
      verified: false,
      pending: false,
      reason: "TXID is not a TRC-20 smart-contract transaction.",
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  const actualContractHex = normalizeTronHex(
    triggerContract?.parameter?.value?.contract_address || ""
  );

  const expectedContractHex =
    normalizeTronHex(USDT_TRC20_CONTRACT_HEX);

  if (actualContractHex !== expectedContractHex) {
    return {
      success: false,
      verified: false,
      pending: false,
      reason: `TXID uses a different TRC-20 contract. Expected USDT contract ${USDT_TRC20_CONTRACT}.`,
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  // ------------------------------------------------------------
  // SECURITY: the payout TXID must be sent FROM the authorized
  // Saint Crypto/Bybit payout wallet. Checking only the recipient
  // would allow an unrelated third party to fund the user's wallet
  // and falsely complete the withdrawal.
  // ------------------------------------------------------------
  const actualSenderHex = normalizeTronHex(
    triggerContract?.parameter?.value?.owner_address || ""
  );

  if (!validTron(AUTHORIZED_PAYOUT_WALLET)) {
    throw new Error(
      "The authorized payout wallet is not configured with a valid TRON address."
    );
  }

  const expectedSenderHex = tronAddressToHex(
    AUTHORIZED_PAYOUT_WALLET
  );

  if (actualSenderHex !== expectedSenderHex) {
    return {
      success: false,
      verified: false,
      pending: false,
      reason:
        "The TXID sender does not match the authorized Saint Crypto payout wallet.",
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  const decoded = decodeTrc20Transfer(triggerContract);
  if (!decoded) {
    return {
      success: false,
      verified: false,
      pending: false,
      reason: "TXID does not contain a valid TRC-20 USDT transfer.",
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  if (decoded.recipientHex !== expectedRecipientHex) {
    return {
      success: false,
      verified: false,
      pending: false,
      reason: "The TXID recipient does not match the user's locked withdrawal wallet.",
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  if (decoded.amountUnits < expectedAmountUnits) {
    return {
      success: false,
      verified: false,
      pending: false,
      reason: "The verified USDT amount is less than the required net payout.",
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  const receiptResult = String(
    receipt?.receipt?.result || ""
  ).toUpperCase();

  if (!receipt || !receipt.blockNumber || receiptResult !== "SUCCESS") {
    return {
      success: false,
      verified: false,
      pending: !receipt || !receipt.blockNumber,
      reason:
        receiptResult && receiptResult !== "SUCCESS"
          ? `TRON execution result is ${receiptResult}.`
          : "TRON transaction is not yet solidified.",
      withdrawalId,
      txid: normalizedTxid,
    };
  }

  let completionResult = null;

  await firestore.runTransaction(async (transactionRef) => {
    const latest = await transactionRef.get(withdrawalRef);
    if (!latest.exists) {
      throw new Error("Withdrawal record not found.");
    }

    const latestData = latest.data() || {};
    const latestStatus = String(latestData.status || "").toUpperCase();

    if (latestStatus === "COMPLETED") {
      completionResult = {
        success: true,
        verified: true,
        alreadyCompleted: true,
        status: "COMPLETED",
        withdrawalId,
        txid: String(latestData.txid || normalizedTxid),
      };
      return;
    }

    if (latestStatus !== "TXID_SUBMITTED") {
      throw new Error(
        `Withdrawal changed state during verification: ${latestStatus || "UNKNOWN"}.`
      );
    }

    if (String(latestData.txid || "").trim() !== normalizedTxid) {
      throw new Error("The submitted TXID changed before verification completed.");
    }

    transactionRef.set(
      withdrawalRef,
      {
        status: "COMPLETED",
        completedAt: FieldValue.serverTimestamp(),
        completedByTelegramUserId: String(telegramUser.id || ""),
        completedByTelegramUsername: String(telegramUser.username || ""),
        txidVerified: true,
        txidVerifiedAt: FieldValue.serverTimestamp(),
        txidVerifiedBlockNumber: Number(receipt.blockNumber),
        txidVerifiedContract: USDT_TRC20_CONTRACT,
        txidVerifiedSender: AUTHORIZED_PAYOUT_WALLET,
        txidVerifiedRecipient: destinationAddress,
        txidVerifiedAmountUnits: decoded.amountUnits.toString(),
        txidVerificationSource: "TRONGRID_SOLIDITYNODE",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    completionResult = {
      success: true,
      verified: true,
      alreadyCompleted: false,
      status: "COMPLETED",
      withdrawalId,
      txid: normalizedTxid,
      destinationAddress,
      verifiedAmountUnits: decoded.amountUnits.toString(),
      blockNumber: Number(receipt.blockNumber),
    };
  });

  console.log(
    `[WITHDRAWAL] TXID verified and withdrawal completed: ${withdrawalId} txid=${normalizedTxid}`
  );

  return completionResult;
}

async function submitWithdrawalTxid(withdrawalId, txid, telegramUser = {}) {
  if (!firestore) throw new Error("Database service is unavailable.");
  const normalizedTxid = normalizeTxid(txid);
  if (!normalizedTxid) throw new Error("TXID is required.");
  if (!/^[A-Fa-f0-9]{64}$/.test(normalizedTxid)) {
    throw new Error("The TRON TXID must be a 64-character hexadecimal transaction ID.");
  }

  const withdrawalRef = firestore.collection("withdrawals").doc(withdrawalId);
  const snapshot = await withdrawalRef.get();
  if (!snapshot.exists) throw new Error("Withdrawal record not found.");
  const data = snapshot.data() || {};
  const status = String(data.status || "").toUpperCase();

  if (status !== "AWAITING_PAYMENT" && status !== "TXID_SUBMITTED") {
    throw new Error(
      `TXID cannot be submitted while withdrawal is ${status || "UNKNOWN"}.`
    );
  }

  const duplicate = await firestore
    .collection("withdrawals")
    .where("txid", "==", normalizedTxid)
    .limit(2)
    .get();

  for (const doc of duplicate.docs) {
    if (doc.id !== withdrawalId) {
      throw new Error("This TXID has already been used for another withdrawal.");
    }
  }

  await withdrawalRef.set(
    {
      status: "TXID_SUBMITTED",
      txid: normalizedTxid,
      txidSubmittedAt: FieldValue.serverTimestamp(),
      txidSubmittedByTelegramUserId: String(telegramUser.id || ""),
      txidSubmittedByTelegramUsername: String(telegramUser.username || ""),
      txidVerificationStatus: "PENDING",
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const verification = await verifyWithdrawalTxid(
    withdrawalId,
    normalizedTxid,
    telegramUser
  );

  if (verification.verified) {
    return verification;
  }

  await withdrawalRef.set(
    {
      txidVerificationStatus: verification.pending
        ? "PENDING"
        : "FAILED",
      txidVerificationReason: verification.reason || "TXID verification failed.",
      txidLastCheckedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    success: true,
    status: "TXID_SUBMITTED",
    withdrawalId,
    txid: normalizedTxid,
    netPayout: Number(data.netPayout || 0),
    destinationAddress: String(data.destinationAddress || ""),
    verified: false,
    pending: Boolean(verification.pending),
    reason: verification.reason || "TXID verification is pending.",
  };
}

// ============================================================
// MANUAL WITHDRAWAL MONITOR
// No Bybit withdrawal polling.
// TXID_SUBMITTED withdrawals are re-verified against solidified
// TRON state until the payment is confirmed.
// ============================================================

async function processWithdrawal(doc) {
  if (!doc) return { checked: false, completed: false, failed: false };

  const withdrawal =
    typeof doc.data === "function" ? doc.data() : doc;

  const withdrawalId =
    withdrawal.withdrawalId || doc.id;

  const status = String(
    withdrawal.status || ""
  ).toUpperCase();

  if (!withdrawalId || !["AWAITING_PAYMENT", "TXID_SUBMITTED"].includes(status)) {
    return {
      checked: false,
      completed: false,
      failed: false,
    };
  }

  if (status === "AWAITING_PAYMENT") {
    return {
      checked: true,
      completed: false,
      failed: false,
      awaitingPayment: true,
      withdrawalId,
    };
  }

  const txid = normalizeTxid(withdrawal.txid);
  if (!txid) {
    return {
      checked: true,
      completed: false,
      failed: false,
      awaitingVerification: true,
      withdrawalId,
      reason: "No TXID has been submitted.",
    };
  }

  try {
    const verification = await verifyWithdrawalTxid(
      withdrawalId,
      txid,
      {
        id: withdrawal.txidSubmittedByTelegramUserId || "",
        username: withdrawal.txidSubmittedByTelegramUsername || "",
      }
    );

    await firestore.collection("withdrawals").doc(withdrawalId).set(
      {
        txidVerificationStatus: verification.verified
          ? "VERIFIED"
          : verification.pending
            ? "PENDING"
            : "FAILED",
        txidVerificationReason: verification.reason || "",
        txidLastCheckedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      checked: true,
      completed: verification.verified === true,
      failed: false,
      awaitingVerification: verification.verified !== true,
      withdrawalId,
      reason: verification.reason || "",
    };
  } catch (error) {
    console.error(
      `[WITHDRAWAL] TXID verification error for ${withdrawalId}:`,
      error.message
    );

    return {
      checked: true,
      completed: false,
      failed: false,
      awaitingVerification: true,
      withdrawalId,
      reason: error.message,
    };
  }
}

let monitorRunning = false;
async function monitorPendingWithdrawals() {
  if (monitorRunning || !firestore) return { checked: 0, updated: 0, completed: 0, failed: 0 };
  monitorRunning = true;
  const summary = { checked: 0, updated: 0, completed: 0, failed: 0 };
  try {
    const snapshot = await firestore.collection("withdrawals").where("status", "in", ["AWAITING_PAYMENT", "TXID_SUBMITTED"]).limit(50).get();
    for (const doc of snapshot.docs) {
      const result = await processWithdrawal(doc);
      if (result?.checked) summary.checked++;
    }
    return summary;
  } catch (error) {
    console.error("❌ Manual withdrawal monitor:", error.message);
    return { ...summary, error: error.message };
  } finally { monitorRunning = false; }
}

const monitorWithdrawals = monitorPendingWithdrawals;
let monitorTimer = null;
function startMonitor(intervalMinutes = 1) {
  const minutes = Number(intervalMinutes);
  const intervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 1000;
  if (monitorTimer) return monitorTimer;
  console.log(`⏰ Manual withdrawal monitor: every ${intervalMs / 60000} minute(s).`);
  monitorPendingWithdrawals().then(s => console.log("💸 Manual withdrawal monitor:", s)).catch(e => console.error("❌ Initial manual withdrawal monitor failed:", e.message));
  monitorTimer = setInterval(async () => {
    try { console.log("💸 Manual withdrawal monitor:", await monitorPendingWithdrawals()); }
    catch (error) { console.error("❌ Manual withdrawal monitor interval failed:", error.message); }
  }, intervalMs);
  return monitorTimer;
}
function stopMonitor() {
  if (!monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = null;
  console.log("🛑 Manual withdrawal monitor stopped.");
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

  if (data.status === "UNDER_REVIEW") {
    message = "Your withdrawal request has been received and is under review.";
  }

  if (data.status === "AWAITING_PAYMENT") {
    message = "Your withdrawal has been approved and is awaiting payment.";
  }

  if (data.status === "TXID_SUBMITTED") {
    message = "Your withdrawal payment TXID has been submitted and is being verified.";
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
    coin: WITHDRAW_COIN,
    chain: WITHDRAW_CHAIN,
    minimum: WITHDRAW_MINIMUM,
    maximum: WITHDRAW_MAXIMUM,
    feePercent: WITHDRAW_FEE_PERCENT,
    manualPayout: true,
    bybitWithdrawalEnabled: false,
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
  approveAndSubmitWithdrawal,
  approveManualWithdrawal,
  rejectWithdrawal,
  submitWithdrawalTxid,
  verifyWithdrawalTxid,
  processWithdrawal,
  getConfig,
};