"use strict";

// ============================================================
// SAINT CRYPTO — WITHDRAWAL WALLET ROUTES
// services/routes/withdrawal_wallet.js
//
// Purpose:
// - Save the user's first USDT TRC20 withdrawal wallet.
// - Allow the user to REQUEST a wallet change later.
// - Never replace the active wallet directly from Flutter.
// - Keep the active wallet protected until the change is approved.
// - No withdrawal request is created by these routes.
// - No ledger/funds are touched by these routes.
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

  function requireWalletChangeService(req, res, next) {
    if (
      !withdrawalWallet ||
      typeof withdrawalWallet.requestWithdrawalWalletChange !==
        "function"
    ) {
      return res.status(503).json({
        success: false,
        code: "WITHDRAWAL_WALLET_CHANGE_UNAVAILABLE",
        message:
          "Withdrawal wallet change service is not available.",
      });
    }

    next();
  }

  function responseStatus(result, fallbackSuccess = 200) {
    const status = Number(result?.httpStatus);

    if (status >= 200 && status <= 599) {
      return status;
    }

    return result?.success ? fallbackSuccess : 400;
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

        return res
          .status(responseStatus(result))
          .json({
            success: result?.success ?? false,
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
  // SAVE FIRST WITHDRAWAL WALLET
  //
  // POST /api/withdrawal-wallet
  //
  // Body:
  // {
  //   "address": "T..."
  // }
  //
  // IMPORTANT:
  // - This endpoint may save ONLY the first wallet.
  // - An existing locked wallet cannot be replaced here.
  // - No withdrawal is created.
  // - No funds are touched.
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

        return res
          .status(responseStatus(result))
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

  // ============================================================
  // REQUEST A NEW WITHDRAWAL WALLET
  //
  // POST /api/withdrawal-wallet/change
  //
  // Body:
  // {
  //   "address": "T..."
  // }
  //
  // IMPORTANT:
  // - This does NOT replace the active wallet.
  // - This creates a pending wallet-change request.
  // - Existing withdrawals continue using their original
  //   destination snapshot.
  // - The service must require admin/security approval before
  //   promoting the new address to the active locked wallet.
  // - No funds are touched.
  // ============================================================

  router.post(
    "/api/withdrawal-wallet/change",
    verifyAuth,
    strictLimiter,
    verifyFirestore,
    requireWalletChangeService,
    async (req, res) => {
      try {
        const address = String(
          req.body?.address ||
            req.body?.newAddress ||
            req.body?.withdrawalWalletAddress ||
            ""
        ).trim();

        if (!address) {
          return res.status(400).json({
            success: false,
            code: "ADDRESS_REQUIRED",
            message:
              "Please enter the new USDT TRC20 wallet address.",
          });
        }

        const result =
          await withdrawalWallet.requestWithdrawalWalletChange(
            req.uid,
            address
          );

        return res
          .status(responseStatus(result))
          .json({
            success: result?.success ?? false,
            ...result,
          });
      } catch (error) {
        console.error(
          "❌ Withdrawal wallet CHANGE:",
          error.message
        );

        return res.status(500).json({
          success: false,
          code:
            error.code ||
            "WITHDRAWAL_WALLET_CHANGE_FAILED",
          message:
            error.message ||
            "Unable to request a withdrawal wallet change.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createRouter,
};
