/**
 * SAINT CRYPTO
 * services/telegram_recharge.js
 *
 * Mobile Money recharge approval bot.
 *
 * Destination:
 * SAINT CRYPTO/services/telegram_recharge.js
 *
 * Flow:
 *   USER ACCEPTS RECHARGE TERMS
 *        ↓
 *   USER SENDS MOBILE MONEY MANUALLY
 *        ↓
 *   USER SUBMITS AMOUNT + TRANSACTION ID
 *        ↓
 *   PENDING_ADMIN_REVIEW
 *        ↓
 *   TELEGRAM ADMIN
 *      APPROVE → LOCKED TRADING CAPITAL CREDITED
 *      REJECT  → NO CREDIT
 *
 * No blockchain deposit verification is performed here.
 * Recharge verification is a manual Mobile Money admin decision.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   TELEGRAM_ADMIN_IDS=123,456
 */

"use strict";

const depositService = require("./deposit");

let TelegramBot = null;
let telegramPackageError = null;

/**
 * Resolve node-telegram-bot-api safely.
 *
 * Some Node/package configurations expose the constructor directly,
 * while others expose it through .default, .TelegramBot, or .Bot.
 *
 * The old code assumed require(...) itself was always the constructor,
 * which caused:
 *
 *     TelegramBot is not a constructor
 *
 * Keep the rest of the Telegram service unchanged and normalize the
 * package export here.
 */
try {
  const telegramModule = require("node-telegram-bot-api");

  const candidates = [
    telegramModule,
    telegramModule?.default,
    telegramModule?.TelegramBot,
    telegramModule?.Bot,
  ];

  TelegramBot =
    candidates.find(
      (candidate) =>
        typeof candidate === "function"
    ) || null;

  if (!TelegramBot) {
    telegramPackageError =
      new Error(
        "node-telegram-bot-api loaded, but no TelegramBot constructor was found."
      );
  }
} catch (error) {
  telegramPackageError = error;
  TelegramBot = null;
}

let bot = null;
let started = false;
let polling = false;

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null
    ? fallback
    : String(value).trim();
}

function parseAdminIds() {
  const raw =
    env("TELEGRAM_ADMIN_IDS") ||
    env("TELEGRAM_ADMIN_ID") ||
    "";

  return new Set(
    raw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function getChatId() {
  return env("TELEGRAM_CHAT_ID");
}

function isConfigured() {
  return Boolean(env("TELEGRAM_BOT_TOKEN") && getChatId());
}

function isAdmin(userId) {
  if (!userId) return false;

  const admins = parseAdminIds();

  if (admins.size > 0) {
    return admins.has(String(userId));
  }

  return String(userId) === String(getChatId());
}

function money(value) {
  const amount = Number(value || 0);

  return new Intl.NumberFormat("en-UG", {
    style: "currency",
    currency: "UGX",
    maximumFractionDigits: 0,
  }).format(amount);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rechargeText(recharge) {
  const network = escapeHtml(recharge.network || "UNKNOWN");
  const senderName = escapeHtml(
    recharge.senderName || "Not supplied"
  );
  const transactionId = escapeHtml(
    recharge.transactionId || "Not supplied"
  );

  return [
    "💰 <b>SAINT CRYPTO RECHARGE</b>",
    "",
    `🆔 <b>ID:</b> <code>${escapeHtml(recharge.id)}</code>`,
    `👤 <b>User:</b> <code>${escapeHtml(recharge.userId)}</code>`,
    "",
    `💵 <b>Amount:</b> ${money(recharge.amountUgx)}`,
    `📱 <b>Network:</b> ${network}`,
    `👤 <b>Sender:</b> ${senderName}`,
    `🧾 <b>Transaction ID:</b> <code>${transactionId}</code>`,
    "",
    `📌 <b>Status:</b> ${escapeHtml(recharge.status)}`,
    `📜 <b>Terms accepted:</b> ${
      recharge.termsAccepted ? "YES" : "NO"
    }`,
    "",
    "⚠️ Verify the Mobile Money transaction before approving.",
    "Approval credits the amount to <b>locked trading capital</b>.",
  ].join("\n");
}

function rechargeKeyboard(rechargeId) {
  return {
    inline_keyboard: [
      [
        {
          text: "✅ APPROVE RECHARGE",
          callback_data: `dep_approve:${rechargeId}`,
        },
        {
          text: "❌ REJECT",
          callback_data: `dep_reject:${rechargeId}`,
        },
      ],
    ],
  };
}

async function sendRechargeForReview(recharge) {
  if (!bot || !getChatId()) {
    return {
      sent: false,
      reason: "TELEGRAM_NOT_CONFIGURED",
    };
  }

  const message = await bot.sendMessage(
    getChatId(),
    rechargeText(recharge),
    {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: rechargeKeyboard(recharge.id),
    }
  );

  return {
    sent: true,
    messageId: message?.message_id || null,
    chatId: getChatId(),
  };
}

async function safeAnswerCallback(queryId, text, showAlert = false) {
  try {
    if (bot && queryId) {
      await bot.answerCallbackQuery(queryId, {
        text,
        show_alert: showAlert,
      });
    }
  } catch (error) {
    console.error(
      "[telegram recharge] callback answer failed:",
      error.message
    );
  }
}

async function editRechargeMessage(
  chatId,
  messageId,
  text
) {
  if (!bot || !chatId || !messageId) return;

  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.error(
      "[telegram recharge] message edit failed:",
      error.message
    );
  }
}

async function handleApprove(query, rechargeId) {
  const recharge =
    await depositService.getRechargeForAdmin(rechargeId);

  if (!recharge) {
    await safeAnswerCallback(
      query.id,
      "Recharge not found.",
      true
    );
    return;
  }

  if (recharge.status !== "PENDING_ADMIN_REVIEW") {
    await safeAnswerCallback(
      query.id,
      `Cannot approve: ${recharge.status}`,
      true
    );
    return;
  }

  try {
    const result =
      await depositService.approveRecharge(
        rechargeId,
        {
          adminTelegramId: String(query.from.id),
        }
      );

    await safeAnswerCallback(
      query.id,
      "Recharge approved. Locked trading capital credited."
    );

    if (bot && query.message) {
      const approvedText = [
        rechargeText(result),
        "",
        "🟢 <b>APPROVED</b>",
        "Locked trading capital has been credited to the user's ledger.",
      ].join("\n");

      await editRechargeMessage(
        query.message.chat.id,
        query.message.message_id,
        approvedText
      );
    }
  } catch (error) {
    console.error(
      "[telegram recharge] approval failed:",
      error
    );

    await safeAnswerCallback(
      query.id,
      error?.message || "Could not approve recharge.",
      true
    );
  }
}

async function handleReject(query, rechargeId) {
  const recharge =
    await depositService.getRechargeForAdmin(rechargeId);

  if (!recharge) {
    await safeAnswerCallback(
      query.id,
      "Recharge not found.",
      true
    );
    return;
  }

  if (recharge.status !== "PENDING_ADMIN_REVIEW") {
    await safeAnswerCallback(
      query.id,
      `Cannot reject: ${recharge.status}`,
      true
    );
    return;
  }

  try {
    const result =
      await depositService.rejectRecharge(
        rechargeId,
        "Rejected by Telegram admin."
      );

    await safeAnswerCallback(
      query.id,
      "Recharge rejected. No ledger credit was made."
    );

    if (bot && query.message) {
      const rejectedText = [
        rechargeText(result),
        "",
        "🔴 <b>REJECTED</b>",
        "No locked trading capital was credited.",
      ].join("\n");

      await editRechargeMessage(
        query.message.chat.id,
        query.message.message_id,
        rejectedText
      );
    }
  } catch (error) {
    console.error(
      "[telegram recharge] rejection failed:",
      error
    );

    await safeAnswerCallback(
      query.id,
      error?.message || "Could not reject recharge.",
      true
    );
  }
}

function registerHandlers() {
  if (!bot) return;

  bot.on("callback_query", async (query) => {
    try {
      if (!isAdmin(query.from?.id)) {
        await safeAnswerCallback(
          query.id,
          "You are not authorized for admin actions.",
          true
        );
        return;
      }

      const data = String(query.data || "");

      if (data.startsWith("dep_approve:")) {
        const rechargeId =
          data.substring("dep_approve:".length);

        await handleApprove(query, rechargeId);
        return;
      }

      if (data.startsWith("dep_reject:")) {
        const rechargeId =
          data.substring("dep_reject:".length);

        await handleReject(query, rechargeId);
        return;
      }

      await safeAnswerCallback(
        query.id,
        "Unknown recharge action.",
        true
      );
    } catch (error) {
      console.error(
        "[telegram recharge] callback handler error:",
        error
      );

      await safeAnswerCallback(
        query.id,
        "Recharge admin action failed.",
        true
      );
    }
  });
}

async function startTelegramRechargeBot() {
  if (started) {
    return {
      started: true,
      alreadyRunning: true,
    };
  }

  if (!TelegramBot) {
    console.error(
      "[telegram recharge] Telegram package could not be initialized:",
      telegramPackageError?.message ||
        "Unknown Telegram package error."
    );

    return {
      started: false,
      reason: "TELEGRAM_PACKAGE_INVALID",
      error:
        telegramPackageError?.message ||
        "node-telegram-bot-api constructor is unavailable.",
    };
  }

  const token = env("TELEGRAM_BOT_TOKEN");

  if (!token) {
    console.warn(
      "[telegram recharge] TELEGRAM_BOT_TOKEN is not configured."
    );

    return {
      started: false,
      reason: "TELEGRAM_BOT_TOKEN_MISSING",
    };
  }

  if (typeof TelegramBot !== "function") {
    throw new Error(
      "Telegram bot constructor is unavailable."
    );
  }

  bot = new TelegramBot(token, {
    polling: true,
  });

  polling = true;
  started = true;

  registerHandlers();

  bot.on("polling_error", (error) => {
    console.error(
      "[telegram recharge] polling error:",
      error?.message || error
    );
  });

  bot.on("error", (error) => {
    console.error(
      "[telegram recharge] bot error:",
      error?.message || error
    );
  });

  console.log("Telegram recharge approval bot started.");

  return {
    started: true,
    polling: true,
    configured: isConfigured(),
  };
}

async function stopTelegramRechargeBot() {
  if (!bot) {
    started = false;
    polling = false;

    return {
      stopped: true,
      wasRunning: false,
    };
  }

  try {
    await bot.stopPolling();
  } catch (error) {
    console.error(
      "[telegram recharge] stop polling failed:",
      error.message
    );
  }

  bot = null;
  started = false;
  polling = false;

  return {
    stopped: true,
    wasRunning: true,
  };
}

async function notifyRechargeCreated(recharge) {
  try {
    return await sendRechargeForReview(recharge);
  } catch (error) {
    console.error(
      "[telegram recharge] notification failed:",
      error
    );

    return {
      sent: false,
      reason: "TELEGRAM_SEND_FAILED",
      error: error.message,
    };
  }
}

function getStatus() {
  return {
    started,
    polling,
    configured: isConfigured(),
    hasBot: Boolean(bot),
    adminIdsConfigured: parseAdminIds().size > 0,
    chatIdConfigured: Boolean(getChatId()),
  };
}

module.exports = {
  startTelegramRechargeBot,
  stopTelegramRechargeBot,
  notifyRechargeCreated,
  sendRechargeForReview,
  getStatus,
};
