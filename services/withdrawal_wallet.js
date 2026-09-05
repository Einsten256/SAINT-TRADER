"use strict";

// ============================================================
// SAINT CRYPTO — WITHDRAWAL WALLET SERVICE
// services/withdrawal_wallet.js
//
// Purpose:
// - Save the user's first USDT TRC20 withdrawal wallet.
// - Lock the active wallet so normal withdrawal requests cannot
//   silently redirect funds.
// - Allow the user to request a NEW wallet separately.
// - Keep the current wallet untouched while a change is pending.
// - Promote the new wallet only through an explicit approval call.
// - No withdrawal request is created here.
// - No ledger/funds are touched here.
// - No Fund PIN is required here.
// ============================================================

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

let firestore;

try {
  firestore = getFirestore();
} catch (error) {
  console.error(
    "❌ withdrawal_wallet.js: Firestore unavailable:",
    error.message
  );
}

// ============================================================
// TRON VALIDATION
// ============================================================

function validTron(address) {
  return (
    typeof address === "string" &&
    /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim())
  );
}

function normalizeAddress(address) {
  return String(address || "").trim();
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
  const status = String(value || "").trim().toUpperCase();
  return status || fallback;
}

// ============================================================
// SAVE FIRST WITHDRAWAL WALLET
// ============================================================

async function saveWithdrawalWallet(userId, address) {
  if (!firestore) {
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

  if (!userId || typeof userId !== "string") {
    return {
      success: false,
      code: "AUTH_REQUIRED",
      message: "Your account could not be verified.",
      httpStatus: 401,
    };
  }

  const normalizedAddress = normalizeAddress(address);

  if (!normalizedAddress) {
    return {
      success: false,
      code: "ADDRESS_REQUIRED",
      message: "Please enter your USDT TRC20 wallet address.",
      httpStatus: 400,
    };
  }

  if (!validTron(normalizedAddress)) {
    return {
      success: false,
      code: "INVALID_TRC20_ADDRESS",
      message: "Please enter a valid USDT TRC20 wallet address.",
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error("Your account record could not be found.");
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};

      if (
        user.is_frozen === true ||
        user.status === "FROZEN"
      ) {
        const error = new Error("Your account is currently restricted.");
        error.code = "ACCOUNT_FROZEN";
        error.httpStatus = 403;
        throw error;
      }

      const existingAddress = normalizeAddress(
        user.withdrawal_wallet_address
      );

      const locked = user.withdrawal_wallet_locked === true;

      // ----------------------------------------------------------
      // Existing active wallet:
      // - Same address = harmless/idempotent.
      // - Different address = MUST use the change endpoint.
      // ----------------------------------------------------------

      if (existingAddress && locked) {
        if (existingAddress !== normalizedAddress) {
          const error = new Error(
            "Your withdrawal wallet is already locked. Use the wallet-change request instead."
          );
          error.code = "WITHDRAWAL_WALLET_LOCKED";
          error.httpStatus = 409;
          throw error;
        }

        result = {
          success: true,
          code: "WITHDRAWAL_WALLET_ALREADY_SAVED",
          message: "Your withdrawal wallet is already saved and locked.",
          wallet: {
            address: existingAddress,
            network: user.withdrawal_wallet_network || "TRC20",
            coin: user.withdrawal_wallet_coin || "USDT",
            locked: true,
            status: safeStatus(
              user.withdrawal_wallet_status,
              "PENDING"
            ),
            savedAt: serializeTimestamp(
              user.withdrawal_wallet_saved_at
            ),
            approvedAt: serializeTimestamp(
              user.withdrawal_wallet_approved_at
            ),
          },
          pendingChange: user.pending_withdrawal_wallet_address
            ? {
                address:
                  user.pending_withdrawal_wallet_address,
                network:
                  user.pending_withdrawal_wallet_network ||
                  "TRC20",
                coin:
                  user.pending_withdrawal_wallet_coin ||
                  "USDT",
                status: safeStatus(
                  user.wallet_change_status,
                  "PENDING"
                ),
                requestedAt: serializeTimestamp(
                  user.wallet_change_requested_at
                ),
              }
            : null,
          httpStatus: 200,
        };

        return;
      }

      // ----------------------------------------------------------
      // First wallet only.
      // ----------------------------------------------------------

      transaction.set(
        userRef,
        {
          withdrawal_wallet_address: normalizedAddress,
          withdrawal_wallet_network: "TRC20",
          withdrawal_wallet_coin: "USDT",
          withdrawal_wallet_locked: true,
          withdrawal_wallet_status: "PENDING",
          withdrawal_wallet_saved_at:
            FieldValue.serverTimestamp(),
          withdrawal_wallet_approved_at: null,
          withdrawal_wallet_updated_at:
            FieldValue.serverTimestamp(),

          // Clear any stale pending-change fields if present.
          pending_withdrawal_wallet_address:
            FieldValue.delete(),
          pending_withdrawal_wallet_network:
            FieldValue.delete(),
          pending_withdrawal_wallet_coin:
            FieldValue.delete(),
          wallet_change_status:
            FieldValue.delete(),
          wallet_change_requested_at:
            FieldValue.delete(),
          wallet_change_approved_at:
            FieldValue.delete(),
          wallet_change_approved_by:
            FieldValue.delete(),
        },
        {
          merge: true,
        }
      );

      result = {
        success: true,
        code: "WITHDRAWAL_WALLET_SAVED",
        message:
          "Your withdrawal wallet has been saved and locked. It can now be prepared in the withdrawal system.",
        wallet: {
          address: normalizedAddress,
          network: "TRC20",
          coin: "USDT",
          locked: true,
          status: "PENDING",
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
      "❌ Save withdrawal wallet:",
      error.message
    );

    return {
      success: false,
      code: error.code || "WITHDRAWAL_WALLET_SAVE_FAILED",
      message:
        error.message ||
        "Unable to save your withdrawal wallet.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// REQUEST NEW WITHDRAWAL WALLET
//
// IMPORTANT:
// - This does NOT replace the active wallet.
// - The active wallet remains locked and unchanged.
// - The new address is stored separately.
// - Approval is required before promotion.
// ============================================================

async function requestWithdrawalWalletChange(
  userId,
  newAddress
) {
  if (!firestore) {
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

  if (!userId || typeof userId !== "string") {
    return {
      success: false,
      code: "AUTH_REQUIRED",
      message: "Your account could not be verified.",
      httpStatus: 401,
    };
  }

  const normalizedAddress = normalizeAddress(newAddress);

  if (!normalizedAddress) {
    return {
      success: false,
      code: "ADDRESS_REQUIRED",
      message: "Please enter the new USDT TRC20 wallet address.",
      httpStatus: 400,
    };
  }

  if (!validTron(normalizedAddress)) {
    return {
      success: false,
      code: "INVALID_TRC20_ADDRESS",
      message: "Please enter a valid USDT TRC20 wallet address.",
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error("Your account record could not be found.");
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};

      if (
        user.is_frozen === true ||
        user.status === "FROZEN"
      ) {
        const error = new Error("Your account is currently restricted.");
        error.code = "ACCOUNT_FROZEN";
        error.httpStatus = 403;
        throw error;
      }

      const currentAddress = normalizeAddress(
        user.withdrawal_wallet_address
      );

      if (
        !currentAddress ||
        user.withdrawal_wallet_locked !== true
      ) {
        const error = new Error(
          "Your current withdrawal wallet has not been set up yet. Save your first wallet before requesting a change."
        );
        error.code = "CURRENT_WALLET_NOT_SET";
        error.httpStatus = 409;
        throw error;
      }

      if (currentAddress === normalizedAddress) {
        result = {
          success: true,
          code: "CURRENT_WALLET_REUSED",
          message:
            "That address is already your active withdrawal wallet.",
          wallet: {
            address: currentAddress,
            network:
              user.withdrawal_wallet_network || "TRC20",
            coin:
              user.withdrawal_wallet_coin || "USDT",
            locked: true,
            status: safeStatus(
              user.withdrawal_wallet_status,
              "PENDING"
            ),
          },
          pendingChange: null,
          httpStatus: 200,
        };
        return;
      }

      const pendingAddress = normalizeAddress(
        user.pending_withdrawal_wallet_address
      );

      const pendingStatus = safeStatus(
        user.wallet_change_status,
        ""
      );

      // ----------------------------------------------------------
      // Do not silently replace an existing pending request.
      // ----------------------------------------------------------

      if (
        pendingAddress &&
        pendingStatus === "PENDING"
      ) {
        if (pendingAddress === normalizedAddress) {
          result = {
            success: true,
            code: "WALLET_CHANGE_ALREADY_PENDING",
            message:
              "This wallet change request is already pending approval.",
            wallet: {
              address: currentAddress,
              network:
                user.withdrawal_wallet_network || "TRC20",
              coin:
                user.withdrawal_wallet_coin || "USDT",
              locked: true,
              status: safeStatus(
                user.withdrawal_wallet_status,
                "PENDING"
              ),
            },
            pendingChange: {
              address: pendingAddress,
              network:
                user.pending_withdrawal_wallet_network ||
                "TRC20",
              coin:
                user.pending_withdrawal_wallet_coin ||
                "USDT",
              status: "PENDING",
              requestedAt: serializeTimestamp(
                user.wallet_change_requested_at
              ),
            },
            httpStatus: 200,
          };
          return;
        }

        const error = new Error(
          "A wallet change request is already pending. Please wait for it to be reviewed."
        );
        error.code = "WALLET_CHANGE_ALREADY_PENDING";
        error.httpStatus = 409;
        throw error;
      }

      transaction.set(
        userRef,
        {
          // Active wallet remains untouched.
          withdrawal_wallet_address: currentAddress,
          withdrawal_wallet_network:
            user.withdrawal_wallet_network || "TRC20",
          withdrawal_wallet_coin:
            user.withdrawal_wallet_coin || "USDT",
          withdrawal_wallet_locked: true,

          // New wallet lives separately until approval.
          pending_withdrawal_wallet_address:
            normalizedAddress,
          pending_withdrawal_wallet_network: "TRC20",
          pending_withdrawal_wallet_coin: "USDT",
          wallet_change_status: "PENDING",
          wallet_change_requested_at:
            FieldValue.serverTimestamp(),
          wallet_change_approved_at: null,
          wallet_change_approved_by: null,
          withdrawal_wallet_updated_at:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      result = {
        success: true,
        code: "WALLET_CHANGE_REQUESTED",
        message:
          "Your new withdrawal wallet has been submitted for review. Your current wallet remains active until the change is approved.",
        wallet: {
          address: currentAddress,
          network:
            user.withdrawal_wallet_network || "TRC20",
          coin:
            user.withdrawal_wallet_coin || "USDT",
          locked: true,
          status: safeStatus(
            user.withdrawal_wallet_status,
            "PENDING"
          ),
        },
        pendingChange: {
          address: normalizedAddress,
          network: "TRC20",
          coin: "USDT",
          status: "PENDING",
          requestedAt: null,
        },
        httpStatus: 200,
      };
    });

    return result;
  } catch (error) {
    console.error(
      "❌ Request withdrawal wallet change:",
      error.message
    );

    return {
      success: false,
      code:
        error.code ||
        "WITHDRAWAL_WALLET_CHANGE_FAILED",
      message:
        error.message ||
        "Unable to request a withdrawal wallet change.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// APPROVE PENDING WALLET CHANGE
//
// SECURITY-SENSITIVE:
// - This function must be called only by a trusted admin/security
//   path, never directly from Flutter.
// - Existing withdrawal records are NOT modified.
// - The new wallet becomes the future active wallet.
// ============================================================

async function approveWithdrawalWalletChange(
  userId,
  approvedBy = ""
) {
  if (!firestore) {
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

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
      message: "An approving administrator is required.",
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error("User account could not be found.");
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};

      if (
        user.is_frozen === true ||
        user.status === "FROZEN"
      ) {
        const error = new Error(
          "The user's account is currently restricted."
        );
        error.code = "ACCOUNT_FROZEN";
        error.httpStatus = 403;
        throw error;
      }

      const currentAddress = normalizeAddress(
        user.withdrawal_wallet_address
      );

      const pendingAddress = normalizeAddress(
        user.pending_withdrawal_wallet_address
      );

      const pendingStatus = safeStatus(
        user.wallet_change_status,
        ""
      );

      if (
        !currentAddress ||
        user.withdrawal_wallet_locked !== true
      ) {
        const error = new Error(
          "The user's current withdrawal wallet is not properly configured."
        );
        error.code = "CURRENT_WALLET_NOT_SET";
        error.httpStatus = 409;
        throw error;
      }

      if (!pendingAddress || pendingStatus !== "PENDING") {
        const error = new Error(
          "There is no pending wallet change request for this user."
        );
        error.code = "NO_PENDING_WALLET_CHANGE";
        error.httpStatus = 409;
        throw error;
      }

      if (!validTron(pendingAddress)) {
        const error = new Error(
          "The pending withdrawal wallet is invalid."
        );
        error.code = "INVALID_PENDING_WALLET";
        error.httpStatus = 409;
        throw error;
      }

      const oldAddress = currentAddress;

      transaction.set(
        userRef,
        {
          withdrawal_wallet_address: pendingAddress,
          withdrawal_wallet_network:
            user.pending_withdrawal_wallet_network ||
            "TRC20",
          withdrawal_wallet_coin:
            user.pending_withdrawal_wallet_coin ||
            "USDT",
          withdrawal_wallet_locked: true,
          withdrawal_wallet_status: "PENDING",
          withdrawal_wallet_saved_at:
            FieldValue.serverTimestamp(),
          withdrawal_wallet_approved_at:
            FieldValue.serverTimestamp(),
          withdrawal_wallet_updated_at:
            FieldValue.serverTimestamp(),

          wallet_change_status: "APPROVED",
          wallet_change_approved_at:
            FieldValue.serverTimestamp(),
          wallet_change_approved_by: approver,

          // Preserve history of the previous active wallet.
          previous_withdrawal_wallet_address:
            oldAddress,
          previous_withdrawal_wallet_changed_at:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      // Do not delete pending address immediately.
      // Keeping it creates a basic audit trail of what was approved.
      result = {
        success: true,
        code: "WALLET_CHANGE_APPROVED",
        message:
          "The pending wallet has been approved and is now the active locked withdrawal wallet.",
        wallet: {
          address: pendingAddress,
          network:
            user.pending_withdrawal_wallet_network ||
            "TRC20",
          coin:
            user.pending_withdrawal_wallet_coin ||
            "USDT",
          locked: true,
          status: "PENDING",
          savedAt: null,
          approvedAt: null,
        },
        previousWallet: {
          address: oldAddress,
          network:
            user.withdrawal_wallet_network || "TRC20",
          coin:
            user.withdrawal_wallet_coin || "USDT",
        },
        approvedBy: approver,
        httpStatus: 200,
      };
    });

    return result;
  } catch (error) {
    console.error(
      "❌ Approve withdrawal wallet change:",
      error.message
    );

    return {
      success: false,
      code:
        error.code ||
        "WITHDRAWAL_WALLET_CHANGE_APPROVAL_FAILED",
      message:
        error.message ||
        "Unable to approve the withdrawal wallet change.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// REJECT PENDING WALLET CHANGE
//
// Security-sensitive admin operation.
// The active wallet remains untouched.
// ============================================================

async function rejectWithdrawalWalletChange(
  userId,
  rejectedBy = "",
  reason = "Withdrawal wallet change rejected."
) {
  if (!firestore) {
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

  if (!userId || typeof userId !== "string") {
    return {
      success: false,
      code: "USER_ID_REQUIRED",
      message: "A valid user is required.",
      httpStatus: 400,
    };
  }

  const approver = String(rejectedBy || "").trim();
  const rejectionReason =
    String(reason || "").trim() ||
    "Withdrawal wallet change rejected.";

  if (!approver) {
    return {
      success: false,
      code: "REVIEWER_REQUIRED",
      message: "A reviewing administrator is required.",
      httpStatus: 400,
    };
  }

  const userRef = firestore.collection("users").doc(userId);

  let result = null;

  try {
    await firestore.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        const error = new Error("User account could not be found.");
        error.code = "USER_NOT_FOUND";
        error.httpStatus = 404;
        throw error;
      }

      const user = userDoc.data() || {};

      const pendingAddress = normalizeAddress(
        user.pending_withdrawal_wallet_address
      );

      const pendingStatus = safeStatus(
        user.wallet_change_status,
        ""
      );

      if (!pendingAddress || pendingStatus !== "PENDING") {
        const error = new Error(
          "There is no pending wallet change request for this user."
        );
        error.code = "NO_PENDING_WALLET_CHANGE";
        error.httpStatus = 409;
        throw error;
      }

      transaction.set(
        userRef,
        {
          wallet_change_status: "REJECTED",
          wallet_change_rejected_at:
            FieldValue.serverTimestamp(),
          wallet_change_rejected_by: approver,
          wallet_change_rejection_reason:
            rejectionReason,
          withdrawal_wallet_updated_at:
            FieldValue.serverTimestamp(),
        },
        {
          merge: true,
        }
      );

      result = {
        success: true,
        code: "WALLET_CHANGE_REJECTED",
        message:
          "The wallet change was rejected. Your current withdrawal wallet remains active.",
        currentWallet: {
          address: normalizeAddress(
            user.withdrawal_wallet_address
          ),
          network:
            user.withdrawal_wallet_network || "TRC20",
          coin:
            user.withdrawal_wallet_coin || "USDT",
          locked:
            user.withdrawal_wallet_locked === true,
        },
        pendingChange: {
          address: pendingAddress,
          status: "REJECTED",
          reason: rejectionReason,
        },
        rejectedBy: approver,
        httpStatus: 200,
      };
    });

    return result;
  } catch (error) {
    console.error(
      "❌ Reject withdrawal wallet change:",
      error.message
    );

    return {
      success: false,
      code:
        error.code ||
        "WITHDRAWAL_WALLET_CHANGE_REJECTION_FAILED",
      message:
        error.message ||
        "Unable to reject the withdrawal wallet change.",
      httpStatus:
        Number(error.httpStatus) >= 400 &&
        Number(error.httpStatus) <= 599
          ? Number(error.httpStatus)
          : 400,
    };
  }
}

// ============================================================
// GET USER WITHDRAWAL WALLET
// ============================================================

async function getWithdrawalWallet(userId) {
  if (!firestore) {
    return {
      success: false,
      code: "DATABASE_UNAVAILABLE",
      message: "Our account database is temporarily unavailable.",
      httpStatus: 503,
    };
  }

  if (!userId || typeof userId !== "string") {
    return {
      success: false,
      code: "AUTH_REQUIRED",
      message: "Your account could not be verified.",
      httpStatus: 401,
    };
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
        message: "Your account record could not be found.",
        httpStatus: 404,
      };
    }

    const user = userDoc.data() || {};
    const address = normalizeAddress(
      user.withdrawal_wallet_address
    );

    const pendingAddress = normalizeAddress(
      user.pending_withdrawal_wallet_address
    );

    return {
      success: true,
      code: "WITHDRAWAL_WALLET_FETCHED",
      wallet: address
        ? {
            address,
            network:
              user.withdrawal_wallet_network || "TRC20",
            coin:
              user.withdrawal_wallet_coin || "USDT",
            locked:
              user.withdrawal_wallet_locked === true,
            status: safeStatus(
              user.withdrawal_wallet_status,
              "PENDING"
            ),
            savedAt: serializeTimestamp(
              user.withdrawal_wallet_saved_at
            ),
            approvedAt: serializeTimestamp(
              user.withdrawal_wallet_approved_at
            ),
          }
        : null,
      pendingChange: pendingAddress
        ? {
            address: pendingAddress,
            network:
              user.pending_withdrawal_wallet_network ||
              "TRC20",
            coin:
              user.pending_withdrawal_wallet_coin ||
              "USDT",
            status: safeStatus(
              user.wallet_change_status,
              "PENDING"
            ),
            requestedAt: serializeTimestamp(
              user.wallet_change_requested_at
            ),
            approvedAt: serializeTimestamp(
              user.wallet_change_approved_at
            ),
            approvedBy:
              user.wallet_change_approved_by || null,
            rejectedAt: serializeTimestamp(
              user.wallet_change_rejected_at
            ),
            rejectedBy:
              user.wallet_change_rejected_by || null,
            rejectionReason:
              user.wallet_change_rejection_reason || null,
          }
        : null,
      previousWallet:
        normalizeAddress(
          user.previous_withdrawal_wallet_address
        )
          ? {
              address:
                user.previous_withdrawal_wallet_address,
              changedAt: serializeTimestamp(
                user.previous_withdrawal_wallet_changed_at
              ),
            }
          : null,
      httpStatus: 200,
    };
  } catch (error) {
    console.error(
      "❌ Get withdrawal wallet:",
      error.message
    );

    return {
      success: false,
      code: "WITHDRAWAL_WALLET_FETCH_FAILED",
      message:
        "Unable to load your withdrawal wallet.",
      httpStatus: 500,
    };
  }
}

module.exports = {
  validTron,
  saveWithdrawalWallet,
  requestWithdrawalWalletChange,
  approveWithdrawalWalletChange,
  rejectWithdrawalWalletChange,
  getWithdrawalWallet,
};
