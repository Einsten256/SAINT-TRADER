"use strict";

// ============================================================
// SAINT CRYPTO — TELEGRAM WITHDRAWAL APPROVAL
//
// Uses the EXISTING TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
// No new bot is required.
//
// Visible workflow:
// UNDER REVIEW -> Telegram APPROVE -> PROCESSING -> DISBURSED/FAILED
//
// This module uses Telegram long polling so it works locally
// without requiring a public webhook URL.
// ============================================================

require("dotenv").config();

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const withdrawalService =
  require("./withdrawal");

const TELEGRAM_BOT_TOKEN =
  String(
    process.env.TELEGRAM_BOT_TOKEN || ""
  ).trim();

const TELEGRAM_CHAT_ID =
  String(
    process.env.TELEGRAM_CHAT_ID || ""
  ).trim();

const configuredAdmins =
  String(
    process.env.TELEGRAM_ADMIN_IDS ||
      ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const ADMIN_IDS =
  configuredAdmins.length > 0
    ? new Set(configuredAdmins)
    : new Set(
        TELEGRAM_CHAT_ID &&
        !TELEGRAM_CHAT_ID.startsWith("-")
          ? [TELEGRAM_CHAT_ID]
          : []
      );

let pollingStarted = false;
let pollingLoopRunning = false;
let updateOffset = 0;

function isConfigured() {
  return Boolean(
    TELEGRAM_BOT_TOKEN &&
    TELEGRAM_CHAT_ID
  );
}

function isAuthorizedAdmin(userId) {
  return ADMIN_IDS.has(
    String(userId || "")
  );
}

async function telegramApi(
  method,
  payload = {}
) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured."
    );
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

  const response =
    await fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify(payload),
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.ok !== true
  ) {
    throw new Error(
      data.description ||
        `Telegram API ${method} failed.`
    );
  }

  return data.result;
}

function money(value) {
  const number =
    Number(value || 0);

  return Number.isFinite(number)
    ? number.toFixed(2)
    : "0.00";
}

function escapeMarkdown(value) {
  return String(value || "")
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// MarkdownV2 code spans only require backslash and backtick escaping.
// Do NOT escape periods, hyphens, etc. inside code spans.
function escapeCode(value) {
  return String(value ?? "")
    .replace(/([\\`])/g, "\\$1");
}

async function notifyWithdrawalUnderReview(
  withdrawalId
) {
  if (!isConfigured()) {
    console.error(
      "[TELEGRAM] Withdrawal approval is not configured."
    );
    return false;
  }

  const db =
    getFirestore();

  const ref =
    db.collection("withdrawals")
      .doc(withdrawalId);

  const snapshot =
    await ref.get();

  if (!snapshot.exists) {
    throw new Error(
      "Withdrawal record not found."
    );
  }

  const data =
    snapshot.data() || {};

  if (
    String(data.status || "").toUpperCase() !==
    "UNDER_REVIEW"
  ) {
    return false;
  }

  const text =
    [
      "🚨 *NEW WITHDRAWAL*",
      "",
      `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
      `👤 *User ID:* \`${escapeCode(data.userId)}\``,
      "",
      `💵 *Gross Amount:* \`${money(data.grossAmount)} USDT\``,
      `💳 *Charge Fee:* \`${money(data.feeDeducted)} USDT\``,
      `💰 *Net Payout:* \`${money(data.netPayout)} USDT\``,
      "",
      `🌐 *Network:* \`${escapeCode(data.destinationNetwork || "TRC20")}\``,
      `🏦 *Coin:* \`${escapeCode(data.coin || "USDT")}\``,
      `📬 *Wallet:* \`${escapeCode(data.destinationAddress)}\``,
      "",
      "🔴 *Status: UNDER REVIEW*",
      "",
      escapeMarkdown("Review this withdrawal before the user can confirm it."),
    ].join("\n");

  const result =
    await telegramApi(
      "sendMessage",
      {
        chat_id:
          TELEGRAM_CHAT_ID,

        text,

        parse_mode:
          "MarkdownV2",

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "✅ APPROVE",
                callback_data:
                  `withdrawal:approve:${withdrawalId}`,
              },
            ],
          ],
        },
      }
    );

  await ref.set(
    {
      telegramMessageId:
        result.message_id,

      telegramChatId:
        TELEGRAM_CHAT_ID,

      telegramNotifiedAt:
        FieldValue.serverTimestamp(),

      updatedAt:
        FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(
    `[TELEGRAM] Withdrawal ${withdrawalId} sent for admin review.`
  );

  return true;
}

async function approveWithdrawal(
  withdrawalId,
  telegramUser
) {
  if (!isAuthorizedAdmin(telegramUser?.id)) {
    throw new Error(
      "You are not authorized to approve withdrawals."
    );
  }

  if (
    !withdrawalService ||
    typeof withdrawalService.approveAndSubmitWithdrawal !==
      "function"
  ) {
    throw new Error(
      "Withdrawal approval service is unavailable."
    );
  }

  return withdrawalService.approveAndSubmitWithdrawal(
    withdrawalId,
    telegramUser
  );
}

async function handleCallbackQuery(
  callbackQuery
) {
  const callbackId =
    callbackQuery?.id;

  const from =
    callbackQuery?.from || {};

  const data =
    String(
      callbackQuery?.data || ""
    );

  console.log(
    `[TELEGRAM] Callback received: user=${String(from.id || "unknown")} data=${data}`
  );

  if (
    !data.startsWith(
      "withdrawal:approve:"
    )
  ) {
    if (callbackId) {
      await telegramApi(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackId,
          text:
            "Unknown approval action.",
          show_alert: true,
        }
      );
    }
    return;
  }

  const withdrawalId =
    data.substring(
      "withdrawal:approve:".length
    ).trim();

  // Acknowledge Telegram immediately. Do not wait for Firestore.
  // This prevents "query is too old" while keeping the withdrawal
  // UNDER REVIEW until approveWithdrawal() actually succeeds.
  if (callbackId) {
    try {
      await telegramApi(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackId,
          text:
            "Approval received. Processing...",
        }
      );
    } catch (callbackError) {
      console.warn(
        "[TELEGRAM] Could not acknowledge callback:",
        callbackError.message
      );
    }
  }

  try {
    if (
      !isAuthorizedAdmin(from.id)
    ) {
      throw new Error(
        "You are not authorized to approve withdrawals."
      );
    }

    // Admin approval immediately starts the Bybit payout.
    // There is no second user confirmation.
    await approveWithdrawal(
      withdrawalId,
      from
    );

    const db =
      getFirestore();

    const ref =
      db.collection("withdrawals")
        .doc(withdrawalId);

    const snapshot =
      await ref.get();

    const record =
      snapshot.exists
        ? snapshot.data() || {}
        : {};

    const originalMessage =
      callbackQuery.message;

    const processingText =
      [
        "🟠 *WITHDRAWAL PROCESSING*",
        "",
        `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
        `👤 *User ID:* \`${escapeCode(record.userId)}\``,
        "",
        `💵 *Gross Amount:* \`${money(record.grossAmount)} USDT\``,
        `💳 *Charge Fee:* \`${money(record.feeDeducted)} USDT\``,
        `💰 *Net Payout:* \`${money(record.netPayout)} USDT\``,
        "",
        `🌐 *Network:* \`${escapeCode(record.destinationNetwork || "TRC20")}\``,
        `📬 *Wallet:* \`${escapeCode(record.destinationAddress)}\``,
        "",
        "🟠 *Status: PROCESSING*",
      ].join("\\n");

    if (
      originalMessage?.chat?.id &&
      originalMessage?.message_id
    ) {
      try {
        await telegramApi(
          "editMessageText",
          {
            chat_id:
              originalMessage.chat.id,
            message_id:
              originalMessage.message_id,
            text:
              processingText,
            parse_mode:
              "MarkdownV2",
            reply_markup: {
              inline_keyboard: [],
            },
          }
        );
      } catch (editError) {
        console.warn(
          "[TELEGRAM] Could not edit approval message:",
          editError.message
        );
      }
    }

  } catch (error) {
    console.error(
      `[TELEGRAM] Approval failed for ${withdrawalId}:`,
      error.message
    );

    if (callbackId) {
      await telegramApi(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackId,
          text:
            error.message ||
            "Approval failed.",
          show_alert: true,
        }
      );
    }
  }
}

async function pollingLoop() {
  if (
    pollingLoopRunning
  ) {
    return;
  }

  pollingLoopRunning = true;

  while (
    pollingStarted
  ) {
    try {
      const updates =
        await telegramApi(
          "getUpdates",
          {
            offset:
              updateOffset,
            timeout:
              20,
            allowed_updates: [
              "callback_query",
            ],
          }
        );

      for (
        const update of
          updates || []
      ) {
        updateOffset =
          Number(update.update_id) + 1;

        if (
          update.callback_query
        ) {
          // Do not block Telegram polling on one approval.
          // Multiple approvals can be processed independently.
          handleCallbackQuery(
            update.callback_query
          ).catch((error) => {
            console.error(
              "[TELEGRAM] Callback processing error:",
              error.message
            );
          });
        }
      }
    } catch (error) {
      console.error(
        "[TELEGRAM] Withdrawal polling error:",
        error.message
      );

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 3000)
      );
    }
  }

  pollingLoopRunning = false;
}

async function prepareTelegramPolling() {
  try {
    await telegramApi("deleteWebhook", {
      drop_pending_updates: false,
    });
    console.log("📡 Telegram webhook cleared; callback polling enabled.");
  } catch (error) {
    console.error("[TELEGRAM] Could not clear webhook:", error.message);
  }

  try {
    const me = await telegramApi("getMe", {});
    console.log(`[TELEGRAM] Bot connection OK: @${me?.username || "unknown"}`);
  } catch (error) {
    console.error("[TELEGRAM] Bot connection test failed:", error.message);
  }
}

// ============================================================
// RECOVER PENDING WITHDRAWALS ON NODE STARTUP
//
// Reconnect existing unfinished admin-review records to Telegram
// without creating duplicate messages when the Node process restarts.
//
// Only these user-facing review states are pushed:
//   UNDER_REVIEW -> APPROVE button
//   AUDITED      -> informational audited message
//
// RESERVED/PROCESSING are NOT pushed as new approvals because they
// may represent older/test records that need separate reconciliation.
// ============================================================

function buildUnderReviewText(withdrawalId, data) {
  return [
    "🚨 *NEW WITHDRAWAL*",
    "",
    `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
    `👤 *User ID:* \`${escapeCode(data.userId)}\``,
    "",
    `💵 *Gross Amount:* \`${money(data.grossAmount)} USDT\``,
    `💳 *Charge Fee:* \`${money(data.feeDeducted)} USDT\``,
    `💰 *Net Payout:* \`${money(data.netPayout)} USDT\``,
    "",
    `🌐 *Network:* \`${escapeCode(data.destinationNetwork || "TRC20")}\``,
    `🏦 *Coin:* \`${escapeCode(data.coin || "USDT")}\``,
    `📬 *Wallet:* \`${escapeCode(data.destinationAddress)}\``,
    "",
    "🔴 *Status: UNDER REVIEW*",
    "",
    escapeMarkdown("Review this withdrawal before the user can confirm it."),
  ].join("\n");
}

function buildAuditedText(withdrawalId, data) {
  return [
    "🟠 *WITHDRAWAL AUDITED*",
    "",
    `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
    `👤 *User ID:* \`${escapeCode(data.userId)}\``,
    "",
    `💵 *Gross Amount:* \`${money(data.grossAmount)} USDT\``,
    `💳 *Charge Fee:* \`${money(data.feeDeducted)} USDT\``,
    `💰 *Net Payout:* \`${money(data.netPayout)} USDT\``,
    "",
    `🌐 *Network:* \`${escapeCode(data.destinationNetwork || "TRC20")}\``,
    `📬 *Wallet:* \`${escapeCode(data.destinationAddress)}\``,
    "",
    "🟠 *Status: AUDITED*",
    "",
    escapeMarkdown("The user may now confirm the withdrawal in the Saint Crypto app."),
  ].join("\n");
}

async function sendAuditedRecoveryMessage(withdrawalId, data, ref) {
  const result = await telegramApi("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: buildAuditedText(withdrawalId, data),
    parse_mode: "MarkdownV2",
  });

  await ref.set(
    {
      telegramMessageId: result.message_id,
      telegramChatId: TELEGRAM_CHAT_ID,
      telegramNotifiedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  console.log(
    `[TELEGRAM] Recovered AUDITED withdrawal ${withdrawalId} on startup.`
  );
}

async function recoverPendingWithdrawalsToTelegram() {
  if (!isConfigured()) {
    return;
  }

  const db = getFirestore();

  const snapshot = await db
    .collection("withdrawals")
    .where("status", "in", ["UNDER_REVIEW", "AUDITED"])
    .limit(100)
    .get();

  if (snapshot.empty) {
    console.log("[TELEGRAM] Startup recovery: no unfinished review withdrawals.");
    return;
  }

  let recovered = 0;

  for (const doc of snapshot.docs) {
    const withdrawalId = doc.id;
    const data = doc.data() || {};
    const status = String(data.status || "").toUpperCase();
    const ref = doc.ref;

    try {
      const existingMessageId = Number(data.telegramMessageId || 0);
      const existingChatId = data.telegramChatId || TELEGRAM_CHAT_ID;

      if (status === "UNDER_REVIEW") {
        const text = buildUnderReviewText(withdrawalId, data);

        if (existingMessageId > 0 && existingChatId) {
          try {
            await telegramApi("editMessageText", {
              chat_id: existingChatId,
              message_id: existingMessageId,
              text,
              parse_mode: "MarkdownV2",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✅ APPROVE",
                      callback_data: `withdrawal:approve:${withdrawalId}`,
                    },
                  ],
                ],
              },
            });

            console.log(
              `[TELEGRAM] Reconnected UNDER REVIEW withdrawal ${withdrawalId} on startup.`
            );
          } catch (editError) {
            // If the old Telegram message was deleted/expired, create a
            // fresh one and replace the stored message reference.
            const result = await telegramApi("sendMessage", {
              chat_id: TELEGRAM_CHAT_ID,
              text,
              parse_mode: "MarkdownV2",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "✅ APPROVE",
                      callback_data: `withdrawal:approve:${withdrawalId}`,
                    },
                  ],
                ],
              },
            });

            await ref.set(
              {
                telegramMessageId: result.message_id,
                telegramChatId: TELEGRAM_CHAT_ID,
                telegramNotifiedAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            console.log(
              `[TELEGRAM] Re-sent UNDER REVIEW withdrawal ${withdrawalId} on startup.`
            );
          }
        } else {
          await notifyWithdrawalUnderReview(withdrawalId);
        }

        recovered++;
      } else if (status === "AUDITED") {
        if (existingMessageId > 0 && existingChatId) {
          try {
            await telegramApi("editMessageText", {
              chat_id: existingChatId,
              message_id: existingMessageId,
              text: buildAuditedText(withdrawalId, data),
              parse_mode: "MarkdownV2",
              reply_markup: {
                inline_keyboard: [],
              },
            });

            console.log(
              `[TELEGRAM] Reconnected AUDITED withdrawal ${withdrawalId} on startup.`
            );
          } catch (editError) {
            await sendAuditedRecoveryMessage(withdrawalId, data, ref);
          }
        } else {
          await sendAuditedRecoveryMessage(withdrawalId, data, ref);
        }

        recovered++;
      }
    } catch (error) {
      // One bad record must never stop recovery of the others.
      console.error(
        `[TELEGRAM] Startup recovery failed for ${withdrawalId}:`,
        error.message
      );
    }
  }

  console.log(
    `[TELEGRAM] Startup recovery complete: ${recovered} unfinished review withdrawal(s) checked.`
  );
}



function startTelegramWithdrawalApproval() {
  if (
    pollingStarted
  ) {
    return false;
  }

  if (!isConfigured()) {
    console.warn(
      "[TELEGRAM] Withdrawal approval not started: Telegram is not configured."
    );
    return false;
  }

  pollingStarted = true;

  console.log(
    `📱 Telegram withdrawal approval: READY (admins=${[...ADMIN_IDS].join(",") || "NONE"})`
  );

  prepareTelegramPolling()
    .then(async () => {
      try {
        await recoverPendingWithdrawalsToTelegram();
      } catch (error) {
        console.error(
          "[TELEGRAM] Startup withdrawal recovery failed:",
          error.message
        );
      }

      return pollingLoop();
    })
    .catch((error) => {
      console.error(
        "[TELEGRAM] Approval polling stopped:",
        error.message
      );
    });

  return true;
}

function stopTelegramWithdrawalApproval() {
  pollingStarted = false;
}

module.exports = {
  isConfigured,
  notifyWithdrawalUnderReview,
  recoverPendingWithdrawalsToTelegram,
  approveWithdrawal,
  startTelegramWithdrawalApproval,
  stopTelegramWithdrawalApproval,
};
