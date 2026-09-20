/**
 * SAINT CRYPTO
 * FILE: services/withdrawal.js
 *
 * FINAL UGX MOBILE MONEY WITHDRAWAL SERVICE
 *
 * BUSINESS RULES
 * ------------------------------------------------------------
 * 1. Withdrawals are made from payout_balance_ugx only.
 * 2. Locked trading capital can NEVER be withdrawn.
 * 3. Network is MTN or AIRTEL.
 * 4. Recipient identity:
 *      - recipientName
 *      - mobileNumber
 *      - network
 * 5. Withdrawal fee is 5%.
 * 6. Gross amount is reserved immediately.
 * 7. Admin approves/rejects through Telegram.
 * 8. Approval means the admin is confirming manual payment.
 * 9. After the admin manually pays the saved number,
 *    withdrawal becomes DISBURSED.
 * 10. Rejection restores the FULL gross amount.
 * 11. No USDT.
 * 12. No TRON.
 * 13. No wallet address.
 * 14. No blockchain TXID verification.
 * 15. All money movements are delegated to services/ledger.js.
 * 16. Operations are idempotent.
 */

"use strict";

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const ledger = require("./ledger");

let firestore = null;

try {
  firestore = getFirestore();
} catch (error) {
  console.error(
    "❌ Withdrawal service: Firestore unavailable:",
    error.message
  );
}

/* ============================================================
   CONFIGURATION
   ============================================================ */

const COLLECTION = "withdrawals";
const USERS_COLLECTION = "users";

const WITHDRAWAL_FEE_PERCENT = Math.max(
  0,
  Math.min(
    100,
    Number(
      process.env.WITHDRAWAL_FEE_PERCENT ??
        process.env.WITHDRAW_FEE_PERCENT ??
        5
    ) || 5
  )
);

const WITHDRAWAL_MINIMUM_UGX = Math.max(
  1,
  Math.round(
    Number(
      process.env.WITHDRAWAL_MINIMUM_UGX ??
        process.env.WITHDRAW_MINIMUM_UGX ??
        1000
    ) || 1000
  )
);

const WITHDRAWAL_MAXIMUM_UGX = Math.max(
  WITHDRAWAL_MINIMUM_UGX,
  Math.round(
    Number(
      process.env.WITHDRAWAL_MAXIMUM_UGX ??
        process.env.WITHDRAW_MAXIMUM_UGX ??
        100000000
    ) || 100000000
  )
);

/* ============================================================
   HELPERS
   ============================================================ */

function requireFirestore() {
  if (!firestore) {
    throw new Error(
      "Database service is unavailable."
    );
  }
}

function validateUserId(userId) {
  if (!userId || typeof userId !== "string") {
    throw new Error("Invalid user account.");
  }

  const uid = userId.trim();

  if (!uid) {
    throw new Error("Invalid user account.");
  }

  return uid;
}

function normalizeNetwork(network) {
  const value = String(network || "")
    .trim()
    .toUpperCase();

  if (value === "MTN") {
    return "MTN";
  }

  if (value === "AIRTEL") {
    return "AIRTEL";
  }

  throw new Error(
    "Select MTN or Airtel Mobile Money."
  );
}

function normalizeName(name) {
  const value = String(name || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!value) {
    throw new Error(
      "Recipient name is required."
    );
  }

  if (value.length < 2 || value.length > 120) {
    throw new Error(
      "Invalid recipient name."
    );
  }

  return value;
}

function normalizePhone(phone) {
  let value = String(phone || "")
    .trim()
    .replace(/[\s-]/g, "");

  if (!value) {
    throw new Error(
      "Mobile Money number is required."
    );
  }

  /*
   * Accept common Uganda forms:
   *   07XXXXXXXX
   *   2567XXXXXXXX
   *   +2567XXXXXXXX
   *
   * Store as 2567XXXXXXXX for consistency.
   */
  if (value.startsWith("+")) {
    value = value.slice(1);
  }

  if (value.startsWith("0")) {
    value = `256${value.slice(1)}`;
  }

  if (
    !/^2567\d{8}$/.test(value)
  ) {
    throw new Error(
      "Enter a valid Ugandan Mobile Money number."
    );
  }

  return value;
}

function displayPhone(phone) {
  const value = normalizePhone(phone);

  return `0${value.slice(3)}`;
}

function normalizeAmount(amountUgx) {
  const amount =
    Math.round(
      Number(amountUgx)
    );

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Enter a valid withdrawal amount."
    );
  }

  if (
    amount < WITHDRAWAL_MINIMUM_UGX
  ) {
    throw new Error(
      `Minimum withdrawal is UGX ${WITHDRAWAL_MINIMUM_UGX.toLocaleString()}.`
    );
  }

  if (
    amount > WITHDRAWAL_MAXIMUM_UGX
  ) {
    throw new Error(
      `Maximum withdrawal is UGX ${WITHDRAWAL_MAXIMUM_UGX.toLocaleString()}.`
    );
  }

  return amount;
}

function calculateWithdrawal(amountUgx) {
  const amount =
    normalizeAmount(amountUgx);

  const feeUgx =
    Math.floor(
      (amount * WITHDRAWAL_FEE_PERCENT) /
        100
    );

  const netAmountUgx =
    amount - feeUgx;

  if (netAmountUgx <= 0) {
    throw new Error(
      "Withdrawal amount is too small after fees."
    );
  }

  return {
    grossAmountUgx: amount,
    feePercent:
      WITHDRAWAL_FEE_PERCENT,
    feeUgx,
    netAmountUgx,
  };
}

function isFrozen(user) {
  return (
    user?.is_frozen === true ||
    String(
      user?.status || ""
    ).toUpperCase() === "FROZEN"
  );
}

/* ============================================================
   WITHDRAWAL CONFIG
 * ============================================================ */

function getWithdrawalConfig() {
  return {
    success: true,
    currency: "UGX",
    feePercent:
      WITHDRAWAL_FEE_PERCENT,
    minimumAmountUgx:
      WITHDRAWAL_MINIMUM_UGX,
    maximumAmountUgx:
      WITHDRAWAL_MAXIMUM_UGX,
    networks: [
      "MTN",
      "AIRTEL",
    ],
    paymentMethod:
      "MOBILE_MONEY",
    manualDisbursement: true,
    lockedCapitalWithdrawable:
      false,
  };
}

/* ============================================================
   GET SAVED WITHDRAWAL PROFILE
 *
 * Stored in:
 *   users/{uid}.withdrawalProfile
 *
 * This replaces the old TRC20 withdrawal wallet.
 * ============================================================ */

async function getWithdrawalProfile(
  userId
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  const userRef =
    firestore
      .collection(USERS_COLLECTION)
      .doc(uid);

  const snapshot =
    await userRef.get();

  if (!snapshot.exists) {
    throw new Error(
      "Your account record could not be found."
    );
  }

  const user =
    snapshot.data() || {};

  const profile =
    user.withdrawalProfile ||
    null;

  if (!profile) {
    return {
      success: true,
      profile: null,
      hasProfile: false,
    };
  }

  return {
    success: true,
    hasProfile: true,
    profile: {
      recipientName:
        profile.recipientName ||
        "",
      network:
        profile.network ||
        "",
      mobileNumber:
        profile.mobileNumber ||
        "",
      mobileNumberDisplay:
        profile.mobileNumber
          ? displayPhone(
              profile.mobileNumber
            )
          : "",
      updatedAt:
        profile.updatedAt ||
        null,
    },
  };
}

/* ============================================================
   SAVE WITHDRAWAL PROFILE
 *
 * The user may update their Mobile Money identity.
 *
 * No money is touched.
 * ============================================================ */

async function saveWithdrawalProfile(
  userId,
  {
    recipientName,
    network,
    mobileNumber,
  } = {}
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  const name =
    normalizeName(
      recipientName
    );

  const finalNetwork =
    normalizeNetwork(network);

  const phone =
    normalizePhone(
      mobileNumber
    );

  const userRef =
    firestore
      .collection(USERS_COLLECTION)
      .doc(uid);

  const userDoc =
    await userRef.get();

  if (!userDoc.exists) {
    throw new Error(
      "Your account record could not be found."
    );
  }

  const user =
    userDoc.data() || {};

  if (isFrozen(user)) {
    throw new Error(
      "Your account is currently restricted."
    );
  }

  await userRef.set(
    {
      withdrawalProfile: {
        recipientName: name,
        network: finalNetwork,
        mobileNumber: phone,
        updatedAt:
          FieldValue.serverTimestamp(),
      },
      updatedAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    }
  );

  return {
    success: true,
    profile: {
      recipientName: name,
      network: finalNetwork,
      mobileNumber: phone,
      mobileNumberDisplay:
        displayPhone(phone),
    },
  };
}

/* ============================================================
   RESOLVE WITHDRAWAL PROFILE
 *
 * If request values are supplied, they are validated and used.
 * Otherwise the saved profile is used.
 *
 * The actual withdrawal record stores a snapshot so that changing
 * the saved profile later cannot change an existing request.
 * ============================================================ */

async function resolveWithdrawalProfile(
  user,
  input = {}
) {
  const saved =
    user.withdrawalProfile ||
    {};

  const hasInput =
    input.recipientName ||
    input.network ||
    input.mobileNumber;

  const recipientName =
    normalizeName(
      input.recipientName ??
        saved.recipientName
    );

  const network =
    normalizeNetwork(
      input.network ??
        saved.network
    );

  const mobileNumber =
    normalizePhone(
      input.mobileNumber ??
        saved.mobileNumber
    );

  /*
   * If a new identity is submitted with the withdrawal,
   * all three fields must be present rather than silently
   * combining an old number with a new network/name.
   */
  if (hasInput) {
    if (
      !input.recipientName ||
      !input.network ||
      !input.mobileNumber
    ) {
      throw new Error(
        "Recipient name, network and mobile number are all required."
      );
    }
  }

  return {
    recipientName,
    network,
    mobileNumber,
    mobileNumberDisplay:
      displayPhone(mobileNumber),
  };
}

/* ============================================================
   REQUEST / RESERVE WITHDRAWAL
 *
 * Gross amount is reserved from payout balance.
 *
 * Example:
 *   Gross: UGX 20,000
 *   Fee:   UGX 1,000
 *   Net:   UGX 19,000
 *
 * The user balance is reduced by the GROSS amount.
 *
 * On rejection:
 *   FULL GROSS amount is restored.
 *
 * On disbursement:
 *   nothing more is deducted.
 * ============================================================ */

async function reserveWithdrawal({
  userId,
  amountUgx,
  recipientName,
  network,
  mobileNumber,
  note = "",
} = {}) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  const calculation =
    calculateWithdrawal(
      amountUgx
    );

  const userRef =
    firestore
      .collection(USERS_COLLECTION)
      .doc(uid);

  const userDoc =
    await userRef.get();

  if (!userDoc.exists) {
    throw new Error(
      "Your account record could not be found."
    );
  }

  const user =
    userDoc.data() || {};

  if (isFrozen(user)) {
    throw new Error(
      "Your account is currently restricted."
    );
  }

  const profile =
    await resolveWithdrawalProfile(
      user,
      {
        recipientName,
        network,
        mobileNumber,
      }
    );

  const withdrawalRef =
    firestore
      .collection(COLLECTION)
      .doc();

  const withdrawalId =
    withdrawalRef.id;

  /*
   * Ledger owns the atomic money reservation.
   * It also writes the withdrawal document.
   */
  await ledger.reserveWithdrawal(
    {
      withdrawalId,
      userId: uid,
      amountUgx:
        calculation.grossAmountUgx,
      feePercent:
        calculation.feePercent,
      record: {
        recipientName:
          profile.recipientName,
        network:
          profile.network,
        mobileNumber:
          profile.mobileNumber,
      },
    }
  );

  /*
   * Add the remaining withdrawal information after the
   * atomic reservation. If this update fails, the money is
   * already safely reserved and the record still exists.
   */
  await withdrawalRef.set(
    {
      withdrawalId,
      userId: uid,

      amountUgx:
        calculation.grossAmountUgx,

      grossAmountUgx:
        calculation.grossAmountUgx,

      feePercent:
        calculation.feePercent,

      feeUgx:
        calculation.feeUgx,

      netAmountUgx:
        calculation.netAmountUgx,

      currency: "UGX",

      paymentMethod:
        "MOBILE_MONEY",

      recipientName:
        profile.recipientName,

      network:
        profile.network,

      mobileNumber:
        profile.mobileNumber,

      mobileNumberDisplay:
        profile.mobileNumberDisplay,

      userNote:
        String(note || "")
          .trim()
          .slice(0, 500) || null,

      status:
        "UNDER_REVIEW",

      fundsReserved:
        true,

      fundsRestored:
        false,

      paymentReference:
        null,

      createdAt:
        FieldValue.serverTimestamp(),

      updatedAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    }
  );

  return {
    success: true,
    withdrawalId,
    status:
      "UNDER_REVIEW",
    currency: "UGX",
    paymentMethod:
      "MOBILE_MONEY",
    grossAmountUgx:
      calculation.grossAmountUgx,
    feePercent:
      calculation.feePercent,
    feeUgx:
      calculation.feeUgx,
    netAmountUgx:
      calculation.netAmountUgx,
    recipientName:
      profile.recipientName,
    network:
      profile.network,
    mobileNumber:
      profile.mobileNumberDisplay,
    message:
      "Withdrawal request submitted for admin review.",
  };
}

/* ============================================================
   GET USER WITHDRAWAL
 * ============================================================ */

async function getWithdrawal(
  userId,
  withdrawalId
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  if (
    !withdrawalId ||
    typeof withdrawalId !== "string"
  ) {
    throw new Error(
      "Withdrawal ID is required."
    );
  }

  const ref =
    firestore
      .collection(COLLECTION)
      .doc(withdrawalId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Withdrawal record could not be found."
    );
  }

  const withdrawal =
    snapshot.data() || {};

  if (
    withdrawal.userId !== uid
  ) {
    throw new Error(
      "You are not allowed to view this withdrawal."
    );
  }

  return {
    success: true,
    withdrawal: {
      withdrawalId:
        snapshot.id,
      ...withdrawal,
    },
  };
}

/* ============================================================
   USER WITHDRAWAL HISTORY
 * ============================================================ */

async function getWithdrawalHistory(
  userId,
  limit = 30
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  let count =
    Number.parseInt(
      limit,
      10
    );

  if (!Number.isFinite(count)) {
    count = 30;
  }

  count = Math.min(
    Math.max(count, 1),
    100
  );

  const snapshot =
    await firestore
      .collection(COLLECTION)
      .where(
        "userId",
        "==",
        uid
      )
      .limit(count)
      .get();

  const records =
    snapshot.docs.map(
      (doc) => ({
        withdrawalId:
          doc.id,
        ...doc.data(),
      })
    );

  records.sort(
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
    withdrawals: records,
  };
}

/* ============================================================
   ADMIN: GET PENDING WITHDRAWALS
 * ============================================================ */

async function getPendingWithdrawals(
  limit = 50
) {
  requireFirestore();

  let count =
    Number.parseInt(
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

  const snapshot =
    await firestore
      .collection(COLLECTION)
      .where(
        "status",
        "==",
        "UNDER_REVIEW"
      )
      .limit(count)
      .get();

  const records =
    snapshot.docs.map(
      (doc) => ({
        withdrawalId:
          doc.id,
        ...doc.data(),
      })
    );

  records.sort(
    (a, b) => {
      const aTime =
        a.createdAt
          ?.toMillis?.() || 0;

      const bTime =
        b.createdAt
          ?.toMillis?.() || 0;

      return aTime - bTime;
    }
  );

  return {
    success: true,
    withdrawals: records,
  };
}

/* ============================================================
   ADMIN: GET WITHDRAWAL
 * ============================================================ */

async function getWithdrawalForAdmin(
  withdrawalId
) {
  requireFirestore();

  if (
    !withdrawalId ||
    typeof withdrawalId !== "string"
  ) {
    throw new Error(
      "Withdrawal ID is required."
    );
  }

  const ref =
    firestore
      .collection(COLLECTION)
      .doc(withdrawalId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Withdrawal record could not be found."
    );
  }

  return {
    success: true,
    withdrawal: {
      withdrawalId:
        snapshot.id,
      ...snapshot.data(),
    },
  };
}

/* ============================================================
   ADMIN: APPROVE / DISBURSE WITHDRAWAL
 *
 * User asked for:
 *   Approve -> DISBURSED
 *
 * Since payment is manual, the safest interpretation is:
 *   admin confirms approval AND confirms the manual payout
 *   has been made.
 *
 * This function therefore:
 *   - validates UNDER_REVIEW
 *   - marks the request DISBURSED
 *   - does not deduct balance again
 *
 * paymentReference is optional because MTN/Airtel manual
 * payment references may not be available through the app.
 * ============================================================ */

async function approveAndDisburseWithdrawal({
  withdrawalId,
  adminId = null,
  paymentReference = null,
  adminNote = "",
} = {}) {
  requireFirestore();

  if (
    !withdrawalId ||
    typeof withdrawalId !== "string"
  ) {
    throw new Error(
      "Withdrawal ID is required."
    );
  }

  const ref =
    firestore
      .collection(COLLECTION)
      .doc(withdrawalId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Withdrawal record could not be found."
    );
  }

  const withdrawal =
    snapshot.data() || {};

  if (
    withdrawal.status ===
    "DISBURSED"
  ) {
    return {
      success: true,
      alreadyDisbursed: true,
      withdrawalId,
      status: "DISBURSED",
    };
  }

  if (
    withdrawal.status !==
    "UNDER_REVIEW"
  ) {
    throw new Error(
      `Withdrawal cannot be approved from status ${
        withdrawal.status || "UNKNOWN"
      }.`
    );
  }

  if (
    withdrawal.fundsReserved !==
    true
  ) {
    throw new Error(
      "Withdrawal funds were not reserved."
    );
  }

  if (
    withdrawal.fundsRestored ===
    true
  ) {
    throw new Error(
      "This withdrawal has already been rejected and refunded."
    );
  }

  const result =
    await ledger.markWithdrawalDisbursed(
      {
        withdrawalId,
        userId:
          withdrawal.userId,
        paymentReference:
          paymentReference ||
          null,
        record: {
          adminId:
            adminId || null,
          adminNote:
            String(
              adminNote || ""
            )
              .trim()
              .slice(0, 500) ||
            null,
          network:
            withdrawal.network ||
            null,
          recipientName:
            withdrawal.recipientName ||
            null,
          mobileNumber:
            withdrawal.mobileNumber ||
            null,
          manualDisbursement:
            true,
        },
      }
    );

  await ref.set(
    {
      status: "DISBURSED",

      approvedBy:
        adminId || null,

      approvedAt:
        FieldValue.serverTimestamp(),

      disbursedBy:
        adminId || null,

      disbursedAt:
        FieldValue.serverTimestamp(),

      paymentReference:
        paymentReference ||
        null,

      adminNote:
        String(
          adminNote || ""
        )
          .trim()
          .slice(0, 500) ||
        null,

      updatedAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    }
  );

  return {
    success: true,
    alreadyDisbursed:
      result.alreadyDisbursed,
    withdrawalId,
    status:
      "DISBURSED",
    grossAmountUgx:
      withdrawal.grossAmountUgx ??
      withdrawal.amountUgx,
    feeUgx:
      withdrawal.feeUgx,
    netAmountUgx:
      withdrawal.netAmountUgx,
    recipientName:
      withdrawal.recipientName,
    network:
      withdrawal.network,
    mobileNumber:
      withdrawal.mobileNumberDisplay ||
      withdrawal.mobileNumber,
    paymentReference:
      paymentReference ||
      null,
  };
}

/* ============================================================
   ADMIN: REJECT WITHDRAWAL
 *
 * Restores FULL gross amount.
 * ============================================================ */

async function rejectWithdrawal({
  withdrawalId,
  adminId = null,
  reason = "",
} = {}) {
  requireFirestore();

  if (
    !withdrawalId ||
    typeof withdrawalId !== "string"
  ) {
    throw new Error(
      "Withdrawal ID is required."
    );
  }

  const ref =
    firestore
      .collection(COLLECTION)
      .doc(withdrawalId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Withdrawal record could not be found."
    );
  }

  const withdrawal =
    snapshot.data() || {};

  if (
    withdrawal.status ===
    "REJECTED"
  ) {
    return {
      success: true,
      alreadyRejected: true,
      withdrawalId,
      status: "REJECTED",
    };
  }

  if (
    withdrawal.status ===
    "DISBURSED"
  ) {
    throw new Error(
      "A disbursed withdrawal cannot be rejected."
    );
  }

  if (
    withdrawal.status !==
    "UNDER_REVIEW"
  ) {
    throw new Error(
      `Withdrawal cannot be rejected from status ${
        withdrawal.status || "UNKNOWN"
      }.`
    );
  }

  if (
    withdrawal.fundsReserved !==
    true
  ) {
    throw new Error(
      "Withdrawal funds were not reserved."
    );
  }

  const result =
    await ledger.restoreWithdrawal(
      {
        withdrawalId,
        userId:
          withdrawal.userId,
        record: {
          adminId:
            adminId || null,
          reason:
            String(
              reason || ""
            )
              .trim()
              .slice(0, 500) ||
            null,
        },
      }
    );

  return {
    success: true,
    alreadyRejected:
      result.alreadyRestored,
    withdrawalId,
    status: "REJECTED",
    restoredAmountUgx:
      withdrawal.grossAmountUgx ??
      withdrawal.amountUgx,
  };
}

/* ============================================================
   CANCEL WITHDRAWAL
 *
 * Optional user cancellation while still UNDER_REVIEW.
 *
 * It uses the same safe restoration mechanism as rejection.
 * This is useful if the user notices a wrong number before
 * admin processing.
 * ============================================================ */

async function cancelWithdrawal(
  userId,
  withdrawalId,
  reason = "Cancelled by user"
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  const ref =
    firestore
      .collection(COLLECTION)
      .doc(withdrawalId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Withdrawal record could not be found."
    );
  }

  const withdrawal =
    snapshot.data() || {};

  if (
    withdrawal.userId !== uid
  ) {
    throw new Error(
      "You are not allowed to cancel this withdrawal."
    );
  }

  if (
    withdrawal.status !==
    "UNDER_REVIEW"
  ) {
    throw new Error(
      "Only a withdrawal under review can be cancelled."
    );
  }

  const result =
    await ledger.restoreWithdrawal(
      {
        withdrawalId,
        userId: uid,
        record: {
          cancelledByUser: true,
          reason:
            String(
              reason || ""
            )
              .trim()
              .slice(0, 500),
        },
      }
    );

  /*
   * ledger.restoreWithdrawal marks the status REJECTED.
   * Change it to CANCELLED while preserving the idempotent
   * refund already performed.
   */
  await ref.set(
    {
      status: "CANCELLED",
      cancelledBy:
        "USER",
      cancelledAt:
        FieldValue.serverTimestamp(),
      updatedAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    }
  );

  return {
    success: true,
    alreadyCancelled:
      result.alreadyRestored,
    withdrawalId,
    status: "CANCELLED",
    restoredAmountUgx:
      withdrawal.grossAmountUgx ??
      withdrawal.amountUgx,
  };
}

/* ============================================================
   EXPORTS
 * ============================================================ */

module.exports = {
  WITHDRAWAL_FEE_PERCENT,
  WITHDRAWAL_MINIMUM_UGX,
  WITHDRAWAL_MAXIMUM_UGX,

  getWithdrawalConfig,

  getWithdrawalProfile,
  saveWithdrawalProfile,

  reserveWithdrawal,

  getWithdrawal,
  getWithdrawalHistory,

  getPendingWithdrawals,
  getWithdrawalForAdmin,

  approveAndDisburseWithdrawal,
  rejectWithdrawal,

  cancelWithdrawal,

  calculateWithdrawal,
  normalizeNetwork,
  normalizePhone,
  normalizeName,
  normalizeAmount,
};
