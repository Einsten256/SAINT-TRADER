/**
 * SAINT CRYPTO
 * services/routes/withdrawal_wallet.js
 *
 * Mobile Money withdrawal identity routes.
 *
 * Destination:
 * SAINT CRYPTO/services/routes/withdrawal_wallet.js
 *
 * This replaces the old USDT/TRON wallet endpoints while preserving
 * the old route family used by the existing Flutter application.
 *
 * Supported identity:
 *   - recipientName
 *   - network: MTN or AIRTEL
 *   - mobileNumber
 *
 * No USDT, TRON, wallet address, blockchain or TXID is used here.
 */

"use strict";

const express = require("express");

const router = express.Router();

const withdrawalService = require("../withdrawal");

let verifyAuth = null;
let verifyFirestore = null;

try {
  const auth = require("./auth");

  verifyAuth =
    auth.verifyAuth ||
    auth.authenticate ||
    auth.requireAuth ||
    null;
} catch (_) {}

try {
  const middleware = require("../middleware");

  verifyAuth =
    verifyAuth ||
    middleware.verifyAuth ||
    middleware.authenticate ||
    middleware.requireAuth ||
    null;

  verifyFirestore =
    middleware.verifyFirestore ||
    middleware.requireFirestore ||
    null;
} catch (_) {}

function requireAuth(req, res, next) {
  if (!verifyAuth) {
    return res.status(500).json({
      success: false,
      error: "AUTH_MIDDLEWARE_NOT_CONFIGURED",
    });
  }

  return verifyAuth(req, res, next);
}

function requireFirestore(req, res, next) {
  if (!verifyFirestore) {
    return next();
  }

  return verifyFirestore(req, res, next);
}

function getUserId(req) {
  return (
    req.user?.uid ||
    req.user?.userId ||
    req.user?.id ||
    req.auth?.uid ||
    req.auth?.userId ||
    null
  );
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("[withdrawal-wallet route]", error);

      const status = Number(error?.statusCode || error?.status || 500);

      return res.status(status >= 400 && status < 600 ? status : 500).json({
        success: false,
        error: error?.code || "WITHDRAWAL_PROFILE_REQUEST_FAILED",
        message:
          error?.message || "Withdrawal profile request failed.",
      });
    }
  };
}

function badRequest(res, code, message) {
  return res.status(400).json({
    success: false,
    error: code,
    message,
  });
}

/**
 * GET /api/withdrawal-wallet
 *
 * Compatibility endpoint.
 *
 * Old Flutter code may call this endpoint expecting a wallet object.
 * It now returns the saved Mobile Money withdrawal identity.
 */
router.get(
  "/",
  requireAuth,
  requireFirestore,
  asyncRoute(async (req, res) => {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "UNAUTHENTICATED",
        message: "Authenticated user is required.",
      });
    }

    const profile =
      await withdrawalService.getWithdrawalProfile(userId);

    return res.json({
      success: true,
      profile: profile || null,

      // Compatibility field.
      // This is deliberately null because there is no blockchain wallet.
      wallet: null,
    });
  })
);

/**
 * POST /api/withdrawal-wallet
 *
 * Saves the Mobile Money withdrawal identity.
 *
 * Body:
 * {
 *   "recipientName": "John Doe",
 *   "network": "MTN",
 *   "mobileNumber": "0771234567"
 * }
 *
 * Compatibility:
 * Also accepts:
 *   name
 *   phone
 *   phoneNumber
 */
router.post(
  "/",
  requireAuth,
  requireFirestore,
  asyncRoute(async (req, res) => {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "UNAUTHENTICATED",
        message: "Authenticated user is required.",
      });
    }

    const body = req.body || {};

    const recipientName =
      body.recipientName ||
      body.name ||
      body.fullName;

    const network =
      body.network ||
      body.provider;

    const mobileNumber =
      body.mobileNumber ||
      body.phoneNumber ||
      body.phone;

    if (!recipientName || !network || !mobileNumber) {
      return badRequest(
        res,
        "WITHDRAWAL_PROFILE_REQUIRED",
        "Recipient name, network and mobile number are required."
      );
    }

    const profile =
      await withdrawalService.saveWithdrawalProfile(userId, {
        recipientName,
        network,
        mobileNumber,
      });

    return res.json({
      success: true,
      message: "Mobile Money withdrawal identity saved.",
      profile,

      // Compatibility field.
      wallet: null,
    });
  })
);

/**
 * POST /api/withdrawal-wallet/change
 *
 * Existing Flutter compatibility endpoint.
 *
 * Changing the saved identity does NOT move money and does NOT create
 * a withdrawal. It only updates the recipient details used for future
 * withdrawal requests.
 */
router.post(
  "/change",
  requireAuth,
  requireFirestore,
  asyncRoute(async (req, res) => {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "UNAUTHENTICATED",
        message: "Authenticated user is required.",
      });
    }

    const body = req.body || {};

    const recipientName =
      body.recipientName ||
      body.name ||
      body.fullName;

    const network =
      body.network ||
      body.provider;

    const mobileNumber =
      body.mobileNumber ||
      body.phoneNumber ||
      body.phone;

    if (!recipientName || !network || !mobileNumber) {
      return badRequest(
        res,
        "WITHDRAWAL_PROFILE_REQUIRED",
        "Recipient name, network and mobile number are required."
      );
    }

    const profile =
      await withdrawalService.saveWithdrawalProfile(userId, {
        recipientName,
        network,
        mobileNumber,
      });

    return res.json({
      success: true,
      message: "Mobile Money withdrawal identity updated.",
      profile,

      // Compatibility field.
      wallet: null,
    });
  })
);

/**
 * GET /api/withdrawal-wallet/profile
 *
 * Optional explicit profile endpoint.
 */
router.get(
  "/profile",
  requireAuth,
  requireFirestore,
  asyncRoute(async (req, res) => {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "UNAUTHENTICATED",
        message: "Authenticated user is required.",
      });
    }

    const profile =
      await withdrawalService.getWithdrawalProfile(userId);

    return res.json({
      success: true,
      profile: profile || null,
    });
  })
);

/**
 * POST /api/withdrawal-wallet/request
 *
 * Compatibility helper for clients that previously used the wallet
 * route to initiate withdrawals.
 *
 * The new withdrawal service is responsible for the actual reservation,
 * fee calculation and ledger transaction.
 */
router.post(
  "/request",
  requireAuth,
  requireFirestore,
  asyncRoute(async (req, res) => {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "UNAUTHENTICATED",
        message: "Authenticated user is required.",
      });
    }

    const amountUgx = req.body?.amountUgx;

    if (
      amountUgx === undefined ||
      amountUgx === null ||
      amountUgx === ""
    ) {
      return badRequest(
        res,
        "WITHDRAWAL_AMOUNT_REQUIRED",
        "Withdrawal amount is required."
      );
    }

    const withdrawal =
      await withdrawalService.reserveWithdrawal(
        userId,
        amountUgx
      );

    return res.status(201).json({
      success: true,
      message:
        "Withdrawal request submitted and placed under admin review.",
      withdrawal,
    });
  })
);

module.exports = router;
