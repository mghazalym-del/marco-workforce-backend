const { pool } = require("../db");

async function generateDayAdjustments({ employee_id, work_date, project_id, generated_by }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) Check eligibility from work_day
    const workDaySql = `
      SELECT
        employee_id,
        work_date,
        day_status,
        final_closed_at,
        final_closed_by
      FROM public.work_day
      WHERE employee_id = $1
        AND work_date = $2
    `;
    const workDayRes = await client.query(workDaySql, [employee_id, work_date]);

    if (workDayRes.rowCount === 0) {
      throw new Error("WORK_DAY_NOT_FOUND");
    }

    const workDay = workDayRes.rows[0];

    if (workDay.day_status !== "FINALIZED") {
      throw new Error("WORK_DAY_NOT_FINALIZED");
    }

    // 2) Delete previous generated data for same employee/day/project
    const existingRunRes = await client.query(
      `
      SELECT adjustment_run_id
      FROM public.worker_day_adjustment_run
      WHERE employee_id = $1
        AND work_date = $2
        AND project_id = $3
      `,
      [employee_id, work_date, project_id]
    );

    if (existingRunRes.rowCount > 0) {
      const existingRunId = existingRunRes.rows[0].adjustment_run_id;

      await client.query(
        `DELETE FROM public.worker_day_adjustment_option1_hdr WHERE adjustment_run_id = $1`,
        [existingRunId]
      );
      await client.query(
        `DELETE FROM public.worker_day_adjustment_option2_hdr WHERE adjustment_run_id = $1`,
        [existingRunId]
      );
      await client.query(
        `DELETE FROM public.worker_day_adjustment_run WHERE adjustment_run_id = $1`,
        [existingRunId]
      );
    }

    // 3) Read original task totals from task_session
    const taskTotalsSql = `
      SELECT
        ts.employee_id,
        ts.work_date,
        ts.project_id,
        ts.task_id,
        MIN(ts.start_ts) AS first_scan_at,
        MAX(COALESCE(ts.end_ts, ts.start_ts)) AS last_scan_at,
        SUM(COALESCE(ts.duration_minutes, 0)) AS original_minutes
      FROM public.task_session ts
      WHERE ts.employee_id = $1
        AND ts.work_date = $2
        AND ts.project_id = $3
      GROUP BY
        ts.employee_id,
        ts.work_date,
        ts.project_id,
        ts.task_id
      ORDER BY
        ts.task_id
    `;
    const taskTotalsRes = await client.query(taskTotalsSql, [employee_id, work_date, project_id]);
    const taskTotals = taskTotalsRes.rows;

    if (taskTotals.length === 0) {
      throw new Error("NO_TASK_SESSION_DATA");
    }

    // 4) Read accepted scans to determine scan order and last scanned task
    const scansSql = `
      SELECT
        s.task_id,
        s.scan_timestamp_device,
        s.scan_timestamp_server
      FROM public.assignment_scan s
      WHERE s.employee_id = $1
        AND s.work_date = $2
        AND s.project_id = $3
        AND s.scan_status = 'Accepted'
      ORDER BY
        s.scan_timestamp_device ASC,
        s.scan_timestamp_server ASC
    `;
    const scansRes = await client.query(scansSql, [employee_id, work_date, project_id]);
    const scans = scansRes.rows;

    if (scans.length === 0) {
      throw new Error("NO_ACCEPTED_SCAN_DATA");
    }

    const distinctScannedTaskIds = [...new Set(scans.map((x) => x.task_id))];
    const scannedTaskCount = distinctScannedTaskIds.length;
    const lastScannedTaskId = scans[scans.length - 1].task_id;

    const taskTotalsMap = new Map();
    for (const row of taskTotals) {
      taskTotalsMap.set(row.task_id, {
        task_id: row.task_id,
        original_minutes: Number(row.original_minutes || 0),
        first_scan_at: row.first_scan_at,
        last_scan_at: row.last_scan_at,
      });
    }

    // Ensure any scanned task with no session total still appears
    for (const taskId of distinctScannedTaskIds) {
      if (!taskTotalsMap.has(taskId)) {
        taskTotalsMap.set(taskId, {
          task_id: taskId,
          original_minutes: 0,
          first_scan_at: null,
          last_scan_at: null,
        });
      }
    }

    const taskRows = Array.from(taskTotalsMap.values());
    const originalTotalMinutes = taskRows.reduce((sum, row) => sum + Number(row.original_minutes || 0), 0);
    const targetTotalMinutes = 480;
    const missingMinutes = Math.max(0, targetTotalMinutes - originalTotalMinutes);

    // 5) Create adjustment run
    const runInsertSql = `
      INSERT INTO public.worker_day_adjustment_run
      (
        employee_id,
        work_date,
        project_id,
        work_day_status_snapshot,
        work_day_final_closed_at,
        work_day_final_closed_by,
        original_total_minutes,
        target_total_minutes,
        missing_minutes,
        scanned_task_count,
        option1_generated,
        option2_generated,
        generated_by,
        remarks
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,$11,$12)
      RETURNING adjustment_run_id
    `;
    const runInsertRes = await client.query(runInsertSql, [
      employee_id,
      work_date,
      project_id,
      workDay.day_status,
      workDay.final_closed_at,
      workDay.final_closed_by,
      originalTotalMinutes,
      targetTotalMinutes,
      missingMinutes,
      scannedTaskCount,
      generated_by || null,
      "Generated by day adjustment engine",
    ]);

    const adjustment_run_id = runInsertRes.rows[0].adjustment_run_id;

    // =========================
    // OPTION 1
    // =========================
    let option1AdjustedTotal = originalTotalMinutes;
    let option1AddedToLastTask = 0;

    const option1Details = taskRows.map((row, index) => {
      let added_minutes = 0;
      let adjusted_minutes = Number(row.original_minutes || 0);

      if (originalTotalMinutes < targetTotalMinutes && row.task_id === lastScannedTaskId) {
        added_minutes = missingMinutes;
        adjusted_minutes += missingMinutes;
        option1AddedToLastTask = missingMinutes;
      }

      return {
        sequence_no: index + 1,
        task_id: row.task_id,
        original_minutes: Number(row.original_minutes || 0),
        added_minutes,
        adjusted_minutes,
        is_last_scanned_task: row.task_id === lastScannedTaskId,
        first_scan_at: row.first_scan_at,
        last_scan_at: row.last_scan_at,
      };
    });

    if (originalTotalMinutes < targetTotalMinutes) {
      option1AdjustedTotal = targetTotalMinutes;
    }

    const option1HdrRes = await client.query(
      `
      INSERT INTO public.worker_day_adjustment_option1_hdr
      (
        adjustment_run_id,
        employee_id,
        work_date,
        project_id,
        original_total_minutes,
        adjusted_total_minutes,
        added_to_last_task_minutes,
        last_task_id,
        calculation_status,
        created_by,
        remarks
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,'GENERATED',$9,$10)
      RETURNING option1_hdr_id
      `,
      [
        adjustment_run_id,
        employee_id,
        work_date,
        project_id,
        originalTotalMinutes,
        option1AdjustedTotal,
        option1AddedToLastTask,
        lastScannedTaskId,
        generated_by || null,
        "Option 1 generated",
      ]
    );

    const option1_hdr_id = option1HdrRes.rows[0].option1_hdr_id;

    for (const row of option1Details) {
      await client.query(
        `
        INSERT INTO public.worker_day_adjustment_option1_dtl
        (
          option1_hdr_id,
          employee_id,
          work_date,
          project_id,
          task_id,
          sequence_no,
          is_last_scanned_task,
          original_minutes,
          added_minutes,
          adjusted_minutes,
          first_scan_at,
          last_scan_at
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `,
        [
          option1_hdr_id,
          employee_id,
          work_date,
          project_id,
          row.task_id,
          row.sequence_no,
          row.is_last_scanned_task,
          row.original_minutes,
          row.added_minutes,
          row.adjusted_minutes,
          row.first_scan_at,
          row.last_scan_at,
        ]
      );
    }

    // =========================
    // OPTION 2
    // =========================
    let distributedMinutesPerTask = 0;
    let option2AdjustedTotal = originalTotalMinutes;

    if (originalTotalMinutes < targetTotalMinutes && scannedTaskCount > 0) {
      distributedMinutesPerTask = Number((targetTotalMinutes / scannedTaskCount).toFixed(2));
      option2AdjustedTotal = targetTotalMinutes;
    }

    const option2Details = distinctScannedTaskIds.map((taskId, index) => {
      const row = taskTotalsMap.get(taskId) || {
        task_id: taskId,
        original_minutes: 0,
        first_scan_at: null,
        last_scan_at: null,
      };

      let distributed_minutes = 0;
      let adjusted_minutes = Number(row.original_minutes || 0);

      if (originalTotalMinutes < targetTotalMinutes && scannedTaskCount > 0) {
        distributed_minutes = distributedMinutesPerTask;
        adjusted_minutes = distributedMinutesPerTask;
      }

      return {
        sequence_no: index + 1,
        task_id: taskId,
        original_minutes: Number(row.original_minutes || 0),
        distributed_minutes,
        adjusted_minutes,
        first_scan_at: row.first_scan_at,
        last_scan_at: row.last_scan_at,
      };
    });

    const option2HdrRes = await client.query(
      `
      INSERT INTO public.worker_day_adjustment_option2_hdr
      (
        adjustment_run_id,
        employee_id,
        work_date,
        project_id,
        original_total_minutes,
        adjusted_total_minutes,
        scanned_task_count,
        distributed_minutes_per_task,
        calculation_status,
        created_by,
        remarks
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,'GENERATED',$9,$10)
      RETURNING option2_hdr_id
      `,
      [
        adjustment_run_id,
        employee_id,
        work_date,
        project_id,
        originalTotalMinutes,
        option2AdjustedTotal,
        scannedTaskCount,
        distributedMinutesPerTask,
        generated_by || null,
        "Option 2 generated",
      ]
    );

    const option2_hdr_id = option2HdrRes.rows[0].option2_hdr_id;

    for (const row of option2Details) {
      await client.query(
        `
        INSERT INTO public.worker_day_adjustment_option2_dtl
        (
          option2_hdr_id,
          employee_id,
          work_date,
          project_id,
          task_id,
          sequence_no,
          original_minutes,
          distributed_minutes,
          adjusted_minutes,
          first_scan_at,
          last_scan_at
        )
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `,
        [
          option2_hdr_id,
          employee_id,
          work_date,
          project_id,
          row.task_id,
          row.sequence_no,
          row.original_minutes,
          row.distributed_minutes,
          row.adjusted_minutes,
          row.first_scan_at,
          row.last_scan_at,
        ]
      );
    }

    // 6) Mark run generated
    await client.query(
      `
      UPDATE public.worker_day_adjustment_run
      SET option1_generated = TRUE,
          option2_generated = TRUE
      WHERE adjustment_run_id = $1
      `,
      [adjustment_run_id]
    );

    await client.query("COMMIT");

    return {
      adjustment_run_id,
      employee_id,
      work_date,
      project_id,
      original_total_minutes: originalTotalMinutes,
      target_total_minutes: targetTotalMinutes,
      missing_minutes: missingMinutes,
      scanned_task_count: scannedTaskCount,
      option1: {
        added_to_last_task_minutes: option1AddedToLastTask,
        last_task_id: lastScannedTaskId,
        adjusted_total_minutes: option1AdjustedTotal,
      },
      option2: {
        distributed_minutes_per_task: distributedMinutesPerTask,
        adjusted_total_minutes: option2AdjustedTotal,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  generateDayAdjustments,
};
