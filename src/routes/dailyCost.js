// src/routes/dailyCost.js

const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/requireAuth");

const dailyCostService = require("../services/dailyCostService");

// VALIDATE
router.post("/validate", requireAuth, async (req, res) => {
  try {
    const { project_id, from, to } = req.body || {};

    const data = await dailyCostService.validateDailyCost({
      project_id,
      from,
      to,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("[daily-cost][validate] error:", err);

    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_FAILED",
        message: err.message,
      },
    });
  }
});

// GENERATE
router.post("/generate", requireAuth, async (req, res) => {
  try {
    const { project_id, from, to } = req.body || {};
    const generated_by = req.user?.employee_id;

    const data = await dailyCostService.generateDailyCost({
      project_id,
      from,
      to,
      generated_by,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("[daily-cost][generate] error:", err);

    return res.status(500).json({
      success: false,
      error: {
        code: "GENERATION_FAILED",
        message: err.message,
      },
    });
  }
});

module.exports = router;