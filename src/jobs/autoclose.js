function todayStrLocal() {
  const d = new Date();
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function endOfDayLocal(workDate) {
  const [y, m, d] = workDate.split("-").map((x) => parseInt(x, 10));
  return new Date(y, (m - 1), d, 23, 59, 59, 0);
}

async function computeDayRollup(client, employeeId, workDate) {
  const dayQ = await client.query(
    `SELECT assignment_day_id
     FROM assignment_day
     WHERE employee_id=$1 AND work_date=$2`,
    [employeeId, workDate]
  );

  if (dayQ.rowCount === 0) return;

  const assignment_day_id = dayQ.rows[0].assignment_day_id;

  const rollQ = await client.query(
    `SELECT
       COUNT(DISTINCT (project_id || '|' || task_id))::int AS distinct_tasks,
       BOOL_OR(scan_status='PendingApproval') AS has_pending
     FROM assignment_scan
     WHERE assignment_day_id=$1`,
    [assignment_day_id]
  );

  const distinctTasks = rollQ.rows[0]?.distinct_tasks ?? 0;
  const hasPending = Boolean(rollQ.rows[0]?.has_pending);
  const status = hasPending ? "PendingApproval" : (distinctTasks === 0 ? "NotAssigned" : "Accepted");

  await client.query(
    `UPDATE assignment_day
     SET total_tasks=$1, status=$2, updated_at=now()
     WHERE assignment_day_id=$3`,
    [distinctTasks, status, assignment_day_id]
  );
}

function startAutoClose(pool) {
  const enabled = String(process.env.AUTO_CLOSE_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return;

  const everyMin = parseInt(process.env.AUTO_CLOSE_INTERVAL_MINUTES || "5", 10);
  const intervalMs = Math.max(1, everyMin) * 60 * 1000;

  setInterval(async () => {
    const today = todayStrLocal();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const q = await client.query(
        `SELECT session_id, employee_id, work_date, start_ts
         FROM task_session
         WHERE status='OPEN' AND work_date < $1
         ORDER BY work_date ASC, start_ts ASC
         LIMIT 200
         FOR UPDATE`,
        [today]
      );

      for (const row of q.rows) {
        const endTs = endOfDayLocal(row.work_date);

        await client.query(
          `UPDATE task_session
           SET end_ts=$1,
               duration_minutes=GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1 - start_ts))/60)::int),
               status='CLOSED'
           WHERE session_id=$2`,
          [endTs, row.session_id]
        );

        await computeDayRollup(client, row.employee_id, row.work_date);
      }

      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      console.error("AUTO_CLOSE error:", e);
    } finally {
      client.release();
    }
  }, intervalMs);

  console.log(`🕒 AUTO_CLOSE enabled (every ${everyMin} min)`);
}

module.exports = { startAutoClose };
