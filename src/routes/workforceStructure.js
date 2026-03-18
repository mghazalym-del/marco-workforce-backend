const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/requireAuth");
const workforceStructureService = require("../services/workforceStructureService");

router.get("/:projectId/tree", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!projectId || !projectId.trim()) {
      return res.status(400).json({
        success: false,
        error: {
          code: "PROJECT_ID_REQUIRED",
          message: "projectId is required.",
        },
      });
    }

    const data = await workforceStructureService.getProjectStructureTree(
      projectId.trim()
    );

    return res.json({
      success: true,
      data: {
        project_id: projectId.trim(),
        count: data.items.length,
        roots: data.tree.length,
        tree: data.tree,
      },
    });
  } catch (err) {
    console.error("GET /workforce-structure/:projectId/tree failed:", err);
    return res.status(500).json({
      success: false,
      error: {
        code: "WORKFORCE_STRUCTURE_TREE_FETCH_FAILED",
        message: "Failed to fetch workforce structure tree.",
      },
    });
  }
});

router.get("/:projectId", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!projectId || !projectId.trim()) {
      return res.status(400).json({
        success: false,
        error: {
          code: "PROJECT_ID_REQUIRED",
          message: "projectId is required.",
        },
      });
    }

    const rows = await workforceStructureService.getProjectStructure(
      projectId.trim()
    );

    return res.json({
      success: true,
      data: {
        project_id: projectId.trim(),
        count: rows.length,
        items: rows,
      },
    });
  } catch (err) {
    console.error("GET /workforce-structure/:projectId failed:", err);
    return res.status(500).json({
      success: false,
      error: {
        code: "WORKFORCE_STRUCTURE_FETCH_FAILED",
        message: "Failed to fetch workforce structure.",
      },
    });
  }
});

router.post("/reassign", requireAuth, async (req, res) => {
  try {
    const {
      project_id,
      employee_id,
      new_reports_to_employee_id,
      updated_by,
    } = req.body || {};

    if (!project_id || !employee_id || !new_reports_to_employee_id) {
      return res.status(400).json({
        success: false,
        error: {
          code: "PROJECT_EMPLOYEE_PARENT_REQUIRED",
          message:
              "project_id, employee_id, and new_reports_to_employee_id are required.",
        },
      });
    }

    const data = await workforceStructureService.reassignWorkforceNode({
      project_id,
      employee_id,
      new_reports_to_employee_id,
      updated_by: updated_by || null,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("POST /workforce-structure/reassign failed:", err);

    let code = "WORKFORCE_REASSIGN_FAILED";
    let message = "Failed to reassign workforce node.";

    if (err.message === "CHILD_NODE_NOT_FOUND") {
      code = "CHILD_NODE_NOT_FOUND";
      message = "Employee not found in project workforce structure.";
    } else if (err.message === "PARENT_NODE_NOT_FOUND") {
      code = "PARENT_NODE_NOT_FOUND";
      message = "New parent not found in project workforce structure.";
    } else if (err.message === "INVALID_HIERARCHY_RELATION") {
      code = "INVALID_HIERARCHY_RELATION";
      message =
          "Invalid hierarchy relation. Allowed: SE->PM, SUPERVISOR->SE, WORKER->SUPERVISOR.";
    } else if (err.message === "SELF_REPORTING_NOT_ALLOWED") {
      code = "SELF_REPORTING_NOT_ALLOWED";
      message = "Employee cannot report to self.";
    } else if (err.message === "CYCLE_NOT_ALLOWED") {
      code = "CYCLE_NOT_ALLOWED";
      message = "This reassignment would create a cycle in the hierarchy.";
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