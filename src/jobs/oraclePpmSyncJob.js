const cron = require("node-cron");
const { runOracleSync } = require("../services/oraclePpmSyncService");

function startOracleSyncJob() {
  // Every day at 11:00 PM server time
  cron.schedule("0 23 * * *", async () => {
    console.log("[ORACLE SYNC] Daily sync started");

    try {
      const result = await runOracleSync();
      console.log("[ORACLE SYNC] Daily sync completed:", result);
    } catch (e) {
      console.error("[ORACLE SYNC] Daily sync failed:", e.message || e);
    }
  });
}

module.exports = {
  startOracleSyncJob,
};