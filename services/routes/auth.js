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
  const { firestore, verifyAuth, verifyFirestore, strictLimiter, services = {} } = routeDeps;

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

  
  // ------------------------------------------------------------
  // UPDATE FUND PASSWORD - CUSTOMER COMPATIBILITY
  // POST /api/user/update-fund-password
  // ------------------------------------------------------------
  router.post(
    "/api/user/update-fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const db = firestore;

        if (!db) {
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
          db.collection("users").doc(uid);

        const snapshot =
          await ref.get();

        if (!snapshot.exists) {
          return res.status(404).json({
            success: false,
            message: "User account not found.",
          });
        }

        const user =
          snapshot.data() || {};

        const oldPassword =
          String(req.body?.oldPassword || "").trim();

        const newPassword =
          String(req.body?.newPassword || "").trim();

        if (!/^\d{6}$/.test(oldPassword)) {
          return res.status(400).json({
            success: false,
            message: "Current Fund PIN must contain exactly 6 digits.",
          });
        }

        if (!/^\d{6}$/.test(newPassword)) {
          return res.status(400).json({
            success: false,
            message: "New Fund PIN must contain exactly 6 digits.",
          });
        }

        if (oldPassword === newPassword) {
          return res.status(400).json({
            success: false,
            message: "Your new Fund PIN must be different from your current PIN.",
          });
        }

        if (
          typeof kendrick.verifyFundPassword !== "function"
        ) {
          return res.status(503).json({
            success: false,
            message: "Fund password verification service is unavailable.",
          });
        }

        const verified =
          await kendrick.verifyFundPassword(
            user,
            oldPassword
          );

        if (!verified) {
          return res.status(400).json({
            success: false,
            message: "Incorrect current Fund PIN.",
          });
        }

        await kendrick.saveFundPassword(
          ref,
          newPassword
        );

        return res.status(200).json({
          success: true,
          message: "Fund PIN updated successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Update Fund PIN error:",
          error.stack || error.message
        );

        return res.status(400).json({
          success: false,
          message:
            error.message ||
            "Unable to update Fund PIN.",
        });
      }
    }
  );

  // ------------------------------------------------------------
  // RESET FUND PASSWORD - CUSTOMER COMPATIBILITY
  // POST /api/user/reset-fund-password
  // ------------------------------------------------------------
  router.post(
    "/api/user/reset-fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const db = firestore;

        if (!db) {
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

        const newPassword =
          String(req.body?.newPassword || "").trim();

        if (!/^\d{6}$/.test(newPassword)) {
          return res.status(400).json({
            success: false,
            message: "Fund PIN must contain exactly 6 digits.",
          });
        }

        await kendrick.saveFundPassword(
          db.collection("users").doc(uid),
          newPassword
        );

        return res.status(200).json({
          success: true,
          message: "Fund PIN reset successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Reset Fund PIN error:",
          error.stack || error.message
        );

        return res.status(400).json({
          success: false,
          message:
            error.message ||
            "Unable to reset Fund PIN.",
        });
      }
    }
  );
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

  
  // ------------------------------------------------------------
  // UPDATE FUND PASSWORD - CUSTOMER COMPATIBILITY
  // POST /api/user/update-fund-password
  // ------------------------------------------------------------
  router.post(
    "/api/user/update-fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const db = firestore;

        if (!db) {
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
          db.collection("users").doc(uid);

        const snapshot =
          await ref.get();

        if (!snapshot.exists) {
          return res.status(404).json({
            success: false,
            message: "User account not found.",
          });
        }

        const user =
          snapshot.data() || {};

        const oldPassword =
          String(req.body?.oldPassword || "").trim();

        const newPassword =
          String(req.body?.newPassword || "").trim();

        if (!/^\d{6}$/.test(oldPassword)) {
          return res.status(400).json({
            success: false,
            message: "Current Fund PIN must contain exactly 6 digits.",
          });
        }

        if (!/^\d{6}$/.test(newPassword)) {
          return res.status(400).json({
            success: false,
            message: "New Fund PIN must contain exactly 6 digits.",
          });
        }

        if (oldPassword === newPassword) {
          return res.status(400).json({
            success: false,
            message: "Your new Fund PIN must be different from your current PIN.",
          });
        }

        if (
          typeof kendrick.verifyFundPassword !== "function"
        ) {
          return res.status(503).json({
            success: false,
            message: "Fund password verification service is unavailable.",
          });
        }

        const verified =
          await kendrick.verifyFundPassword(
            user,
            oldPassword
          );

        if (!verified) {
          return res.status(400).json({
            success: false,
            message: "Incorrect current Fund PIN.",
          });
        }

        await kendrick.saveFundPassword(
          ref,
          newPassword
        );

        return res.status(200).json({
          success: true,
          message: "Fund PIN updated successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Update Fund PIN error:",
          error.stack || error.message
        );

        return res.status(400).json({
          success: false,
          message:
            error.message ||
            "Unable to update Fund PIN.",
        });
      }
    }
  );

  // ------------------------------------------------------------
  // RESET FUND PASSWORD - CUSTOMER COMPATIBILITY
  // POST /api/user/reset-fund-password
  // ------------------------------------------------------------
  router.post(
    "/api/user/reset-fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const db = firestore;

        if (!db) {
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

        const newPassword =
          String(req.body?.newPassword || "").trim();

        if (!/^\d{6}$/.test(newPassword)) {
          return res.status(400).json({
            success: false,
            message: "Fund PIN must contain exactly 6 digits.",
          });
        }

        await kendrick.saveFundPassword(
          db.collection("users").doc(uid),
          newPassword
        );

        return res.status(200).json({
          success: true,
          message: "Fund PIN reset successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Reset Fund PIN error:",
          error.stack || error.message
        );

        return res.status(400).json({
          success: false,
          message:
            error.message ||
            "Unable to reset Fund PIN.",
        });
      }
    }
  );
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
        const db = firestore;

        if (!db) {
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
          db.collection("users").doc(uid),
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
        const db = firestore;

        if (!db) {
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
          db.collection("users").doc(uid);

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


  // ------------------------------------------------------------
  // UPDATE FUND PASSWORD - CUSTOMER COMPATIBILITY
  // POST /api/user/update-fund-password
  // ------------------------------------------------------------
  router.post(
    "/api/user/update-fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const db = firestore;

        if (!db) {
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
          db.collection("users").doc(uid);

        const snapshot =
          await ref.get();

        if (!snapshot.exists) {
          return res.status(404).json({
            success: false,
            message: "User account not found.",
          });
        }

        const user =
          snapshot.data() || {};

        const oldPassword =
          String(req.body?.oldPassword || "").trim();

        const newPassword =
          String(req.body?.newPassword || "").trim();

        if (!/^\d{6}$/.test(oldPassword)) {
          return res.status(400).json({
            success: false,
            message: "Current Fund PIN must contain exactly 6 digits.",
          });
        }

        if (!/^\d{6}$/.test(newPassword)) {
          return res.status(400).json({
            success: false,
            message: "New Fund PIN must contain exactly 6 digits.",
          });
        }

        if (oldPassword === newPassword) {
          return res.status(400).json({
            success: false,
            message: "Your new Fund PIN must be different from your current PIN.",
          });
        }

        if (
          typeof kendrick.verifyFundPassword !== "function"
        ) {
          return res.status(503).json({
            success: false,
            message: "Fund password verification service is unavailable.",
          });
        }

        const verified =
          await kendrick.verifyFundPassword(
            user,
            oldPassword
          );

        if (!verified) {
          return res.status(400).json({
            success: false,
            message: "Incorrect current Fund PIN.",
          });
        }

        await kendrick.saveFundPassword(
          ref,
          newPassword
        );

        return res.status(200).json({
          success: true,
          message: "Fund PIN updated successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Update Fund PIN error:",
          error.stack || error.message
        );

        return res.status(400).json({
          success: false,
          message:
            error.message ||
            "Unable to update Fund PIN.",
        });
      }
    }
  );

  // ------------------------------------------------------------
  // RESET FUND PASSWORD - CUSTOMER COMPATIBILITY
  // POST /api/user/reset-fund-password
  // ------------------------------------------------------------
  router.post(
    "/api/user/reset-fund-password",
    verifyAuth,
    limiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const db = firestore;

        if (!db) {
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

        const newPassword =
          String(req.body?.newPassword || "").trim();

        if (!/^\d{6}$/.test(newPassword)) {
          return res.status(400).json({
            success: false,
            message: "Fund PIN must contain exactly 6 digits.",
          });
        }

        await kendrick.saveFundPassword(
          db.collection("users").doc(uid),
          newPassword
        );

        return res.status(200).json({
          success: true,
          message: "Fund PIN reset successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Reset Fund PIN error:",
          error.stack || error.message
        );

        return res.status(400).json({
          success: false,
          message:
            error.message ||
            "Unable to reset Fund PIN.",
        });
      }
    }
  );
  return router;
}

module.exports = {
  createRouter,
};


