/**







 * SAINT CRYPTO







 * services/telegram_withdrawal.js







 *







 * Mobile Money withdrawal admin approval bot.







 *







 * Destination:







 * SAINT CRYPTO/services/telegram_withdrawal.js







 *







 * Flow:







 *   USER REQUEST







 *      â†“







 *   PAYOUT BALANCE RESERVED







 *      â†“







 *   TELEGRAM ADMIN REVIEW







 *      â†“







 *   APPROVE â†’ ADMIN MANUALLY SENDS MOBILE MONEY â†’ CONFIRM DISBURSEMENT







 *   REJECT  â†’ RESERVED AMOUNT RESTORED







 *







 * There is NO:







 *   - USDT







 *   - TRON







 *   - blockchain withdrawal







 *   - wallet address







 *   - TXID verification







 *







 * Environment:







 *   TELEGRAM_BOT_TOKEN







 *   TELEGRAM_CHAT_ID







 *   TELEGRAM_ADMIN_IDS=123,456







 \*/















"use strict";















const withdrawalService = require("./withdrawal");















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







 \*/







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



let ownsBot = false;















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







  return (







    env("TELEGRAM_WITHDRAWAL_CHAT_ID") ||







    env("TELEGRAM_ADMIN_CHAT_ID") ||







    env("TELEGRAM_CHAT_ID")







  );







}















function isConfigured() {







  return Boolean(env("TELEGRAM_BOT_TOKEN") && getChatId());







}















function isAdmin(userId) {







  if (!userId) return false;















  const admins = parseAdminIds();















  // If TELEGRAM_ADMIN_IDS is configured, enforce it.







  if (admins.size > 0) {







    return admins.has(String(userId));







  }















  // Backward-compatible fallback:







  // TELEGRAM_CHAT_ID can be used as the private admin chat when no







  // explicit admin list was configured.







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







    .replace(/**<**/g, "&lt;")







    .replace(/>/g, "&gt;");







}















function withdrawalText(withdrawal) {







  const network = escapeHtml(withdrawal.network || "UNKNOWN");







  const recipientName = escapeHtml(







    withdrawal.recipientName || "Unknown"







  );







  const mobileNumber = escapeHtml(







    withdrawal.mobileNumber || "Unknown"







  );















  return [







    "ðŸ’¸ \<b>SAINT CRYPTO WITHDRAWAL\</b>",







    "",







    `ðŸ†” \<b>ID:\</b> \<code>${escapeHtml(withdrawal.id)}\</code>`,







    `ðŸ‘¤ \<b>User:\</b> \<code>${escapeHtml(withdrawal.userId)}\</code>`,







    "",







    `ðŸ‘¤ \<b>Recipient:\</b> ${recipientName}`,







    `ðŸ“± \<b>Network:\</b> ${network}`,







    `â˜Žï¸ \<b>Number:\</b> \<code>${mobileNumber}\</code>`,







    "",







    `ðŸ’° \<b>Gross:\</b> ${money(withdrawal.amountUgx)}`,







    `ðŸ’³ \<b>Fee (5%):\</b> ${money(withdrawal.feeUgx)}`,







    `ðŸ“¤ \<b>Net to send:\</b> ${money(withdrawal.netAmountUgx)}`,







    "",







    `ðŸ“Œ \<b>Status:\</b> ${escapeHtml(withdrawal.status)}`,







    "",







    "âš ï¸ \<b>Manual Mobile Money payment required.\</b>",







    "Send the NET amount to the saved number above.",







    "Then use \<b>CONFIRM PAID\</b>.",







  ].join("\n");







}















function withdrawalKeyboard(withdrawalId) {







  return {







    inline_keyboard: [







      [







        {







          text: "âœ… APPROVE / PAY",







          callback_data: `wd_approve:${withdrawalId}`,







        },







        {







          text: "âŒ REJECT",







          callback_data: `wd_reject:${withdrawalId}`,







        },







      ],







      [







        {







          text: "ðŸ’µ CONFIRM PAID",







          callback_data: `wd_paid:${withdrawalId}`,







        },







      ],







    ],







  };







}















async function sendWithdrawalForReview(withdrawal) {







  if (!bot || !getChatId()) {







    return {







      sent: false,







      reason: "TELEGRAM_NOT_CONFIGURED",







    };







  }















  const text = withdrawalText(withdrawal);















  const message = await bot.api.sendMessage({ chat_id: getChatId(), text, 







    parse_mode: "HTML",







    disable_web_page_preview: true,







    reply_markup: withdrawalKeyboard(withdrawal.id),







   });















  return {







    sent: true,







    messageId: message?.message_id || null,







    chatId: getChatId(),







  };







}















async function safeAnswerCallback(queryId, text, showAlert = false) {







  try {







    if (bot && queryId) {







      await bot.api.answerCallbackQuery({ callback_query_id: queryId, 







        text,







        show_alert: showAlert,







       });







    }







  } catch (error) {







    console.error(







      "[telegram withdrawal] callback answer failed:",







      error.message







    );







  }







}















async function editWithdrawalMessage(chatId, messageId, text, replyMarkup) {







  if (!bot || !chatId || !messageId) return;















  try {







    await bot.api.editMessageText({ chat_id: chatId, message_id: messageId, text, 







      chat_id: chatId,







      message_id: messageId,







      parse_mode: "HTML",







      disable_web_page_preview: true,







      ...(replyMarkup







        ? {







            reply_markup: replyMarkup,







          }







        : { }),







    });







  } catch (error) {







    // Telegram may return "message is not modified". This is harmless.







    console.error(







      "[telegram withdrawal] message edit failed:",







      error.message







    );







  }







}















/**







 * Approve button:







 *







 * IMPORTANT:







 * Approval means the admin has accepted the withdrawal and should now







 * manually send the NET amount.







 *







 * The withdrawal is NOT automatically paid by Telegram.







 *







 * We intentionally keep it in UNDER_REVIEW until CONFIRM PAID is pressed.







 \*/







async function handleApprove(query, withdrawalId) {







  const withdrawal =







    await withdrawalService.getWithdrawalForAdmin(withdrawalId);















  if (!withdrawal) {







    await safeAnswerCallback(







      query.id,







      "Withdrawal not found.",







      true







    );







    return;







  }















  if (







    withdrawal.status !== "UNDER_REVIEW" &&







    withdrawal.status !== "PROCESSING"







  ) {







    await safeAnswerCallback(







      query.id,







      `Cannot approve: ${withdrawal.status}`,







      true







    );







    return;







  }















  await safeAnswerCallback(







    query.id,







    "Approved. Send the NET amount manually, then press CONFIRM PAID."







  );















  if (bot && query.message) {







    const approvedText = [







      withdrawalText(withdrawal),







      "",







      "ðŸŸ¡ \<b>ADMIN ACTION:\</b> APPROVED",







      "ðŸ“² Manually send the NET amount to the number above.",







      "After payment is completed, press \<b>CONFIRM PAID\</b>.",







    ].join("\n");















    await editWithdrawalMessage(







      query.message.chat.id,







      query.message.message_id,







      approvedText,







      {







        inline_keyboard: [







          [







            {







              text: "ðŸ’µ CONFIRM PAID",







              callback_data: `wd_paid:${withdrawalId}`,







            },







            {







              text: "âŒ REJECT",







              callback_data: `wd_reject:${withdrawalId}`,







            },







          ],







        ],







      }







    );







  }







}















/**







 * CONFIRM PAID:







 *







 * The admin confirms that the manual Mobile Money payment was actually







 * sent. The service then marks the withdrawal DISBURSED.







 \*/







async function handleConfirmPaid(query, withdrawalId) {







  const withdrawal =







    await withdrawalService.getWithdrawalForAdmin(withdrawalId);















  if (!withdrawal) {







    await safeAnswerCallback(







      query.id,







      "Withdrawal not found.",







      true







    );







    return;







  }















  if (







    withdrawal.status !== "UNDER_REVIEW" &&







    withdrawal.status !== "PROCESSING"







  ) {







    await safeAnswerCallback(







      query.id,







      `Cannot confirm payment: ${withdrawal.status}`,







      true







    );







    return;







  }















  try {







    const result =







      await withdrawalService.approveAndDisburseWithdrawal(







        withdrawalId,







        {







          paymentReference:







            `MANUAL_MM\\\\_${Date.now()}`,







          adminTelegramId: String(query.from.id),







          approvedAt: new Date(),







        }







      );















    await safeAnswerCallback(







      query.id,







      "Payment confirmed. Withdrawal marked DISBURSED."







    );















    if (bot && query.message) {







      const paidText = [







        withdrawalText(result),







        "",







        "ðŸŸ¢ \<b>DISBURSED\</b>",







        "Manual Mobile Money payment confirmed by admin.",







        `ðŸ’µ \<b>Paid:\</b> ${money(result.netAmountUgx)}`,







        result.paymentReference







          ? `ðŸ§¾ \<b>Reference:\</b> \<code>${escapeHtml(







              result.paymentReference







            )}\</code>`







          : "",







      ]







        .filter(Boolean)







        .join("\n");















      await editWithdrawalMessage(







        query.message.chat.id,







        query.message.message_id,







        paidText







      );







    }







  } catch (error) {







    console.error(







      "[telegram withdrawal] confirm payment failed:",







      error







    );















    await safeAnswerCallback(







      query.id,







      error?.message || "Could not confirm payment.",







      true







    );







  }







}















async function handleReject(query, withdrawalId) {







  const withdrawal =







    await withdrawalService.getWithdrawalForAdmin(withdrawalId);















  if (!withdrawal) {







    await safeAnswerCallback(







      query.id,







      "Withdrawal not found.",







      true







    );







    return;







  }















  if (







    withdrawal.status !== "UNDER_REVIEW" &&







    withdrawal.status !== "PROCESSING"







  ) {







    await safeAnswerCallback(







      query.id,







      `Cannot reject: ${withdrawal.status}`,







      true







    );







    return;







  }















  try {







    const result =







      await withdrawalService.rejectWithdrawal(







        withdrawalId,







        "Rejected by Telegram admin."







      );















    await safeAnswerCallback(







      query.id,







      "Withdrawal rejected. Reserved funds restored."







    );















    if (bot && query.message) {







      const rejectedText = [







        withdrawalText(result),







        "",







        "ðŸ”´ \<b>REJECTED\</b>",







        "Reserved payout funds have been restored to the user.",







      ].join("\n");















      await editWithdrawalMessage(







        query.message.chat.id,







        query.message.message_id,







        rejectedText







      );







    }







  } catch (error) {







    console.error(







      "[telegram withdrawal] rejection failed:",







      error







    );















    await safeAnswerCallback(







      query.id,







      error?.message || "Could not reject withdrawal.",







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















      if (data.startsWith("wd_approve:")) {







        const withdrawalId = data.substring("wd_approve:".length);







        await handleApprove(query, withdrawalId);







        return;







      }















      if (data.startsWith("wd_reject:")) {







        const withdrawalId = data.substring("wd_reject:".length);







        await handleReject(query, withdrawalId);







        return;







      }















      if (data.startsWith("wd_paid:")) {







        const withdrawalId = data.substring("wd_paid:".length);







        await handleConfirmPaid(query, withdrawalId);







        return;







      }















      await safeAnswerCallback(







        query.id,







        "Unknown withdrawal action.",







        true







      );







    } catch (error) {







      console.error(







        "[telegram withdrawal] callback handler error:",







        error







      );















      await safeAnswerCallback(







        query.id,







        "Admin action failed.",







        true







      );







    }







  });







}
















async function resendPendingWithdrawalsOnStartup() {
  try {
    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore();

    const snap = await db.collection("withdrawals")
      .where("status", "==", "UNDER_REVIEW")
      .get();

    console.log("[telegram withdrawal] Pending on startup:", snap.size);

    for (const doc of snap.docs) {
      const withdrawal = {
        id: doc.id,
        ...(doc.data() || {})
      };

      try {
        await sendWithdrawalForReview(withdrawal);
        console.log(
          "[telegram withdrawal] Startup resend:",
          withdrawal.id
        );
      } catch (error) {
        console.error(
          "[telegram withdrawal] Startup resend failed:",
          withdrawal.id,
          error?.message || error
        );
      }
    }
  } catch (error) {
    console.error(
      "[telegram withdrawal] Startup recovery failed:",
      error?.message || error
    );
  }
}

async function startTelegramWithdrawalBot(sharedBot = null) {







  if (started) {







    return {







      started: true,







      alreadyRunning: true,







    };







  }















  if (!TelegramBot) {







    console.error(







      "[telegram withdrawal] Telegram package could not be initialized:",







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







      "[telegram withdrawal] TELEGRAM_BOT_TOKEN is not configured."







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















  if (sharedBot) {







    bot = sharedBot;



    ownsBot = false;



    polling = false;



    started = true;







    registerHandlers();
    setTimeout(() => resendPendingWithdrawalsOnStartup(), 1500);







    console.log("Telegram withdrawal handlers attached to shared bot.");







    return {



      started: true,



      polling: false,



      shared: true,



      configured: isConfigured(),



    };







  }







  bot = new TelegramBot(token, {



    polling: true,



  });







  ownsBot = true;



  polling = true;



  started = true;







  registerHandlers();















  bot.on("polling_error", (error) => {







    console.error(







      "[telegram withdrawal] polling error:",







      error?.message || error







    );







  });















  bot.on("error", (error) => {







    console.error(







      "[telegram withdrawal] bot error:",







      error?.message || error







    );







  });















  console.log("Telegram withdrawal approval bot started.");















  return {







    started: true,







    polling: true,







    configured: isConfigured(),







  };







}















async function stopTelegramWithdrawalBot() {







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







  if (!ownsBot) {



    bot = null;



    started = false;



    polling = false;



    return {



      stopped: true,



      wasRunning: true,



      pollingStopped: false,



      shared: true,



    };



  }







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















    // Render/SIGTERM can terminate the process while the Telegram client is







    // already tearing down. A missing stopPolling method is harmless during







    // process shutdown; avoid presenting it as a service failure.







    if (!/stopPolling.*not a function/i.test(message)) {







      console.warn(







        "[telegram withdrawal] graceful stop warning:",







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















async function notifyWithdrawalCreated(withdrawal) {







  try {







    return await sendWithdrawalForReview(withdrawal);







  } catch (error) {







    console.error(







      "[telegram withdrawal] notification failed:",







      error







    );















    return {







      sent: false,







      reason: "TELEGRAM_SEND_FAILED",







      error: error.message,







    };







  }







}















async function notifyWithdrawalUnderReview(withdrawalOrId) {

  try {

    let withdrawal = withdrawalOrId;



    if (typeof withdrawalOrId === "string") {

      withdrawal = await withdrawalService.getWithdrawalForAdmin(withdrawalOrId);

    }



    if (!withdrawal) {

      console.error("[TELEGRAM] Withdrawal not found:", withdrawalOrId);

      return false;

    }



    const result = await notifyWithdrawalCreated(withdrawal);

    return Boolean(result && result.sent);

  } catch (error) {

    console.error(

      "[TELEGRAM] Under-review notification failed:",

      error?.message || error

    );

    return false;

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







  startTelegramWithdrawalBot,







  stopTelegramWithdrawalBot,







    notifyWithdrawalCreated,



  notifyWithdrawalUnderReview,



  sendWithdrawalForReview,







  getStatus,







};

