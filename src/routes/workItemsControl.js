// C:\MARCO-Workforce-App\backend\src\routes\workItemsControl.js

const express = require("express");
const router = express.Router();
const { pool } = require("../db");

console.log("🔥 WORKITEMSCONTROL LOADED FROM:", __filename);

/**
 * Desktop-only auth (MVP)
 * Accepts Bearer DEV-TOKEN-E2001 style tokens.
 * Sets req.user = { id: "E2001" }
 */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";

  if (!token) {
    return res.status(401).json({
      success: false,
      error: {
        code: "AUTH_MISSING",
        message: "Missing Authorization Bearer token",
      },
    });
  }

  const prefix = "DEV-TOKEN-";
  if (!token.startsWith(prefix)) {
    return res.status(401).json({
      success: false,
      error: {
        code: "AUTH_INVALID_TOKEN",
        message: "Invalid token format",
      },
    });
  }

  const employeeId = token.substring(prefix.length).trim();
  if (!employeeId) {
    return res.status(401).json({
      success: false,
      error: {
        code: "AUTH_INVALID_TOKEN",
        message: "Invalid token content",
      },
    });
  }

  req.user = { id: employeeId };
  next();
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "").trim()
  );
}

async function writeAudit({
  workItemId,
  action,
  oldStatus,
  newStatus,
  actorId,
  details,
}) {
  await pool.query(
    `INSERT INTO task_audit_log(work_item_id, action, old_status, new_status, actor_id, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      workItemId,
      action,
      oldStatus || null,
      newStatus || null,
      actorId || null,
      details || null,
    ]
  );
}

async function getEmployeeRole(client, employeeId) {
  const r = await client.query(
    `SELECT role
       FROM employees
      WHERE employee_id = $1
      LIMIT 1`,
    [employeeId]
  );
  return String(r.rows[0]?.role || "").trim().toUpperCase();
}

async function requirePmRole(client, actorId) {
  const role = await getEmployeeRole(client, actorId);
  if (role !== "PM") {
    const err = new Error("PM_ONLY");
    err.httpStatus = 403;
    throw err;
  }
}

async function getWorkItemForUpdate(client, workItemId) {
  const r = await client.query(
    `SELECT
        work_item_id,
        project_code,
        parent_work_item_id,
        item_type,
        item_code,
        name,
        task_status,
        assigned_to_employee_id,
        assigned_by,
        assigned_at,
        activated_at,
        activated_by
     FROM work_items
     WHERE work_item_id = $1
     FOR UPDATE`,
    [workItemId]
  );
  return r.rows[0] || null;
}

async function getParentWorkItem(client, parentWorkItemId) {
  if (!parentWorkItemId) return null;

  const r = await client.query(
    `SELECT
        work_item_id,
        item_code,
        name,
        task_status
     FROM work_items
     WHERE work_item_id = $1
     LIMIT 1`,
    [parentWorkItemId]
  );

  return r.rows[0] || null;
}

async function hasChildren(client, workItemId) {
  const r = await client.query(
    `SELECT 1
       FROM work_items
      WHERE parent_work_item_id = $1
      LIMIT 1`,
    [workItemId]
  );
  return r.rowCount > 0;
}

async function getEmployeeBasic(client, employeeId) {
  const r = await client.query(
    `SELECT employee_id, full_name, role
       FROM employees
      WHERE employee_id = $1
      LIMIT 1`,
    [employeeId]
  );
  return r.rows[0] || null;
}

/**
 * ACTIVATE
 * POST /api/v1/work-items/:id/activate
 *
 * Rules:
 * - Only PM can activate
 * - Only INACTIVE tasks can be activated
 * - Parent/main task must already be ACTIVE (if parent exists)
 */
router.post("/:id/activate", requireAuth, async (req, res) => {
  const workItemId = String(req.params.id).trim();
  if (!isUuid(workItemId)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_ID", message: "work_item_id must be a UUID." },
    });
  }

  const actorId = req.user?.id || "unknown";
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await requirePmRole(client, actorId);

    const wi = await getWorkItemForUpdate(client, workItemId);

    console.log("[ACTIVATE] child row", {
      workItemId,
      item_code: wi?.item_code,
      task_status: wi?.task_status,
      parent_work_item_id: wi?.parent_work_item_id,
      actorId,
    });

    if (!wi) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    if (String(wi.task_status || "").toUpperCase() !== "INACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_STATUS",
          message: "Only INACTIVE tasks can be activated.",
        },
      });
    }

    if (wi.parent_work_item_id) {
      const parent = await getParentWorkItem(client, wi.parent_work_item_id);

      console.log("[ACTIVATE] parent row", parent);

      if (!parent) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: {
            code: "PARENT_NOT_FOUND",
            message: "Parent task not found.",
          },
        });
      }

      if (String(parent.task_status || "").toUpperCase() !== "ACTIVE") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: {
            code: "PARENT_NOT_ACTIVE",
            message:
              "Parent/main task must be ACTIVE before activating this task.",
          },
        });
      }
    }

    const upd = await client.query(
      `UPDATE work_items
          SET task_status = 'ACTIVE',
              activated_at = NOW(),
              activated_by = $2
        WHERE work_item_id = $1
      RETURNING
          work_item_id,
          project_code,
          parent_work_item_id,
          item_code,
          name,
          task_status,
          activated_at,
          activated_by`,
      [workItemId, actorId]
    );

    await writeAudit({
      workItemId,
      action: "ACTIVATE",
      oldStatus: "INACTIVE",
      newStatus: "ACTIVE",
      actorId,
      details: {
        source: "desktop",
        rule: "PM_ONLY",
        parent_required_active: true,
      },
    });

    await client.query("COMMIT");
    return res.json({
      success: true,
      data: {
        work_item: upd.rows[0],
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");

    if (e.message === "PM_ONLY") {
      return res.status(403).json({
        success: false,
        error: {
          code: "PM_ONLY",
          message: "Only Project Manager can activate tasks.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "SERVER_ERROR",
        message: "Activate failed.",
        details: String(e.message || e),
      },
    });
  } finally {
    client.release();
  }
});

/**
 * DEACTIVATE
 * POST /api/v1/work-items/:id/deactivate
 *
 * Rules:
 * - Only PM can deactivate
 * - Only ACTIVE tasks can be deactivated
 * - Block deactivation if task is assigned
 */
router.post("/:id/deactivate", requireAuth, async (req, res) => {
  const workItemId = String(req.params.id).trim();
  if (!isUuid(workItemId)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_ID", message: "work_item_id must be a UUID." },
    });
  }

  const actorId = req.user?.id || "unknown";
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await requirePmRole(client, actorId);

    const wi = await getWorkItemForUpdate(client, workItemId);
    if (!wi) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    if (String(wi.task_status || "").toUpperCase() !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_STATUS",
          message: "Only ACTIVE tasks can be deactivated.",
        },
      });
    }

    if (wi.assigned_to_employee_id) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: {
          code: "TASK_ASSIGNED",
          message:
            "Task cannot be deactivated while it is assigned. Unassign it first.",
        },
      });
    }

    const upd = await client.query(
      `UPDATE work_items
          SET task_status = 'INACTIVE'
        WHERE work_item_id = $1
      RETURNING
          work_item_id,
          project_code,
          parent_work_item_id,
          item_code,
          name,
          task_status`,
      [workItemId]
    );

    await writeAudit({
      workItemId,
      action: "DEACTIVATE",
      oldStatus: "ACTIVE",
      newStatus: "INACTIVE",
      actorId,
      details: {
        source: "desktop",
        rule: "PM_ONLY",
      },
    });

    await client.query("COMMIT");
    return res.json({
      success: true,
      data: {
        work_item: upd.rows[0],
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");

    if (e.message === "PM_ONLY") {
      return res.status(403).json({
        success: false,
        error: {
          code: "PM_ONLY",
          message: "Only Project Manager can deactivate tasks.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "SERVER_ERROR",
        message: "Deactivate failed.",
        details: String(e.message || e),
      },
    });
  } finally {
    client.release();
  }
});

/**
 * ASSIGN
 * POST /api/v1/work-items/:id/assign
 *
 * Accepted body:
 * - { assigned_to_employee_id }
 * - { se_employee_id }
 * - { notes? }
 *
 * Rules:
 * - Only PM can assign
 * - Only ACTIVE tasks can be assigned
 * - Only leaf tasks can be assigned
 * - Assignee must be SE
 */
router.post("/:id/assign", requireAuth, async (req, res) => {
  const workItemId = String(req.params.id).trim();
  if (!isUuid(workItemId)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_ID", message: "work_item_id must be a UUID." },
    });
  }

  const actorId = req.user?.id || "unknown";
  const body = req.body || {};

  const assignedTo = String(
    body.se_employee_id || body.assigned_to_employee_id || ""
  ).trim();

  const notes = body.notes || null;

  if (!assignedTo) {
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "se_employee_id or assigned_to_employee_id is required.",
      },
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await requirePmRole(client, actorId);

    const wi = await getWorkItemForUpdate(client, workItemId);
    if (!wi) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    if (String(wi.task_status || "").toUpperCase() !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_STATUS",
          message: "Only ACTIVE tasks can be assigned.",
        },
      });
    }

    const childrenExist = await hasChildren(client, workItemId);
    if (childrenExist) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: {
          code: "NOT_LEAF",
          message: "Only leaf tasks can be assigned.",
        },
      });
    }

    const assignee = await getEmployeeBasic(client, assignedTo);
    if (!assignee) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: {
          code: "ASSIGNEE_NOT_FOUND",
          message: "Assigned employee not found.",
        },
      });
    }

    if (String(assignee.role || "").toUpperCase() !== "SE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: {
          code: "ASSIGNEE_NOT_SE",
          message: "Task can only be assigned to Site Engineer (SE).",
        },
      });
    }

    const upd = await client.query(
      `UPDATE work_items
          SET task_status = 'ASSIGNED',
              assigned_to_employee_id = $2,
              assigned_by = $3,
              assigned_at = NOW()
        WHERE work_item_id = $1
      RETURNING
          work_item_id,
          project_code,
          parent_work_item_id,
          item_code,
          name,
          task_status,
          assigned_to_employee_id,
          assigned_by,
          assigned_at`,
      [workItemId, assignedTo, actorId]
    );

    await writeAudit({
      workItemId,
      action: "ASSIGN",
      oldStatus: "ACTIVE",
      newStatus: "ASSIGNED",
      actorId,
      details: {
        source: "desktop",
        assigned_to_employee_id: assignedTo,
        assigned_to_role: assignee.role,
        notes,
        rule: "PM_TO_SE",
      },
    });

    await client.query("COMMIT");
    return res.json({
      success: true,
      data: {
        work_item: upd.rows[0],
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");

    if (e.message === "PM_ONLY") {
      return res.status(403).json({
        success: false,
        error: {
          code: "PM_ONLY",
          message: "Only Project Manager can assign tasks.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "SERVER_ERROR",
        message: "Assign failed.",
        details: String(e.message || e),
      },
    });
  } finally {
    client.release();
  }
});

/**
 * UNASSIGN
 * POST /api/v1/work-items/:id/unassign
 *
 * Rules:
 * - Only PM can unassign
 * - Only ASSIGNED tasks can be unassigned
 */
router.post("/:id/unassign", requireAuth, async (req, res) => {
  const workItemId = String(req.params.id).trim();
  if (!isUuid(workItemId)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_ID", message: "work_item_id must be a UUID." },
    });
  }

  const actorId = req.user?.id || "unknown";
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await requirePmRole(client, actorId);

    const wi = await getWorkItemForUpdate(client, workItemId);
    if (!wi) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    if (String(wi.task_status || "").toUpperCase() !== "ASSIGNED") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_STATUS",
          message: "Only ASSIGNED tasks can be unassigned.",
        },
      });
    }

    const upd = await client.query(
      `UPDATE work_items
          SET task_status = 'ACTIVE',
              assigned_to_employee_id = NULL,
              assigned_by = NULL,
              assigned_at = NULL
        WHERE work_item_id = $1
      RETURNING
          work_item_id,
          project_code,
          parent_work_item_id,
          item_code,
          name,
          task_status`,
      [workItemId]
    );

    await writeAudit({
      workItemId,
      action: "UNASSIGN",
      oldStatus: "ASSIGNED",
      newStatus: "ACTIVE",
      actorId,
      details: {
        source: "desktop",
        previously_assigned_to: wi.assigned_to_employee_id,
        rule: "PM_ONLY",
      },
    });

    await client.query("COMMIT");
    return res.json({
      success: true,
      data: {
        work_item: upd.rows[0],
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");

    if (e.message === "PM_ONLY") {
      return res.status(403).json({
        success: false,
        error: {
          code: "PM_ONLY",
          message: "Only Project Manager can unassign tasks.",
        },
      });
    }

    return res.status(500).json({
      success: false,
      error: {
        code: "SERVER_ERROR",
        message: "Unassign failed.",
        details: String(e.message || e),
      },
    });
  } finally {
    client.release();
  }
});

/**
 * HISTORY
 * GET /api/v1/work-items/:id/history
 */
router.get("/:id/history", requireAuth, async (req, res) => {
  const workItemId = String(req.params.id).trim();
  if (!isUuid(workItemId)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_ID", message: "work_item_id must be a UUID." },
    });
  }

  try {
    const r = await pool.query(
      `SELECT id, action, old_status, new_status, actor_id, details, created_at
         FROM task_audit_log
        WHERE work_item_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [workItemId]
    );

    return res.json({
      success: true,
      data: { history: r.rows },
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: {
        code: "SERVER_ERROR",
        message: "History fetch failed.",
        details: String(e.message || e),
      },
    });
  }
});

module.exports = router;