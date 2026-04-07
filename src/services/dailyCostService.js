// src/services/dailyCostService.js

const { pool } = require("../db");
const dayAdjustmentsService = require("./dayAdjustmentsService");

// 🔍 VALIDATE
async function validateDailyCost({ project_id, from, to }) {
  if (!project_id) throw new Error("project_id is required");
  if (!from || !to) throw new Error("from and to dates are required");

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT 
        wd.employee_id,
        e.full_name AS employee_name,
        wd.work_date,
        wd.day_status,
        COUNT(ts.*) FILTER (WHERE ts.status = 'OPEN') AS open_sessions,

        EXISTS (
          SELECT 1 FROM worker_day_adjustment_option2_hdr hdr
          WHERE hdr.employee_id = wd.employee_id
          AND hdr.work_date = wd.work_date
          AND hdr.project_id = $1
        ) AS already_generated

      FROM work_day wd
      JOIN employees e ON e.employee_id = wd.employee_id
      LEFT JOIN task_session ts 
        ON ts.employee_id = wd.employee_id
        AND ts.work_date = wd.work_date

      WHERE wd.work_date BETWEEN $2 AND $3

      GROUP BY wd.employee_id, e.full_name, wd.work_date, wd.day_status
      ORDER BY wd.work_date, wd.employee_id
      `,
      [project_id, from, to]
    );

    const rows = result.rows.map((r) => {
      let eligible = true;
      let reason = null;

      if (r.day_status !== "FINALIZED") {
        eligible = false;
        reason = "DAY_NOT_FINALIZED";
      } else if (Number(r.open_sessions) > 0) {
        eligible = false;
        reason = "OPEN_SESSIONS_EXIST";
      } else if (r.already_generated) {
        eligible = false;
        reason = "ALREADY_GENERATED";
      }

      return {
        ...r,
        eligible,
        blocker_reason: reason,
      };
    });

    return rows;
  } finally {
    client.release();
  }
}

// 🚀 GENERATE
async function generateDailyCost({
  project_id,
  from,
  to,
  generated_by,
}) {
  const validation = await validateDailyCost({
    project_id,
    from,
    to,
  });

  let generated = 0;
  let skipped = 0;

  for (const row of validation) {
    if (!row.eligible) {
      skipped++;
      continue;
    }

    await dayAdjustmentsService.generateDayAdjustments({
      employee_id: row.employee_id,
      work_date: row.work_date,
      project_id,
      generated_by,
    });

    generated++;
  }

  return {
    total: validation.length,
    generated,
    skipped,
    validation,
  };
}

module.exports = {
  validateDailyCost,
  generateDailyCost,
};