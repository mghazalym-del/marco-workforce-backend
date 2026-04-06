const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/requireAuth");
const { runOracleSync } = require("../services/oraclePpmSyncService");

router.post("/sync", requireAuth, async (req, res) => {
  try {
    const result = await runOracleSync();

    return res.json({
      success: true,
      data: result,
    });
  } catch (e) {
    console.error("POST /oracle/sync error:", e);

    return res.status(500).json({
      success: false,
      error: {
        code: "ORACLE_SYNC_FAILED",
        message: e.message || "Oracle sync failed.",
      },
    });
  }
});

module.exports = router;