"use strict";

const express = require("express");

/*
|--------------------------------------------------------------------------
| SAINT CRYPTO — WITHDRAWAL ROUTES
|--------------------------------------------------------------------------
|
| This file ONLY handles HTTP routing.
|
| Actual withdrawal business logic belongs in:
|
|     services/withdrawal.js
|
| The route receives the authenticated Firebase UID from index.js:
|
|     req.uid
|
|--------------------------------------------------------------------------
*/

function createRouter({
  verifyAuth,
  verifyFirestore,
  strictLimiter,
  services,
}) {
  const router = express.Router();

  const {
    withdrawal,
    telegramWithdrawal,
  } = services;

  // ============================================================
  // SERVICE CHECK
  // ============================================================

  function requireWithdrawalService(
    req,
    res,
    next
  ) {
    if (
      !withdrawal ||
      typeof withdrawal.requestWithdrawal !==
        "function"
    ) {
      return res
        .status(503)
        .json({
          success: false,
          code:
            "WITHDRAWAL_SERVICE_UNAVAILABLE",
          message:
            "Withdrawal service is not available.",
        });
    }

    next();
  }

  // ============================================================
  // REQUEST WITHDRAWAL
  // ============================================================
  //
  // Flutter:
  //
  // POST /api/withdrawals/request
  //
  // Body:
  //
  // {
  //   "amount": 100,
  //   "destinationAddress": "T...",
  //   "password": "123456",
  //   "fundPassword": "123456"
  // }
  //
  // Identity comes from Firebase Bearer authentication.
  //
  // ============================================================

  router.post(
    "/api/withdrawals/request",

    verifyAuth,

    strictLimiter,

    verifyFirestore,

    requireWithdrawalService,

    async (req, res) => {
      try {
        const amount =
          req.body?.amount;

        // --------------------------------------------------------
        // Accept both Flutter field names.
        // --------------------------------------------------------

        const fundPassword =
          String(
            req.body?.fundPassword ||
              req.body?.password ||
              ""
          ).trim();

        // --------------------------------------------------------
        // BASIC VALIDATION
        // --------------------------------------------------------

        if (
          amount === undefined ||
          amount === null ||
          amount === ""
        ) {
          return res
            .status(400)
            .json({
              success: false,
              code:
                "AMOUNT_REQUIRED",
              message:
                "Withdrawal amount is required.",
            });
        }

        const numericAmount =
          Number(amount);

        if (
          !Number.isFinite(
            numericAmount
          ) ||
          numericAmount <= 0
        ) {
          return res
            .status(400)
            .json({
              success: false,
              code:
                "INVALID_AMOUNT",
              message:
                "Please enter a valid withdrawal amount.",
            });
        }

        // The withdrawal wallet is registered separately and locked.
        // No new destination address is accepted on a withdrawal request.

        // --------------------------------------------------------
        // FUND PIN BASIC VALIDATION
        // --------------------------------------------------------

        if (
          !/^\d{6}$/.test(
            fundPassword
          )
        ) {
          return res
            .status(400)
            .json({
              success: false,
              code:
                "INVALID_FUND_PASSWORD",
              message:
                "Fund PIN must contain exactly 6 digits.",
            });
        }

        // ========================================================
        // CALL WITHDRAWAL SERVICE
        //
        // IMPORTANT:
        //
        // services/withdrawal.js expects:
        //
        // requestWithdrawal(userId, body)
        //
        // ========================================================

        const result =
          await withdrawal.requestWithdrawal(
            req.uid,
            {
              amount:
                numericAmount,

              fundPassword,

              // Compatibility aliases.
              password:
                fundPassword,

              fundPin:
                fundPassword,
            }
          );

        if (
          result?.success === true &&
          result?.status === "UNDER_REVIEW" &&
          telegramWithdrawal &&
          typeof telegramWithdrawal.notifyWithdrawalUnderReview ===
            "function"
        ) {
          try {
            await telegramWithdrawal.notifyWithdrawalUnderReview(
              result.withdrawalId
            );
          } catch (telegramError) {
            // Telegram failure never cancels an UNDER_REVIEW withdrawal.
            console.error(
              `[TELEGRAM] Could not notify withdrawal ${result.withdrawalId}:`,
              telegramError.message
            );
          }
        }

        const status =
          Number(
            result?.httpStatus
          );

        return res
          .status(
            status >= 200 &&
            status <= 599
              ? status
              : (
                  result?.success
                    ? 200
                    : 400
                )
          )
          .json({
            success:
              result?.success ??
              true,

            ...result,
          });

      } catch (error) {
        console.error(
          "❌ Withdrawal request error:",
          error.message
        );

        const status =
          Number(
            error?.statusCode ||
              error?.status ||
              400
          );

        return res
          .status(
            status >= 400 &&
            status <= 599
              ? status
              : 400
          )
          .json({
            success: false,

            code:
              error?.code ||
              "WITHDRAWAL_FAILED",

            message:
              error?.message ||
              "Unable to process withdrawal request.",
          });
      }
    }
  );

  // ============================================================
  // GET USER WITHDRAWALS
  //
  // Existing endpoint:
  //
  // GET /api/withdrawals
  //
  // ============================================================

  router.get(
    "/api/withdrawals",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        // ========================================================
        // FIX:
        //
        // The withdrawal service exports:
        //
        //     getWithdrawalHistory()
        //
        // NOT:
        //
        //     getUserWithdrawals()
        // ========================================================

        if (
          !withdrawal ||
          typeof withdrawal.getWithdrawalHistory !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "WITHDRAWAL_SERVICE_UNAVAILABLE",
              message:
                "Withdrawal history service is not available.",
              withdrawals: [],
            });
        }

        const result =
          await withdrawal.getWithdrawalHistory(
            req.uid
          );

        const status =
          Number(
            result?.httpStatus
          );

        return res
          .status(
            status >= 200 &&
            status <= 599
              ? status
              : 200
          )
          .json({
            success:
              result?.success ??
              true,

            ...result,
          });

      } catch (error) {
        console.error(
          "❌ Withdrawal history error:",
          error.message
        );

        const status =
          Number(
            error?.statusCode ||
              error?.status ||
              500
          );

        return res
          .status(
            status >= 400 &&
            status <= 599
              ? status
              : 500
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Unable to load withdrawal history.",
            withdrawals: [],
          });
      }
    }
  );

  // ============================================================
  // FLUTTER COMPATIBILITY
  //
  // GET /api/withdrawals/records
  //
  // This is the endpoint expected by the Flutter records screen.
  //
  // ============================================================

  router.get(
    "/api/withdrawals/records",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        // ========================================================
        // FIX:
        //
        // Flutter calls:
        //
        //     /api/withdrawals/records
        //
        // The actual service function is:
        //
        //     getWithdrawalHistory()
        //
        // ========================================================

        if (
          !withdrawal ||
          typeof withdrawal.getWithdrawalHistory !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "WITHDRAWAL_SERVICE_UNAVAILABLE",
              message:
                "Withdrawal records service is not available.",
              withdrawals: [],
            });
        }

        const result =
          await withdrawal.getWithdrawalHistory(
            req.uid
          );

        const status =
          Number(
            result?.httpStatus
          );

        return res
          .status(
            status >= 200 &&
            status <= 599
              ? status
              : 200
          )
          .json({
            success:
              result?.success ??
              true,

            ...result,
          });

      } catch (error) {
        console.error(
          "❌ Withdrawal records error:",
          error.message
        );

        const status =
          Number(
            error?.statusCode ||
              error?.status ||
              500
          );

        return res
          .status(
            status >= 400 &&
            status <= 599
              ? status
              : 500
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Unable to load withdrawal records.",
            withdrawals: [],
          });
      }
    }
  );

  // ============================================================
  // GET WITHDRAWAL STATUS
  //
  // IMPORTANT:
  // This MUST appear before:
  //
  // /api/withdrawals/:withdrawalId
  //
  // ============================================================

  router.get(
    "/api/withdrawals/:withdrawalId/status",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        if (
          !withdrawal ||
          typeof withdrawal.getWithdrawalStatus !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "WITHDRAWAL_SERVICE_UNAVAILABLE",
              message:
                "Withdrawal status service is not available.",
            });
        }

        const withdrawalId =
          String(
            req.params.withdrawalId ||
              ""
          ).trim();

        if (
          !withdrawalId
        ) {
          return res
            .status(400)
            .json({
              success: false,
              code:
                "WITHDRAWAL_ID_REQUIRED",
              message:
                "Withdrawal ID is required.",
            });
        }

        const result =
          await withdrawal.getWithdrawalStatus(
            req.uid,
            withdrawalId
          );

        const status =
          Number(
            result?.httpStatus
          );

        return res
          .status(
            status >= 200 &&
            status <= 599
              ? status
              : 200
          )
          .json({
            success:
              result?.success ??
              true,

            ...result,
          });

      } catch (error) {
        console.error(
          "❌ Withdrawal status error:",
          error.message
        );

        const status =
          Number(
            error?.statusCode ||
              error?.status ||
              404
          );

        return res
          .status(
            status >= 400 &&
            status <= 599
              ? status
              : 404
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Unable to retrieve withdrawal status.",
          });
      }
    }
  );

  // ============================================================
  // GET SINGLE WITHDRAWAL
  //
  // This comes AFTER /:withdrawalId/status intentionally.
  //
  // ============================================================

  router.get(
    "/api/withdrawals/:withdrawalId",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        if (
          !withdrawal ||
          typeof withdrawal.getWithdrawal !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "WITHDRAWAL_SERVICE_UNAVAILABLE",
              message:
                "Withdrawal service is not available.",
            });
        }

        const withdrawalId =
          String(
            req.params.withdrawalId ||
              ""
          ).trim();

        if (
          !withdrawalId
        ) {
          return res
            .status(400)
            .json({
              success: false,
              code:
                "WITHDRAWAL_ID_REQUIRED",
              message:
                "Withdrawal ID is required.",
            });
        }

        const result =
          await withdrawal.getWithdrawal(
            req.uid,
            withdrawalId
          );

        const status =
          Number(
            result?.httpStatus
          );

        return res
          .status(
            status >= 200 &&
            status <= 599
              ? status
              : 200
          )
          .json({
            success:
              result?.success ??
              true,

            ...result,
          });

      } catch (error) {
        console.error(
          "❌ Withdrawal lookup error:",
          error.message
        );

        const status =
          Number(
            error?.statusCode ||
              error?.status ||
              404
          );

        return res
          .status(
            status >= 400 &&
            status <= 599
              ? status
              : 404
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Withdrawal not found.",
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