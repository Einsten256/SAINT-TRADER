/**
 * SAINT CRYPTO
 * FILE: services/routes/signal.js
 *
 * FINAL DAILY SIGNAL API
 *
 * Routes:
 *   GET  /api/signals/active
 *   GET  /api/signals/status
 *   GET  /api/signals/:code
 *   POST /api/signals/redeem
 *   GET  /api/signals/redemptions
 *   GET  /api/signals/redemptions/:redemptionId
 *
 * User-side routes only.
 * Signal generation and payout processing are server-side.
 */

"use strict";

const express = require("express");

const signal = require("../signal");

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
    throw new Error("Signal routes require verifyAuth from routeDeps.");
  }

  if (typeof verifyFirestore !== "function") {
    throw new Error("Signal routes require verifyFirestore from routeDeps.");
  }

/* ============================================================
   HELPERS
   ============================================================ */

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      console.error(
        "❌ Signal route error:",
        error
      );

      const status =
        Number.isInteger(
          error?.statusCode
        )
          ? error.statusCode
          : 400;

      return res.status(status).json({
        success: false,
        message:
          error?.message ||
          "Unable to process signal request.",
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
  const uid =
    getUserId(req);

  if (!uid) {
    res.status(401).json({
      success: false,
      message:
        "Authentication required.",
    });

    return null;
  }

  return uid;
}

function parseLimit(
  value,
  fallback = 50
) {
  const parsed =
    Number.parseInt(
      value,
      10
    );

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(parsed, 1),
    100
  );
}

/* ============================================================
   GET ACTIVE SIGNAL
 *
 * GET /api/signals/active
 * ============================================================ */

router.get(
  "/active",
  verifyAuth,
  verifyFirestore,
  asyncRoute(async (req, res) => {
    const result =
      await signal.getActiveSignal();

    return res.json(result);
  })
);

/* ============================================================
   GET SIGNAL SERVICE STATUS
 *
 * GET /api/signals/status
 *
 * Does not expose internal database information.
 * ============================================================ */

router.get(
  "/status",
  verifyAuth,
  verifyFirestore,
  asyncRoute(async (req, res) => {
    const result =
      await signal.getStatus();

    return res.json(result);
  })
);

/* ============================================================
   POST REDEEM SIGNAL
 *
 * POST /api/signals/redeem
 *
 * Body:
 * {
 *   "code": "XXXXXXXXXXXX"
 * }
 *
 * The response is PROCESSING.
 * No balance is credited here.
 * ============================================================ */

const redeemHandler =
  asyncRoute(async (req, res) => {
    const uid =
      requireUserId(req, res);

    if (!uid) {
      return;
    }

    const body =
      req.body || {};

    const result =
      await signal.redeemSignal(
        uid,
        {
          code:
            body.code ??
            body.signalCode ??
            body.signal_code,
        }
      );

    return res.json(result);
  });

if (strictLimiter) {
  router.post(
    "/redeem",
    verifyAuth,
    verifyFirestore,
    strictLimiter,
    redeemHandler
  );
} else {
  router.post(
    "/redeem",
    verifyAuth,
    verifyFirestore,
    redeemHandler
  );
}

/* ============================================================
   GET USER REDEMPTION HISTORY
 *
 * GET /api/signals/redemptions
 * ============================================================ */

router.get(
  "/redemptions",
  verifyAuth,
  verifyFirestore,
  asyncRoute(async (req, res) => {
    const uid =
      requireUserId(req, res);

    if (!uid) {
      return;
    }

    const limit =
      parseLimit(
        req.query.limit,
        50
      );

    const result =
      await signal.getRedemptionHistory(
        uid,
        limit
      );

    return res.json(result);
  })
);

/* ============================================================
   GET ONE REDEMPTION
 *
 * GET /api/signals/redemptions/:redemptionId
 * ============================================================ */

router.get(
  "/redemptions/:redemptionId",
  verifyAuth,
  verifyFirestore,
  asyncRoute(async (req, res) => {
    const uid =
      requireUserId(req, res);

    if (!uid) {
      return;
    }

    const redemptionId =
      String(
        req.params.redemptionId ||
          ""
      ).trim();

    if (!redemptionId) {
      return res.status(400).json({
        success: false,
        message:
          "Redemption ID is required.",
      });
    }

    const result =
      await signal.getRedemption(
        uid,
        redemptionId
      );

    return res.json(result);
  })
);

/* ============================================================
   GET SIGNAL BY CODE
 *
 * This route is deliberately placed AFTER the named routes
 * above so:
 *
 *   /redemptions
 *   /redemptions/:id
 *   /active
 *   /status
 *
 * are not interpreted as signal codes.
 *
 * GET /api/signals/:code
 * ============================================================ */

router.get(
  "/:code",
  verifyAuth,
  verifyFirestore,
  asyncRoute(async (req, res) => {
    const code =
      String(
        req.params.code || ""
      ).trim();

    const result =
      await signal.getSignal(
        code
      );

    return res.json(result);
  })
);

/* ============================================================
   EXPORT
 * ============================================================ */

  return router;
}

module.exports = { createRouter };
