const { pool } = require("../db");

function buildDynamicFilters({
  from,
  to,
  employee_id,
  project_id,
  task_id,
  employeeField = "r.employee_id",
  projectField = "r.project_id",
  taskField = "d.task_id",
  dateField = "r.work_date",
}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (from) {
    conditions.push(`${dateField} >= $${idx++}`);
    values.push(from);
  }

  if (to) {
    conditions.push(`${dateField} <= $${idx++}`);
    values.push(to);
  }

  if (employee_id) {
    conditions.push(`${employeeField} = $${idx++}`);
    values.push(employee_id);
  }

  if (project_id) {
    conditions.push(`${projectField} = $${idx++}`);
    values.push(project_id);
  }

  if (task_id) {
    conditions.push(`${taskField} = $${idx++}`);
    values.push(task_id);
  }

  return { conditions, values };
}

/**
 * FINALIZED DAYS
 */
async function getFinalizedDays({
  from,
  to,
  employee_id,
  project_id,
}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  conditions.push(`wd.day_status = 'FINALIZED'`);

  if (from) {
    conditions.push(`wd.work_date >= $${idx++}`);
    values.push(from);
  }

  if (to) {
    conditions.push(`wd.work_date <= $${idx++}`);
    values.push(to);
  }

  if (employee_id) {
    conditions.push(`wd.employee_id = $${idx++}`);
    values.push(employee_id);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  let projectFilterSql = "";
  if (project_id) {
    projectFilterSql = `AND st.project_id = $${idx++}`;
    values.push(project_id);
  }

  const sql = `
    WITH finalized_days AS (
      SELECT
        wd.employee_id,
        wd.work_date,
        wd.day_status,
        wd.final_closed_at,
        wd.final_closed_by
      FROM public.work_day wd
      ${whereClause}
    ),
    session_totals AS (
      SELECT
        ts.employee_id,
        ts.work_date,
        ts.project_id,
        SUM(COALESCE(ts.duration_minutes, 0)) AS original_total_minutes
      FROM public.task_session ts
      GROUP BY
        ts.employee_id,
        ts.work_date,
        ts.project_id
    ),
    scan_counts AS (
      SELECT
        s.employee_id,
        s.work_date,
        s.project_id,
        COUNT(DISTINCT s.task_id) AS scanned_task_count
      FROM public.assignment_scan s
      WHERE s.scan_status = 'Accepted'
      GROUP BY
        s.employee_id,
        s.work_date,
        s.project_id
    )
    SELECT
      fd.employee_id,
      e.full_name AS employee_name,
      fd.work_date,
      st.project_id,
      fd.day_status,
      fd.final_closed_at,
      fd.final_closed_by,
      approver.full_name AS final_closed_by_name,
      COALESCE(st.original_total_minutes, 0) AS original_total_minutes,
      COALESCE(sc.scanned_task_count, 0) AS scanned_task_count
    FROM finalized_days fd
    JOIN public.employees e
      ON e.employee_id = fd.employee_id
    LEFT JOIN session_totals st
      ON st.employee_id = fd.employee_id
     AND st.work_date = fd.work_date
    LEFT JOIN scan_counts sc
      ON sc.employee_id = fd.employee_id
     AND sc.work_date = fd.work_date
     AND sc.project_id = st.project_id
    LEFT JOIN public.employees approver
      ON approver.employee_id = fd.final_closed_by
    WHERE st.project_id IS NOT NULL
      ${projectFilterSql}
    ORDER BY
      fd.work_date DESC,
      fd.employee_id ASC,
      st.project_id ASC
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

/**
 * REVIEW SUMMARY
 */
async function getDayAdjustmentReview({
  from,
  to,
  employee_id,
  project_id,
}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (from) {
    conditions.push(`r.work_date >= $${idx++}`);
    values.push(from);
  }

  if (to) {
    conditions.push(`r.work_date <= $${idx++}`);
    values.push(to);
  }

  if (employee_id) {
    conditions.push(`r.employee_id = $${idx++}`);
    values.push(employee_id);
  }

  if (project_id) {
    conditions.push(`r.project_id = $${idx++}`);
    values.push(project_id);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      r.adjustment_run_id,
      r.employee_id,
      e.full_name AS employee_name,
      r.work_date,
      r.project_id,
      r.work_day_status_snapshot,
      r.work_day_final_closed_at,
      r.work_day_final_closed_by,
      approver.full_name AS work_day_final_closed_by_name,
      r.original_total_minutes,
      r.target_total_minutes,
      r.missing_minutes,
      r.scanned_task_count,
      r.option1_generated,
      r.option2_generated,
      r.generated_at,
      r.generated_by,
      generator.full_name AS generated_by_name,

      o1.option1_hdr_id,
      o1.adjusted_total_minutes AS option1_adjusted_total_minutes,
      o1.added_to_last_task_minutes AS option1_added_to_last_task_minutes,
      o1.last_task_id AS option1_last_task_id,
      o1.calculation_status AS option1_status,

      o2.option2_hdr_id,
      o2.adjusted_total_minutes AS option2_adjusted_total_minutes,
      o2.distributed_minutes_per_task AS option2_distributed_minutes_per_task,
      o2.scanned_task_count AS option2_scanned_task_count,
      o2.calculation_status AS option2_status

    FROM public.worker_day_adjustment_run r
    JOIN public.employees e
      ON e.employee_id = r.employee_id
    LEFT JOIN public.employees approver
      ON approver.employee_id = r.work_day_final_closed_by
    LEFT JOIN public.employees generator
      ON generator.employee_id = r.generated_by
    LEFT JOIN public.worker_day_adjustment_option1_hdr o1
      ON o1.adjustment_run_id = r.adjustment_run_id
    LEFT JOIN public.worker_day_adjustment_option2_hdr o2
      ON o2.adjustment_run_id = r.adjustment_run_id
    ${whereClause}
    ORDER BY
      r.work_date DESC,
      r.employee_id ASC,
      r.project_id ASC,
      r.generated_at DESC
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

/**
 * OPTION 1 DETAILS
 */
async function getOption1Details({
  from,
  to,
  employee_id,
  project_id,
  task_id,
}) {
  const { conditions, values } = buildDynamicFilters({
    from,
    to,
    employee_id,
    project_id,
    task_id,
    employeeField: "r.employee_id",
    projectField: "r.project_id",
    taskField: "d.task_id",
    dateField: "r.work_date",
  });

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      r.adjustment_run_id,
      r.employee_id,
      e.full_name AS employee_name,
      r.work_date,
      r.project_id,

      d.task_id,
      d.sequence_no,
      d.original_minutes,
      d.added_minutes,
      d.adjusted_minutes,
      d.is_last_scanned_task

    FROM public.worker_day_adjustment_run r
    JOIN public.employees e
      ON e.employee_id = r.employee_id
    JOIN public.worker_day_adjustment_option1_hdr h
      ON h.adjustment_run_id = r.adjustment_run_id
    JOIN public.worker_day_adjustment_option1_dtl d
      ON d.option1_hdr_id = h.option1_hdr_id
    ${whereClause}
    ORDER BY
      r.work_date DESC,
      r.employee_id ASC,
      d.sequence_no ASC
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

/**
 * OPTION 2 DETAILS
 */
async function getOption2Details({
  from,
  to,
  employee_id,
  project_id,
  task_id,
}) {
  const { conditions, values } = buildDynamicFilters({
    from,
    to,
    employee_id,
    project_id,
    task_id,
    employeeField: "r.employee_id",
    projectField: "r.project_id",
    taskField: "d.task_id",
    dateField: "r.work_date",
  });

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      r.adjustment_run_id,
      r.employee_id,
      e.full_name AS employee_name,
      r.work_date,
      r.project_id,

      d.task_id,
      d.sequence_no,
      d.original_minutes,
      d.distributed_minutes,
      d.adjusted_minutes

    FROM public.worker_day_adjustment_run r
    JOIN public.employees e
      ON e.employee_id = r.employee_id
    JOIN public.worker_day_adjustment_option2_hdr h
      ON h.adjustment_run_id = r.adjustment_run_id
    JOIN public.worker_day_adjustment_option2_dtl d
      ON d.option2_hdr_id = h.option2_hdr_id
    ${whereClause}
    ORDER BY
      r.work_date DESC,
      r.employee_id ASC,
      d.sequence_no ASC
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

/**
 * OPTION 1 TASK SUMMARY
 */
async function getOption1TaskSummary({
  from,
  to,
  employee_id,
  project_id,
  task_id,
}) {
  const { conditions, values } = buildDynamicFilters({
    from,
    to,
    employee_id,
    project_id,
    task_id,
    employeeField: "r.employee_id",
    projectField: "r.project_id",
    taskField: "d.task_id",
    dateField: "r.work_date",
  });

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      r.project_id,
      d.task_id,
      COUNT(*) AS row_count,
      SUM(COALESCE(d.original_minutes, 0)) AS total_original_minutes,
      SUM(COALESCE(d.added_minutes, 0)) AS total_added_minutes,
      SUM(COALESCE(d.adjusted_minutes, 0)) AS total_adjusted_minutes
    FROM public.worker_day_adjustment_run r
    JOIN public.worker_day_adjustment_option1_hdr h
      ON h.adjustment_run_id = r.adjustment_run_id
    JOIN public.worker_day_adjustment_option1_dtl d
      ON d.option1_hdr_id = h.option1_hdr_id
    ${whereClause}
    GROUP BY
      r.project_id,
      d.task_id
    ORDER BY
      r.project_id ASC,
      d.task_id ASC
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

/**
 * OPTION 2 TASK SUMMARY
 */
async function getOption2TaskSummary({
  from,
  to,
  employee_id,
  project_id,
  task_id,
}) {
  const { conditions, values } = buildDynamicFilters({
    from,
    to,
    employee_id,
    project_id,
    task_id,
    employeeField: "r.employee_id",
    projectField: "r.project_id",
    taskField: "d.task_id",
    dateField: "r.work_date",
  });

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      r.project_id,
      d.task_id,
      COUNT(*) AS row_count,
      SUM(COALESCE(d.original_minutes, 0)) AS total_original_minutes,
      SUM(COALESCE(d.distributed_minutes, 0)) AS total_distributed_minutes,
      SUM(COALESCE(d.adjusted_minutes, 0)) AS total_adjusted_minutes
    FROM public.worker_day_adjustment_run r
    JOIN public.worker_day_adjustment_option2_hdr h
      ON h.adjustment_run_id = r.adjustment_run_id
    JOIN public.worker_day_adjustment_option2_dtl d
      ON d.option2_hdr_id = h.option2_hdr_id
    ${whereClause}
    GROUP BY
      r.project_id,
      d.task_id
    ORDER BY
      r.project_id ASC,
      d.task_id ASC
  `;

  const result = await pool.query(sql, values);
  return result.rows;
}

module.exports = {
  getFinalizedDays,
  getDayAdjustmentReview,
  getOption1Details,
  getOption2Details,
  getOption1TaskSummary,
  getOption2TaskSummary,
};