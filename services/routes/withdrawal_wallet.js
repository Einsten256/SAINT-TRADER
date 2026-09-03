"use strict";

// ============================================================
// SAINT CRYPTO — WITHDRAWAL WALLET ROUTES
// services/routes/withdrawal_wallet.js
//
// This is separate from an actual withdrawal request.
// The user saves the wallet in advance so admin can prepare it
// in Bybit and handle any new-address security delay.
// ============================================================

const express = require("express");

function createRouter({
  verifyAuth,
  verifyFirestore,
  strictLimiter,
  services,
}) {
  const router = express.Router();

  const { withdrawalWallet } = services;

  function requireWithdrawalWalletService(req, res, next) {
    if (
      !withdrawalWallet ||
      typeof withdrawalWallet.saveWithdrawalWallet !== "function" ||
      typeof withdrawalWallet.getWithdrawalWallet !== "function"
    ) {
      return res.status(503).json({
        success: false,
        code: "WITHDRAWAL_WALLET_SERVICE_UNAVAILABLE",
        message: "Withdrawal wallet service is not available.",
      });
    }

    next();
  }

  // ============================================================
  // GET CURRENT WITHDRAWAL WALLET
  //
  // GET /api/withdrawal-wallet
  // ============================================================

  router.get(
    "/api/withdrawal-wallet",
    verifyAuth,
    verifyFirestore,
    requireWithdrawalWalletService,
    async (req, res) => {
      try {
        const result =
          await withdrawalWallet.getWithdrawalWallet(req.uid);

        const status = Number(result?.httpStatus);

        return res
          .status(
            status >= 200 && status <= 599
              ? status
              : result?.success
              ? 200
              : 400
          )
          .json({
            success: result?.success ?? true,
            ...result,
          });
      } catch (error) {
        console.error(
          "❌ Withdrawal wallet GET:",
          error.message
        );

        return res.status(500).json({
          success: false,
          code: "WITHDRAWAL_WALLET_FETCH_FAILED",
          message:
            error.message ||
            "Unable to load your withdrawal wallet.",
        });
      }
    }
  );

  // ============================================================
  // SAVE CURRENT WITHDRAWAL WALLET
  //
  // POST /api/withdrawal-wallet
  //
  // Body:
  // {
  //   "address": "T..."
  // }
  //
  // IMPORTANT:
  // - No withdrawal is created.
  // - No funds are touched.
  // - No Fund PIN is required.
  // - The first saved address becomes locked.
  // ============================================================

  router.post(
    "/api/withdrawal-wallet",
    verifyAuth,
    strictLimiter,
    verifyFirestore,
    requireWithdrawalWalletService,
    async (req, res) => {
      try {
        const address = String(
          req.body?.address ||
            req.body?.withdrawalWalletAddress ||
            ""
        ).trim();

        if (!address) {
          return res.status(400).json({
            success: false,
            code: "ADDRESS_REQUIRED",
            message:
              "Please enter your USDT TRC20 wallet address.",
          });
        }

        const result =
          await withdrawalWallet.saveWithdrawalWallet(
            req.uid,
            address
          );

        const status = Number(result?.httpStatus);

        return res
          .status(
            status >= 200 && status <= 599
              ? status
              : result?.success
              ? 200
              : 400
          )
          .json({
            success: result?.success ?? false,
            ...result,
          });
      } catch (error) {
        console.error(
          "❌ Withdrawal wallet POST:",
          error.message
        );

        return res.status(500).json({
          success: false,
          code:
            error.code ||
            "WITHDRAWAL_WALLET_SAVE_FAILED",
          message:
            error.message ||
            "Unable to save your withdrawal wallet.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createRouter,
};
