const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireAuth = require("../middleware/requireAuth");

// --- helpers ---
function normalizeRole(r) {
  return String(r || "").trim().toUpperCase();
}

async function getMyProfileFromToken(req) {
  // If requireAuth populated req.user BUT without role, do NOT return it.
  if (req.user && req.user.employee_id && req.user.role) return req.user;

  // Always fetch full profile (including role) from DB using employee_id from req.user if present
  let employeeId = req.user?.employee_id;

  // Fallback: parse DEV token
  if (!employeeId) {
    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+DEV-TOKEN-(.+)$/i);
    employeeId = m ? String(m[1]).trim() : "";
  }

  if (!employeeId) return null;

  const q = await pool.query(
    `SELECT employee_id, full_name, role, status, is_supervisor, supervisor_employee_id
       FROM employees
      WHERE employee_id = $1`,
    [employeeId]
  );
  return q.rows[0] || null;
}

async function requireAdmin(req, res, next) {
  try {
    const me = await getMyProfileFromToken(req);
    if (!me) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Missing/invalid token" },
      });
    }

    const role = normalizeRole(me.role);
    if (role !== "ADMIN") {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Admin role required" },
      });
    }

    req.user = me;
    return next();
  } catch (e) {
    console.error("[ADMIN] requireAdmin error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  }
}

// =============================
// GET /api/v1/admin/employees
// =============================
router.get("/employees", requireAuth, requireAdmin, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT employee_id, full_name, role, status, is_supervisor, supervisor_employee_id, position_title
         FROM employees
        ORDER BY employee_id`
    );
    return res.json({ success: true, data: { employees: q.rows } });
  } catch (e) {
    console.error("[ADMIN] list employees:", e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  }
});

// ============================================
// PATCH /api/v1/admin/employees/:employee_id
// Body: { role?, status?, supervisor_employee_id? , is_supervisor? }
// ============================================
router.patch("/employees/:employee_id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const employeeId = String(req.params.employee_id || "").trim();
    if (!employeeId) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "employee_id is required" },
      });
    }

    const body = req.body || {};
    const fields = [];
    const values = [];
    let idx = 1;

    if (body.role !== undefined) {
      fields.push(`role = $${idx++}`);
      values.push(String(body.role).trim());
    }

    if (body.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(String(body.status).trim());
    }

    if (body.supervisor_employee_id !== undefined) {
      const v = body.supervisor_employee_id;
      fields.push(`supervisor_employee_id = $${idx++}`);
      values.push(v ? String(v).trim() : null);
    }

    if (body.is_supervisor !== undefined) {
      fields.push(`is_supervisor = $${idx++}`);
      values.push(body.is_supervisor === true);
    }

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "No fields to update" },
      });
    }

    values.push(employeeId);

    const sql = `
      UPDATE employees
         SET ${fields.join(", ")},
             updated_at = NOW()
       WHERE employee_id = $${idx}
       RETURNING employee_id, full_name, role, status, is_supervisor, supervisor_employee_id, position_title
    `;

    const q = await pool.query(sql, values);
    if (q.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Employee not found" },
      });
    }

    return res.json({ success: true, data: { employee: q.rows[0] } });
  } catch (e) {
    console.error("[ADMIN] update employee:", e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  }
});



// =============================
// GET /api/v1/admin/supervisors
// (Needed by Desktop Supervisor Control UI)
// =============================
router.get("/supervisors", requireAuth, async (req, res) => {
  try {
    // Restrict access to Admin or Supervisor accounts
    const me = await getMyProfileFromToken(req);
    if (!me) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const role = String(me.role || "").toUpperCase();
    const isSup = !!me.is_supervisor;
    if (!(role === "ADMIN" || role === "SUPERVISOR" || isSup)) {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Forbidden" },
      });
    }

    const q = await pool.query(
      `SELECT employee_id, full_name, role, status, is_supervisor, supervisor_employee_id, position_title
         FROM employees
        WHERE COALESCE(is_supervisor,false) = true
           OR UPPER(COALESCE(role,'')) IN ('SUPERVISOR','ADMIN')
        ORDER BY employee_id`
    );

    return res.json({ success: true, data: { supervisors: q.rows } });
  } catch (e) {
    console.error("[ADMIN] list supervisors:", e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  }
});

module.exports = router;
