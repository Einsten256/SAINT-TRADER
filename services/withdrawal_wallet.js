// ============================================================
// SAINT CRYPTO — MOBILE MONEY WITHDRAWAL PROFILE SERVICE
// services/withdrawal_wallet.js
// ============================================================
// Purpose:
// - Save the user's withdrawal identity for Mobile Money.
// - Support MTN or Airtel.
// - Save recipient name + mobile number.
// - Keep the profile reusable for future withdrawals.
// - Allow the user to request a new withdrawal identity.
// - Keep the current identity active while a change is pending.
// - Promote/reject changes only through an admin/security path.
// - No withdrawal request is created here.
// - No ledger/funds are touched here.
// - No crypto wallet / TRON / USDT logic.
// ============================================================

"use strict";

const { getFirestore, FieldValue } =
  require("firebase-admin/firestore");

let firestore = null;

try {
  firestore = getFirestore();
} catch (error) {
  console.error(
    "❌ withdrawal_wallet.js: Firestore unavailable:",
    error.message
  );
}

// ============================================================
// HELPERS
// ============================================================

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function normalizeNetwork(value) {
  const network = String(value || "")
    .trim()
    .toUpperCase();

  if (network === "MTN") return "MTN";
  if (network === "AIRTEL") return "AIRTEL";

  return "";
}

function normalizePhone(value) {
  let phone = String(value || "")
    .trim()
    .replace(/[\s()-]/g, "");

  if (phone.startsWith("+256")) {
    phone = "0" + phone.slice(4);
  } else if (phone.startsWith("256")) {
    phone = "0" + phone.slice(3);
  }

  return phone;
}

function validUgandaPhone(phone) {
  return /^07[0-9]{8}$/.test(phone);
}

function validNetworkPhone(network, phone) {
  if (!validUgandaPhone(phone)) {
    return false;
  }

  const prefix = phone.slice(0, 3);

  const mtnPrefixes = [
    "077", "078", "076"
  ];

  const airtelPrefixes = [
    "070", "075", "074"
  ];

  if (network === "MTN") {
    return mtnPrefixes.includes(prefix);
  }

  if (network === "AIRTEL") {
    return airtelPrefixes.includes(prefix);
  }

  return false;
}

function serializeTimestamp(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function safeStatus(value, fallback = "PENDING") {
  const status = String(value || "")
    .trim()
    .toUpperCase();

  return status || fallback;
}

function authRequired() {
  return {
    success: false,
    code: "AUTH_REQUIRED",
    message: "Your account could not be verified.",
    httpStatus: 401,
  };
}

function databaseUnavailable() {
  return {
    success: false,
    code: "DATABASE_UNAVAILABLE",
    message:
      "Our account database is temporarily unavailable.",
    httpStatus: 503,
  };
}

function accountFrozen() {
  const error = new Error(
    "Your account is currently restricted."
  );
  error.code = "ACCOUNT_FROZEN";
  error.httpStatus = 403;
  return error;
}

function validateIdentity(name, network, mobile) {
  if (!name) {
    return {
      ok: false,
      code: "RECIPIENT_NAME_REQUIRED",
      message: "Please enter the recipient name.",
    };
  }

  if (name.length < 2) {
    return {
      ok: false,
      code: "INVALID_RECIPIENT_NAME",
      message: "Please enter a valid recipient name.",
    };
  }

  if (!network) {
    return {
      ok: false,
      code: "NETWORK_REQUIRED",
      message: "Please select MTN or Airtel.",
    };
  }

  if (!mobile) {
    return {
      ok: false,
      code: "MOBILE_NUMBER_REQUIRED",
      message: "Please enter the Mobile Money number.",
    };
  }

  if (!validUgandaPhone(mobile)) {
    return {
      ok: false,
      code: "INVALID_MOBILE_NUMBER",
      message:
        "Please enter a valid Ugandan Mobile Money number.",
    };
  }

  if (!validNetworkPhone(network, mobile)) {
    return {
      ok: false,
      code: "NETWORK_NUMBER_MISMATCH",
      message:
        `The number does not match the selected ${network} network.`,
    };
  }

  return { ok: true };
}

function serializeProfile(user) {
  const profile = user.withdrawalProfile || {};

  const name = normalizeName(
    profile.name || user.withdrawal_name
  );

  const network = normalizeNetwork(
    profile.network || user.withdrawal_network
  );

  const mobile = normalizePhone(
    profile.mobile || user.withdrawal_mobile
  );

  if (!name && !network && !mobile) {
    return null;
  }

  return {
    name,
    network,
    mobile,
    locked:
      profile.locked === true ||
      user.withdrawal_profile_locked === true,
    status: safeStatus(
      profile.status || user.withdrawal_profile_status,
      "PENDING"
    ),
    savedAt: serializeTimestamp(
      profile.savedAt || user.withdrawal_profile_saved_at
    ),
    approvedAt: serializeTimestamp(
      profile.approvedAt ||
      user.withdrawal_profile_approved_at
    ),
  };
}

function serializePending(user) {
  const pendingName = normalizeName(
    user.pending_withdrawal_name
  );

  const pendingNetwork = normalizeNetwork(
    user.pending_withdrawal_network
  );

  const pendingMobile = normalizePhone(
    user.pending_withdrawal_mobile
  );

  if (!pendingName && !pendingNetwork && !pendingMobile) {
    return null;
  }

  return {
    name: pendingName,
    network: pendingNetwork,
    mobile: pendingMobile,
    status: safeStatus(
      user.withdrawal_profile_change_status,
      "PENDING"
    ),
    requestedAt: serializeTimestamp(
      user.withdrawal_profile_change_requested_at
    ),
    approvedAt: serializeTimestamp(
      user.withdrawal_profile_change_approved_at
    ),
    approvedBy:
      user.withdrawal_profile_change_approved_by || null,
    rejectedAt: serializeTimestamp(
      user.withdrawal_profile_change_rejected_at
    ),
    rejectedBy:
      user.withdrawal_profile_change_rejected_by || null,
    rejectionReason:
      user.withdrawal_profile_change_rejection_reason ||
      null,
  };
}

// ============================================================
// SAVE FIRST WITHDRAWAL PROFILE
// ============================================================

async function saveWithdrawalWallet(
  userId,
  name,
  network,
  mobile
) {
  if (!firestore) return databaseUnavailable();

  if (!userId || typeof userId !== "string") {
    return authRequired();
  }

  const cleanName = normalizeName(name);
  const cleanNetwork = normalizeNetwork(network);
  const cleanMobile = normalizePhone(mobile);

  const validation = validateIdentity(
    cleanName,
    cleanNetwork,
    cleanMobile
  );

  if (!validation.ok) {
    return {
      success: false,
      code: validation.code,
      message: validation.message,
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error(
          "Your account record could not be found."
        );
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};

      if (
        user.is_frozen === true ||
        String(user.status || "").toUpperCase() === "FROZEN"
      ) {
        throw accountFrozen();
      }

      const existing = serializeProfile(user);
      const locked =
        user.withdrawal_profile_locked === true ||
        existing?.locked === true;

      if (existing && locked) {
        const same =
          existing.name.toLowerCase() ===
            cleanName.toLowerCase() &&
          existing.network === cleanNetwork &&
          existing.mobile === cleanMobile;

        if (!same) {
          const error = new Error(
            "Your withdrawal details are already locked. Use the withdrawal-details change request instead."
          );
          error.code = "WITHDRAWAL_PROFILE_LOCKED";
          error.httpStatus = 409;
          throw error;
        }

        result = {
          success: true,
          code: "WITHDRAWAL_PROFILE_ALREADY_SAVED",
          message:
            "Your Mobile Money withdrawal details are already saved and locked.",
          profile: existing,
          pendingChange: serializePending(user),
          httpStatus: 200,
        };

        return;
      }

      transaction.set(
        userRef,
        {
          withdrawalProfile: {
            name: cleanName,
            network: cleanNetwork,
            mobile: cleanMobile,
            locked: true,
            status: "ACTIVE",
            savedAt:
              FieldValue.serverTimestamp(),
            approvedAt:
              FieldValue.serverTimestamp(),
          },

          // Flat fields retained for compatibility.
          withdrawal_name: cleanName,
          withdrawal_network: cleanNetwork,
          withdrawal_mobile: cleanMobile,
          withdrawal_profile_locked: true,
          withdrawal_profile_status: "ACTIVE",
          withdrawal_profile_saved_at:
            FieldValue.serverTimestamp(),
          withdrawal_profile_approved_at:
            FieldValue.serverTimestamp(),
          withdrawal_profile_updated_at:
            FieldValue.serverTimestamp(),

          // Clear stale pending request.
          pending_withdrawal_name:
            FieldValue.delete(),
          pending_withdrawal_network:
            FieldValue.delete(),
          pending_withdrawal_mobile:
            FieldValue.delete(),
          withdrawal_profile_change_status:
            FieldValue.delete(),
          withdrawal_profile_change_requested_at:
            FieldValue.delete(),
          withdrawal_profile_change_approved_at:
            FieldValue.delete(),
          withdrawal_profile_change_approved_by:
            FieldValue.delete(),
        },
        { merge: true }
      );

      result = {
        success: true,
        code: "WITHDRAWAL_PROFILE_SAVED",
        message:
          "Your Mobile Money withdrawal details have been saved.",
        profile: {
          name: cleanName,
          network: cleanNetwork,
          mobile: cleanMobile,
          locked: true,
          status: "ACTIVE",
          savedAt: null,
          approvedAt: null,
        },
        pendingChange: null,
        httpStatus: 200,
      };
    });

    return result;
  } catch (error) {
    console.error(
      "❌ Save withdrawal profile:",
      error.message
    );

    return {
      success: false,
      code:
        error.code ||
        "WITHDRAWAL_PROFILE_SAVE_FAILED",
      message:
        error.message ||
        "Unable to save your withdrawal details.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// REQUEST NEW WITHDRAWAL PROFILE
// ============================================================

async function requestWithdrawalWalletChange(
  userId,
  name,
  network,
  mobile
) {
  if (!firestore) return databaseUnavailable();

  if (!userId || typeof userId !== "string") {
    return authRequired();
  }

  const cleanName = normalizeName(name);
  const cleanNetwork = normalizeNetwork(network);
  const cleanMobile = normalizePhone(mobile);

  const validation = validateIdentity(
    cleanName,
    cleanNetwork,
    cleanMobile
  );

  if (!validation.ok) {
    return {
      success: false,
      code: validation.code,
      message: validation.message,
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error(
          "Your account record could not be found."
        );
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};

      if (
        user.is_frozen === true ||
        String(user.status || "").toUpperCase() === "FROZEN"
      ) {
        throw accountFrozen();
      }

      const current = serializeProfile(user);

      if (!current || current.locked !== true) {
        const error = new Error(
          "Your current withdrawal details have not been set up yet."
        );
        error.code = "CURRENT_PROFILE_NOT_SET";
        error.httpStatus = 409;
        throw error;
      }

      const same =
        current.name.toLowerCase() ===
          cleanName.toLowerCase() &&
        current.network === cleanNetwork &&
        current.mobile === cleanMobile;

      if (same) {
        result = {
          success: true,
          code: "CURRENT_PROFILE_REUSED",
          message:
            "Those are already your active withdrawal details.",
          profile: current,
          pendingChange: null,
          httpStatus: 200,
        };
        return;
      }

      const pending = serializePending(user);

      if (
        pending &&
        pending.status === "PENDING"
      ) {
        const samePending =
          pending.name.toLowerCase() ===
            cleanName.toLowerCase() &&
          pending.network === cleanNetwork &&
          pending.mobile === cleanMobile;

        if (samePending) {
          result = {
            success: true,
            code: "WITHDRAWAL_PROFILE_CHANGE_ALREADY_PENDING",
            message:
              "These withdrawal details are already pending approval.",
            profile: current,
            pendingChange: pending,
            httpStatus: 200,
          };
          return;
        }

        const error = new Error(
          "A withdrawal-details change request is already pending."
        );
        error.code =
          "WITHDRAWAL_PROFILE_CHANGE_ALREADY_PENDING";
        error.httpStatus = 409;
        throw error;
      }

      transaction.set(
        userRef,
        {
          pending_withdrawal_name: cleanName,
          pending_withdrawal_network: cleanNetwork,
          pending_withdrawal_mobile: cleanMobile,

          withdrawal_profile_change_status: "PENDING",
          withdrawal_profile_change_requested_at:
            FieldValue.serverTimestamp(),
          withdrawal_profile_change_approved_at: null,
          withdrawal_profile_change_approved_by: null,
          withdrawal_profile_change_rejected_at: null,
          withdrawal_profile_change_rejected_by: null,
          withdrawal_profile_change_rejection_reason: null,

          withdrawal_profile_updated_at:
            FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      result = {
        success: true,
        code: "WITHDRAWAL_PROFILE_CHANGE_REQUESTED",
        message:
          "Your new Mobile Money withdrawal details have been submitted for review. Your current details remain active until approval.",
        profile: current,
        pendingChange: {
          name: cleanName,
          network: cleanNetwork,
          mobile: cleanMobile,
          status: "PENDING",
          requestedAt: null,
        },
        httpStatus: 200,
      };
    });

    return result;
  } catch (error) {
    console.error(
      "❌ Request withdrawal profile change:",
      error.message
    );

    return {
      success: false,
      code:
        error.code ||
        "WITHDRAWAL_PROFILE_CHANGE_FAILED",
      message:
        error.message ||
        "Unable to request a withdrawal-details change.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// APPROVE PENDING WITHDRAWAL PROFILE CHANGE
// ============================================================
// SECURITY-SENSITIVE: admin/security path only.

async function approveWithdrawalWalletChange(
  userId,
  approvedBy = ""
) {
  if (!firestore) return databaseUnavailable();

  if (!userId || typeof userId !== "string") {
    return {
      success: false,
      code: "USER_ID_REQUIRED",
      message: "A valid user is required.",
      httpStatus: 400,
    };
  }

  const approver = String(approvedBy || "").trim();

  if (!approver) {
    return {
      success: false,
      code: "APPROVER_REQUIRED",
      message:
        "An approving administrator is required.",
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error(
          "User account could not be found."
        );
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};

      if (
        user.is_frozen === true ||
        String(user.status || "").toUpperCase() === "FROZEN"
      ) {
        throw accountFrozen();
      }

      const current = serializeProfile(user);
      const pending = serializePending(user);

      if (!current || current.locked !== true) {
        const error = new Error(
          "The user's current withdrawal details are not properly configured."
        );
        error.code = "CURRENT_PROFILE_NOT_SET";
        error.httpStatus = 409;
        throw error;
      }

      if (
        !pending ||
        pending.status !== "PENDING"
      ) {
        const error = new Error(
          "There is no pending withdrawal-details change request for this user."
        );
        error.code =
          "NO_PENDING_WITHDRAWAL_PROFILE_CHANGE";
        error.httpStatus = 409;
        throw error;
      }

      const validation = validateIdentity(
        pending.name,
        pending.network,
        pending.mobile
      );

      if (!validation.ok) {
        const error = new Error(
          validation.message
        );
        error.code =
          "INVALID_PENDING_WITHDRAWAL_PROFILE";
        error.httpStatus = 409;
        throw error;
      }

      transaction.set(
        userRef,
        {
          withdrawalProfile: {
            name: pending.name,
            network: pending.network,
            mobile: pending.mobile,
            locked: true,
            status: "ACTIVE",
            savedAt:
              FieldValue.serverTimestamp(),
            approvedAt:
              FieldValue.serverTimestamp(),
          },

          withdrawal_name: pending.name,
          withdrawal_network: pending.network,
          withdrawal_mobile: pending.mobile,
          withdrawal_profile_locked: true,
          withdrawal_profile_status: "ACTIVE",
          withdrawal_profile_saved_at:
            FieldValue.serverTimestamp(),
          withdrawal_profile_approved_at:
            FieldValue.serverTimestamp(),
          withdrawal_profile_updated_at:
            FieldValue.serverTimestamp(),

          withdrawal_profile_change_status:
            "APPROVED",
          withdrawal_profile_change_approved_at:
            FieldValue.serverTimestamp(),
          withdrawal_profile_change_approved_by:
            approver,

          previous_withdrawal_name: current.name,
          previous_withdrawal_network:
            current.network,
          previous_withdrawal_mobile:
            current.mobile,
          previous_withdrawal_changed_at:
            FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      result = {
        success: true,
        code:
          "WITHDRAWAL_PROFILE_CHANGE_APPROVED",
        message:
          "The new Mobile Money withdrawal details have been approved and are now active.",
        profile: {
          name: pending.name,
          network: pending.network,
          mobile: pending.mobile,
          locked: true,
          status: "ACTIVE",
          savedAt: null,
          approvedAt: null,
        },
        previousProfile: {
          name: current.name,
          network: current.network,
          mobile: current.mobile,
        },
        approvedBy: approver,
        httpStatus: 200,
      };
    });

    return result;
  } catch (error) {
    console.error(
      "❌ Approve withdrawal profile change:",
      error.message
    );

    return {
      success: false,
      code:
        error.code ||
        "WITHDRAWAL_PROFILE_CHANGE_APPROVAL_FAILED",
      message:
        error.message ||
        "Unable to approve the withdrawal-details change.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// REJECT PENDING WITHDRAWAL PROFILE CHANGE
// ============================================================

async function rejectWithdrawalWalletChange(
  userId,
  rejectedBy = "",
  reason = "Withdrawal details change rejected."
) {
  if (!firestore) return databaseUnavailable();

  if (!userId || typeof userId !== "string") {
    return {
      success: false,
      code: "USER_ID_REQUIRED",
      message: "A valid user is required.",
      httpStatus: 400,
    };
  }

  const reviewer = String(rejectedBy || "").trim();
  const rejectionReason =
    String(reason || "").trim() ||
    "Withdrawal details change rejected.";

  if (!reviewer) {
    return {
      success: false,
      code: "REVIEWER_REQUIRED",
      message:
        "A reviewing administrator is required.",
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error(
          "User account could not be found."
        );
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};
      const pending = serializePending(user);

      if (
        !pending ||
        pending.status !== "PENDING"
      ) {
        const error = new Error(
          "There is no pending withdrawal-details change request for this user."
        );
        error.code =
          "NO_PENDING_WITHDRAWAL_PROFILE_CHANGE";
        error.httpStatus = 409;
        throw error;
      }

      transaction.set(
        userRef,
        {
          withdrawal_profile_change_status:
            "REJECTED",
          withdrawal_profile_change_rejected_at:
            FieldValue.serverTimestamp(),
          withdrawal_profile_change_rejected_by:
            reviewer,
          withdrawal_profile_change_rejection_reason:
            rejectionReason,
          withdrawal_profile_updated_at:
            FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      result = {
        success: true,
        code:
          "WITHDRAWAL_PROFILE_CHANGE_REJECTED",
        message:
          "The withdrawal-details change was rejected. Your current details remain active.",
        currentProfile: serializeProfile(user),
        pendingChange: {
          name: pending.name,
          network: pending.network,
          mobile: pending.mobile,
          status: "REJECTED",
          reason: rejectionReason,
        },
        rejectedBy: reviewer,
        httpStatus: 200,
      };
    });

    return result;
  } catch (error) {
    console.error(
      "❌ Reject withdrawal profile change:",
      error.message
    );

    return {
      success: false,
      code:
        error.code ||
        "WITHDRAWAL_PROFILE_CHANGE_REJECTION_FAILED",
      message:
        error.message ||
        "Unable to reject the withdrawal-details change.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// GET USER WITHDRAWAL PROFILE
// ============================================================

async function getWithdrawalWallet(userId) {
  if (!firestore) return databaseUnavailable();

  if (!userId || typeof userId !== "string") {
    return authRequired();
  }

  try {
    const userDoc = await firestore
      .collection("users")
      .doc(userId)
      .get();

    if (!userDoc.exists) {
      return {
        success: false,
        code: "USER_NOT_FOUND",
        message:
          "Your account record could not be found.",
        httpStatus: 404,
      };
    }

    const user = userDoc.data() || {};

    return {
      success: true,
      code: "WITHDRAWAL_PROFILE_FETCHED",
      profile: serializeProfile(user),
      pendingChange: serializePending(user),
      previousProfile:
        normalizeName(user.previous_withdrawal_name) ||
        normalizeNetwork(
          user.previous_withdrawal_network
        ) ||
        normalizePhone(
          user.previous_withdrawal_mobile
        )
          ? {
              name:
                normalizeName(
                  user.previous_withdrawal_name
                ) || null,
              network:
                normalizeNetwork(
                  user.previous_withdrawal_network
                ) || null,
              mobile:
                normalizePhone(
                  user.previous_withdrawal_mobile
                ) || null,
              changedAt: serializeTimestamp(
                user.previous_withdrawal_changed_at
              ),
            }
          : null,
      httpStatus: 200,
    };
  } catch (error) {
    console.error(
      "❌ Get withdrawal profile:",
      error.message
    );

    return {
      success: false,
      code: "WITHDRAWAL_PROFILE_FETCH_FAILED",
      message:
        "Unable to load your withdrawal details.",
      httpStatus: 500,
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Kept export name so existing route/index wiring does not
  // immediately break while the backend is migrated.
  saveWithdrawalWallet,
  requestWithdrawalWalletChange,
  approveWithdrawalWalletChange,
  rejectWithdrawalWalletChange,
  getWithdrawalWallet,

  // New Mobile Money helpers.
  normalizeName,
  normalizeNetwork,
  normalizePhone,
  validUgandaPhone,
  validNetworkPhone,
};
