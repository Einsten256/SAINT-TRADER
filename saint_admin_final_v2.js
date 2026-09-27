const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "index.js");
const marker = "// SAINT_ADMIN_FINAL_V2";

if (!fs.existsSync(file)) throw new Error("index.js not found.");

let source = fs.readFileSync(file, "utf8");

if (source.includes(marker)) {
  console.log("SAINT ADMIN FINAL V2 is already installed.");
  process.exit(0);
}

const backup = file + ".backup-before-saint-admin-final-" + Date.now();
fs.copyFileSync(file, backup);

const pos = source.indexOf("const server =");
if (pos < 0) throw new Error("Could not find const server = in index.js.");

const block = `
// SAINT_ADMIN_FINAL_V2
// Complete SAINT ADMIN API layer. Inserted before app.listen().
// Existing Saint Crypto routes/services remain untouched.

// ----- finance queues -----
app.get(
  API_PREFIX + "/admin/finance/recharges",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const snap = await firestore.collection("recharges").limit(300).get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const all = req.query.all === "true";
      const recharges = all ? rows : rows.filter(x =>
        ["PENDING_ADMIN_REVIEW", "PENDING"].includes(
          String(x.status || "").toUpperCase()
        )
      );
      return res.json({ success: true, count: recharges.length, recharges });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "ADMIN_RECHARGES_FAILED", message: e.message
      });
    }
  }
);

app.get(
  API_PREFIX + "/admin/finance/withdrawals",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const snap = await firestore.collection("withdrawals").limit(300).get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const all = req.query.all === "true";
      const withdrawals = all ? rows : rows.filter(x =>
        ["PENDING", "PENDING_ADMIN_REVIEW", "AWAITING_PAYMENT", "PROCESSING"]
          .includes(String(x.status || "").toUpperCase())
      );
      return res.json({ success: true, count: withdrawals.length, withdrawals });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "ADMIN_WITHDRAWALS_FAILED", message: e.message
      });
    }
  }
);

// ----- recharge approval -----
app.post(
  API_PREFIX + "/admin/finance/recharges/:rechargeId/approve",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.rechargeId || "").trim();
      if (!id) return res.status(400).json({
        success: false, message: "Recharge ID is required."
      });
      if (!deposit || typeof deposit.approveRecharge !== "function") {
        return res.status(503).json({
          success: false, code: "RECHARGE_SERVICE_UNAVAILABLE"
        });
      }
      const result = await deposit.approveRecharge(id, req.uid);
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "RECHARGE_APPROVED", target: id,
        details: result, createdAt: new Date()
      });
      return res.json({ success: true, message: "Recharge approved.", recharge: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "RECHARGE_APPROVAL_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/finance/recharges/:rechargeId/reject",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.rechargeId || "").trim();
      const reason = String(req.body && req.body.reason || "Rejected by SAINT ADMIN.")
        .trim().slice(0, 500);
      if (!id) return res.status(400).json({
        success: false, message: "Recharge ID is required."
      });
      if (!deposit || typeof deposit.rejectRecharge !== "function") {
        return res.status(503).json({
          success: false, code: "RECHARGE_SERVICE_UNAVAILABLE"
        });
      }
      const result = await deposit.rejectRecharge(id, req.uid, reason);
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "RECHARGE_REJECTED", target: id,
        details: { reason, result }, createdAt: new Date()
      });
      return res.json({ success: true, message: "Recharge rejected.", recharge: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "RECHARGE_REJECTION_FAILED", message: e.message
      });
    }
  }
);

// ----- withdrawal approval / rejection -----
app.post(
  API_PREFIX + "/admin/finance/withdrawals/:withdrawalId/approve",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.withdrawalId || "").trim();
      if (!id) return res.status(400).json({
        success: false, message: "Withdrawal ID is required."
      });
      if (!withdrawal || typeof withdrawal.approveAndDisburseWithdrawal !== "function") {
        return res.status(503).json({
          success: false, code: "WITHDRAWAL_SERVICE_UNAVAILABLE"
        });
      }
      const result = await withdrawal.approveAndDisburseWithdrawal(id, {
        paymentReference: String(req.body && req.body.paymentReference ||
          "SAINT_ADMIN_MM_" + Date.now()).trim(),
        adminId: req.uid,
        adminUsername: "SAINT ADMIN"
      });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "WITHDRAWAL_APPROVED", target: id,
        details: result, createdAt: new Date()
      });
      return res.json({ success: true, withdrawal: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "WITHDRAWAL_APPROVAL_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/finance/withdrawals/:withdrawalId/reject",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.withdrawalId || "").trim();
      const reason = String(req.body && req.body.reason || "Rejected by SAINT ADMIN.")
        .trim().slice(0, 500);
      if (!id) return res.status(400).json({
        success: false, message: "Withdrawal ID is required."
      });
      if (!withdrawal || typeof withdrawal.rejectWithdrawal !== "function") {
        return res.status(503).json({
          success: false, code: "WITHDRAWAL_SERVICE_UNAVAILABLE"
        });
      }
      const result = await withdrawal.rejectWithdrawal(id, reason);
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "WITHDRAWAL_REJECTED", target: id,
        details: { reason, result }, createdAt: new Date()
      });
      return res.json({ success: true, withdrawal: result });
    } catch (e) {
      return res.status(400).json({
        success: false, code: "WITHDRAWAL_REJECTION_FAILED", message: e.message
      });
    }
  }
);

// ----- user detail / freeze -----
app.get(
  API_PREFIX + "/admin/users/:userId",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.userId || "").trim();
      const doc = await firestore.collection("users").doc(id).get();
      if (!doc.exists) return res.status(404).json({
        success: false, code: "USER_NOT_FOUND"
      });
      const read = async name => {
        const snap = await firestore.collection(name).limit(300).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(x => String(x.userId || x.uid || "") === id);
      };
      const [recharges, withdrawals, signals] = await Promise.all([
        read("recharges"), read("withdrawals"), read("signal_redemptions")
      ]);
      return res.json({
        success: true,
        user: { id: doc.id, ...doc.data() },
        recharges, withdrawals, signalHistory: signals
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "USER_DETAIL_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/users/:userId/freeze",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.userId || "").trim();
      await firestore.collection("users").doc(id).set({
        is_frozen: true,
        status: "FROZEN",
        freezeReason: String(req.body && req.body.reason || "Frozen by SAINT ADMIN.")
          .slice(0, 500),
        updatedAt: new Date()
      }, { merge: true });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "USER_FROZEN", target: id,
        details: req.body || {}, createdAt: new Date()
      });
      return res.json({ success: true, message: "User frozen." });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "USER_FREEZE_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/users/:userId/unfreeze",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.userId || "").trim();
      await firestore.collection("users").doc(id).set({
        is_frozen: false, status: "ACTIVE", freezeReason: null, updatedAt: new Date()
      }, { merge: true });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "USER_UNFROZEN", target: id,
        details: {}, createdAt: new Date()
      });
      return res.json({ success: true, message: "User unfrozen." });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "USER_UNFREEZE_FAILED", message: e.message
      });
    }
  }
);

// ----- system controls -----
app.get(
  API_PREFIX + "/admin/system/status",
  requireSaintAdmin,
  async (req, res) => {
    try {
      let c = {};
      if (realtimeDb) {
        const snap = await realtimeDb.ref("system_control").once("value");
        c = snap.val() || {};
      }
      return res.json({
        success: true, backend: "ONLINE",
        firebase: Boolean(firebaseReady),
        firestore: Boolean(firestore),
        realtimeDb: Boolean(realtimeDb),
        tradingFrozen: c.trading_frozen === true,
        withdrawalsFrozen: c.withdrawals_frozen === true,
        maintenance: c.maintenance === true,
        announcement: String(c.announcement || "")
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SYSTEM_STATUS_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/system/control",
  requireSaintAdmin,
  async (req, res) => {
    try {
      if (!realtimeDb) return res.status(503).json({
        success: false, message: "Realtime Database unavailable."
      });
      const u = { updatedAt: new Date().toISOString(), updatedBy: req.uid };
      if (typeof req.body && typeof req.body.tradingFrozen === "boolean")
        u.trading_frozen = req.body.tradingFrozen;
      if (typeof req.body && typeof req.body.withdrawalsFrozen === "boolean")
        u.withdrawals_frozen = req.body.withdrawalsFrozen;
      if (typeof req.body && typeof req.body.maintenance === "boolean")
        u.maintenance = req.body.maintenance;
      if (req.body && req.body.announcement !== undefined)
        u.announcement = String(req.body.announcement || "").slice(0, 1000);
      await realtimeDb.ref("system_control").update(u);
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "SYSTEM_CONTROL_UPDATE",
        target: "system_control", details: u, createdAt: new Date()
      });
      return res.json({ success: true, controls: u });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SYSTEM_CONTROL_FAILED", message: e.message
      });
    }
  }
);

// ----- audit -----
app.get(
  API_PREFIX + "/admin/audit",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const snap = await firestore.collection("admin_audit_logs").limit(300).get();
      const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, count: logs.length, logs });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "AUDIT_FAILED", message: e.message
      });
    }
  }
);

// ----- signals -----
app.get(
  API_PREFIX + "/admin/signals",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const snap = await firestore.collection("signals").limit(200).get();
      const signals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, count: signals.length, signals });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "SIGNALS_FAILED", message: e.message
      });
    }
  }
);

// ----- reports -----
app.get(
  API_PREFIX + "/admin/reports",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const [users, recharges, withdrawals, rewards] = await Promise.all([
        firestore.collection("users").limit(300).get(),
        firestore.collection("recharges").limit(300).get(),
        firestore.collection("withdrawals").limit(300).get(),
        firestore.collection("signal_redemptions").limit(300).get()
      ]);
      const u = users.docs.map(d => d.data());
      const r = recharges.docs.map(d => d.data());
      const w = withdrawals.docs.map(d => d.data());
      const s = rewards.docs.map(d => d.data());
      const num = x => Number.isFinite(Number(x)) ? Number(x) : 0;
      return res.json({
        success: true,
        users: {
          total: u.length,
          frozen: u.filter(x => x.is_frozen === true).length
        },
        finance: {
          rechargeCount: r.length,
          approvedRechargeUgx: r.filter(x => String(x.status || "").toUpperCase() === "APPROVED")
            .reduce((a,x) => a + num(x.amountUgx || x.amount_ugx), 0),
          withdrawalCount: w.length,
          paidWithdrawalUgx: w.filter(x =>
            ["PAID","DISBURSED","COMPLETED"].includes(String(x.status || "").toUpperCase())
          ).reduce((a,x) => a + num(x.netPayout || x.amountUgx || x.amount_ugx), 0),
          rewards: s.reduce((a,x) => a + num(x.reward || x.profit || x.amount), 0)
        },
        generatedAt: new Date().toISOString()
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "REPORTS_FAILED", message: e.message
      });
    }
  }
);

// ----- MT5 registry / command queue -----
app.get(
  API_PREFIX + "/admin/mt5/accounts",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const snap = await firestore.collection("mt5_accounts").limit(200).get();
      return res.json({
        success: true,
        count: snap.size,
        accounts: snap.docs.map(d => ({ id: d.id, ...d.data() }))
      });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "MT5_ACCOUNTS_FAILED", message: e.message
      });
    }
  }
);

app.post(
  API_PREFIX + "/admin/mt5/accounts/:accountId/command",
  requireSaintAdmin,
  async (req, res) => {
    try {
      const accountId = String(req.params.accountId || "").trim();
      const command = String(req.body && req.body.command || "").trim().toUpperCase();
      if (!accountId || !["START_BOT","STOP_BOT","CLOSE_ALL","REFRESH"].includes(command))
        return res.status(400).json({ success: false, message: "Invalid MT5 command." });
      const ref = await firestore.collection("mt5_commands").add({
        accountId, command, status: "PENDING", createdAt: new Date(), createdBy: req.uid
      });
      await firestore.collection("admin_audit_logs").add({
        adminUid: req.uid, action: "MT5_COMMAND", target: accountId,
        details: { command, commandId: ref.id }, createdAt: new Date()
      });
      return res.json({ success: true, commandId: ref.id });
    } catch (e) {
      return res.status(500).json({
        success: false, code: "MT5_COMMAND_FAILED", message: e.message
      });
    }
  }
);

`;

source = source.slice(0, pos) + block + source.slice(pos);
fs.writeFileSync(file, source, "utf8");

console.log("SAINT ADMIN FINAL V2 installed successfully.");
console.log("Backup created: " + backup);
