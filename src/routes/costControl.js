const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/requireAuth");
const service = require("../services/costControlService");

function getFilters(req) {
  const {
    from,
    to,
    employee_id,
    project_id,
    task_id,
  } = req.query;

  return {
    from: from || null,
    to: to || null,
    employee_id: employee_id || null,
    project_id: project_id || null,
    task_id: task_id || null,
  };
}

/**
 * FINALIZED DAYS
 */
router.get("/finalized-days", requireAuth, async (req, res) => {
  try {
    const rows = await service.getFinalizedDays(getFilters(req));

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("FINALIZED DAYS ERROR:", err);
    res.status(500).json({
      success: false,
      error: {
        code: "FINALIZED_DAYS_FETCH_FAILED",
        message: "Failed to fetch finalized days.",
      },
    });
  }
});

/**
 * REVIEW SUMMARY
 */
router.get("/day-adjustment-review", requireAuth, async (req, res) => {
  try {
    const rows = await service.getDayAdjustmentReview(getFilters(req));

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("REVIEW ERROR:", err);
    res.status(500).json({
      success: false,
      error: {
        code: "DAY_ADJUSTMENT_REVIEW_FETCH_FAILED",
        message: "Failed to fetch day adjustment review.",
      },
    });
  }
});

/**
 * OPTION 1 DETAILS
 */
router.get("/option1-details", requireAuth, async (req, res) => {
  try {
    const rows = await service.getOption1Details(getFilters(req));

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("OPTION1 DETAILS ERROR:", err);
    res.status(500).json({
      success: false,
      error: {
        code: "OPTION1_DETAILS_FETCH_FAILED",
        message: "Failed to fetch Option 1 details.",
      },
    });
  }
});

/**
 * OPTION 2 DETAILS
 */
router.get("/option2-details", requireAuth, async (req, res) => {
  try {
    const rows = await service.getOption2Details(getFilters(req));

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("OPTION2 DETAILS ERROR:", err);
    res.status(500).json({
      success: false,
      error: {
        code: "OPTION2_DETAILS_FETCH_FAILED",
        message: "Failed to fetch Option 2 details.",
      },
    });
  }
});

/**
 * OPTION 1 TASK SUMMARY
 */
router.get("/option1-task-summary", requireAuth, async (req, res) => {
  try {
    const rows = await service.getOption1TaskSummary(getFilters(req));

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("OPTION1 TASK SUMMARY ERROR:", err);
    res.status(500).json({
      success: false,
      error: {
        code: "OPTION1_TASK_SUMMARY_FETCH_FAILED",
        message: "Failed to fetch Option 1 task summary.",
      },
    });
  }
});

/**
 * OPTION 2 TASK SUMMARY
 */
router.get("/option2-task-summary", requireAuth, async (req, res) => {
  try {
    const rows = await service.getOption2TaskSummary(getFilters(req));

    res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("OPTION2 TASK SUMMARY ERROR:", err);
    res.status(500).json({
      success: false,
      error: {
        code: "OPTION2_TASK_SUMMARY_FETCH_FAILED",
        message: "Failed to fetch Option 2 task summary.",
      },
    });
  }
});

module.exports = router;