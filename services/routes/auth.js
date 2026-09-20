/**
 * SAINT CRYPTO
 * services/routes/auth.js
 *
 * RESTORED AUTH ROUTE
 *
 * Destination:
 * D:\BACKEND\services\routes\auth.js
 *
 * IMPORTANT:
 * The existing Saint Crypto authentication middleware is owned by index.js
 * and is passed into this router through createRouter(routeDeps).
 *
 * Do NOT require ../auth here. There is no services/auth.js in the current
 * backend architecture. The previous compatibility wrapper caused the
 * startup warning:
 *
 *   Cannot find module '../auth'
 *
 * This file restores the original createRouter contract and keeps the
 * existing authentication/fund-password behavior intact.
 */

"use strict";

const express = require("express");

function createRouter(routeDeps = {}) {
  const {
    verifyAuth,
    verifyFirestore,
    strictLimiter,
    services = {},
  } = routeDeps;

  const router = express.Router();
  const kendrick = services.kendrick;

  if (!kendrick) {
    router.use((req, res) => {
      return res.status(500).json({
        success: false,
        error: "KENDRICK_SERVICE_NOT_AVAILABLE",
        message: "Authentication support service is unavailable.",
      });
    });

    return router;
  }

  if (
    typeof verifyAuth !== "function" ||
    typeof verifyFirestore !== "function"
  ) {
    router.use((req, res) => {
      return res.status(500).json({
        success: false,
        error: "AUTH_MIDDLEWARE_NOT_AVAILABLE",
        message: "Authentication middleware is unavailable.",
      });
    });

    return router;
  }

  const limiter =
    typeof strictLimiter === "function"
      ? strictLimiter
      : (req, res, next) => next();

  // ------------------------------------------------------------
  // SET FUND PASSWORD
  // ------------------------------------------------------------
  router.post(
    "/api/user/set-fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const firestore =
          typeof kendrick.getFirestore === "function"
            ? kendrick.getFirestore()
            : null;

        if (!firestore) {
          return res.status(500).json({
            success: false,
            message: "Firestore service is unavailable.",
          });
        }

        const uid =
          req.uid ||
          req.user?.uid ||
          req.user?.userId ||
          req.user?.id;

        if (!uid) {
          return res.status(401).json({
            success: false,
            message: "Authenticated user is required.",
          });
        }

        await kendrick.saveFundPassword(
          firestore.collection("users").doc(uid),
          req.body?.newPassword
        );

        return res.json({
          success: true,
          message: "Fund password set successfully.",
        });
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }
    }
  );

  // ------------------------------------------------------------
  // UPDATE FUND PASSWORD
  // ------------------------------------------------------------
  router.post(
    "/api/users/fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const firestore =
          typeof kendrick.getFirestore === "function"
            ? kendrick.getFirestore()
            : null;

        if (!firestore) {
          return res.status(500).json({
            success: false,
            message: "Firestore service is unavailable.",
          });
        }

        const uid =
          req.uid ||
          req.user?.uid ||
          req.user?.userId ||
          req.user?.id;

        if (!uid) {
          return res.status(401).json({
            success: false,
            message: "Authenticated user is required.",
          });
        }

        const ref =
          firestore.collection("users").doc(uid);

        const doc = await ref.get();

        if (!doc.exists) {
          return res.json({
            success: false,
            message: "User account not found.",
          });
        }

        const user = doc.data() || {};

        if (
          user.fundPasswordHash ||
          user.fundPassword
        ) {
          if (
            typeof kendrick.verifyFundPassword !== "function" ||
            !(await kendrick.verifyFundPassword(
              user,
              req.body?.oldPassword
            ))
          ) {
            return res.json({
              success: false,
              message: "Incorrect old fund password.",
            });
          }
        }

        const newPassword = String(
          req.body?.newPassword || ""
        ).trim();

        if (!/^(?:\d{6}|[a-f0-9]{64})$/i.test(newPassword)) {
          return res.json({
            success: false,
            message: "Fund password must be 6 digits.",
          });
        }

        if (
          typeof kendrick.setFundPasswordFromLegacyHash !==
          "function"
        ) {
          return res.status(500).json({
            success: false,
            message: "Fund password service is unavailable.",
          });
        }

        await kendrick.setFundPasswordFromLegacyHash(
          ref,
          newPassword
        );

        return res.json({
          success: true,
          message: "Fund password updated successfully.",
        });
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }
    }
  );

  return router;
}

module.exports = {
  createRouter,
};
