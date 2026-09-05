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
  // GET ACTIVE SIGNALS
  // ============================================================

  router.get(
    "/api/signals/active",
    verifyAuth,
    verifyFirestore,
    async (req, res) => {
      try {
        const result =
          await signal.getActiveSignals(
            req.uid
          );

        return res
          .status(result?.success === false ? 400 : 200)
          .json(result);
      } catch (error) {
        console.error(
          "❌ Get active signals error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          message:
            error.message ||
            "Unable to load active signals.",
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
          await signal.getActiveSignals(
            req.uid
          );

        return res
          .status(result?.success === false ? 400 : 200)
          .json(result);
      } catch (error) {
        console.error(
          "❌ Get signals error:",
          error.message
        );

        return res.status(500).json({
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

        return res
          .status(result?.success === false ? 400 : 200)
          .json(result);
      } catch (error) {
        console.error(
          "❌ Signal status error:",
          error.message
        );

        return res.status(400).json({
          success: false,
          message:
            error.message ||
            "Unable to check signal.",
        });
      }
    }
  );

  // ============================================================
  // REDEEM SIGNAL
  //
  // IMPORTANT:
  //
  // Firebase UID comes from verifyAuth:
  //
  //     req.uid
  //
  // Flutter only sends the signal code.
  //
  // Expected body:
  //
  // {
  //   "code": "8FQ2M7KX91ZT"
  // }
  //
  // The service expects:
  //
  //     redeemSignal(userId, body)
  //
  // Therefore we MUST call:
  //
  //     redeemSignal(req.uid, req.body)
  //
  // NOT:
  //
  //     redeemSignal({ uid: req.uid, code })
  //
  // ============================================================

  router.post(
    "/api/signals/redeem",

    verifyAuth,

    strictLimiter,

    verifyFirestore,

    async (req, res) => {
      try {
        // --------------------------------------------------------
        // Validate request body
        // --------------------------------------------------------

        const body =
          req.body &&
          typeof req.body === "object"
            ? req.body
            : {};

        const code =
          typeof body.code === "string"
            ? body.code.trim()
            : typeof body.signalCode === "string"
              ? body.signalCode.trim()
              : typeof body.signal_code === "string"
                ? body.signal_code.trim()
                : "";

        if (!code) {
          return res.status(400).json({
            success: false,
            status: "INVALID_CODE",
            message:
              "Signal code is required.",
          });
        }

        // --------------------------------------------------------
        // IMPORTANT FIX
        //
        // redeemSignal(userId, body)
        // --------------------------------------------------------

        const result =
          await signal.redeemSignal(
            req.uid,
            {
              code,
            }
          );

        // --------------------------------------------------------
        // Return service result
        // --------------------------------------------------------

        return res
          .status(
            result?.success === false
              ? 400
              : 200
          )
          .json(result);

      } catch (error) {
        console.error(
          `❌ Signal redemption error for ${req.uid || "unknown user"}:`,
          error
        );

        return res.status(
          error.statusCode || 400
        ).json({
          success: false,
          status:
            error.code ||
            "REDEMPTION_FAILED",
          message:
            error.message ||
            "Unable to redeem signal.",
        });
      }
    }
  );

  // ============================================================
  // SIGNAL REDEMPTION HISTORY
  // ============================================================

  router.get(
    "/api/signals/redemptions",
    verifyAuth,
    verifyFirestore,
    async (req, res) => {
      try {
        const result =
          await signal.getUserRedemptions(
            req.uid,
            req.query.limit
          );

        return res
          .status(result?.success === false ? 400 : 200)
          .json(result);
      } catch (error) {
        console.error(
          "❌ Signal redemption history error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          message:
            error.message ||
            "Unable to load redemption history.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createRouter,
};