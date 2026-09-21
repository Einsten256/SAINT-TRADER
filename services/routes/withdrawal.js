/**
 * SAINT CRYPTO
 * services/routes/withdrawal.js
 *
 * Mobile Money withdrawal routes.
 *
 * IMPORTANT:
 * This version receives verifyAuth from index.js through createRouter().
 * It does NOT try to discover authentication middleware with require().
 *
 * Destination:
 * SAINT CRYPTO/services/routes/withdrawal.js
 */

"use strict";

const express = require("express");

function createRouter({
  verifyAuth,
  verifyFirestore,
  strictLimiter,
  services,
}) {
  const router = express.Router();

  const withdrawal =
    services?.withdrawal;

  // ------------------------------------------------------------
  // Authentication must come from index.js.
  // This prevents AUTH_MIDDLEWARE_NOT_CONFIGURED caused by
  // trying to load middleware from the wrong module path.
  // ------------------------------------------------------------
  function requireAuth(req, res, next) {
    if (typeof verifyAuth !== "function") {
      return res.status(503).json({
        success: false,
        code: "AUTH_SERVICE_UNAVAILABLE",
        message:
          "Secure sign-in service is temporarily unavailable. Please try again in a moment.",
      });
    }

    return verifyAuth(req, res, next);
  }

  function requireFirestore(req, res, next) {
    if (typeof verifyFirestore !== "function") {
      return next();
    }

    return verifyFirestore(req, res, next);
  }

  function getUserId(req) {
    return (
      req.uid ||
      req.user?.uid ||
      req.user?.userId ||
      req.user?.id ||
      req.auth?.uid ||
      req.auth?.userId ||
      null
    );
  }

  function userRequired(res) {
    return res.status(401).json({
      success: false,
      code: "AUTH_REQUIRED",
      message:
        "Your session has expired. Please sign in again.",
    });
  }

  function badRequest(res, code, message) {
    return res.status(400).json({
      success: false,
      code,
      message,
    });
  }

  function friendlyError(error, fallback) {
    const code =
      String(error?.code || "").toUpperCase();

    const raw =
      String(error?.message || "").trim();

    if (
      code.includes("AUTH") ||
      raw.includes("AUTH_MIDDLEWARE_NOT_CONFIGURED")
    ) {
      return "We couldn't verify your account. Please sign in again.";
    }

    if (
      code === "UNAUTHENTICATED" ||
      raw.toLowerCase().includes("authenticated user")
    ) {
      return "Your session has expired. Please sign in again.";
    }

    if (
      raw.toLowerCase().includes("account record could not be found")
    ) {
      return "We couldn't find your account details. Please sign in again.";
    }

    if (
      raw.toLowerCase().includes("currently restricted") ||
      raw.toLowerCase().includes("account is frozen")
    ) {
      return "Your account is currently restricted. Please contact SAINT CRYPTO Support.";
    }

    return raw || fallback;
  }

  function asyncRoute(handler) {
    return async (req, res) => {
      try {
        return await handler(req, res);
      } catch (error) {
        console.error("[withdrawal route]", error);

        const status =
          Number(error?.statusCode || error?.status);

        return res
          .status(
            status >= 400 && status <= 599
              ? status
              : 500
          )
          .json({
            success: false,
            code:
              error?.code ||
              "WITHDRAWAL_REQUEST_FAILED",
            message: friendlyError(
              error,
              "We couldn't complete this request right now. Please try again."
            ),
          });
      }
    };
  }

  function requireWithdrawalService(req, res, next) {
    if (
      !withdrawal ||
      typeof withdrawal.getWithdrawalConfig !== "function"
    ) {
      return res.status(503).json({
        success: false,
        code: "WITHDRAWAL_SERVICE_UNAVAILABLE",
        message:
          "Withdrawal service is temporarily unavailable. Please try again shortly.",
      });
    }

    return next();
  }

  // ============================================================
  // GET WITHDRAWAL CONFIG
  // ============================================================

  router.get(
    "/api/withdrawals/config",
    requireAuth,
    requireFirestore,
    requireWithdrawalService,
    asyncRoute(async (req, res) => {
      const config =
        await withdrawal.getWithdrawalConfig();

      return res.json({
        success: true,
        config,
      });
    })
  );

  // ============================================================
  // GET SAVED MOBILE MONEY PROFILE
  // ============================================================

  router.get(
    "/api/withdrawals/profile",
    requireAuth,
    requireFirestore,
    requireWithdrawalService,
    asyncRoute(async (req, res) => {
      const userId = getUserId(req);

      if (!userId) {
        return userRequired(res);
      }

      const profile =
        await withdrawal.getWithdrawalProfile(
          userId
        );

      return res.json({
        success: true,
        profile:
          profile?.profile || null,
        hasProfile:
          profile?.hasProfile === true,
      });
    })
  );

  // ============================================================
  // SAVE MOBILE MONEY PROFILE
  // ============================================================
  //
  // No Fund Password is required here.
  // Saving details does not move money.
  // ============================================================

  router.post(
    "/api/withdrawals/profile",
    requireAuth,
    requireFirestore,
    requireWithdrawalService,
    asyncRoute(async (req, res) => {
      const userId = getUserId(req);

      if (!userId) {
        return userRequired(res);
      }

      const recipientName =
        String(
          req.body?.recipientName ||
          req.body?.name ||
          ""
        ).trim();

      const network =
        String(
          req.body?.network || ""
        )
          .trim()
          .toUpperCase();

      const mobileNumber =
        String(
          req.body?.mobileNumber ||
          req.body?.phone ||
          ""
        ).trim();

      if (!recipientName) {
        return badRequest(
          res,
          "RECIPIENT_NAME_REQUIRED",
          "Please enter the full name registered on the Mobile Money account."
        );
      }

      if (
        network !== "MTN" &&
        network !== "AIRTEL"
      ) {
        return badRequest(
          res,
          "INVALID_NETWORK",
          "Please select MTN or Airtel."
        );
      }

      if (
        !/^(?:\+256|0)7\d{8}$/.test(
          mobileNumber.replace(
            /[\s-]/g,
            ""
          )
        )
      ) {
        return badRequest(
          res,
          "INVALID_MOBILE_NUMBER",
          "Please enter a valid Ugandan MTN or Airtel mobile number."
        );
      }

      const result =
        await withdrawal.saveWithdrawalProfile(
          userId,
          {
            recipientName,
            network,
            mobileNumber,
          }
        );

      if (result?.success === false) {
        return res.status(
          Number(result?.httpStatus) >= 400
            ? Number(result.httpStatus)
            : 400
        ).json({
          success: false,
          code:
            result?.code ||
            "WITHDRAWAL_PROFILE_SAVE_FAILED",
          message: friendlyError(
            result,
            "We couldn't save your Mobile Money details. Please check them and try again."
          ),
        });
      }

      return res.json({
        success: true,
        code: "WITHDRAWAL_PROFILE_SAVED",
        message:
          "Your Mobile Money details were saved successfully.",
        profile:
          result?.profile || null,
      });
    })
  );

  // ============================================================
  // REQUEST WITHDRAWAL
  // ============================================================
  //
  // Fund Password IS required here.
  // The backend verifies it against the stored security hash.
  // ============================================================

  router.post(
    "/api/withdrawals/request",
    requireAuth,
    requireFirestore,
    requireWithdrawalService,
    ...(typeof strictLimiter === "function"
      ? [strictLimiter]
      : []),
    asyncRoute(async (req, res) => {
      const userId = getUserId(req);

      if (!userId) {
        return userRequired(res);
      }

      const amount =
        req.body?.amount ??
        req.body?.amountUgx;

      if (
        amount === undefined ||
        amount === null ||
        amount === ""
      ) {
        return badRequest(
          res,
          "WITHDRAWAL_AMOUNT_REQUIRED",
          "Please enter the amount you want to withdraw."
        );
      }

      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return badRequest(
          res,
          "INVALID_AMOUNT",
          "Please enter a valid withdrawal amount."
        );
      }

      const fundPassword =
        String(
          req.body?.fundPassword ||
          req.body?.password ||
          req.body?.fundPin ||
          ""
        ).trim();

      if (!/^\d{6}$/.test(fundPassword)) {
        return badRequest(
          res,
          "INVALID_FUND_PASSWORD",
          "Please enter your 6-digit Fund Password."
        );
      }

      const result =
        await withdrawal.requestWithdrawal(
          userId,
          {
            amount: numericAmount,
            amountUgx: numericAmount,
            fundPassword,
            password: fundPassword,
            fundPin: fundPassword,
          }
        );

      if (result?.success !== true) {
        const status =
          Number(result?.httpStatus);

        return res
          .status(
            status >= 400 && status <= 599
              ? status
              : 400
          )
          .json({
            success: false,
            code:
              result?.code ||
              "WITHDRAWAL_FAILED",
            message: friendlyError(
              result,
              "We couldn't submit your withdrawal. Please try again."
            ),
          });
      }

      return res
        .status(200)
        .json({
          success: true,
          code:
            result?.code ||
            "WITHDRAWAL_UNDER_REVIEW",
          status:
            result?.status ||
            "UNDER_REVIEW",
          message:
            result?.message ||
            "Your withdrawal request was received and is now under review.",
          withdrawalId:
            result?.withdrawalId || "",
          grossAmountUgx:
            result?.grossAmountUgx ??
            result?.grossAmount ??
            numericAmount,
          feePercent:
            result?.feePercent ?? 5,
          feeUgx:
            result?.feeUgx ??
            result?.feeDeducted ??
            0,
          netAmountUgx:
            result?.netAmountUgx ??
            result?.netPayout ??
            0,
          withdrawal:
            result?.withdrawal ||
            null,
        });
    })
  );

  // ============================================================
  // WITHDRAWAL HISTORY
  // ============================================================

  router.get(
    "/api/withdrawals/history",
    requireAuth,
    requireFirestore,
    requireWithdrawalService,
    asyncRoute(async (req, res) => {
      const userId = getUserId(req);

      if (!userId) {
        return userRequired(res);
      }

      const rawLimit =
        Number(req.query?.limit || 30);

      const limit =
        Math.min(
          Math.max(
            Number.isFinite(rawLimit)
              ? Math.floor(rawLimit)
              : 30,
            1
          ),
          100
        );

      const history =
        await withdrawal.getWithdrawalHistory(
          userId,
          limit
        );

      return res.json({
        success: true,
        withdrawals:
          Array.isArray(history)
            ? history
            : history?.withdrawals || [],
      });
    })
  );

  // ============================================================
  // SINGLE WITHDRAWAL STATUS
  // ============================================================

  router.get(
    "/api/withdrawals/:withdrawalId",
    requireAuth,
    requireFirestore,
    requireWithdrawalService,
    asyncRoute(async (req, res) => {
      const userId = getUserId(req);
      const withdrawalId =
        String(
          req.params.withdrawalId || ""
        ).trim();

      if (!userId) {
        return userRequired(res);
      }

      if (!withdrawalId) {
        return badRequest(
          res,
          "WITHDRAWAL_ID_REQUIRED",
          "Withdrawal record could not be identified."
        );
      }

      const record =
        await withdrawal.getWithdrawal(
          withdrawalId
        );

      if (!record) {
        return res.status(404).json({
          success: false,
          code: "WITHDRAWAL_NOT_FOUND",
          message:
            "That withdrawal record could not be found.",
        });
      }

      if (
        record.userId &&
        record.userId !== userId
      ) {
        return res.status(403).json({
          success: false,
          code: "FORBIDDEN",
          message:
            "You can only view your own withdrawal records.",
        });
      }

      return res.json({
        success: true,
        withdrawal: record,
      });
    })
  );

  return router;
}

module.exports = {
  createRouter,
};
