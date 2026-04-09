const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/requireAuth");
const service = require("../services/monthlyCostService");

function requireCostAccess(req, res) {
  const role = req.user?.role;

  if (!["PM", "COST_CONTROLLER"].includes(role)) {
    return res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Insufficient role" },
    });
  }

  return null;
}

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
    const deny = requireCostAccess(req, res);
    if (deny) return deny;

    const actorId = employeeIdFromAuth(req);
    if (!actorId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const { project_id, cost_month, option_type } = req.body || {};

    const data = await service.validateMonthlyCost({
      project_id,
      cost_month,
      option_type,
    });

    return res.json({ success: true, data });
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
        error: { code: "VALIDATION_ERROR", message: msg },
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

router.post("/generate", requireAuth, async (req, res) => {
  try {
    const deny = requireCostAccess(req, res);
    if (deny) return deny;

    const actorId = employeeIdFromAuth(req);
    if (!actorId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const { project_id, cost_month, option_type } = req.body || {};

    const data = await service.generateMonthlyCost({
      project_id,
      cost_month,
      option_type,
      actor_id: actorId,
    });

    if (!data.ready) {
      return res.status(409).json({
        success: false,
        error: {
          code: "MONTHLY_COST_BLOCKED",
          message: "Monthly cost generation is blocked by validation issues.",
        },
        data,
      });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[monthly-cost][POST /generate] error:", err);

    const msg = String(err.message || "");

    if (msg.includes("MONTH_ALREADY_APPROVED_LOCKED")) {
      return res.status(409).json({
        success: false,
        error: {
          code: "MONTH_LOCKED",
          message: "This month is already approved and cannot be regenerated.",
        },
      });
    }

    if (
      msg.includes("project_id is required") ||
      msg.includes("cost_month must be first day of month") ||
      msg.includes("option_type must be OPTION1 or OPTION2") ||
      msg.includes("actor_id is required")
    ) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: msg },
      });
    }

    if (msg.includes("Batch is already in status")) {
      return res.status(409).json({
        success: false,
        error: { code: "BATCH_STATUS_BLOCKED", message: msg },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "MONTHLY_COST_GENERATE_FAILED",
        message: "Failed to generate monthly cost batch.",
      },
    });
  }
});

router.get("/batches", requireAuth, async (req, res) => {
  try {
    const deny = requireCostAccess(req, res);
    if (deny) return deny;

    const data = await service.listBatches({
      project_id: req.query.project_id || null,
      cost_month: req.query.cost_month || null,
      option_type: req.query.option_type || null,
      status: req.query.status || null,
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[monthly-cost][GET /batches] error:", err);
    return res.status(500).json({
      success: false,
      error: {
        code: "MONTHLY_COST_BATCHES_FAILED",
        message: "Failed to load monthly cost batches.",
      },
    });
  }
});

router.get("/batches/:batch_id", requireAuth, async (req, res) => {
  try {
    const deny = requireCostAccess(req, res);
    if (deny) return deny;

    const data = await service.getBatchDetail(req.params.batch_id);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("[monthly-cost][GET /batches/:batch_id] error:", err);

    if (String(err.message || "") === "BATCH_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: { code: "BATCH_NOT_FOUND", message: "Batch not found." },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "MONTHLY_COST_BATCH_DETAIL_FAILED",
        message: "Failed to load monthly cost batch detail.",
      },
    });
  }
});

router.post("/batches/:batch_id/submit", requireAuth, async (req, res) => {
  try {
    const deny = requireCostAccess(req, res);
    if (deny) return deny;

    const actorId = employeeIdFromAuth(req);

    if (!actorId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const data = await service.submitBatch({
      batch_id: req.params.batch_id,
      actor_id: actorId,
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[monthly-cost][POST /submit] error:", err);
    const msg = String(err.message || "");

    if (msg === "BATCH_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: { code: "BATCH_NOT_FOUND", message: "Batch not found." },
      });
    }

    if (msg.startsWith("BATCH_SUBMIT_INVALID_STATUS:")) {
      return res.status(409).json({
        success: false,
        error: {
          code: "BATCH_SUBMIT_INVALID_STATUS",
          message: "Batch cannot be submitted from current status.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "MONTHLY_COST_SUBMIT_FAILED",
        message: "Failed to submit monthly cost batch.",
      },
    });
  }
});

router.post("/batches/:batch_id/approve", requireAuth, async (req, res) => {
  try {
    const deny = requireCostAccess(req, res);
    if (deny) return deny;

    const actorId = employeeIdFromAuth(req);
    if (!actorId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const { comments = null } = req.body || {};

    const data = await service.approveBatch({
      batch_id: req.params.batch_id,
      actor_id: actorId,
      comments,
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[monthly-cost][POST /approve] error:", err);
    const msg = String(err.message || "");

    if (msg === "BATCH_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: { code: "BATCH_NOT_FOUND", message: "Batch not found." },
      });
    }

    if (msg.startsWith("BATCH_APPROVE_INVALID_STATUS:")) {
      return res.status(409).json({
        success: false,
        error: {
          code: "BATCH_APPROVE_INVALID_STATUS",
          message: "Batch cannot be approved from current status.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "MONTHLY_COST_APPROVE_FAILED",
        message: "Failed to approve monthly cost batch.",
      },
    });
  }
});

router.post("/batches/:batch_id/reject", requireAuth, async (req, res) => {
  try {
    const deny = requireCostAccess(req, res);
    if (deny) return deny;

    const actorId = employeeIdFromAuth(req);
    if (!actorId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const { reason } = req.body || {};

    const data = await service.rejectBatch({
      batch_id: req.params.batch_id,
      actor_id: actorId,
      reason,
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[monthly-cost][POST /reject] error:", err);
    const msg = String(err.message || "");

    if (msg === "BATCH_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        error: { code: "BATCH_NOT_FOUND", message: "Batch not found." },
      });
    }

    if (msg === "reason is required") {
      return res.status(400).json({
        success: false,
        error: {
          code: "REJECT_REASON_REQUIRED",
          message: "Reject reason is required.",
        },
      });
    }

    if (msg.startsWith("BATCH_REJECT_INVALID_STATUS:")) {
      return res.status(409).json({
        success: false,
        error: {
          code: "BATCH_REJECT_INVALID_STATUS",
          message: "Batch cannot be rejected from current status.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "MONTHLY_COST_REJECT_FAILED",
        message: "Failed to reject monthly cost batch.",
      },
    });
  }
});

module.exports = router;