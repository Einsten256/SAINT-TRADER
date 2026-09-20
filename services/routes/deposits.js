/**
 * SAINT CRYPTO
 * FILE: services/routes/deposits.js
 *
 * FINAL MOBILE MONEY RECHARGE ROUTES
 *
 * These routes replace the old USDT/TRON deposit API.
 *
 * User flow:
 *   GET  /api/deposits/config
 *   POST /api/deposits/submit
 *   GET  /api/deposits/:depositId
 *   GET  /api/deposits
 *   GET  /api/deposits/history
 *   GET  /api/deposits/records
 *
 * Admin approval is intentionally NOT exposed through these
 * authenticated user routes. Telegram/admin services call the
 * deposit service directly.
 */

"use strict";

const express = require("express");

const deposit = require("../deposit");

/*
 * IMPORTANT: Authentication is supplied by index.js through the
 * existing routeDeps object. Do NOT require ../middleware/auth here.
 * This keeps the financial route additive and compatible with the
 * existing Saint Crypto authentication system.
 */
function createRouter({
  verifyAuth,
  verifyFirestore,
  strictLimiter,
} = {}) {
  const router = express.Router();

  if (typeof verifyAuth !== "function") {
    throw new Error("Deposits routes require verifyAuth from routeDeps.");
  }

  if (typeof verifyFirestore !== "function") {
    throw new Error("Deposits routes require verifyFirestore from routeDeps.");
  }

/* ============================================================
   HELPERS
   ============================================================ */

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error(
        "❌ Deposits route error:",
        error
      );

      const status =
        Number.isInteger(error?.statusCode)
          ? error.statusCode
          : 400;

      return res.status(status).json({
        success: false,
        message:
          error?.message ||
          "Unable to process recharge request.",
      });
    }
  };
}

function getUserId(req) {
  return (
    req.uid ||
    req.user?.uid ||
    req.auth?.uid ||
    null
  );
}

function requireUserId(req, res) {
  const uid = getUserId(req);

  if (!uid) {
    res.status(401).json({
      success: false,
      message: "Authentication required.",
    });

    return null;
  }

  return uid;
}

function parseLimit(value, fallback = 30) {
  const parsed =
    Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(parsed, 1),
    100
  );
}

function getBody(req) {
  return req.body || {};
}

/* ============================================================
   GET RECHARGE CONFIG
 *
 * Public configuration is safe to expose because it contains
 * only operator payment information and limits.
 *
 * Flutter uses this to display:
 *   MTN number
 *   Airtel number
 *   minimum
 *   maximum
 *   zero recharge fee
 * ============================================================ */

router.get(
  "/config",
  asyncRoute(async (req, res) => {
    const result =
      deposit.getRechargeConfig();

    return res.json(result);
  })
);

/* ============================================================
   POST SUBMIT RECHARGE
 *
 * Authentication required.
 *
 * Expected body:
 * {
 *   "amountUgx": 50000,
 *   "network": "MTN",
 *   "transactionId": "TX123456",
 *   "senderName": "John Doe",
 *   "termsAccepted": true
 * }
 *
 * Compatibility aliases are also accepted by the service:
 * amount, txid, sender, acceptedTerms.
 * ============================================================ */

const submitRechargeHandler =
  asyncRoute(async (req, res) => {
    const uid =
      requireUserId(req, res);

    if (!uid) {
      return;
    }

    const body =
      getBody(req);

    const result =
      await deposit.submitRecharge(
        uid,
        {
          amountUgx:
            body.amountUgx ??
            body.amount,

          network:
            body.network,

          transactionId:
            body.transactionId ??
            body.txid ??
            body.transaction_id,

          senderName:
            body.senderName ??
            body.sender ??
            body.sender_name,

          termsAccepted:
            body.termsAccepted ??
            body.acceptedTerms ??
            body.terms_accepted,
        }
      );

    return res.status(
      result.duplicate
        ? 200
        : 201
    ).json(result);
  });

if (strictLimiter) {
  router.post(
    "/submit",
    verifyAuth,
    verifyFirestore,
    strictLimiter,
    submitRechargeHandler
  );
} else {
  router.post(
    "/submit",
    verifyAuth,
    verifyFirestore,
    submitRechargeHandler
  );
}

/* ============================================================
   POST /api/deposit
 *
 * Backward-compatible alias for the old frontend.
 * It uses the NEW Mobile Money recharge logic.
 * ============================================================ */

if (strictLimiter) {
  router.post(
    "/../deposit",
    verifyAuth,
    verifyFirestore,
    strictLimiter,
    submitRechargeHandler
  );
}

/*
 * IMPORTANT:
 * Express does not reliably treat "/../deposit" as a separate
 * mounted route in every deployment. The actual compatibility
 * endpoint is registered below at the application level only
 * if index.js mounts this router differently.
 *
 * The preferred endpoint is:
 *   POST /api/deposits/submit
 *
 * We also expose a direct router route:
 */
if (strictLimiter) {
  router.post(
    "/legacy-submit",
    verifyAuth,
    verifyFirestore,
    strictLimiter,
    submitRechargeHandler
  );
} else {
  router.post(
    "/legacy-submit",
    verifyAuth,
    verifyFirestore,
    submitRechargeHandler
  );
}

/* ============================================================
   GET ONE RECHARGE
 *
 * GET /api/deposits/:depositId
 * ============================================================ */

router.get(
  "/:depositId",
  verifyAuth,
  verifyFirestore,
  asyncRoute(async (req, res) => {
    const uid =
      requireUserId(req, res);

    if (!uid) {
      return;
    }

    const rechargeId =
      String(
        req.params.depositId || ""
      ).trim();

    if (!rechargeId) {
      return res.status(400).json({
        success: false,
        message: "Recharge ID is required.",
      });
    }

    const result =
      await deposit.getRecharge(
        uid,
        rechargeId
      );

    return res.json(result);
  })
);

/* ============================================================
   GET RECHARGE HISTORY
 *
 * GET /api/deposits
 * GET /api/deposits/history
 * GET /api/deposits/records
 *
 * All three return the user's recharge history.
 * ============================================================ */

const historyHandler =
  asyncRoute(async (req, res) => {
    const uid =
      requireUserId(req, res);

    if (!uid) {
      return;
    }

    const limit =
      parseLimit(
        req.query.limit,
        30
      );

    const result =
      await deposit.getRechargeHistory(
        uid,
        limit
      );

    return res.json(result);
  });

router.get(
  "/",
  verifyAuth,
  verifyFirestore,
  historyHandler
);

router.get(
  "/history",
  verifyAuth,
  verifyFirestore,
  historyHandler
);

router.get(
  "/records",
  verifyAuth,
  verifyFirestore,
  historyHandler
);

/* ============================================================
   ROUTE NOTES
 *
 * Admin operations are deliberately absent:
 *
 *   deposit.approveRecharge()
 *   deposit.rejectRecharge()
 *
 * are called by the Telegram/admin approval service.
 *
 * This prevents an ordinary authenticated Flutter user from
 * approving their own recharge.
 * ============================================================ */

  return router;
}

module.exports = { createRouter };
