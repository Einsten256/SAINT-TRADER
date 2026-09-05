"use strict";

// ============================================================
// SAINT CRYPTO — TELEGRAM WITHDRAWAL APPROVAL
//
// Uses the EXISTING TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
// No new bot is required.
//
// Visible workflow:
// UNDER REVIEW -> Telegram APPROVE -> AWAITING PAYMENT -> TXID SUBMITTED -> COMPLETED/FAILED
// Admin manually sends the net payout. This module never sends withdrawals to Bybit.
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

// Admin -> withdrawal awaiting a TXID reply.
const pendingTxidEntry = new Map();

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
    .replace(/([\`])/g, "\\$1");
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
              {
                text:
                  "❌ REJECT",
                callback_data:
                  `withdrawal:reject:${withdrawalId}`,
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

async function rejectWithdrawal(
  withdrawalId,
  telegramUser
) {
  if (!isAuthorizedAdmin(telegramUser?.id)) {
    throw new Error(
      "You are not authorized to reject withdrawals."
    );
  }

  if (
    !withdrawalService ||
    typeof withdrawalService.restoreWithdrawal !==
      "function"
  ) {
    throw new Error(
      "Withdrawal rejection service is unavailable."
    );
  }

  const db = getFirestore();
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

  const status =
    String(data.status || "").toUpperCase();

  if (
    status !== "UNDER_REVIEW" &&
    status !== "AWAITING_PAYMENT"
  ) {
    throw new Error(
      `This withdrawal is already ${status || "UNKNOWN"}.`
    );
  }

  await withdrawalService.restoreWithdrawal(
    withdrawalId,
    "Rejected by Telegram administrator."
  );

  for (const [adminId, pendingId] of pendingTxidEntry.entries()) {
    if (pendingId === withdrawalId) {
      pendingTxidEntry.delete(adminId);
    }
  }

  return data;
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

  const isApprove =
    data.startsWith(
      "withdrawal:approve:"
    );

  const isReject =
    data.startsWith(
      "withdrawal:reject:"
    );

  if (!isApprove && !isReject) {
    if (callbackId) {
      await telegramApi(
        "answerCallbackQuery",
        {
          callback_query_id:
            callbackId,
          text:
            "Unknown withdrawal action.",
          show_alert: true,
        }
      );
    }
    return;
  }

  const actionPrefix =
    isApprove
      ? "withdrawal:approve:"
      : "withdrawal:reject:";

  const withdrawalId =
    data.substring(
      actionPrefix.length
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
            isApprove
              ? "Approval received."
              : isReject
                ? "Rejection received."
                : "TXID entry requested.",
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

    if (isApprove) {
      // Approval only authorizes manual payout.
      // It NEVER sends a withdrawal to Bybit.
      await approveWithdrawal(
        withdrawalId,
        from
      );
    } else if (isReject) {
      await rejectWithdrawal(
        withdrawalId,
        from
      );
    } else {
      const db = getFirestore();
      const ref =
        db.collection("withdrawals")
          .doc(withdrawalId);

      const snapshot =
        await ref.get();

      if (!snapshot.exists) {
        throw new Error("Withdrawal record not found.");
      }

      const record =
        snapshot.data() || {};

      const status =
        String(record.status || "").toUpperCase();

      if (status !== "AWAITING_PAYMENT") {
        throw new Error(
          `This withdrawal is ${status || "UNKNOWN"} and is not awaiting payment.`
        );
      }

      pendingTxidEntry.set(
        String(from.id),
        withdrawalId
      );

      await telegramApi(
        "sendMessage",
        {
          chat_id:
            callbackQuery?.message?.chat?.id ||
            TELEGRAM_CHAT_ID,
          text: [
            "📋 *ENTER PAYMENT TXID*",
            "",
            `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
            `💰 *Send:* \`${money(record.netPayout)} USDT\``,
            `🌐 *Network:* \`${escapeCode(record.destinationNetwork || "TRC20")}\``,
            "",
            escapeMarkdown(
              "Reply to this message with the TXID after you manually send the USDT."
            ),
          ].join("\n"),
          parse_mode: "MarkdownV2",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "Paste the transaction TXID"
          }
        }
      );

      return;
    }

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
      isApprove
        ? [
            "🟠 *PAYMENT REQUIRED*",
            "",
            `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
            `👤 *User ID:* \`${escapeCode(record.userId)}\``,
            "",
            `💵 *Gross Amount:* \`${money(record.grossAmount)} USDT\``,
            `💳 *Charge Fee:* \`${money(record.feeDeducted)} USDT\``,
            `💰 *SEND TO USER:* \`${money(record.netPayout)} USDT\``,
            "",
            `🌐 *Network:* \`${escapeCode(record.destinationNetwork || "TRC20")}\``,
            `🏦 *Coin:* \`${escapeCode(record.coin || "USDT")}\``,
            `📬 *Wallet:* \`${escapeCode(record.destinationAddress)}\``,
            "",
            "🟠 *Status: AWAITING PAYMENT*",
            "",
            escapeMarkdown(
              "Manually send the net payout to the wallet above, then press ENTER TXID and submit the blockchain transaction ID."
            ),
          ].join("\n")
        : [
            "🔴 *WITHDRAWAL REJECTED*",
            "",
            `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
            `👤 *User ID:* \`${escapeCode(record.userId)}\``,
            "",
            `💵 *Gross Amount:* \`${money(record.grossAmount)} USDT\``,
            `💳 *Charge Fee:* \`${money(record.feeDeducted)} USDT\``,
            "",
            "🔴 *Status: REJECTED*",
            "",
            escapeMarkdown(
              "The reserved withdrawal funds have been restored to the user's Withdraw balance."
            ),
          ].join("\n");

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
              inline_keyboard:
                isApprove
                  ? [[
                      {
                        text: "📋 ENTER TXID",
                        callback_data: `withdrawal:enter_txid:${withdrawalId}`,
                      },
                    ]]
                  : [],
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
            (isApprove
              ? "Approval failed."
              : "Rejection failed."),
          show_alert: true,
        }
      );
    }
  }
}

async function handleTelegramMessage(message) {
  const from = message?.from || {};
  const adminId = String(from.id || "");

  if (!isAuthorizedAdmin(adminId)) {
    return;
  }

  const text =
    typeof message?.text === "string"
      ? message.text.trim()
      : "";

  if (!text) {
    return;
  }

  const withdrawalId =
    pendingTxidEntry.get(adminId);

  if (!withdrawalId) {
    return;
  }

  const replyTo =
    message?.reply_to_message;

  const promptText =
    String(replyTo?.text || "");

  if (
    !replyTo ||
    !promptText.includes("ENTER PAYMENT TXID")
  ) {
    return;
  }

  try {
    if (
      !withdrawalService ||
      typeof withdrawalService.submitWithdrawalTxid !==
        "function"
    ) {
      throw new Error(
        "Withdrawal TXID service is unavailable."
      );
    }

    await withdrawalService.submitWithdrawalTxid(
      withdrawalId,
      text,
      from
    );

    pendingTxidEntry.delete(adminId);

    await telegramApi(
      "sendMessage",
      {
        chat_id:
          message.chat?.id ||
          TELEGRAM_CHAT_ID,
        text: [
          "🟡 *TXID SUBMITTED*",
          "",
          `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
          `🔗 *TXID:* \`${escapeCode(text)}\``,
          "",
          "🟡 *Status: TXID SUBMITTED*",
          "",
          escapeMarkdown(
            "The transaction ID has been recorded. The withdrawal is not marked COMPLETED until blockchain verification succeeds."
          ),
        ].join("\n"),
        parse_mode: "MarkdownV2",
      }
    );

    console.log(
      `[TELEGRAM] TXID submitted for manual withdrawal ${withdrawalId} by admin ${adminId}.`
    );
  } catch (error) {
    console.error(
      `[TELEGRAM] TXID submission failed for ${withdrawalId}:`,
      error.message
    );

    await telegramApi(
      "sendMessage",
      {
        chat_id:
          message.chat?.id ||
          TELEGRAM_CHAT_ID,
        text: [
          "❌ *TXID NOT ACCEPTED*",
          "",
          escapeMarkdown(
            error.message || "Could not record the TXID."
          ),
          "",
          escapeMarkdown(
            "Reply to the TXID prompt with the transaction ID after the manual payment."
          ),
        ].join("\n"),
        parse_mode: "MarkdownV2",
      }
    );
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
              "message",
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

        if (
          update.message
        ) {
          handleTelegramMessage(
            update.message
          ).catch((error) => {
            console.error(
              "[TELEGRAM] Message processing error:",
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
// User-facing unfinished states:
//   UNDER_REVIEW     -> APPROVE + REJECT buttons
//   AWAITING_PAYMENT -> ENTER TXID + REJECT
//   TXID_SUBMITTED   -> informational/manual verification state
//   AUDITED          -> legacy informational audited message
//
// This module never sends a withdrawal through Bybit.
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

function buildAwaitingPaymentText(withdrawalId, data) {
  return [
    "🟠 *PAYMENT REQUIRED*",
    "",
    `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
    `👤 *User ID:* \`${escapeCode(data.userId)}\``,
    "",
    `💵 *Gross Amount:* \`${money(data.grossAmount)} USDT\``,
    `💳 *Charge Fee:* \`${money(data.feeDeducted)} USDT\``,
    `💰 *SEND TO USER:* \`${money(data.netPayout)} USDT\``,
    "",
    `🌐 *Network:* \`${escapeCode(data.destinationNetwork || "TRC20")}\``,
    `🏦 *Coin:* \`${escapeCode(data.coin || "USDT")}\``,
    `📬 *Wallet:* \`${escapeCode(data.destinationAddress)}\``,
    "",
    "🟠 *Status: AWAITING PAYMENT*",
    "",
    escapeMarkdown(
      "Manually send the net payout, then press ENTER TXID and submit the blockchain transaction ID."
    ),
  ].join("\n");
}

async function sendAwaitingPaymentRecoveryMessage(withdrawalId, data, ref) {
  const result = await telegramApi("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: buildAwaitingPaymentText(withdrawalId, data),
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [[
        {
          text: "📋 ENTER TXID",
          callback_data: `withdrawal:enter_txid:${withdrawalId}`,
        },
        {
          text: "❌ REJECT",
          callback_data: `withdrawal:reject:${withdrawalId}`,
        },
      ]],
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
}

async function recoverPendingWithdrawalsToTelegram() {
  if (!isConfigured()) {
    return;
  }

  const db = getFirestore();

  const snapshot = await db
    .collection("withdrawals")
    .where("status", "in", ["UNDER_REVIEW", "AWAITING_PAYMENT", "TXID_SUBMITTED", "AUDITED"])
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
                    {
                      text: "❌ REJECT",
                      callback_data: `withdrawal:reject:${withdrawalId}`,
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
                    {
                      text: "❌ REJECT",
                      callback_data: `withdrawal:reject:${withdrawalId}`,
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
      } else if (
        status === "AWAITING_PAYMENT" ||
        status === "TXID_SUBMITTED"
      ) {
        const text =
          status === "TXID_SUBMITTED"
            ? [
                "🟡 *TXID SUBMITTED*",
                "",
                `🆔 *Withdrawal ID:* \`${escapeCode(withdrawalId)}\``,
                `👤 *User ID:* \`${escapeCode(data.userId)}\``,
                "",
                `💰 *Payout:* \`${money(data.netPayout)} USDT\``,
                `📬 *Wallet:* \`${escapeCode(data.destinationAddress)}\``,
                `🔗 *TXID:* \`${escapeCode(data.txid || "")}\``,
                "",
                "🟡 *Status: TXID SUBMITTED*",
                "",
                escapeMarkdown(
                  "Awaiting blockchain verification. Do not mark this withdrawal completed manually."
                ),
              ].join("\n")
            : buildAwaitingPaymentText(withdrawalId, data);

        const keyboard =
          status === "TXID_SUBMITTED"
            ? []
            : [[
                {
                  text: "📋 ENTER TXID",
                  callback_data: `withdrawal:enter_txid:${withdrawalId}`,
                },
                {
                  text: "❌ REJECT",
                  callback_data: `withdrawal:reject:${withdrawalId}`,
                },
              ]];

        if (existingMessageId > 0 && existingChatId) {
          try {
            await telegramApi("editMessageText", {
              chat_id: existingChatId,
              message_id: existingMessageId,
              text,
              parse_mode: "MarkdownV2",
              reply_markup: {
                inline_keyboard: keyboard,
              },
            });
          } catch (editError) {
            const result = await telegramApi("sendMessage", {
              chat_id: TELEGRAM_CHAT_ID,
              text,
              parse_mode: "MarkdownV2",
              reply_markup: {
                inline_keyboard: keyboard,
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
          }
        } else {
          await sendAwaitingPaymentRecoveryMessage(
            withdrawalId,
            data,
            ref
          );
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
  rejectWithdrawal,
  startTelegramWithdrawalApproval,
  stopTelegramWithdrawalApproval,
};
