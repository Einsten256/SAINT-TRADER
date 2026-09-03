"use strict";

const express = require("express");

function createRouter({
  verifyAuth,
  verifyFirestore,
  strictLimiter,
  services,
}) {
  const router = express.Router();

  const { kendrick, ledger } = services;

  // ============================================================
  // INTERNAL TRANSFER
  // ============================================================
  //
  // Allowed user movements:
  //
  // TRADE:
  //     exchange -> trade
  //
  // WITHDRAW:
  //     trade -> withdraw
  //
  // The authenticated Firebase UID is always used.
  // The client cannot choose another user's UID.
  //
  // ============================================================

  router.post(
    "/api/transfer",
    verifyAuth,
    strictLimiter,
    verifyFirestore,
    async (req, res) => {
      try {
        if (!ledger || typeof ledger.transferInternalFunds !== "function") {
          console.error(
            "❌ Transfer error: ledger.transferInternalFunds is unavailable."
          );

          return res.status(500).json({
            success: false,
            message: "Transfer service is unavailable.",
          });
        }

        const fromAccount =
          typeof req.body?.fromAccount === "string"
            ? req.body.fromAccount.trim().toLowerCase()
            : "";

        const toAccount =
          typeof req.body?.toAccount === "string"
            ? req.body.toAccount.trim().toLowerCase()
            : "";

        const amount = Number(req.body?.amount);

        // --------------------------------------------------------
        // BASIC VALIDATION
        // --------------------------------------------------------

        if (!fromAccount || !toAccount) {
          return res.status(400).json({
            success: false,
            message: "Source and destination accounts are required.",
          });
        }

        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(400).json({
            success: false,
            message: "Transfer amount must be greater than zero.",
          });
        }

        // Prevent excessive decimal precision.
        if (Math.round(amount * 100) !== amount * 100) {
          return res.status(400).json({
            success: false,
            message: "Amount can have a maximum of 2 decimal places.",
          });
        }

        // --------------------------------------------------------
        // ALLOWED MOVEMENTS
        // --------------------------------------------------------
        //
        // Flutter may send the transfer type implicitly through
        // the account combination.
        //
        // exchange -> trade      = TRADE
        // trade    -> withdraw   = WITHDRAW
        //
        // Nothing else is allowed through this endpoint.
        // --------------------------------------------------------

        let transferType;

        if (
          fromAccount === "exchange" &&
          toAccount === "trade"
        ) {
          transferType = "TRADE";
        } else if (
          fromAccount === "trade" &&
          toAccount === "withdraw"
        ) {
          transferType = "WITHDRAW";
        } else {
          return res.status(400).json({
            success: false,
            message:
              "Invalid transfer. Only Exchange → Trade or Trade → Withdraw is allowed.",
          });
        }

        // --------------------------------------------------------
        // AUTHENTICATED USER
        // --------------------------------------------------------

        const userId = req.uid;

        if (!userId) {
          return res.status(401).json({
            success: false,
            message: "Authentication required.",
          });
        }

        // --------------------------------------------------------
        // LEDGER TRANSFER
        // --------------------------------------------------------

        const result = await ledger.transferInternalFunds({
          userId,
          fromAccount,
          toAccount,
          amount,
          transferType,
        });

        return res.status(200).json({
          success: true,
          message:
            transferType === "TRADE"
              ? "Funds transferred to Trade successfully."
              : "Funds moved to Withdraw successfully.",
          transferType,
          amount,
          fromAccount,
          toAccount,
          ...result,
        });
      } catch (error) {
        console.error(
          "❌ Internal transfer error:",
          error.message
        );

        const statusCode =
          Number.isInteger(error.statusCode)
            ? error.statusCode
            : 400;

        return res.status(statusCode).json({
          success: false,
          message:
            error.message ||
            "Unable to complete the transfer.",
        });
      }
    }
  );

  // ============================================================
  // KENDRICK ASSISTANT
  // ============================================================

  router.post(
    "/api/kendrick/chat",
    verifyAuth,
    strictLimiter,
    verifyFirestore,
    async (req, res) => {
      try {
        const message =
          typeof req.body?.message === "string"
            ? req.body.message.trim()
            : "";

        if (!message) {
          return res.status(400).json({
            success: false,
            message: "Message is required.",
          });
        }

        if (message.length > 4000) {
          return res.status(400).json({
            success: false,
            message:
              "Message is too long. Maximum 4000 characters.",
          });
        }

        const result =
          await kendrick.chat({
            uid: req.uid,
            message,
            conversationId:
              req.body?.conversationId || null,
            context:
              req.body?.context || null,
          });

        return res.json({
          success: true,
          ...result,
        });
      } catch (error) {
        console.error(
          "❌ Kendrick chat error:",
          error.message
        );

        return res.status(
          error.statusCode || 500
        ).json({
          success: false,
          message:
            error.message ||
            "Kendrick is temporarily unavailable.",
        });
      }
    }
  );

  // ============================================================
  // KENDRICK HEALTH
  // ============================================================

  router.get(
    "/api/kendrick/status",
    verifyAuth,
    async (req, res) => {
      try {
        const result =
          await kendrick.getStatus({
            uid: req.uid,
          });

        return res.json({
          success: true,
          ...result,
        });
      } catch (error) {
        console.error(
          "❌ Kendrick status error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          message:
            "Kendrick status unavailable.",
        });
      }
    }
  );

  // ============================================================
  // KENDRICK ACCOUNT CONTEXT
  // ============================================================
  //
  // Gives Flutter the authenticated user's safe assistant
  // context. Financial operations must still go through the
  // dedicated financial routes.
  //
  // ============================================================

  router.get(
    "/api/kendrick/context",
    verifyAuth,
    verifyFirestore,
    async (req, res) => {
      try {
        const result =
          await kendrick.getAccountContext(
            req.uid
          );

        return res.json({
          success: true,
          ...result,
        });
      } catch (error) {
        console.error(
          "❌ Kendrick context error:",
          error.message
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to load Kendrick account context.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createRouter,
};