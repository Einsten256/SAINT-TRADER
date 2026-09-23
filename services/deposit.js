/**
 * SAINT CRYPTO
 * FILE: services/deposit.js
 *
 * FINAL MOBILE MONEY RECHARGE SERVICE
 *
 * NOTE:
 * This file is the user's supplied recharge service with two
 * integration hardenings: after a recharge is created,
 * Telegram notification is attempted through a lazy require so
 * there is no circular require during application startup.
 */

"use strict";

const crypto = require("crypto");
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
    "❌ Deposit service: Firestore unavailable:",
    error.message
  );
}

const DEFAULT_MIN_RECHARGE_UGX = 1000;
const DEFAULT_MAX_RECHARGE_UGX = 100000000;

const DEFAULT_MTN_NUMBER =
  process.env.RECHARGE_MTN_NUMBER ||
  process.env.MTN_RECHARGE_NUMBER ||
  "";

const DEFAULT_AIRTEL_NUMBER =
  process.env.RECHARGE_AIRTEL_NUMBER ||
  process.env.AIRTEL_RECHARGE_NUMBER ||
  "";

const DEFAULT_MTN_NAME =
  process.env.RECHARGE_MTN_NAME ||
  "MTN Mobile Money";

const DEFAULT_AIRTEL_NAME =
  process.env.RECHARGE_AIRTEL_NAME ||
  "Airtel Money";

const RECHARGE_MINIMUM_UGX = Math.max(
  1,
  Number(
    process.env.RECHARGE_MINIMUM_UGX ??
      process.env.DEPOSIT_MINIMUM_UGX ??
      DEFAULT_MIN_RECHARGE_UGX
  ) || DEFAULT_MIN_RECHARGE_UGX
);

const RECHARGE_MAXIMUM_UGX = Math.max(
  RECHARGE_MINIMUM_UGX,
  Number(
    process.env.RECHARGE_MAXIMUM_UGX ??
      process.env.DEPOSIT_MAXIMUM_UGX ??
      DEFAULT_MAX_RECHARGE_UGX
  ) || DEFAULT_MAX_RECHARGE_UGX
);

const COLLECTION = "recharges";
const USERS_COLLECTION = "users";

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

  const value = userId.trim();

  if (!value) {
    throw new Error("Invalid user account.");
  }

  return value;
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

function normalizeTransactionId(transactionId) {
  const value = String(transactionId || "")
    .trim();

  if (!value) {
    throw new Error(
      "Mobile Money transaction ID is required."
    );
  }

  if (value.length < 4 || value.length > 100) {
    throw new Error(
      "Invalid Mobile Money transaction ID."
    );
  }

  return value;
}

function normalizeSenderName(senderName) {
  const value = String(senderName || "")
    .trim();

  // Sender name is optional.
  // The authenticated Firebase UID is the authoritative user identity.
  if (!value) {
    return "";
  }

  if (value.length > 120) {
    throw new Error("Sender name is too long.");
  }

  return value;
}

function normalizeAmount(amountUgx) {
  const amount = Math.round(Number(amountUgx));

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    throw new Error(
      "Enter a valid recharge amount."
    );
  }

  if (amount < RECHARGE_MINIMUM_UGX) {
    throw new Error(
      `Minimum recharge is UGX ${RECHARGE_MINIMUM_UGX.toLocaleString()}.`
    );
  }

  if (amount > RECHARGE_MAXIMUM_UGX) {
    throw new Error(
      `Maximum recharge is UGX ${RECHARGE_MAXIMUM_UGX.toLocaleString()}.`
    );
  }

  return amount;
}

function isFrozen(user) {
  return (
    user?.is_frozen === true ||
    String(user?.status || "").toUpperCase() === "FROZEN"
  );
}

function safeNetworkConfig() {
  return {
    MTN: {
      network: "MTN",
      displayName: DEFAULT_MTN_NAME,
      number: DEFAULT_MTN_NUMBER,
    },
    AIRTEL: {
      network: "AIRTEL",
      displayName: DEFAULT_AIRTEL_NAME,
      number: DEFAULT_AIRTEL_NUMBER,
    },
  };
}

function transactionFingerprint(
  userId,
  transactionId
) {
  return crypto
    .createHash("sha256")
    .update(
      `${userId}:${transactionId.toUpperCase()}`
    )
    .digest("hex");
}

function getRechargeConfig() {
  const networks = safeNetworkConfig();

  return {
    success: true,
    currency: "UGX",
    feePercent: 0,
    minimumAmountUgx:
      RECHARGE_MINIMUM_UGX,
    maximumAmountUgx:
      RECHARGE_MAXIMUM_UGX,
    networks: {
      MTN: {
        network: networks.MTN.network,
        displayName: networks.MTN.displayName,
        number: networks.MTN.number,
      },
      AIRTEL: {
        network: networks.AIRTEL.network,
        displayName:
          networks.AIRTEL.displayName,
        number: networks.AIRTEL.number,
      },
    },
    instructions: [
      "Accept the Recharge Terms and Conditions.",
      "Choose MTN or Airtel Mobile Money.",
      "Send the exact amount to the displayed operator number.",
      "Keep your Mobile Money transaction ID.",
      "Submit the amount and transaction ID for admin verification.",
      "Your recharge is credited only after admin approval.",
    ],
  };
}

async function notifyRechargeCreatedSafely(
  recharge
) {
  try {
    const telegramRecharge =
      require("./telegram_recharge");

    if (
      telegramRecharge &&
      typeof telegramRecharge.notifyRechargeCreated ===
        "function"
    ) {
      return await telegramRecharge.notifyRechargeCreated(
        recharge
      );
    }
  } catch (error) {
    console.error(
      "[deposit] Telegram recharge notification failed:",
      error?.message || error
    );
  }

  return {
    sent: false,
    reason: "TELEGRAM_NOTIFICATION_UNAVAILABLE",
  };
}

async function submitRecharge(
  userId,
  {
    amountUgx,
    amount,
    network,
    transactionId,
    txid,
    senderName,
    sender,
    termsAccepted,
    acceptedTerms,
  } = {}
) {
  requireFirestore();

  const uid = validateUserId(userId);

  const finalAmount = normalizeAmount(
    amountUgx ?? amount
  );

  const finalNetwork =
    normalizeNetwork(network);

  const finalTransactionId =
    normalizeTransactionId(
      transactionId ?? txid
    );

  const finalSenderName =
    normalizeSenderName(
      senderName ?? sender
    );

  const accepted =
    termsAccepted === true ||
    acceptedTerms === true ||
    String(termsAccepted).toLowerCase() === "true" ||
    String(acceptedTerms).toLowerCase() === "true";

  if (!accepted) {
    throw new Error(
      "You must accept the Recharge Terms and Conditions."
    );
  }

  const userRef =
    firestore
      .collection(USERS_COLLECTION)
      .doc(uid);

  const transactionHash =
    transactionFingerprint(
      uid,
      finalTransactionId
    );

  const duplicateQuery =
    await firestore
      .collection(COLLECTION)
      .where(
        "transactionFingerprint",
        "==",
        transactionHash
      )
      .limit(1)
      .get();

  if (!duplicateQuery.empty) {
    const existing =
      duplicateQuery.docs[0];

    const existingData =
      existing.data() || {};

    return {
      success: true,
      duplicate: true,
      rechargeId: existing.id,
      status:
        existingData.status ||
        "PENDING_ADMIN_REVIEW",
      message:
        existingData.status === "APPROVED"
          ? "This Mobile Money transaction has already been approved."
          : existingData.status === "REJECTED"
            ? "This Mobile Money transaction was already rejected."
            : "This Mobile Money transaction is already under review.",
    };
  }

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
      "Your account is currently restricted. Please contact support."
    );
  }

  const rechargeRef =
    firestore
      .collection(COLLECTION)
      .doc();

  const rechargeId =
    rechargeRef.id;

  const now =
    FieldValue.serverTimestamp();

  const rechargeRecord = {
    rechargeId,
    userId: uid,
    amountUgx: finalAmount,
    amount: finalAmount,
    currency: "UGX",
    network: finalNetwork,
    transactionId: finalTransactionId,
    transactionFingerprint:
      transactionHash,
    senderName: finalSenderName || "Not supplied",
    termsAccepted: true,
    termsAcceptedAt: now,
    status: "PENDING_ADMIN_REVIEW",
    creditedToLedger: false,
    ledgerCreditAmountUgx: 0,
    createdAt: now,
    updatedAt: now,
  };

  await rechargeRef.create(
    rechargeRecord
  );

  const result = {
    success: true,
    duplicate: false,
    rechargeId,
    status:
      "PENDING_ADMIN_REVIEW",
    amountUgx:
      finalAmount,
    currency: "UGX",
    network:
      finalNetwork,
    transactionId:
      finalTransactionId,
    senderName:
      finalSenderName,
    userId: uid,
    termsAccepted: true,
    message:
      "Recharge submitted successfully. Waiting for admin verification.",
  };

  const telegramResult =
    await notifyRechargeCreatedSafely(
      result
    );

  return {
    ...result,
    telegramNotification:
      telegramResult,
  };
}

async function getRecharge(
  userId,
  rechargeId
) {
  requireFirestore();

  const uid =
    validateUserId(userId);

  if (
    !rechargeId ||
    typeof rechargeId !== "string"
  ) {
    throw new Error(
      "Recharge ID is required."
    );
  }

  const ref =
    firestore
      .collection(COLLECTION)
      .doc(rechargeId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Recharge record could not be found."
    );
  }

  const data =
    snapshot.data() || {};

  if (data.userId !== uid) {
    throw new Error(
      "You are not allowed to view this recharge."
    );
  }

  return {
    success: true,
    recharge: {
      rechargeId:
        snapshot.id,
      ...data,
    },
  };
}

async function getRechargeHistory(
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
        rechargeId:
          doc.id,
        ...doc.data(),
      })
    );

  records.sort(
    (a, b) => {
      const aTime =
        a.createdAt?.toMillis?.() ||
        0;

      const bTime =
        b.createdAt?.toMillis?.() ||
        0;

      return bTime - aTime;
    }
  );

  return {
    success: true,
    recharges: records,
  };
}

async function getPendingRecharges(
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
        "PENDING_ADMIN_REVIEW"
      )
      .limit(count)
      .get();

  const records =
    snapshot.docs.map(
      (doc) => ({
        rechargeId:
          doc.id,
        ...doc.data(),
      })
    );

  records.sort(
    (a, b) => {
      const aTime =
        a.createdAt?.toMillis?.() ||
        0;

      const bTime =
        b.createdAt?.toMillis?.() ||
        0;

      return aTime - bTime;
    }
  );

  return {
    success: true,
    recharges: records,
  };
}

async function approveRecharge(
  rechargeId,
  adminId = null
) {
  requireFirestore();

  if (
    !rechargeId ||
    typeof rechargeId !== "string"
  ) {
    throw new Error(
      "Recharge ID is required."
    );
  }

  const rechargeRef =
    firestore
      .collection(COLLECTION)
      .doc(rechargeId);

  const rechargeDoc =
    await rechargeRef.get();

  if (!rechargeDoc.exists) {
    throw new Error(
      "Recharge record could not be found."
    );
  }

  const recharge =
    rechargeDoc.data() || {};

  if (
    recharge.status === "APPROVED" &&
    recharge.creditedToLedger === true
  ) {
    return {
      success: true,
      alreadyApproved: true,
      rechargeId,
      userId:
        recharge.userId,
      amountUgx:
        recharge.amountUgx,
      status: "APPROVED",
    };
  }

  if (
    recharge.status !==
    "PENDING_ADMIN_REVIEW"
  ) {
    throw new Error(
      `Recharge cannot be approved from status ${
        recharge.status || "UNKNOWN"
      }.`
    );
  }

  const result =
    await ledger.creditRechargeToLedger(
      rechargeId,
      recharge.userId,
      recharge.amountUgx,
      {
        adminId:
          adminId || null,
        approvedBy:
          adminId || null,
        approvedFrom:
          "MOBILE_MONEY_ADMIN",
      }
    );

  return {
    success: true,
    alreadyApproved:
      result?.alreadyCredited === true,
    rechargeId,
    userId:
      recharge.userId,
    amountUgx:
      recharge.amountUgx,
    status:
      "APPROVED",
  };
}

async function rejectRecharge(
  rechargeId,
  adminId = null,
  reason = ""
) {
  requireFirestore();

  if (
    !rechargeId ||
    typeof rechargeId !== "string"
  ) {
    throw new Error(
      "Recharge ID is required."
    );
  }

  if (
    reason === "" &&
    typeof adminId === "string" &&
    adminId.toLowerCase().startsWith("rejected by")
  ) {
    reason = adminId;
    adminId = null;
  }

  const rechargeRef =
    firestore
      .collection(COLLECTION)
      .doc(rechargeId);

  let alreadyRejected = false;

  await firestore.runTransaction(
    async (transaction) => {
      const rechargeDoc =
        await transaction.get(
          rechargeRef
        );

      if (!rechargeDoc.exists) {
        throw new Error(
          "Recharge record could not be found."
        );
      }

      const recharge =
        rechargeDoc.data() || {};

      if (
        recharge.status ===
        "REJECTED"
      ) {
        alreadyRejected = true;
        return;
      }

      if (
        recharge.status ===
        "APPROVED"
      ) {
        throw new Error(
          "An approved recharge cannot be rejected."
        );
      }

      if (
        recharge.status !==
        "PENDING_ADMIN_REVIEW"
      ) {
        throw new Error(
          `Recharge cannot be rejected from status ${
            recharge.status || "UNKNOWN"
          }.`
        );
      }

      transaction.set(
        rechargeRef,
        {
          status: "REJECTED",
          rejectionReason:
            String(reason || "")
              .trim()
              .slice(0, 500) || null,
          rejectedBy:
            adminId || null,
          rejectedAt:
            FieldValue.serverTimestamp(),
          updatedAt:
            FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  );

  return {
    success: true,
    alreadyRejected,
    rechargeId,
    status: "REJECTED",
  };
}

async function getRechargeForAdmin(
  rechargeId
) {
  requireFirestore();

  if (
    !rechargeId ||
    typeof rechargeId !== "string"
  ) {
    throw new Error(
      "Recharge ID is required."
    );
  }

  const ref =
    firestore
      .collection(COLLECTION)
      .doc(rechargeId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Recharge record could not be found."
    );
  }

  return {
    success: true,
    recharge: {
      rechargeId:
        snapshot.id,
      ...snapshot.data(),
    },
  };
}

module.exports = {
  getRechargeConfig,
  submitRecharge,
  getRecharge,
  getRechargeHistory,
  getPendingRecharges,
  getRechargeForAdmin,
  approveRecharge,
  rejectRecharge,
  normalizeNetwork,
  normalizeTransactionId,
  normalizeAmount,
};