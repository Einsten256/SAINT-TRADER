// ============================================================
// SAINT CRYPTO — AUTH / FUND PIN ROUTES
// ============================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const { FieldValue } = require("firebase-admin/firestore");

// ============================================================
// ROUTER FACTORY
// ============================================================

function createRouter({
  firestore,
  verifyAuth,
  strictLimiter,
}) {
  const router = express.Router();

  // ==========================================================
  // HELPERS
  // ==========================================================

  function getUserRef(userId) {
    return firestore.collection("users").doc(userId);
  }

  function validatePin(pin) {
    return /^\d{6}$/.test(String(pin || ""));
  }

  // ==========================================================
  // SET FUND PIN
  // ==========================================================

  router.post(
    "/api/user/set-fund-password",
    strictLimiter,
    verifyAuth,
    async (req, res) => {
      try {
        const { newPassword } = req.body || {};
        const userId = req.uid;

        if (!validatePin(newPassword)) {
          return res.status(400).json({
            success: false,
            message: "Fund PIN must contain exactly 6 digits.",
          });
        }

        const userRef = getUserRef(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
          return res.status(404).json({
            success: false,
            message: "Your account record could not be found.",
          });
        }

        const user = userDoc.data() || {};

        if (user.fundPasswordHash) {
          return res.status(400).json({
            success: false,
            message:
              "A Fund PIN already exists. Please use Change Fund PIN.",
          });
        }

        const fundPasswordHash = await bcrypt.hash(
          String(newPassword),
          12
        );

        await userRef.update({
          fundPasswordHash,
          hasFundPassword: true,
          fundPasswordUpdatedAt:
            FieldValue.serverTimestamp(),
        });

        return res.status(200).json({
          success: true,
          message: "Fund PIN created successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Set Fund PIN error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to create Fund PIN. Please try again.",
        });
      }
    }
  );

  // ==========================================================
  // CHANGE FUND PIN
  // ==========================================================

  router.post(
    "/api/user/update-fund-password",
    strictLimiter,
    verifyAuth,
    async (req, res) => {
      try {
        const {
          oldPassword,
          newPassword,
        } = req.body || {};

        const userId = req.uid;

        if (!validatePin(oldPassword)) {
          return res.status(400).json({
            success: false,
            message:
              "Current Fund PIN must contain exactly 6 digits.",
          });
        }

        if (!validatePin(newPassword)) {
          return res.status(400).json({
            success: false,
            message:
              "New Fund PIN must contain exactly 6 digits.",
          });
        }

        const userRef = getUserRef(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
          return res.status(404).json({
            success: false,
            message:
              "Your account record could not be found.",
          });
        }

        const user = userDoc.data() || {};

        if (!user.fundPasswordHash) {
          return res.status(400).json({
            success: false,
            message:
              "You have not created a Fund PIN yet. Please create one first.",
          });
        }

        const valid = await bcrypt.compare(
          String(oldPassword),
          user.fundPasswordHash
        );

        if (!valid) {
          return res.status(400).json({
            success: false,
            message:
              "Incorrect current Fund PIN.",
          });
        }

        const fundPasswordHash = await bcrypt.hash(
          String(newPassword),
          12
        );

        await userRef.update({
          fundPasswordHash,
          hasFundPassword: true,
          fundPasswordUpdatedAt:
            FieldValue.serverTimestamp(),
        });

        return res.status(200).json({
          success: true,
          message: "Fund PIN changed successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Change Fund PIN error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to change Fund PIN. Please try again.",
        });
      }
    }
  );

  // ==========================================================
  // RESET / RECOVER FUND PIN
  //
  // Flutter re-authenticates the user's LOGIN password
  // before calling this endpoint.
  // ==========================================================

  router.post(
    "/api/user/reset-fund-password",
    strictLimiter,
    verifyAuth,
    async (req, res) => {
      try {
        const { newPassword } = req.body || {};
        const userId = req.uid;

        if (!validatePin(newPassword)) {
          return res.status(400).json({
            success: false,
            message:
              "Fund PIN must contain exactly 6 digits.",
          });
        }

        const userRef = getUserRef(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
          return res.status(404).json({
            success: false,
            message:
              "Your account record could not be found.",
          });
        }

        const fundPasswordHash = await bcrypt.hash(
          String(newPassword),
          12
        );

        await userRef.update({
          fundPasswordHash,
          hasFundPassword: true,
          fundPasswordUpdatedAt:
            FieldValue.serverTimestamp(),
        });

        return res.status(200).json({
          success: true,
          message:
            "Fund PIN reset successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Reset Fund PIN error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to reset Fund PIN. Please try again.",
        });
      }
    }
  );

  // ==========================================================
  // LEGACY FUND PIN UPDATE
  //
  // Kept for compatibility with older Flutter builds.
  // ==========================================================

  router.post(
    "/api/users/fund-password",
    strictLimiter,
    verifyAuth,
    async (req, res) => {
      try {
        const {
          oldPassword,
          newPassword,
        } = req.body || {};

        const userId = req.uid;

        if (!validatePin(oldPassword)) {
          return res.status(400).json({
            success: false,
            message:
              "Current Fund PIN must contain exactly 6 digits.",
          });
        }

        if (!validatePin(newPassword)) {
          return res.status(400).json({
            success: false,
            message:
              "New Fund PIN must contain exactly 6 digits.",
          });
        }

        const userRef = getUserRef(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
          return res.status(404).json({
            success: false,
            message:
              "Your account record could not be found.",
          });
        }

        const user = userDoc.data() || {};

        if (!user.fundPasswordHash) {
          return res.status(400).json({
            success: false,
            message:
              "You have not created a Fund PIN yet.",
          });
        }

        const valid = await bcrypt.compare(
          String(oldPassword),
          user.fundPasswordHash
        );

        if (!valid) {
          return res.status(400).json({
            success: false,
            message:
              "Incorrect current Fund PIN.",
          });
        }

        const fundPasswordHash = await bcrypt.hash(
          String(newPassword),
          12
        );

        await userRef.update({
          fundPasswordHash,
          hasFundPassword: true,
          fundPasswordUpdatedAt:
            FieldValue.serverTimestamp(),
        });

        return res.status(200).json({
          success: true,
          message:
            "Fund PIN changed successfully.",
        });
      } catch (error) {
        console.error(
          "❌ Legacy Fund PIN update error:",
          error
        );

        return res.status(500).json({
          success: false,
          message:
            "Unable to update Fund PIN.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createRouter,
};