/**
 * SAINT CRYPTO
 * services/routes/withdrawal.js
 *
 * Mobile Money withdrawal routes.
 *
 * Destination:
 * SAINT CRYPTO/services/routes/withdrawal.js
 *
 * API:
 *   GET  /api/withdrawals/config
 *   GET  /api/withdrawals/profile
 *   POST /api/withdrawals/profile
 *   POST /api/withdrawals/request
 *   GET  /api/withdrawals/:withdrawalId
 *   GET  /api/withdrawals/history
 *
 * Admin actions are intentionally NOT exposed through these user routes.
 * Telegram/admin code should call services/withdrawal.js directly.
 */

"use strict";

const express = require("express");

const router = express.Router();

const withdrawalService = require("../withdrawal");

// These are the same middleware names used by the existing SAINT CRYPTO API.
// Keeping the route layer compatible makes this file easier to drop in.
let verifyAuth = null;
let verifyFirestore = null;
let strictLimiter = null;

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

  strictLimiter =
    middleware.strictLimiter ||
    middleware.strictRateLimiter ||
    null;
} catch (_) {}

/**
 * The application normally supplies authentication middleware.
 * If it is not found here, fail closed instead of exposing financial routes.
 */
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
      console.error("[withdrawal route]", error);

      const status = Number(error?.statusCode || error?.status || 500);

      return res.status(status >= 400 && status < 600 ? status : 500).json({
        success: false,
        error: error?.code || "WITHDRAWAL_REQUEST_FAILED",
        message: error?.message || "Withdrawal request failed.",
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
 * GET /api/withdrawals/config
 *
 * Returns public withdrawal settings such as fee/minimum/maximum.
 * No private user information is returned.
 */
router.get(
  "/config",
  requireAuth,
  requireFirestore,
  asyncRoute(async (req, res) => {
    const config = await withdrawalService.getWithdrawalConfig();

    return res.json({
      success: true,
      config,
    });
  })
);

/**
 * GET /api/withdrawals/profile
 *
 * Returns the saved Mobile Money withdrawal identity.
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

    const profile = await withdrawalService.getWithdrawalProfile(userId);

    return res.json({
      success: true,
      profile: profile || null,
    });
  })
);

/**
 * POST /api/withdrawals/profile
 *
 * Saves/replaces the user's Mobile Money withdrawal identity.
 *
 * Body:
 * {
 *   "recipientName": "John Doe",
 *   "network": "MTN",
 *   "mobileNumber": "0771234567"
 * }
 */
router.post(
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

    const { recipientName, network, mobileNumber } = req.body || {};

    if (!recipientName || !network || !mobileNumber) {
      return badRequest(
        res,
        "WITHDRAWAL_PROFILE_REQUIRED",
        "Recipient name, network and mobile number are required."
      );
    }

    const profile = await withdrawalService.saveWithdrawalProfile(userId, {
      recipientName,
      network,
      mobileNumber,
    });

    return res.json({
      success: true,
      message: "Withdrawal Mobile Money profile saved.",
      profile,
    });
  })
);

/**
 * POST /api/withdrawals/request
 *
 * Creates a withdrawal request.
 *
 * Body:
 * {
 *   "amountUgx": 20000
 * }
 *
 * The service:
 * - checks payout balance
 * - calculates 5% fee
 * - reserves the gross amount atomically
 * - stores the saved recipient identity
 * - puts the request under admin review
 */
router.post(
  "/request",
  requireAuth,
  requireFirestore,
  ...(strictLimiter ? [strictLimiter] : []),
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

    const result = await withdrawalService.reserveWithdrawal(
      userId,
      amountUgx
    );

    return res.status(201).json({
      success: true,
      message:
        "Withdrawal request submitted and placed under admin review.",
      withdrawal: result,
    });
  })
);

/**
 * GET /api/withdrawals/history
 *
 * User's own withdrawal history.
 */
router.get(
  "/history",
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

    const rawLimit = Number(req.query?.limit || 50);
    const limit = Math.min(
      Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 1),
      100
    );

    const history = await withdrawalService.getWithdrawalHistory(
      userId,
      limit
    );

    return res.json({
      success: true,
      withdrawals: history,
    });
  })
);

/**
 * GET /api/withdrawals/:withdrawalId
 *
 * Returns one withdrawal only if it belongs to the authenticated user.
 */
router.get(
  "/:withdrawalId",
  requireAuth,
  requireFirestore,
  asyncRoute(async (req, res) => {
    const userId = getUserId(req);
    const withdrawalId = String(req.params.withdrawalId || "").trim();

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "UNAUTHENTICATED",
        message: "Authenticated user is required.",
      });
    }

    if (!withdrawalId) {
      return badRequest(
        res,
        "WITHDRAWAL_ID_REQUIRED",
        "Withdrawal ID is required."
      );
    }

    const withdrawal =
      await withdrawalService.getWithdrawal(withdrawalId);

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        error: "WITHDRAWAL_NOT_FOUND",
        message: "Withdrawal request not found.",
      });
    }

    if (withdrawal.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "FORBIDDEN",
        message: "You cannot view this withdrawal.",
      });
    }

    return res.json({
      success: true,
      withdrawal,
    });
  })
);

/**
 * Compatibility aliases
 *
 * These aliases make the migration easier for the existing Flutter app.
 *
 * POST /api/withdrawal
 * GET  /api/withdrawal/:withdrawalId
 * GET  /api/withdrawal/history
 * GET  /api/withdrawal/profile
 * POST /api/withdrawal/profile
 */
router.post(
  "/../withdrawal",
  requireAuth,
  requireFirestore,
  ...(strictLimiter ? [strictLimiter] : []),
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

    const result = await withdrawalService.reserveWithdrawal(
      userId,
      amountUgx
    );

    return res.status(201).json({
      success: true,
      message:
        "Withdrawal request submitted and placed under admin review.",
      withdrawal: result,
    });
  })
);

module.exports = router;
