const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * Dev login (MVP)
 * Body: { employee_id: "E1001" }
 *
 * IMPORTANT:
 * - Mobile may treat is_supervisor as 1/0 (int), not boolean.
 * - So we normalize:
 *    profile.is_supervisor -> 1/0
 *    profile.is_supervisor_bool -> true/false
 * - We also provide profile.ui_mode for routing ("SUPERVISOR" / "WORKER")
 */
router.post("/login", async (req, res) => {
  try {
    const { employee_id } = req.body || {};
    const emp = String(employee_id || "").trim();

    if (!emp) {
      return res.status(400).json({
        success: false,
        error: { code: "AUTH_MISSING_EMPLOYEE", message: "employee_id is required" },
      });
    }

    const q = await pool.query(
      `SELECT employee_id, full_name, position_title, supervisor_employee_id, is_supervisor, status, role
         FROM employees
        WHERE employee_id = $1`,
      [emp]
    );

    if (q.rowCount === 0) {
      return res.status(401).json({
        success: false,
        error: { code: "AUTH_INVALID_EMPLOYEE", message: "Employee not found" },
      });
    }

    const profile = q.rows[0];

    // Normalize role
    const role = String(profile.role || "").toUpperCase();

    // Treat these roles as supervisor-capable (even if is_supervisor flag is missing)
    const supervisorRoles = new Set(["ADMIN", "SUPERVISOR", "SE", "PM"]);

    const isSupervisorBool =
      profile.is_supervisor === true || profile.is_supervisor === 1 || supervisorRoles.has(role);

    // 🔥 Compatibility: mobile may expect 1/0 not true/false
    const normalizedProfile = {
      ...profile,
      role,
      is_supervisor_bool: isSupervisorBool,
      is_supervisor: isSupervisorBool ? 1 : 0,
      ui_mode: isSupervisorBool ? "SUPERVISOR" : "WORKER",
    };

    const token = `DEV-TOKEN-${profile.employee_id}`;
    return res.json({ success: true, data: { token, profile: normalizedProfile } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  }
});

module.exports = router;
