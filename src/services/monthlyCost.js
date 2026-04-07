const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/requireAuth");
const service = require("../services/monthlyCostService");

function employeeIdFromAuth(req) {
  const direct =
    req.employee_id ||
    req.employeeId ||
    (req.user && (req.user.employee_id || req.user.employeeId)) ||
    (req.auth && (req.auth.employee_id || req.auth.employeeId)) ||
    (req.claims && (req.claims.employee_id || req.claims.employeeId));

  if (direct) return String(direct);

  const h = req.headers.authorization || "";
  const m = h.match(/Bearer\s+DEV-TOKEN-([A-Za-z0-9_-]+)/i);
  if (m && m[1]) return String(m[1]);

  return null;
}

router.post("/validate", requireAuth, async (req, res) => {
  try {
    const actorId = employeeIdFromAuth(req);

    if (!actorId) {
      return res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Unauthorized",
        },
      });
    }

    const {
      project_id,
      cost_month,
      option_type,
    } = req.body || {};

    const data = await service.validateMonthlyCost({
      project_id,
      cost_month,
      option_type,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("[monthly-cost][POST /validate] error:", err);

    const msg = String(err.message || "");

    if (
      msg.includes("project_id is required") ||
      msg.includes("cost_month must be first day of month") ||
      msg.includes("option_type must be OPTION1 or OPTION2")
    ) {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: msg,
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "MONTHLY_COST_VALIDATE_FAILED",
        message: "Failed to validate monthly cost batch.",
      },
    });
  }
});

module.exports = router;