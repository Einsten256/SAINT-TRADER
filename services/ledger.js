/**
 * SAINT CRYPTO
 * FILE: services/ledger.js
 *
 * FINAL UGX LEDGER
 *
 * Money model:
 *   1. locked_trading_capital_ugx
 *      - Approved Mobile Money recharge capital.
 *      - Qualifies the user to redeem signals.
 *      - Is NOT withdrawable.
 *
 *   2. payout_balance_ugx
 *      - Signal rewards credited after the 7-minute processing period.
 *      - This is the ONLY balance available for withdrawal.
 *
 * Important:
 *   - No Bybit.
 *   - No USDT.
 *   - No TRON.
 *   - No exchange/trade/perpetual/withdraw buckets.
 *   - Recharge approval increases locked trading capital only.
 *   - Signal payout increases payout balance only.
 *   - Withdrawal reservation decreases payout balance atomically.
 *   - Withdrawal rejection restores the reserved amount atomically.
 *   - Every money movement has an immutable ledger transaction.
 *   - Money operations are idempotent.
 */

"use strict";

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

let firestore = null;

try {
  firestore = getFirestore();
} catch (error) {
  console.error(
    "❌ Ledger: Firestore unavailable:",
    error.message
  );
}

/* ============================================================
   CONSTANTS
   ============================================================ */

const CURRENCY = "UGX";

const COLLECTIONS = {
  USERS: "users",
  RECHARGES: "recharges",
  SIGNAL_REDEMPTIONS: "signal_redemptions",
  WITHDRAWALS: "withdrawals",
  LEDGER: "ledger_transactions",
};

/* ============================================================
   HELPERS
   ============================================================ */

function requireFirestore() {
  if (!firestore) {
    throw new Error("Database service is unavailable.");
  }
}

function validateUserId(userId) {
  if (!userId || typeof userId !== "string") {
    throw new Error("Invalid user account.");
  }

  const id = userId.trim();

  if (!id) {
    throw new Error("Invalid user account.");
  }

  return id;
}

function money(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.round(number);
}

function requirePositiveAmount(value, message = "Invalid amount.") {
  const amount = money(value);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(message);
  }

  return amount;
}

function isFrozen(user) {
  return (
    user?.is_frozen === true ||
    String(user?.status || "").toUpperCase() === "FROZEN"
  );
}

function userBalanceSnapshot(user = {}) {
  return {
    locked_trading_capital_ugx: Math.max(
      0,
      money(user.locked_trading_capital_ugx)
    ),
    payout_balance_ugx: Math.max(
      0,
      money(user.payout_balance_ugx)
    ),
  };
}

/* ============================================================
   GET BALANCE
   ============================================================ */

async function getBalance(userId) {
  requireFirestore();

  const uid = validateUserId(userId);

  const userRef = firestore
    .collection(COLLECTIONS.USERS)
    .doc(uid);

  const snapshot = await userRef.get();

  if (!snapshot.exists) {
    throw new Error("Your account record could not be found.");
  }

  const balances = userBalanceSnapshot(snapshot.data());

  return {
    success: true,
    userId: uid,
    currency: CURRENCY,
    locked_trading_capital_ugx:
      balances.locked_trading_capital_ugx,
    payout_balance_ugx:
      balances.payout_balance_ugx,
    withdrawable_balance_ugx:
      balances.payout_balance_ugx,
  };
}

/* ============================================================
   CREATE IMMUTABLE LEDGER ENTRY
   ============================================================ */

async function createLedgerEntry({
  ledgerTransactionId = null,
  userId,
  type,
  direction,
  amount,
  source = "INTERNAL",
  referenceId = null,
  metadata = {},
  transaction = null,
}) {
  requireFirestore();

  const uid = validateUserId(userId);
  const value = requirePositiveAmount(
    amount,
    "Invalid ledger amount."
  );

  const ledgerId =
    ledgerTransactionId ||
    firestore
      .collection(COLLECTIONS.LEDGER)
      .doc().id;

  const ledgerRef = firestore
    .collection(COLLECTIONS.LEDGER)
    .doc(ledgerId);

  const data = {
    transactionId: ledgerId,
    ledgerTransactionId: ledgerId,
    userId: uid,
    type: type || "INTERNAL",
    direction: direction || "CREDIT",
    amount: value,
    amountUgx: value,
    currency: CURRENCY,
    source,
    referenceId,
    metadata: metadata || {},
    createdAt: FieldValue.serverTimestamp(),
  };

  if (transaction) {
    transaction.set(ledgerRef, data, {
      merge: false,
    });
  } else {
    await ledgerRef.create(data);
  }

  return {
    success: true,
    ledgerTransactionId: ledgerId,
    amountUgx: value,
  };
}

/* ============================================================
   RECHARGE CREDIT
 *
 * Called ONLY after admin approves a Mobile Money recharge.
 *
 * Effect:
 *   locked_trading_capital_ugx += amount
 *
 * payout_balance_ugx is untouched.
 *
 * Idempotency:
 *   recharge_<rechargeId> is the deterministic ledger ID.
 * ============================================================ */

async function creditRechargeToLedger(
  rechargeId,
  userId,
  amountUgx,
  record = null
) {
  requireFirestore();

  const uid = validateUserId(userId);

  if (!rechargeId || typeof rechargeId !== "string") {
    throw new Error("Recharge ID is required.");
  }

  const amount = requirePositiveAmount(
    amountUgx,
    "Invalid recharge amount."
  );

  const rechargeRef = firestore
    .collection(COLLECTIONS.RECHARGES)
    .doc(rechargeId);

  const userRef = firestore
    .collection(COLLECTIONS.USERS)
    .doc(uid);

  const ledgerId = `recharge_${rechargeId}`;

  const ledgerRef = firestore
    .collection(COLLECTIONS.LEDGER)
    .doc(ledgerId);

  let alreadyCredited = false;

  await firestore.runTransaction(async (transaction) => {
    const rechargeDoc = await transaction.get(
      rechargeRef
    );

    if (!rechargeDoc.exists) {
      throw new Error("Recharge record could not be found.");
    }

    const recharge = rechargeDoc.data() || {};

    if (
      recharge.userId &&
      recharge.userId !== uid
    ) {
      throw new Error("Recharge account mismatch.");
    }

    /*
     * Idempotent success.
     */
    if (
      recharge.status === "APPROVED" &&
      recharge.creditedToLedger === true
    ) {
      alreadyCredited = true;
      return;
    }

    if (
      recharge.status !== "PENDING_ADMIN_REVIEW"
    ) {
      throw new Error(
        `Recharge cannot be credited from status ${
          recharge.status || "UNKNOWN"
        }.`
      );
    }

    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error(
        "Your account record could not be found."
      );
    }

    const user = userDoc.data() || {};

    if (isFrozen(user)) {
      throw new Error(
        "This account is currently restricted."
      );
    }

    const oldLocked = Math.max(
      0,
      money(user.locked_trading_capital_ugx)
    );

    const oldPayout = Math.max(
      0,
      money(user.payout_balance_ugx)
    );

    const newLocked = oldLocked + amount;

    transaction.set(
      userRef,
      {
        locked_trading_capital_ugx: newLocked,
        payout_balance_ugx: oldPayout,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      rechargeRef,
      {
        status: "APPROVED",
        creditedToLedger: true,
        ledgerCreditAmountUgx: amount,
        approvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        approvalSource: "ADMIN",
      },
      { merge: true }
    );

    transaction.set(
      ledgerRef,
      {
        transactionId: ledgerId,
        ledgerTransactionId: ledgerId,
        userId: uid,
        type: "RECHARGE_CREDIT",
        direction: "CREDIT",
        amount,
        amountUgx: amount,
        currency: CURRENCY,
        source: "MOBILE_MONEY_RECHARGE",
        referenceId: rechargeId,
        metadata: {
          network: recharge.network || null,
          senderName: recharge.senderName || null,
          transactionId:
            recharge.transactionId || null,
          previousLockedTradingCapitalUgx:
            oldLocked,
          newLockedTradingCapitalUgx:
            newLocked,
          record: record || null,
        },
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  });

  return {
    success: true,
    alreadyCredited,
    rechargeId,
    userId: uid,
    amountUgx: amount,
    locked_trading_capital_ugx:
      alreadyCredited
        ? undefined
        : undefined,
  };
}

/* ============================================================
   SIGNAL PAYOUT
 *
 * Called by the durable signal-payout processor after the
 * redemption's 7-minute processing period has completed.
 *
 * Effect:
 *   payout_balance_ugx += reward
 *
 * Locked trading capital is untouched.
 *
 * Idempotency:
 *   signal_payout_<redemptionId> is deterministic.
 * ============================================================ */

async function creditSignalPayoutToLedger({
  redemptionId,
  userId,
  amountUgx,
  record = null,
}) {
  requireFirestore();

  const uid = validateUserId(userId);

  if (
    !redemptionId ||
    typeof redemptionId !== "string"
  ) {
    throw new Error("Redemption ID is required.");
  }

  const amount = requirePositiveAmount(
    amountUgx,
    "Invalid signal payout amount."
  );

  const redemptionRef = firestore
    .collection(COLLECTIONS.SIGNAL_REDEMPTIONS)
    .doc(redemptionId);

  const userRef = firestore
    .collection(COLLECTIONS.USERS)
    .doc(uid);

  const ledgerId =
    `signal_payout_${redemptionId}`;

  const ledgerRef = firestore
    .collection(COLLECTIONS.LEDGER)
    .doc(ledgerId);

  let alreadyCredited = false;

  await firestore.runTransaction(async (transaction) => {
    const redemptionDoc = await transaction.get(
      redemptionRef
    );

    if (!redemptionDoc.exists) {
      throw new Error(
        "Signal redemption record could not be found."
      );
    }

    const redemption = redemptionDoc.data() || {};

    if (
      redemption.userId &&
      redemption.userId !== uid
    ) {
      throw new Error(
        "Signal redemption account mismatch."
      );
    }

    /*
     * Idempotent success.
     */
    if (
      redemption.status === "CREDITED" &&
      redemption.creditedToLedger === true
    ) {
      alreadyCredited = true;
      return;
    }

    /*
     * The signal service/processor must only call this for a
     * PROCESSING redemption whose credit time has arrived.
     */
    if (
      redemption.status !== "PROCESSING"
    ) {
      throw new Error(
        `Signal payout cannot be credited from status ${
          redemption.status || "UNKNOWN"
        }.`
      );
    }

    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error(
        "Your account record could not be found."
      );
    }

    const user = userDoc.data() || {};

    if (isFrozen(user)) {
      throw new Error(
        "This account is currently restricted."
      );
    }

    const lockedCapital = Math.max(
      0,
      money(user.locked_trading_capital_ugx)
    );

    /*
     * A user must still have qualifying locked trading
     * capital when the payout is actually credited.
     */
    if (lockedCapital <= 0) {
      throw new Error(
        "No qualifying locked trading capital is available."
      );
    }

    const oldPayout = Math.max(
      0,
      money(user.payout_balance_ugx)
    );

    const newPayout = oldPayout + amount;

    transaction.set(
      userRef,
      {
        locked_trading_capital_ugx:
          lockedCapital,
        payout_balance_ugx:
          newPayout,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      redemptionRef,
      {
        status: "CREDITED",
        creditedToLedger: true,
        creditedAmountUgx: amount,
        creditedAt:
          FieldValue.serverTimestamp(),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      ledgerRef,
      {
        transactionId: ledgerId,
        ledgerTransactionId: ledgerId,
        userId: uid,
        type: "SIGNAL_PAYOUT",
        direction: "CREDIT",
        amount,
        amountUgx: amount,
        currency: CURRENCY,
        source: "SIGNAL_REWARD",
        referenceId: redemptionId,
        metadata: {
          signalCode:
            redemption.signalCode ||
            redemption.code ||
            null,
          previousPayoutBalanceUgx:
            oldPayout,
          newPayoutBalanceUgx:
            newPayout,
          lockedTradingCapitalUgx:
            lockedCapital,
          record: record || null,
        },
        createdAt:
          FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  });

  return {
    success: true,
    alreadyCredited,
    redemptionId,
    userId: uid,
    amountUgx: amount,
  };
}

/* ============================================================
   RESERVE WITHDRAWAL
 *
 * Gross withdrawal amount is reserved from payout balance.
 *
 * Fee:
 *   5% is calculated here.
 *
 * Example:
 *   requested = 20,000
 *   fee       = 1,000
 *   net       = 19,000
 *
 * The gross amount leaves payout_balance immediately.
 * If admin rejects the withdrawal, the gross amount is restored.
 *
 * The withdrawal service owns the withdrawal request document;
 * this function performs the atomic money movement.
 * ============================================================ */

async function reserveWithdrawal({
  withdrawalId,
  userId,
  amountUgx,
  feePercent = 5,
  record = null,
}) {
  requireFirestore();

  const uid = validateUserId(userId);

  if (
    !withdrawalId ||
    typeof withdrawalId !== "string"
  ) {
    throw new Error("Withdrawal ID is required.");
  }

  const amount = requirePositiveAmount(
    amountUgx,
    "Invalid withdrawal amount."
  );

  const feeRate = Number(feePercent);

  if (
    !Number.isFinite(feeRate) ||
    feeRate < 0 ||
    feeRate > 100
  ) {
    throw new Error("Invalid withdrawal fee.");
  }

  const fee = Math.floor(
    (amount * feeRate) / 100
  );

  const netAmount = amount - fee;

  if (netAmount <= 0) {
    throw new Error(
      "Withdrawal amount is too small after fees."
    );
  }

  const withdrawalRef = firestore
    .collection(COLLECTIONS.WITHDRAWALS)
    .doc(withdrawalId);

  const userRef = firestore
    .collection(COLLECTIONS.USERS)
    .doc(uid);

  const ledgerId =
    `withdrawal_reserve_${withdrawalId}`;

  const ledgerRef = firestore
    .collection(COLLECTIONS.LEDGER)
    .doc(ledgerId);

  let alreadyReserved = false;

  await firestore.runTransaction(async (transaction) => {
    const withdrawalDoc = await transaction.get(
      withdrawalRef
    );

    /*
     * If the request already has fundsReserved=true,
     * never subtract again.
     */
    if (withdrawalDoc.exists) {
      const existing =
        withdrawalDoc.data() || {};

      if (
        existing.fundsReserved === true
      ) {
        alreadyReserved = true;
        return;
      }

      if (
        existing.userId &&
        existing.userId !== uid
      ) {
        throw new Error(
          "Withdrawal account mismatch."
        );
      }
    }

    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error(
        "Your account record could not be found."
      );
    }

    const user = userDoc.data() || {};

    if (isFrozen(user)) {
      throw new Error(
        "This account is currently restricted."
      );
    }

    const payoutBalance = Math.max(
      0,
      money(user.payout_balance_ugx)
    );

    if (payoutBalance < amount) {
      throw new Error(
        `Insufficient payout balance. Available: UGX ${payoutBalance.toLocaleString()}.`
      );
    }

    const newPayoutBalance =
      payoutBalance - amount;

    transaction.set(
      userRef,
      {
        payout_balance_ugx:
          newPayoutBalance,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      withdrawalRef,
      {
        withdrawalId,
        userId: uid,
        amountUgx: amount,
        grossAmountUgx: amount,
        feePercent: feeRate,
        feeUgx: fee,
        netAmountUgx: netAmount,
        currency: CURRENCY,
        fundsReserved: true,
        fundsRestored: false,
        status: "UNDER_REVIEW",
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      ledgerRef,
      {
        transactionId: ledgerId,
        ledgerTransactionId: ledgerId,
        userId: uid,
        type: "WITHDRAWAL_RESERVE",
        direction: "DEBIT",
        amount,
        amountUgx: amount,
        currency: CURRENCY,
        source: "MOBILE_MONEY_WITHDRAWAL",
        referenceId: withdrawalId,
        metadata: {
          feePercent: feeRate,
          feeUgx: fee,
          netAmountUgx: netAmount,
          previousPayoutBalanceUgx:
            payoutBalance,
          newPayoutBalanceUgx:
            newPayoutBalance,
          record: record || null,
        },
        createdAt:
          FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  });

  return {
    success: true,
    alreadyReserved,
    withdrawalId,
    userId: uid,
    grossAmountUgx: amount,
    feeUgx: fee,
    netAmountUgx: netAmount,
  };
}

/* ============================================================
   RESTORE REJECTED WITHDRAWAL
 *
 * Admin rejection restores the FULL gross amount.
 * The user does not lose the 5% fee when the withdrawal
 * is rejected.
 * ============================================================ */

async function restoreWithdrawal({
  withdrawalId,
  userId,
  record = null,
}) {
  requireFirestore();

  const uid = validateUserId(userId);

  if (
    !withdrawalId ||
    typeof withdrawalId !== "string"
  ) {
    throw new Error("Withdrawal ID is required.");
  }

  const withdrawalRef = firestore
    .collection(COLLECTIONS.WITHDRAWALS)
    .doc(withdrawalId);

  const userRef = firestore
    .collection(COLLECTIONS.USERS)
    .doc(uid);

  const ledgerId =
    `withdrawal_restore_${withdrawalId}`;

  const ledgerRef = firestore
    .collection(COLLECTIONS.LEDGER)
    .doc(ledgerId);

  let alreadyRestored = false;

  await firestore.runTransaction(async (transaction) => {
    const withdrawalDoc = await transaction.get(
      withdrawalRef
    );

    if (!withdrawalDoc.exists) {
      throw new Error(
        "Withdrawal record could not be found."
      );
    }

    const withdrawal =
      withdrawalDoc.data() || {};

    if (
      withdrawal.userId &&
      withdrawal.userId !== uid
    ) {
      throw new Error(
        "Withdrawal account mismatch."
      );
    }

    if (
      withdrawal.fundsRestored === true
    ) {
      alreadyRestored = true;
      return;
    }

    if (
      withdrawal.fundsReserved !== true
    ) {
      throw new Error(
        "Withdrawal funds were not reserved."
      );
    }

    const amount = requirePositiveAmount(
      withdrawal.grossAmountUgx ??
      withdrawal.amountUgx,
      "Invalid reserved withdrawal amount."
    );

    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error(
        "Your account record could not be found."
      );
    }

    const user = userDoc.data() || {};

    const currentPayout = Math.max(
      0,
      money(user.payout_balance_ugx)
    );

    const restoredBalance =
      currentPayout + amount;

    transaction.set(
      userRef,
      {
        payout_balance_ugx:
          restoredBalance,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      withdrawalRef,
      {
        status: "REJECTED",
        fundsRestored: true,
        rejectedAt:
          FieldValue.serverTimestamp(),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      ledgerRef,
      {
        transactionId: ledgerId,
        ledgerTransactionId: ledgerId,
        userId: uid,
        type: "WITHDRAWAL_REFUND",
        direction: "CREDIT",
        amount,
        amountUgx: amount,
        currency: CURRENCY,
        source: "MOBILE_MONEY_WITHDRAWAL_REJECTED",
        referenceId: withdrawalId,
        metadata: {
          previousPayoutBalanceUgx:
            currentPayout,
          restoredPayoutBalanceUgx:
            restoredBalance,
          record: record || null,
        },
        createdAt:
          FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  });

  return {
    success: true,
    alreadyRestored,
    withdrawalId,
    userId: uid,
  };
}

/* ============================================================
   MARK WITHDRAWAL DISBURSED
 *
 * Admin has approved the request and manually sent the
 * net amount to the saved MTN/Airtel number.
 *
 * This does NOT move user balance again because the gross
 * amount was already reserved.
 *
 * This operation is idempotent.
 * ============================================================ */

async function markWithdrawalDisbursed({
  withdrawalId,
  userId,
  paymentReference = null,
  record = null,
}) {
  requireFirestore();

  const uid = validateUserId(userId);

  if (
    !withdrawalId ||
    typeof withdrawalId !== "string"
  ) {
    throw new Error("Withdrawal ID is required.");
  }

  const withdrawalRef = firestore
    .collection(COLLECTIONS.WITHDRAWALS)
    .doc(withdrawalId);

  const ledgerId =
    `withdrawal_disbursed_${withdrawalId}`;

  const ledgerRef = firestore
    .collection(COLLECTIONS.LEDGER)
    .doc(ledgerId);

  let alreadyDisbursed = false;

  await firestore.runTransaction(async (transaction) => {
    const withdrawalDoc = await transaction.get(
      withdrawalRef
    );

    if (!withdrawalDoc.exists) {
      throw new Error(
        "Withdrawal record could not be found."
      );
    }

    const withdrawal =
      withdrawalDoc.data() || {};

    if (
      withdrawal.userId &&
      withdrawal.userId !== uid
    ) {
      throw new Error(
        "Withdrawal account mismatch."
      );
    }

    if (
      withdrawal.status === "DISBURSED"
    ) {
      alreadyDisbursed = true;
      return;
    }

    if (
      withdrawal.fundsReserved !== true
    ) {
      throw new Error(
        "Withdrawal funds were not reserved."
      );
    }

    if (
      withdrawal.fundsRestored === true
    ) {
      throw new Error(
        "This withdrawal has already been rejected and restored."
      );
    }

    transaction.set(
      withdrawalRef,
      {
        status: "DISBURSED",
        paymentReference:
          paymentReference || null,
        disbursedAt:
          FieldValue.serverTimestamp(),
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      ledgerRef,
      {
        transactionId: ledgerId,
        ledgerTransactionId: ledgerId,
        userId: uid,
        type: "WITHDRAWAL_DISBURSED",
        direction: "DEBIT",
        amount: Math.max(
          0,
          money(
            withdrawal.grossAmountUgx ??
            withdrawal.amountUgx
          )
        ),
        amountUgx: Math.max(
          0,
          money(
            withdrawal.grossAmountUgx ??
            withdrawal.amountUgx
          )
        ),
        currency: CURRENCY,
        source: "MOBILE_MONEY_DISBURSEMENT",
        referenceId: withdrawalId,
        metadata: {
          grossAmountUgx:
            money(
              withdrawal.grossAmountUgx ??
              withdrawal.amountUgx
            ),
          feeUgx:
            money(withdrawal.feeUgx),
          netAmountUgx:
            money(withdrawal.netAmountUgx),
          network:
            withdrawal.network || null,
          recipientName:
            withdrawal.recipientName || null,
          mobileNumber:
            withdrawal.mobileNumber || null,
          paymentReference:
            paymentReference || null,
          record: record || null,
        },
        createdAt:
          FieldValue.serverTimestamp(),
      },
      { merge: false }
    );
  });

  return {
    success: true,
    alreadyDisbursed,
    withdrawalId,
    userId: uid,
    paymentReference:
      paymentReference || null,
  };
}

/* ============================================================
   LEDGER HISTORY
 * ============================================================ */

async function getLedgerHistory(
  userId,
  limit = 50
) {
  requireFirestore();

  const uid = validateUserId(userId);

  let count = Number.parseInt(
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

  const snapshot = await firestore
    .collection(COLLECTIONS.LEDGER)
    .where("userId", "==", uid)
    .limit(count)
    .get();

  const transactions =
    snapshot.docs.map((doc) => ({
      ledgerTransactionId: doc.id,
      ...doc.data(),
    }));

  transactions.sort((a, b) => {
    const aTime =
      a.createdAt?.toMillis?.() || 0;

    const bTime =
      b.createdAt?.toMillis?.() || 0;

    return bTime - aTime;
  });

  return {
    success: true,
    userId: uid,
    currency: CURRENCY,
    transactions,
  };
}

/* ============================================================
   EXPORTS
 * ============================================================ */

module.exports = {
  getBalance,

  createLedgerEntry,

  creditRechargeToLedger,

  creditSignalPayoutToLedger,

  reserveWithdrawal,

  restoreWithdrawal,

  markWithdrawalDisbursed,

  getLedgerHistory,

  money,
};
