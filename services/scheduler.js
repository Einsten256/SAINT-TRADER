/**
 * SAINT CRYPTO
 * services/scheduler.js
 *
 * DAILY SIGNAL SCHEDULER
 *
 * Destination:
 * SAINT CRYPTO/services/scheduler.js
 *
 * Schedule:
 *   Monday-Friday
 *   21:00 Africa/Kampala (EAT)
 *   One signal per day
 *
 * The actual signal creation is handled by services/signal.js.
 * This scheduler only decides WHEN to create it.
 *
 * Durable daily uniqueness is enforced by signal.js using:
 *   signal_daily/{YYYY-MM-DD}
 *
 * This means a server restart or multiple backend instances must not
 * create multiple daily signals.
 */

"use strict";

const signalService = require("./signal");

const TIMEZONE =
  String(
    process.env.SIGNAL_TIMEZONE || "Africa/Kampala"
  ).trim();

const SIGNAL_TIME =
  String(
    process.env.SIGNAL_TIME || "21:00"
  ).trim();

const ENABLED =
  String(
    process.env.ENABLE_DAILY_SIGNAL ?? "true"
  )
    .trim()
    .toLowerCase() !== "false";

const INTERVAL_MS = Math.max(
  1000,
  Number(
    process.env.SIGNAL_SCHEDULER_INTERVAL_MS || 5000
  )
);

let timer = null;
let running = false;
let lastAttemptKey = null;

/**
 * Get date/time parts in the configured timezone.
 *
 * Returns:
 * {
 *   year,
 *   month,
 *   day,
 *   weekday,
 *   hour,
 *   minute,
 *   second,
 *   dateKey
 * }
 */
function getTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }
  );

  const parts = formatter.formatToParts(date);
  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  let hour = Number(map.hour);

  // Some Intl implementations can represent midnight as 24.
  if (hour === 24) {
    hour = 0;
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);

  return {
    year,
    month,
    day,
    weekday: map.weekday,
    hour,
    minute: Number(map.minute),
    second: Number(map.second),

    dateKey:
      `${year}-${String(month).padStart(2, "0")}-` +
      `${String(day).padStart(2, "0")}`,
  };
}

function isWeekday(weekday) {
  return [
    "Mon",
    "Tue",
    "Wed",
    "Thu",
    "Fri",
  ].includes(weekday);
}

function parseSignalTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(
    String(value || "").trim()
  );

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return {
    hour,
    minute,
  };
}

const parsedSignalTime =
  parseSignalTime(SIGNAL_TIME);

if (!parsedSignalTime) {
  throw new Error(
    `Invalid SIGNAL_TIME "${SIGNAL_TIME}". Expected HH:MM.`
  );
}

/**
 * Check whether the scheduler is currently at the configured
 * signal minute.
 *
 * We intentionally use the minute as the scheduling boundary rather
 * than requiring second === 0, because the process checks every few
 * seconds and could otherwise miss the exact second.
 */
function isSignalTime(date = new Date()) {
  const parts = getTimeParts(date);

  return (
    isWeekday(parts.weekday) &&
    parts.hour === parsedSignalTime.hour &&
    parts.minute === parsedSignalTime.minute
  );
}

/**
 * Unique attempt key for the current scheduled minute.
 */
function getAttemptKey(date = new Date()) {
  const parts = getTimeParts(date);

  return `${parts.dateKey}_${String(parts.hour).padStart(
    2,
    "0"
  )}:${String(parts.minute).padStart(2, "0")}`;
}

/**
 * Create the daily signal.
 *
 * signalService.createSignal() performs its own durable daily
 * uniqueness transaction, so this function is safe against duplicate
 * scheduler executions.
 */
async function runDailySignal(date = new Date()) {
  if (!ENABLED) {
    return {
      created: false,
      skipped: true,
      reason: "DAILY_SIGNAL_DISABLED",
    };
  }

  const parts = getTimeParts(date);

  if (!isWeekday(parts.weekday)) {
    return {
      created: false,
      skipped: true,
      reason: "WEEKEND",
      dateKey: parts.dateKey,
    };
  }

  if (!isSignalTime(date)) {
    return {
      created: false,
      skipped: true,
      reason: "NOT_SIGNAL_TIME",
      dateKey: parts.dateKey,
    };
  }

  const attemptKey = getAttemptKey(date);

  // Avoid repeatedly attempting the same minute inside one process.
  if (lastAttemptKey === attemptKey) {
    return {
      created: false,
      skipped: true,
      reason: "ALREADY_ATTEMPTED_THIS_MINUTE",
      attemptKey,
    };
  }

  lastAttemptKey = attemptKey;

  try {
    const signal =
      await signalService.createSignal({
        force: false,
      });

    console.log(
      `[signal scheduler] Daily signal created: ${signal.code}`
    );

    return {
      created: true,
      signal,
      attemptKey,
    };
  } catch (error) {
    /**
     * Another server instance may have created today's signal first.
     * signal.js remains the final authority for uniqueness.
     */
    const message = String(
      error?.message || ""
    ).toLowerCase();

    if (
      message.includes("already exists") ||
      message.includes("already created") ||
      message.includes("already generated")
    ) {
      console.log(
        `[signal scheduler] Signal already exists for ${parts.dateKey}.`
      );

      return {
        created: false,
        skipped: true,
        reason: "DAILY_SIGNAL_ALREADY_EXISTS",
        dateKey: parts.dateKey,
      };
    }

    console.error(
      "[signal scheduler] Signal creation failed:",
      error
    );

    return {
      created: false,
      skipped: false,
      reason: "SIGNAL_CREATION_FAILED",
      error: error?.message || "Unknown error",
      attemptKey,
    };
  }
}

/**
 * One scheduler tick.
 */
async function tick() {
  if (running) {
    return;
  }

  running = true;

  try {
    const result = await runDailySignal();

    if (result.created) {
      console.log(
        "[signal scheduler] Daily signal cycle completed."
      );
    }
  } catch (error) {
    console.error(
      "[signal scheduler] Tick failed:",
      error
    );
  } finally {
    running = false;
  }
}

/**
 * Start scheduler.
 */
function startScheduler() {
  if (timer) {
    return {
      started: true,
      alreadyRunning: true,
      timezone: TIMEZONE,
      signalTime: SIGNAL_TIME,
      enabled: ENABLED,
    };
  }

  if (!ENABLED) {
    console.log(
      "[signal scheduler] Daily signal scheduler disabled."
    );

    return {
      started: false,
      enabled: false,
      timezone: TIMEZONE,
      signalTime: SIGNAL_TIME,
    };
  }

  console.log(
    `[signal scheduler] Started: Mon-Fri at ${SIGNAL_TIME} ${TIMEZONE}`
  );

  // Check immediately after server startup.
  void tick();

  timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);

  // Do not prevent Node from shutting down naturally.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    started: true,
    alreadyRunning: false,
    timezone: TIMEZONE,
    signalTime: SIGNAL_TIME,
    intervalMs: INTERVAL_MS,
    enabled: ENABLED,
  };
}

/**
 * Stop scheduler.
 */
function stopScheduler() {
  if (!timer) {
    return {
      stopped: true,
      wasRunning: false,
    };
  }

  clearInterval(timer);
  timer = null;
  running = false;

  return {
    stopped: true,
    wasRunning: true,
  };
}

/**
 * Status for backend diagnostics.
 */
function getStatus() {
  const now = new Date();
  const parts = getTimeParts(now);

  return {
    running: Boolean(timer),
    tickRunning: running,
    enabled: ENABLED,
    timezone: TIMEZONE,
    signalTime: SIGNAL_TIME,
    intervalMs: INTERVAL_MS,
    currentDate: parts.dateKey,
    currentWeekday: parts.weekday,
    currentTime:
      `${String(parts.hour).padStart(2, "0")}:` +
      `${String(parts.minute).padStart(2, "0")}:` +
      `${String(parts.second).padStart(2, "0")}`,
    isWeekday: isWeekday(parts.weekday),
    isSignalTime: isSignalTime(now),
    lastAttemptKey,
  };
}

module.exports = {
  startScheduler,
  stopScheduler,
  runDailySignal,
  getTimeParts,
  isWeekday,
  isSignalTime,
  getStatus,
};
