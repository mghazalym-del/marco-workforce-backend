// C:\MARCO-Workforce-App\backend\src\routes\workItemsControl.js

const express = require("express");
const router = express.Router();
const { pool } = require("../db");

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
      error: { code: "AUTH_MISSING", message: "Missing Authorization Bearer token" },
    });
  }

  const prefix = "DEV-TOKEN-";
  if (!token.startsWith(prefix)) {
    return res.status(401).json({
      success: false,
      error: { code: "AUTH_INVALID_TOKEN", message: "Invalid token format" },
    });
  }

  const employeeId = token.substring(prefix.length).trim();
  if (!employeeId) {
    return res.status(401).json({
      success: false,
      error: { code: "AUTH_INVALID_TOKEN", message: "Invalid token content" },
    });
  }

  req.user = { id: employeeId };
  next();
}

async function writeAudit({ workItemId, action, oldStatus, newStatus, actorId, details }) {
  await pool.query(
    `INSERT INTO task_audit_log(work_item_id, action, old_status, new_status, actor_id, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [workItemId, action, oldStatus || null, newStatus || null, actorId || null, details || null]
  );
}

/**
 * ACTIVATE
 * POST /api/v1/work-items/:id/activate
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

    const wi = await client.query(
      `SELECT work_item_id, task_status
       FROM work_items
       WHERE work_item_id = $1
       FOR UPDATE`,
      [workItemId]
    );

    if (wi.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    const row = wi.rows[0];
    if (row.task_status !== "INACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_STATUS", message: "Only INACTIVE tasks can be activated." },
      });
    }

    const upd = await client.query(
      `UPDATE work_items
       SET task_status = 'ACTIVE',
           activated_at = NOW(),
           activated_by = $2
       WHERE work_item_id = $1
       RETURNING work_item_id, task_status, activated_at, activated_by`,
      [workItemId, actorId]
    );

    await writeAudit({
      workItemId,
      action: "ACTIVATE",
      oldStatus: "INACTIVE",
      newStatus: "ACTIVE",
      actorId,
      details: { source: "desktop" },
    });

    await client.query("COMMIT");
    return res.json({ success: true, data: { work_item: upd.rows[0] } });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Activate failed.", details: String(e.message || e) },
    });
  } finally {
    client.release();
  }
});

//sssssss
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

///ssssss


/**
 * DEACTIVATE
 * POST /api/v1/work-items/:id/deactivate
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

    const wi = await client.query(
      `SELECT work_item_id, task_status
       FROM work_items
       WHERE work_item_id = $1
       FOR UPDATE`,
      [workItemId]
    );

    if (wi.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    const row = wi.rows[0];
    if (row.task_status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_STATUS", message: "Only ACTIVE tasks can be deactivated." },
      });
    }

    const upd = await client.query(
      `UPDATE work_items
       SET task_status = 'INACTIVE'
       WHERE work_item_id = $1
       RETURNING work_item_id, task_status`,
      [workItemId]
    );

    await writeAudit({
      workItemId,
      action: "DEACTIVATE",
      oldStatus: "ACTIVE",
      newStatus: "INACTIVE",
      actorId,
      details: { source: "desktop" },
    });

    await client.query("COMMIT");
    return res.json({ success: true, data: { work_item: upd.rows[0] } });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Deactivate failed.", details: String(e.message || e) },
    });
  } finally {
    client.release();
  }
});

/**
 * ASSIGN
 * POST /api/v1/work-items/:id/assign
 * body: { assigned_to_employee_id, notes? }
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
  const { assigned_to_employee_id, notes } = req.body || {};

  if (!assigned_to_employee_id || String(assigned_to_employee_id).trim() === "") {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "assigned_to_employee_id is required." },
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const wi = await client.query(
      `SELECT work_item_id, task_status
       FROM work_items
       WHERE work_item_id = $1
       FOR UPDATE`,
      [workItemId]
    );

    if (wi.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    const row = wi.rows[0];
    if (row.task_status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_STATUS", message: "Only ACTIVE tasks can be assigned." },
      });
    }

    // Leaf-only enforcement: check children using parent_work_item_id
    const children = await client.query(
      `SELECT 1 FROM work_items WHERE parent_work_item_id = $1 LIMIT 1`,
      [workItemId]
    );
    if (children.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: { code: "NOT_LEAF", message: "Only leaf tasks can be assigned." },
      });
    }

    const upd = await client.query(
      `UPDATE work_items
       SET task_status = 'ASSIGNED',
           assigned_to_employee_id = $2,
           assigned_by = $3,
           assigned_at = NOW()
       WHERE work_item_id = $1
       RETURNING work_item_id, task_status, assigned_to_employee_id, assigned_by, assigned_at`,
      [workItemId, String(assigned_to_employee_id).trim(), actorId]
    );

    await writeAudit({
      workItemId,
      action: "ASSIGN",
      oldStatus: "ACTIVE",
      newStatus: "ASSIGNED",
      actorId,
      details: { source: "desktop", assigned_to_employee_id, notes: notes || null },
    });

    await client.query("COMMIT");
    return res.json({ success: true, data: { work_item: upd.rows[0] } });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Assign failed.", details: String(e.message || e) },
    });
  } finally {
    client.release();
  }
});

/**
 * UNASSIGN
 * POST /api/v1/work-items/:id/unassign
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

    const wi = await client.query(
      `SELECT work_item_id, task_status, assigned_to_employee_id
       FROM work_items
       WHERE work_item_id = $1
       FOR UPDATE`,
      [workItemId]
    );

    if (wi.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Work item not found." },
      });
    }

    const row = wi.rows[0];
    if (row.task_status !== "ASSIGNED") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_STATUS", message: "Only ASSIGNED tasks can be unassigned." },
      });
    }

    const upd = await client.query(
      `UPDATE work_items
       SET task_status = 'ACTIVE',
           assigned_to_employee_id = NULL,
           assigned_by = NULL,
           assigned_at = NULL
       WHERE work_item_id = $1
       RETURNING work_item_id, task_status`,
      [workItemId]
    );

    await writeAudit({
      workItemId,
      action: "UNASSIGN",
      oldStatus: "ASSIGNED",
      newStatus: "ACTIVE",
      actorId,
      details: { source: "desktop", previously_assigned_to: row.assigned_to_employee_id },
    });

    await client.query("COMMIT");
    return res.json({ success: true, data: { work_item: upd.rows[0] } });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unassign failed.", details: String(e.message || e) },
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

    return res.json({ success: true, data: { history: r.rows } });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "History fetch failed.", details: String(e.message || e) },
    });
  }
});

module.exports = router;
