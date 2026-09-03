"use strict";

const express = require("express");

function createRouter({
  verifyAuth,
  verifyFirestore,
  strictLimiter,
  services,
}) {
  const router = express.Router();

  const { signal } = services;

  // ============================================================
  // GET ACTIVE SIGNAL
  // ============================================================

  router.get(
    "/api/signals/active",
    verifyAuth,
    verifyFirestore,
    async (req, res) => {
      try {
        const result =
          await signal.getActiveSignal();

        return res.json(result);
      } catch (error) {
        console.error(
          "❌ Active signal error:",
          error.message
        );

        return res.status(
          error.statusCode || 500
        ).json({
          success: false,
          message:
            error.message ||
            "Unable to load active signal.",
        });
      }
    }
  );

  // ============================================================
  // GET SIGNALS
  // ============================================================

  router.get(
    "/api/signals",
    verifyAuth,
    verifyFirestore,
    async (req, res) => {
      try {
        const result =
          await signal.getSignals({
            uid: req.uid,
          });

        return res.json(result);
      } catch (error) {
        console.error(
          "❌ Signals error:",
          error.message
        );

        return res.status(
          error.statusCode || 500
        ).json({
          success: false,
          message:
            error.message ||
            "Unable to load signals.",
        });
      }
    }
  );

  // ============================================================
  // SIGNAL STATUS
  // ============================================================

  router.get(
    "/api/signals/status/:code",
    verifyAuth,
    verifyFirestore,
    async (req, res) => {
      try {
        const result =
          await signal.getSignalStatus(
            req.params.code
          );

        return res.json(result);
      } catch (error) {
        console.error(
          "❌ Signal status error:",
          error.message
        );

        return res.status(
          error.statusCode || 404
        ).json({
          success: false,
          message:
            error.message ||
            "Signal not found.",
        });
      }
    }
  );

  // ============================================================
  // REDEEM SIGNAL
  // ============================================================

  router.post(
    "/api/signals/redeem",
    verifyAuth,
    strictLimiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const code =
          typeof req.body?.code === "string"
            ? req.body.code.trim()
            : "";

        if (!code) {
          return res.status(400).json({
            success: false,
            message:
              "Signal code is required.",
          });
        }

        const result =
          await signal.redeemSignal({
            uid: req.uid,
            code,
          });

        return res.json(result);
      } catch (error) {
        console.error(
          "❌ Signal redemption error:",
          error.message
        );

        return res.status(
          error.statusCode || 400
        ).json({
          success: false,
          message:
            error.message ||
            "Unable to redeem signal.",
        });
      }
    }
  );

  // ============================================================
  // RETURN ROUTER
  // ============================================================

  return router;
}

module.exports = {
  createRouter,
};