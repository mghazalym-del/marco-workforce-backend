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
      WITH candidate_days AS (
        SELECT DISTINCT
          ts.employee_id,
          ts.work_date,
          ts.project_id
        FROM task_session ts
        WHERE ts.project_id = $1
          AND ts.work_date BETWEEN $2 AND $3
      )
      SELECT
        cd.employee_id,
        e.full_name AS employee_name,
        cd.work_date,
        COALESCE(wd.day_status, 'OPEN') AS day_status,

        (
          SELECT COUNT(*)
          FROM task_session ts2
          WHERE ts2.employee_id = cd.employee_id
            AND ts2.work_date = cd.work_date
            AND ts2.project_id = cd.project_id
            AND UPPER(COALESCE(ts2.status, 'OPEN')) = 'OPEN'
        ) AS open_sessions,

        EXISTS (
          SELECT 1
          FROM worker_day_adjustment_run r
          WHERE r.employee_id = cd.employee_id
            AND r.work_date = cd.work_date
            AND r.project_id = cd.project_id
        ) AS already_generated

      FROM candidate_days cd
      LEFT JOIN employees e
        ON e.employee_id = cd.employee_id
      LEFT JOIN work_day wd
        ON wd.employee_id = cd.employee_id
      AND wd.work_date = cd.work_date

      ORDER BY cd.work_date, cd.employee_id
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