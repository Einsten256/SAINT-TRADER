/**
 * SAINT CRYPTO
 * FILE: services/telegram_recharge.js
 *
 * FINAL MOBILE MONEY RECHARGE APPROVAL BOT
 *
 * Destination:
 *   services/telegram_recharge.js
 *
 * Flow:
 *   USER ACCEPTS TERMS
 *        ↓
 *   USER SENDS MOBILE MONEY
 *        ↓
 *   USER SUBMITS AMOUNT + TRANSACTION ID
 *        ↓
 *   PENDING_ADMIN_REVIEW
 *        ↓
 *   TELEGRAM ADMIN
 *     APPROVE → locked trading capital credited
 *     REJECT  → no ledger credit
 *
 * No blockchain / USDT / TRON / Bybit recharge verification.
 */

"use strict";

const depositService = require("./deposit");

let TelegramBot = null;
let telegramPackageError = null;

try {
  const telegramModule =
    require("node-telegram-bot-api");

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
      .split(/[, \t\r\n]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function getChatId() {
  return (
    env("TELEGRAM_RECHARGE_CHAT_ID") ||
    env("TELEGRAM_ADMIN_CHAT_ID") ||
    env("TELEGRAM_CHAT_ID")
  );
}

function isConfigured() {
  return Boolean(
    env("TELEGRAM_BOT_TOKEN") &&
    getChatId()
  );
}

function isAdmin(userId) {
  if (!userId) {
    return false;
  }

  const admins = parseAdminIds();

  if (admins.size > 0) {
    return admins.has(String(userId));
  }

  /*
   * If TELEGRAM_ADMIN_IDS is not configured, do not silently
   * authorize arbitrary users. TELEGRAM_ADMIN_ID should be used
   * explicitly for a single-admin fallback.
   */
  const singleAdmin =
    env("TELEGRAM_ADMIN_ID");

  return Boolean(
    singleAdmin &&
    String(userId) === String(singleAdmin)
  );
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

function normalizeRechargeRecord(input) {
  /*
   * getRechargeForAdmin() returns:
   *   { success: true, recharge: {...} }
   *
   * submitRecharge()/other callers may pass the record itself.
   * Normalize both shapes so the Telegram layer never renders
   * undefined fields.
   */
  if (
    input &&
    input.recharge &&
    typeof input.recharge === "object"
  ) {
    return input.recharge;
  }

  return input || {};
}

function rechargeIdOf(recharge) {
  const record =
    normalizeRechargeRecord(recharge);

  return (
    record.rechargeId ||
    record.id ||
    record.depositId ||
    ""
  );
}

function rechargeText(input) {
  const recharge =
    normalizeRechargeRecord(input);

  const rechargeId =
    rechargeIdOf(recharge);

  const network =
    escapeHtml(
      recharge.network || "UNKNOWN"
    );

  const senderName =
    escapeHtml(
      recharge.senderName ||
      "Not supplied"
    );

  const transactionId =
    escapeHtml(
      recharge.transactionId ||
      recharge.txid ||
      "Not supplied"
    );

  const userId =
    escapeHtml(
      recharge.userId ||
      "Unknown"
    );

  const status =
    escapeHtml(
      recharge.status ||
      "UNKNOWN"
    );

  return [
    "💰 <b>SAINT CRYPTO RECHARGE</b>",
    "",
    `🆔 <b>ID:</b> <code>${escapeHtml(
      rechargeId || "UNKNOWN"
    )}</code>`,
    `👤 <b>User:</b> <code>${userId}</code>`,
    "",
    `💵 <b>Amount:</b> ${money(
      recharge.amountUgx ??
      recharge.amount
    )}`,
    `📱 <b>Network:</b> ${network}`,
    `👤 <b>Sender:</b> ${senderName}`,
    `🧾 <b>Transaction ID:</b> <code>${transactionId}</code>`,
    "",
    `📌 <b>Status:</b> ${status}`,
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
          callback_data:
            `dep_approve:${rechargeId}`,
        },
        {
          text: "❌ REJECT",
          callback_data:
            `dep_reject:${rechargeId}`,
        },
      ],
    ],
  };
}

async function sendRechargeForReview(
  rechargeInput
) {
  const recharge =
    normalizeRechargeRecord(
      rechargeInput
    );

  const rechargeId =
    rechargeIdOf(recharge);

  if (!rechargeId) {
    return {
      sent: false,
      reason: "RECHARGE_ID_MISSING",
    };
  }

  if (!bot || !getChatId()) {
    return {
      sent: false,
      reason: "TELEGRAM_NOT_CONFIGURED",
    };
  }

  const message =
    await bot.sendMessage(
      getChatId(),
      rechargeText(recharge),
      {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup:
          rechargeKeyboard(rechargeId),
      }
    );

  return {
    sent: true,
    messageId:
      message?.message_id || null,
    chatId: getChatId(),
    rechargeId,
  };
}

async function safeAnswerCallback(
  queryId,
  text,
  showAlert = false
) {
  try {
    if (bot && queryId) {
      await bot.answerCallbackQuery(
        queryId,
        {
          text: String(text || "").slice(
            0,
            200
          ),
          show_alert: showAlert,
        }
      );
    }
  } catch (error) {
    console.error(
      "[telegram recharge] callback answer failed:",
      error?.message || error
    );
  }
}

async function editRechargeMessage(
  chatId,
  messageId,
  text
) {
  if (!bot || !chatId || !messageId) {
    return;
  }

  try {
    await bot.editMessageText(
      text,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }
    );
  } catch (error) {
    /*
     * Telegram may return "message is not modified" if an
     * identical update is attempted. This is not a fatal error.
     */
    if (
      !String(
        error?.message || ""
      )
        .toLowerCase()
        .includes("message is not modified")
    ) {
      console.error(
        "[telegram recharge] message edit failed:",
        error?.message || error
      );
    }
  }
}

async function fetchAdminRecharge(
  rechargeId
) {
  if (
    !depositService ||
    typeof depositService.getRechargeForAdmin !==
      "function"
  ) {
    throw new Error(
      "Recharge admin lookup service is unavailable."
    );
  }

  const result =
    await depositService.getRechargeForAdmin(
      rechargeId
    );

  return normalizeRechargeRecord(
    result
  );
}

async function handleApprove(
  query,
  rechargeId
) {
  try {
    const recharge =
      await fetchAdminRecharge(
        rechargeId
      );

    if (!recharge?.rechargeId) {
      await safeAnswerCallback(
        query.id,
        "Recharge not found.",
        true
      );
      return;
    }

    if (
      recharge.status !==
      "PENDING_ADMIN_REVIEW"
    ) {
      await safeAnswerCallback(
        query.id,
        `Cannot approve: ${recharge.status || "UNKNOWN"}`,
        true
      );
      return;
    }

    const result =
      await depositService.approveRecharge(
        rechargeId,
        String(query.from?.id || "")
      );

    /*
     * Re-read the record after approval so the edited Telegram
     * message contains the real recharge details, not the small
     * service-result object.
     */
    let finalRecharge = recharge;

    try {
      finalRecharge =
        await fetchAdminRecharge(
          rechargeId
        );
    } catch (refreshError) {
      console.error(
        "[telegram recharge] post-approval refresh failed:",
        refreshError?.message || refreshError
      );
    }

    await safeAnswerCallback(
      query.id,
      result?.alreadyApproved
        ? "Recharge was already approved."
        : "Recharge approved. Locked trading capital credited."
    );

    if (bot && query.message) {
      const approvedText = [
        rechargeText(finalRecharge),
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
      error?.stack || error
    );

    await safeAnswerCallback(
      query.id,
      error?.message ||
        "Could not approve recharge.",
      true
    );
  }
}

async function handleReject(
  query,
  rechargeId
) {
  try {
    const recharge =
      await fetchAdminRecharge(
        rechargeId
      );

    if (!recharge?.rechargeId) {
      await safeAnswerCallback(
        query.id,
        "Recharge not found.",
        true
      );
      return;
    }

    if (
      recharge.status !==
      "PENDING_ADMIN_REVIEW"
    ) {
      await safeAnswerCallback(
        query.id,
        `Cannot reject: ${recharge.status || "UNKNOWN"}`,
        true
      );
      return;
    }

    const result =
      await depositService.rejectRecharge(
        rechargeId,
        String(query.from?.id || ""),
        "Rejected by Telegram admin."
      );

    let finalRecharge = recharge;

    try {
      finalRecharge =
        await fetchAdminRecharge(
          rechargeId
        );
    } catch (refreshError) {
      console.error(
        "[telegram recharge] post-rejection refresh failed:",
        refreshError?.message || refreshError
      );
    }

    await safeAnswerCallback(
      query.id,
      result?.alreadyRejected
        ? "Recharge was already rejected."
        : "Recharge rejected. No ledger credit was made."
    );

    if (bot && query.message) {
      const rejectedText = [
        rechargeText(finalRecharge),
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
      error?.stack || error
    );

    await safeAnswerCallback(
      query.id,
      error?.message ||
        "Could not reject recharge.",
      true
    );
  }
}

function registerHandlers() {
  if (!bot) {
    return;
  }

  bot.on(
    "callback_query",
    async (query) => {
      try {
        if (
          !isAdmin(query.from?.id)
        ) {
          await safeAnswerCallback(
            query.id,
            "You are not authorized for admin actions.",
            true
          );
          return;
        }

        const data =
          String(query.data || "");

        if (
          data.startsWith(
            "dep_approve:"
          )
        ) {
          const rechargeId =
            data.substring(
              "dep_approve:".length
            );

          if (!rechargeId) {
            await safeAnswerCallback(
              query.id,
              "Recharge ID is missing.",
              true
            );
            return;
          }

          await handleApprove(
            query,
            rechargeId
          );
          return;
        }

        if (
          data.startsWith(
            "dep_reject:"
          )
        ) {
          const rechargeId =
            data.substring(
              "dep_reject:".length
            );

          if (!rechargeId) {
            await safeAnswerCallback(
              query.id,
              "Recharge ID is missing.",
              true
            );
            return;
          }

          await handleReject(
            query,
            rechargeId
          );
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
          error?.stack || error
        );

        await safeAnswerCallback(
          query.id,
          "Recharge admin action failed.",
          true
        );
      }
    }
  );
}

async function startTelegramRechargeBot() {
  if (started) {
    return {
      started: true,
      alreadyRunning: true,
      polling,
      configured: isConfigured(),
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
      reason:
        "TELEGRAM_PACKAGE_INVALID",
      error:
        telegramPackageError?.message ||
        "node-telegram-bot-api constructor is unavailable.",
    };
  }

  const token =
    env("TELEGRAM_BOT_TOKEN");

  if (!token) {
    console.warn(
      "[telegram recharge] TELEGRAM_BOT_TOKEN is not configured."
    );

    return {
      started: false,
      reason:
        "TELEGRAM_BOT_TOKEN_MISSING",
    };
  }

  if (typeof TelegramBot !== "function") {
    return {
      started: false,
      reason:
        "TELEGRAM_CONSTRUCTOR_UNAVAILABLE",
    };
  }

  try {
    bot = new TelegramBot(
      token,
      {
        polling: true,
      }
    );

    console.log(
      "[telegram recharge] BOT DIAGNOSTIC:",
      JSON.stringify({
        constructor: bot?.constructor?.name || null,
        typeofBot: typeof bot,
        sendMessage: typeof bot?.sendMessage,
        on: typeof bot?.on,
        answerCallbackQuery: typeof bot?.answerCallbackQuery,
        editMessageText: typeof bot?.editMessageText,
      })
    );

    polling = true;
    started = true;

    registerHandlers();

    bot.on(
      "polling_error",
      (error) => {
        console.error(
          "[telegram recharge] polling error:",
          error?.message || error
        );
      }
    );

    bot.on(
      "error",
      (error) => {
        console.error(
          "[telegram recharge] bot error:",
          error?.message || error
        );
      }
    );

    console.log(
      "Telegram recharge approval bot started."
    );

    return {
      started: true,
      polling: true,
      configured: isConfigured(),
    };
  } catch (error) {
    bot = null;
    polling = false;
    started = false;

    console.error(
      "[telegram recharge] bot startup failed:",
      error?.stack || error
    );

    return {
      started: false,
      reason:
        "TELEGRAM_START_FAILED",
      error:
        error?.message ||
        "Unable to start Telegram recharge bot.",
    };
  }
}

async function stopTelegramRechargeBot() {
  const currentBot = bot;

  if (!currentBot) {
    started = false;
    polling = false;

    return {
      stopped: true,
      wasRunning: false,
      pollingStopped: false,
    };
  }

  let pollingStopped = false;

  try {
    if (typeof currentBot.stopPolling === "function") {
      await currentBot.stopPolling();
      pollingStopped = true;
    } else if (typeof currentBot.stop === "function") {
      await currentBot.stop();
      pollingStopped = true;
    }
  } catch (error) {
    const message = String(error?.message || error || "");

    // During a Render/SIGTERM shutdown, some Telegram wrappers expose the
    // polling client without a stopPolling method. The process itself is
    // already terminating, so do not turn graceful shutdown into a scary
    // error log. Report only unexpected cleanup failures.
    if (!/stopPolling.*not a function/i.test(message)) {
      console.warn(
        "[telegram recharge] graceful stop warning:",
        message
      );
    }
  }

  bot = null;
  started = false;
  polling = false;

  return {
    stopped: true,
    wasRunning: true,
    pollingStopped,
  };
}

async function notifyRechargeCreated(
  rechargeInput
) {
  try {
    const recharge =
      normalizeRechargeRecord(
        rechargeInput
      );

    return await sendRechargeForReview(
      recharge
    );
  } catch (error) {
    console.error(
      "[telegram recharge] notification failed:",
      error?.stack || error
    );

    return {
      sent: false,
      reason:
        "TELEGRAM_SEND_FAILED",
      error:
        error?.message ||
        "Telegram notification failed.",
    };
  }
}

function getStatus() {
  return {
    started,
    polling,
    configured: isConfigured(),
    hasBot: Boolean(bot),
    adminIdsConfigured:
      parseAdminIds().size > 0,
    chatIdConfigured:
      Boolean(getChatId()),
  };
}

module.exports = {
  startTelegramRechargeBot,
  stopTelegramRechargeBot,
  notifyRechargeCreated,
  sendRechargeForReview,
  getStatus,
};
