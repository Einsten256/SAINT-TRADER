"use strict";

// ============================================================
// SAINT CRYPTO
// services/ledger.js
//
// CENTRAL INTERNAL LEDGER
//
// Responsibilities:
// - Credit verified deposits
// - Keep user balance synchronized
// - Maintain locked principal
// - Create immutable ledger transactions
// - Prevent duplicate deposit credits
// - Provide balance information
//
// IMPORTANT:
// This service does NOT talk directly to Bybit.
// Bybit verification belongs to services/bybit.js.
// ============================================================

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

// ============================================================
// FIRESTORE
// ============================================================

let firestore = null;

try {
  firestore = getFirestore();
} catch (error) {
  console.error(
    "❌ Ledger: Firestore unavailable:",
    error.message
  );
}

// ============================================================
// HELPERS
// ============================================================

function roundMoney(
  value,
  decimals = 4
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return 0;
  }

  const factor =
    10 ** decimals;

  return (
    Math.round(
      number * factor
    ) / factor
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
      data.usdt_balance || 0
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
// VALIDATE USER
// ============================================================

function validateUserId(
  userId
) {
  if (
    !userId ||
    typeof userId !==
      "string"
  ) {
    throw new Error(
      "Invalid user account."
    );
  }

  return userId.trim();
}

// ============================================================
// GET USER BALANCE
// ============================================================

async function getBalance(
  userId
) {
  validateUserId(
    userId
  );

  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  const userRef =
    firestore
      .collection("users")
      .doc(userId);

  const snapshot =
    await userRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Your account record could not be found."
    );
  }

  const user =
    snapshot.data() || {};

  const balance =
    roundMoney(
      user.usdt_balance || 0
    );

  const lockedPrincipal =
    roundMoney(
      user.locked_principal || 0
    );

  const withdrawable =
    roundMoney(
      Math.max(
        0,
        balance -
          lockedPrincipal
      )
    );

  return {
    success: true,

    userId,

    usdt_balance:
      balance,

    locked_principal:
      lockedPrincipal,

    withdrawable,

    balances:
      balancesOf(user),
  };
}

// ============================================================
// CREDIT VERIFIED DEPOSIT
//
// THIS IS THE CRITICAL MONEY OPERATION.
//
// Firestore transaction guarantees:
//
// 1. Deposit is checked.
// 2. User balance is increased.
// 3. Locked principal is increased.
// 4. Trade balance is increased.
// 5. Deposit is marked COMPLETED.
// 6. Ledger transaction is created.
// 7. Same deposit cannot be credited twice.
//
// ============================================================

async function creditDepositToLedger(
  depositId,
  userId,
  amount,
  record = null
) {
  validateUserId(
    userId
  );

  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  if (
    !depositId ||
    typeof depositId !==
      "string"
  ) {
    throw new Error(
      "Deposit ID is required."
    );
  }

  const credit =
    roundMoney(amount);

  if (
    !Number.isFinite(
      credit
    ) ||
    credit <= 0
  ) {
    throw new Error(
      "Invalid deposit credit amount."
    );
  }

  const depositRef =
    firestore
      .collection("deposits")
      .doc(depositId);

  const userRef =
    firestore
      .collection("users")
      .doc(userId);

  let alreadyCredited =
    false;

  await firestore.runTransaction(
    async (transaction) => {
      // --------------------------------------------------------
      // READ DEPOSIT
      // --------------------------------------------------------

      const depositDoc =
        await transaction.get(
          depositRef
        );

      if (
        !depositDoc.exists
      ) {
        throw new Error(
          "Deposit record could not be found."
        );
      }

      const deposit =
        depositDoc.data() || {};

      // --------------------------------------------------------
      // IDEMPOTENCY PROTECTION
      // --------------------------------------------------------

      if (
        deposit.status ===
          "COMPLETED" &&
        deposit.creditedToLedger ===
          true
      ) {
        alreadyCredited =
          true;

        return;
      }

      // --------------------------------------------------------
      // READ USER
      // --------------------------------------------------------

      const userDoc =
        await transaction.get(
          userRef
        );

      if (
        !userDoc.exists
      ) {
        throw new Error(
          "Your account record could not be found."
        );
      }

      const user =
        userDoc.data() || {};

      // --------------------------------------------------------
      // FROZEN ACCOUNT PROTECTION
      // --------------------------------------------------------

      if (
        user.is_frozen ===
          true ||
        user.status ===
          "FROZEN"
      ) {
        throw new Error(
          "Your account is currently restricted. Please contact support."
        );
      }

      // --------------------------------------------------------
      // CURRENT BALANCES
      // --------------------------------------------------------

      const currentBalance =
        Number(
          user.usdt_balance || 0
        );

      const locked =
        Number(
          user.locked_principal ||
            0
        );

      const balances =
        balancesOf(user);

      // --------------------------------------------------------
      // NEW TOTAL BALANCE
      // --------------------------------------------------------

      const newBalance =
        roundMoney(
          currentBalance +
            credit
        );

      // --------------------------------------------------------
      // EXCHANGE BALANCE
      //
      // A verified deposit enters the user's Exchange balance first.
      // The user must explicitly move funds from Exchange -> Trade
      // through the internal transfer endpoint before trading.
      // The corresponding amount is also added to locked_principal,
      // so deposited principal cannot be withdrawn as profit.
      // --------------------------------------------------------

      balances.exchange =
        roundMoney(
          balances.exchange +
            credit
        );

      // --------------------------------------------------------
      // LOCKED PRINCIPAL
      //
      // Saint Crypto model:
      //
      // withdrawable =
      // balance - locked_principal
      //
      // --------------------------------------------------------

      const newLockedPrincipal =
        roundMoney(
          locked +
            credit
        );

      // --------------------------------------------------------
      // UPDATE USER
      // --------------------------------------------------------

      transaction.set(
        userRef,
        {
          usdt_balance:
            newBalance,

          locked_principal:
            newLockedPrincipal,

          balances,

          last_updated:
            FieldValue.serverTimestamp(),

          updatedAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      // --------------------------------------------------------
      // COMPLETE DEPOSIT
      // --------------------------------------------------------

      transaction.set(
        depositRef,
        {
          status:
            "COMPLETED",

          creditedToLedger:
            true,

          ledgerCreditAmount:
            credit,

          verifiedAt:
            FieldValue.serverTimestamp(),

          bybitDepositId:
            record?.id ||
            null,

          bybitChain:
            record?.chain ||
            null,

          bybitSuccessAt:
            record?.successAt ||
            null,

          updatedAt:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      // --------------------------------------------------------
      // CREATE LEDGER ENTRY
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
            "DEPOSIT_CREDIT",

          direction:
            "CREDIT",

          amount:
            credit,

          currency:
            "USDT",

          source:
            "BYBIT_DEPOSIT",

          depositId,

          txid:
            deposit.txid ||
            "",

          createdAt:
            FieldValue.serverTimestamp(),
        }
      );
    }
  );

  // ==========================================================
  // RETURN RESULT
  // ==========================================================

  return {
    success: true,

    alreadyCredited,

    depositId,

    userId,

    amount:
      credit,
  };
}

// ============================================================
// GENERIC LEDGER ENTRY
//
// Used for internal accounting events that should not directly
// call Bybit.
// ============================================================

async function createLedgerEntry({
  userId,
  type,
  direction,
  amount,
  currency = "USDT",
  source = "INTERNAL",
  referenceId = null,
  txid = "",
  metadata = {},
}) {
  validateUserId(
    userId
  );

  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  const value =
    roundMoney(amount);

  if (
    !Number.isFinite(
      value
    ) ||
    value <= 0
  ) {
    throw new Error(
      "Invalid ledger amount."
    );
  }

  const ledgerRef =
    firestore
      .collection(
        "ledger_transactions"
      )
      .doc();

  await ledgerRef.set({
    ledgerTransactionId:
      ledgerRef.id,

    userId,

    type:
      type || "INTERNAL",

    direction:
      direction || "CREDIT",

    amount:
      value,

    currency,

    source,

    referenceId,

    txid,

    metadata,

    createdAt:
      FieldValue.serverTimestamp(),
  });

  return {
    success: true,

    ledgerTransactionId:
      ledgerRef.id,

    amount:
      value,
  };
}


// ============================================================
// INTERNAL ACCOUNT TRANSFER
//
// Allowed Saint Crypto movements:
//   TRADE    = exchange -> trade
//   WITHDRAW = trade -> withdraw
//   RETURN_WITHDRAW = withdraw -> trade
//
// Internal transfers do not change:
//   - usdt_balance
//   - locked_principal
//
// They only move funds between the internal balance buckets.
// Every movement is atomic and creates an immutable ledger entry.
// ============================================================

async function transferInternalFunds({
  userId,
  fromAccount,
  toAccount,
  amount,
  transferType,
}) {
  validateUserId(userId);

  if (!firestore) {
    throw new Error("Database service is unavailable.");
  }

  const allowedTransfers = {
    TRADE: {
      from: "exchange",
      to: "trade",
    },
    WITHDRAW: {
      from: "trade",
      to: "withdraw",
    },
    RETURN_WITHDRAW: {
      from: "withdraw",
      to: "trade",
    },
  };

  const type = String(transferType || "").trim().toUpperCase();
  const rule = allowedTransfers[type];

  if (!rule) {
    throw new Error(
      "Invalid transfer type. Only TRADE and WITHDRAW are allowed."
    );
  }

  const from = String(fromAccount || "").trim().toLowerCase();
  const to = String(toAccount || "").trim().toLowerCase();

  if (from !== rule.from || to !== rule.to) {
    throw new Error(
      `${type} transfer must move funds from ${rule.from} to ${rule.to}.`
    );
  }

  const value = roundMoney(amount);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid transfer amount.");
  }

  const userRef = firestore
    .collection("users")
    .doc(userId);

  let result = null;

  await firestore.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error(
        "Your account record could not be found."
      );
    }

    const user = userDoc.data() || {};

    if (
      user.is_frozen === true ||
      user.status === "FROZEN"
    ) {
      throw new Error(
        "Your account is currently restricted. Please contact support."
      );
    }

    const balances = balancesOf(user);

    // ----------------------------------------------------------
    // Source balance protection
    // ----------------------------------------------------------

    if (balances[from] < value) {
      throw new Error(
        `Insufficient ${from} balance. Available: $${balances[from].toFixed(2)} USDT.`
      );
    }

    // ----------------------------------------------------------
    // Locked-principal protection
    //
    // Deposited capital is already placed in Trade and marked as
    // locked principal. It must never be treated as withdrawable.
    //
    // Therefore:
    //   - TRADE (exchange -> trade) may only move funds that are
    //     genuinely sitting in Exchange.
    //   - WITHDRAW (trade -> withdraw) may only move the user's
    //     currently withdrawable profit/funds.
    // ----------------------------------------------------------

    if (type === "WITHDRAW") {
      const totalBalance = roundMoney(
        Number(user.usdt_balance || 0)
      );

      const lockedPrincipal = roundMoney(
        Number(user.locked_principal || 0)
      );

      const withdrawable = roundMoney(
        Math.max(
          0,
          totalBalance - lockedPrincipal
        )
      );

      // Funds already staged in Withdraw are already part of the
      // withdrawable pool. Only the remaining withdrawable amount
      // may be moved from Trade to Withdraw.
      const alreadyInWithdraw = roundMoney(
        balances.withdraw
      );

      const availableToStage = roundMoney(
        Math.max(
          0,
          withdrawable - alreadyInWithdraw
        )
      );

      if (value > availableToStage) {
        throw new Error(
          `Only $${availableToStage.toFixed(2)} USDT is currently available for withdrawal. Your deposited principal remains locked.`
        );
      }
    }

    // ----------------------------------------------------------
    // Perform the internal movement.
    // ----------------------------------------------------------

    balances[from] = roundMoney(
      balances[from] - value
    );

    balances[to] = roundMoney(
      balances[to] + value
    );

    transaction.set(
      userRef,
      {
        // Total ledger balance does not change during an
        // internal transfer.
        usdt_balance: roundMoney(
          Number(user.usdt_balance || 0)
        ),

        // Locked principal does not change.
        locked_principal: roundMoney(
          Number(user.locked_principal || 0)
        ),

        balances,

        last_updated:
          FieldValue.serverTimestamp(),

        updatedAt:
          FieldValue.serverTimestamp(),
      },
      {
        merge: true,
      }
    );

    // ----------------------------------------------------------
    // Immutable ledger record.
    // ----------------------------------------------------------

    const ledgerRef = firestore
      .collection("ledger_transactions")
      .doc();

    transaction.set(ledgerRef, {
      ledgerTransactionId: ledgerRef.id,

      userId,

      type:
        type === "TRADE"
          ? "INTERNAL_TRANSFER_TO_TRADE"
          : type === "WITHDRAW"
            ? "INTERNAL_TRANSFER_TO_WITHDRAW"
            : "INTERNAL_TRANSFER_FROM_WITHDRAW",

      direction: "TRANSFER",

      amount: value,

      currency: "USDT",

      source: "INTERNAL_LEDGER",

      fromAccount: from,

      toAccount: to,

      transferType: type,

      createdAt:
        FieldValue.serverTimestamp(),
    });

    result = {
      success: true,

      transferType: type,

      fromAccount: from,

      toAccount: to,

      amount: value,

      ledgerTransactionId:
        ledgerRef.id,

      balances,
    };
  });

  return result;
}

// ============================================================
// GET LEDGER HISTORY
// ============================================================

async function getLedgerHistory(
  userId,
  limit = 50
) {
  validateUserId(
    userId
  );

  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }

  let count =
    Number.parseInt(
      limit,
      10
    );

  if (
    !Number.isFinite(
      count
    )
  ) {
    count = 50;
  }

  count =
    Math.min(
      Math.max(
        count,
        1
      ),
      100
    );

  const snapshot =
    await firestore
      .collection(
        "ledger_transactions"
      )
      .where(
        "userId",
        "==",
        userId
      )
      .limit(count)
      .get();

  const transactions =
    snapshot.docs.map(
      (doc) => ({
        ledgerTransactionId:
          doc.id,

        ...doc.data(),
      })
    );

  // ----------------------------------------------------------
  // Newest first.
  // ----------------------------------------------------------

  transactions.sort(
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

    transactions,
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getBalance,

  creditDepositToLedger,

  createLedgerEntry,

  getLedgerHistory,

  transferInternalFunds,

  balancesOf,

  roundMoney,
};