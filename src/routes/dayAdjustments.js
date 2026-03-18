const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/requireAuth");
const dayAdjustmentsService = require("../services/dayAdjustmentsService");

router.post("/generate", requireAuth, async (req, res) => {
  try {
    const { employee_id, work_date, project_id, generated_by } = req.body || {};

    if (!employee_id || !work_date || !project_id) {
      return res.status(400).json({
        success: false,
        error: {
          code: "EMPLOYEE_WORKDATE_PROJECT_REQUIRED",
          message: "employee_id, work_date, and project_id are required.",
        },
      });
    }

    const data = await dayAdjustmentsService.generateDayAdjustments({
      employee_id,
      work_date,
      project_id,
      generated_by: generated_by || null,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("POST /day-adjustments/generate failed:", err);

    let code = "DAY_ADJUSTMENT_GENERATION_FAILED";
    let message = "Failed to generate day adjustments.";

    if (err.message === "WORK_DAY_NOT_FOUND") {
      code = "WORK_DAY_NOT_FOUND";
      message = "No work_day record found for the employee and date.";
    } else if (err.message === "WORK_DAY_NOT_FINALIZED") {
      code = "WORK_DAY_NOT_FINALIZED";
      message = "Day adjustment can only be generated for FINALIZED work_day.";
    } else if (err.message === "NO_TASK_SESSION_DATA") {
      code = "NO_TASK_SESSION_DATA";
      message = "No task_session data found for the employee/date/project.";
    } else if (err.message === "NO_ACCEPTED_SCAN_DATA") {
      code = "NO_ACCEPTED_SCAN_DATA";
      message = "No accepted assignment_scan data found for the employee/date/project.";
    }

    return res.status(500).json({
      success: false,
      error: {
        code,
        message,
      },
    });
  }
});

module.exports = router;
