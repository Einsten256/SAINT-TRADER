"use strict";

const express = require("express");

function createRouter({
  verifyAuth,
  verifyFirestore,
  strictLimiter,
  services,
}) {
  const router = express.Router();

  const deposit = services.deposit;

  // ============================================================
  // SERVICE CHECK
  // ============================================================

  function requireDepositService(
    req,
    res,
    next
  ) {
    if (
      !deposit ||
      typeof deposit.submitDeposit !==
        "function"
    ) {
      return res
        .status(503)
        .json({
          success: false,
          code:
            "DEPOSIT_SERVICE_UNAVAILABLE",
          message:
            "Deposit service is not available.",
        });
    }

    next();
  }

  // ============================================================
  // SUBMIT DEPOSIT
  // ============================================================
  //
  // Flutter sends:
  //
  // {
  //   "txid": "...",
  //   "amount": 100,
  //   "network": "TRC20",
  //   "depositAddress": "..."
  // }
  //
  // UID comes from Firebase Authentication.
  //
  // ============================================================

  router.post(
    "/api/deposits/submit",

    verifyAuth,

    strictLimiter,

    verifyFirestore,

    requireDepositService,

    async (req, res) => {
      try {
        const result =
          await deposit.submitDeposit(
            req.uid,
            req.body
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
              : (
                  result?.success
                    ? 200
                    : 202
                )
          )
          .json(result);

      } catch (error) {
        console.error(
          "❌ Deposit submission error:",
          error.message
        );

        return res
          .status(
            Number(
              error?.statusCode ||
                error?.status ||
                400
            )
          )
          .json({
            success: false,

            status: "FAILED",

            code:
              error?.code ||
              "DEPOSIT_SUBMISSION_FAILED",

            message:
              error?.message ||
              "Unable to submit deposit.",
          });
      }
    }
  );

  // ============================================================
  // FLUTTER COMPATIBILITY ENDPOINT
  // ============================================================

  router.post(
    "/api/deposit",

    verifyAuth,

    strictLimiter,

    verifyFirestore,

    requireDepositService,

    async (req, res) => {
      try {
        const result =
          await deposit.submitDeposit(
            req.uid,
            req.body
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
              : (
                  result?.success
                    ? 200
                    : 202
                )
          )
          .json(result);

      } catch (error) {
        console.error(
          "❌ Deposit error:",
          error.message
        );

        return res
          .status(
            Number(
              error?.statusCode ||
                error?.status ||
                400
            )
          )
          .json({
            success: false,

            status: "FAILED",

            code:
              error?.code ||
              "DEPOSIT_FAILED",

            message:
              error?.message ||
              "Unable to submit deposit.",
          });
      }
    }
  );

  // ============================================================
  // GET SINGLE DEPOSIT STATUS
  // ============================================================

  router.get(
    "/api/deposits/:depositId",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        if (
          !deposit ||
          typeof deposit.getDepositStatus !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "DEPOSIT_SERVICE_UNAVAILABLE",
              message:
                "Deposit status service is not available.",
            });
        }

        const depositId =
          String(
            req.params.depositId ||
              ""
          ).trim();

        if (!depositId) {
          return res
            .status(400)
            .json({
              success: false,
              code:
                "DEPOSIT_ID_REQUIRED",
              message:
                "Deposit ID is required.",
            });
        }

        const result =
          await deposit.getDepositStatus(
            req.uid,
            depositId
          );

        return res.json(
          result
        );

      } catch (error) {
        console.error(
          "❌ Deposit status error:",
          error.message
        );

        if (
          error.message ===
          "Access denied."
        ) {
          return res
            .status(403)
            .json({
              success: false,
              message:
                "Access denied.",
            });
        }

        return res
          .status(
            error?.statusCode ||
              error?.status ||
              500
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Unable to retrieve deposit status.",
          });
      }
    }
  );

  // ============================================================
  // GET DEPOSIT HISTORY
  //
  // Existing endpoint:
  //
  // GET /api/deposits
  //
  // ============================================================

  router.get(
    "/api/deposits",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        if (
          !deposit ||
          typeof deposit.getDepositHistory !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "DEPOSIT_SERVICE_UNAVAILABLE",
              message:
                "Deposit history service is not available.",
            });
        }

        const result =
          await deposit.getDepositHistory(
            req.uid,
            req.query.limit
          );

        return res.json(
          result
        );

      } catch (error) {
        console.error(
          "❌ Deposit history error:",
          error.message
        );

        return res
          .status(
            error?.statusCode ||
              error?.status ||
              500
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Unable to load deposit history.",
          });
      }
    }
  );

  // ============================================================
  // FLUTTER COMPATIBILITY:
  // GET /api/deposits/history
  // ============================================================

  router.get(
    "/api/deposits/history",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        if (
          !deposit ||
          typeof deposit.getDepositHistory !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "DEPOSIT_SERVICE_UNAVAILABLE",
              message:
                "Deposit history service is not available.",
            });
        }

        const result =
          await deposit.getDepositHistory(
            req.uid,
            req.query.limit
          );

        return res.json(
          result
        );

      } catch (error) {
        console.error(
          "❌ Deposit history error:",
          error.message
        );

        return res
          .status(
            error?.statusCode ||
              error?.status ||
              500
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Unable to load deposit history.",
          });
      }
    }
  );

  // ============================================================
  // FLUTTER COMPATIBILITY:
  // GET /api/deposits/records
  //
  // This is the endpoint your Flutter records screen expects.
  //
  // It uses the SAME authenticated UID and the SAME
  // getDepositHistory() service.
  //
  // ============================================================

  router.get(
    "/api/deposits/records",

    verifyAuth,

    verifyFirestore,

    async (req, res) => {
      try {
        if (
          !deposit ||
          typeof deposit.getDepositHistory !==
            "function"
        ) {
          return res
            .status(503)
            .json({
              success: false,
              code:
                "DEPOSIT_SERVICE_UNAVAILABLE",
              message:
                "Deposit records service is not available.",
            });
        }

        const result =
          await deposit.getDepositHistory(
            req.uid,
            req.query.limit
          );

        return res.json(
          result
        );

      } catch (error) {
        console.error(
          "❌ Deposit records error:",
          error.message
        );

        return res
          .status(
            error?.statusCode ||
              error?.status ||
              500
          )
          .json({
            success: false,
            message:
              error?.message ||
              "Unable to load deposit records.",
          });
      }
    }
  );

  return router;
}

module.exports = {
  createRouter,
};