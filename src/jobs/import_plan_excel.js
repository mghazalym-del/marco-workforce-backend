require("dotenv").config();

/* eslint-disable no-console */
const path = require("path");
const xlsx = require("xlsx");
const { pool } = require("../db");

function normalizeTaskNumber(v, topLevelWidth = 2) {
  if (v === null || v === undefined || v === "") return null;

  // Excel sometimes stores Parent Task Number as numeric (1, 2, 3...)
  if (typeof v === "number") {
    const n = String(Math.trunc(v));
    return n.padStart(topLevelWidth, "0");
  }

  const s = String(v).trim();
  if (!s) return null;

  // If someone typed 1 instead of 01
  if (/^\d+$/.test(s)) return s.padStart(topLevelWidth, "0");
  return s;
}

async function ensureProjectExists(projectCode) {
  const q = await pool.query(`SELECT project_code FROM projects WHERE project_code = $1`, [projectCode]);
  if (q.rowCount === 0) {
    throw new Error(`Project code ${projectCode} not found in projects table. Insert PRJ001 first.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find(a => a.startsWith("--file="));
  const projArg = args.find(a => a.startsWith("--project_code="));
  const purge = args.includes("--purge");

  if (!fileArg || !projArg) {
    console.log(`Usage:
node scripts/import_plan_excel.js --file="C:\\path\\plan.xlsx" --project_code=PRJ001 [--purge]`);
    process.exit(1);
  }

  const filePath = fileArg.split("=").slice(1).join("=");
  const projectCode = projArg.split("=").slice(1).join("=").trim();

  await ensureProjectExists(projectCode);

  const wb = xlsx.readFile(path.resolve(filePath));
  const ws = wb.Sheets["Tasks"];
  if (!ws) throw new Error(`Sheet "Tasks" not found`);

  // Your sheet has headers on row 4 (1-based). xlsx range can skip first 3 rows.
  const rows = xlsx.utils.sheet_to_json(ws, { range: 3, defval: null });

  // Columns in your file:
  // *Project Name, Project Number, *Task Name, *Task Number, Parent Task Number, Planned Start Date, Planned End Date, ...
  const items = rows
    .filter(r => r["*Task Number"] && r["*Task Name"])
    .map(r => ({
      taskNumberRaw: r["*Task Number"],
      taskNumber: String(r["*Task Number"]).trim(),
      name: String(r["*Task Name"]).trim(),
      parentRaw: r["Parent Task Number"],
      plannedStart: r["Planned Start Date"] || null,
      plannedEnd: r["Planned End Date"] || null,
    }));

  if (items.length === 0) throw new Error("No tasks found in Excel.");

  // Determine top-level width based on top-level codes found (e.g., 01, 02, 10)
  const topLevels = items
    .map(x => x.taskNumber)
    .filter(n => !String(n).includes("-"));
  const topLevelWidth = Math.max(2, ...topLevels.map(n => String(n).length));

  // Normalize parent codes
  for (const it of items) {
   it.taskNumber = normalizeTaskNumber(it.taskNumber, topLevelWidth) || it.taskNumber;
  it.parentTaskNumber = normalizeTaskNumber(it.parentRaw, topLevelWidth);

  // IMPORTANT: In your Excel, top-level rows sometimes have parent = self (e.g., 01 -> 01).
  // Treat that as "no parent".
  if (it.parentTaskNumber && it.parentTaskNumber === it.taskNumber) {
    it.parentTaskNumber = null;
  }
  }

  // Optional purge (re-import clean)
  if (purge) {
    console.log(`[IMPORT] Purging existing work_items for ${projectCode}...`);
    await pool.query(`DELETE FROM work_items WHERE project_code = $1`, [projectCode]);
  }

  console.log(`[IMPORT] Importing ${items.length} rows into work_items for ${projectCode}...`);

  // 1) Insert top-level tasks first (no parent)
  const idMap = new Map(); // taskNumber -> work_item_id

  await pool.query("BEGIN");

  try {
    const top = items.filter(x => !x.parentTaskNumber);

    for (const it of top) {
      const itemType = "TASK";
      const status = "DRAFT";

      const ins = await pool.query(
        `INSERT INTO work_items
          (project_code, parent_work_item_id, item_type, item_code, name,
           planned_start, planned_end, planned_duration_days, status)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, NULL, $7)
         ON CONFLICT (project_code, item_code)
         DO UPDATE SET
           name = EXCLUDED.name,
           planned_start = EXCLUDED.planned_start,
           planned_end = EXCLUDED.planned_end,
           updated_at = NOW()
         RETURNING work_item_id`,
        [projectCode, itemType, it.taskNumber, it.name, it.plannedStart, it.plannedEnd, status]
      );

      idMap.set(it.taskNumber, ins.rows[0].work_item_id);
    }

    // 2) Insert children (subtasks) - repeat until no progress (handles multi-level)
    let remaining = items.filter(x => x.parentTaskNumber);
    let safety = 0;

    while (remaining.length > 0) {
      safety++;
      if (safety > 20) throw new Error("Hierarchy too deep or parent mapping failed.");

      const nextRemaining = [];
      let progress = 0;

      for (const it of remaining) {
        const parentId = idMap.get(it.parentTaskNumber);
        if (!parentId) {
          nextRemaining.push(it);
          continue;
        }

        const itemType = "SUBTASK";
        const status = "DRAFT";

        const ins = await pool.query(
          `INSERT INTO work_items
            (project_code, parent_work_item_id, item_type, item_code, name,
             planned_start, planned_end, planned_duration_days, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
           ON CONFLICT (project_code, item_code)
           DO UPDATE SET
             parent_work_item_id = EXCLUDED.parent_work_item_id,
             name = EXCLUDED.name,
             planned_start = EXCLUDED.planned_start,
             planned_end = EXCLUDED.planned_end,
             updated_at = NOW()
           RETURNING work_item_id`,
          [projectCode, parentId, itemType, it.taskNumber, it.name, it.plannedStart, it.plannedEnd, status]
        );

        idMap.set(it.taskNumber, ins.rows[0].work_item_id);
        progress++;
      }

      if (progress === 0) {
        const sample = nextRemaining.slice(0, 10).map(x => ({ task: x.taskNumber, parent: x.parentTaskNumber }));
        throw new Error(
          `Could not resolve parent mapping for ${nextRemaining.length} rows. Sample: ${JSON.stringify(sample)}`
        );
      }

      remaining = nextRemaining;
    }

    await pool.query("COMMIT");
    console.log(`[IMPORT] Done. Imported/updated ${idMap.size} work_items.`);
    process.exit(0);
  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("[IMPORT] Failed:", e.message);
    process.exit(1);
  }
}

main().catch(e => {
  console.error("[IMPORT] Fatal:", e);
  process.exit(1);
});
