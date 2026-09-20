/**
 * SAINT CRYPTO
 * services/routes/config.js
 *
 * Safe public configuration API.
 *
 * Destination:
 * SAINT CRYPTO/services/routes/config.js
 *
 * This route exposes only frontend-safe settings from services/config.js.
 * Secrets such as Firebase credentials, Telegram tokens and private keys
 * are never returned.
 */

"use strict";

const express = require("express");

const router = express.Router();

const config = require("../config");

/**
 * GET /api/config
 *
 * Returns the complete frontend-safe configuration.
 *
 * This is useful for Flutter/web clients that need to know:
 * - signal reward
 * - signal schedule
 * - signal processing time
 * - recharge Mobile Money numbers
 * - recharge limits
 * - withdrawal fee
 * - withdrawal limits
 */
router.get("/", (req, res) => {
  try {
    return res.json({
      success: true,
      config: config.getPublicConfig(),
    });
  } catch (error) {
    console.error("[config route]", error);

    return res.status(500).json({
      success: false,
      error: "CONFIG_LOAD_FAILED",
      message: "Could not load public configuration.",
    });
  }
});

/**
 * GET /api/config/signal
 *
 * Signal-only configuration.
 */
router.get("/signal", (req, res) => {
  try {
    const publicConfig = config.getPublicConfig();

    return res.json({
      success: true,
      signal: publicConfig.signal,
    });
  } catch (error) {
    console.error("[config route] signal", error);

    return res.status(500).json({
      success: false,
      error: "SIGNAL_CONFIG_LOAD_FAILED",
      message: "Could not load signal configuration.",
    });
  }
});

/**
 * GET /api/config/recharge
 *
 * Recharge-only configuration.
 *
 * Operator Mobile Money numbers are intentionally exposed here because
 * the frontend needs them so the user knows where to send the recharge.
 *
 * No secrets are exposed.
 */
router.get("/recharge", (req, res) => {
  try {
    const publicConfig = config.getPublicConfig();

    return res.json({
      success: true,
      recharge: publicConfig.recharge,
    });
  } catch (error) {
    console.error("[config route] recharge", error);

    return res.status(500).json({
      success: false,
      error: "RECHARGE_CONFIG_LOAD_FAILED",
      message: "Could not load recharge configuration.",
    });
  }
});

/**
 * GET /api/config/withdrawal
 *
 * Withdrawal-only configuration.
 */
router.get("/withdrawal", (req, res) => {
  try {
    const publicConfig = config.getPublicConfig();

    return res.json({
      success: true,
      withdrawal: publicConfig.withdrawal,
    });
  } catch (error) {
    console.error("[config route] withdrawal", error);

    return res.status(500).json({
      success: false,
      error: "WITHDRAWAL_CONFIG_LOAD_FAILED",
      message:
        "Could not load withdrawal configuration.",
    });
  }
});

module.exports = router;
