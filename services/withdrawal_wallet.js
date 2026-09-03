"use strict";

// ============================================================
// SAINT CRYPTO — WITHDRAWAL WALLET SERVICE
// services/withdrawal_wallet.js
//
// Purpose:
// - Save one user-owned USDT TRC20 withdrawal wallet.
// - Save it only after the user confirms in Flutter.
// - Lock the first saved address so the user cannot change it.
// - Keep the address available for admin onboarding to Bybit.
// - No withdrawal request is created here.
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
      // First address is permanent for the user.
      // Re-submitting the exact same address is harmless/idempotent.
      // ----------------------------------------------------------

      if (existingAddress && locked) {
        if (existingAddress !== normalizedAddress) {
          const error = new Error(
            "Your withdrawal wallet is already locked. It cannot be changed."
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
            locked: true,
            status: user.withdrawal_wallet_status || "PENDING",
            savedAt: serializeTimestamp(
              user.withdrawal_wallet_saved_at
            ),
            approvedAt: serializeTimestamp(
              user.withdrawal_wallet_approved_at
            ),
          },
          httpStatus: 200,
        };

        return;
      }

      // ----------------------------------------------------------
      // Save and immediately lock the first address.
      // Admin can now add this exact address to Bybit.
      // ----------------------------------------------------------

      transaction.set(
        userRef,
        {
          withdrawal_wallet_address: normalizedAddress,
          withdrawal_wallet_network: "TRC20",
          withdrawal_wallet_coin: "USDT",
          withdrawal_wallet_locked: true,
          withdrawal_wallet_status: "PENDING",
          withdrawal_wallet_saved_at: FieldValue.serverTimestamp(),
          withdrawal_wallet_approved_at: null,
          withdrawal_wallet_updated_at: FieldValue.serverTimestamp(),
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

    return {
      success: true,
      code: "WITHDRAWAL_WALLET_FETCHED",
      wallet: address
        ? {
            address,
            network: user.withdrawal_wallet_network || "TRC20",
            coin: user.withdrawal_wallet_coin || "USDT",
            locked: user.withdrawal_wallet_locked === true,
            status: user.withdrawal_wallet_status || "PENDING",
            savedAt: serializeTimestamp(
              user.withdrawal_wallet_saved_at
            ),
            approvedAt: serializeTimestamp(
              user.withdrawal_wallet_approved_at
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
  getWithdrawalWallet,
};
