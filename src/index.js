// C:\MARCO-Workforce-App\backend\src\index.js
// Express bootstrap for MARCO Workforce backend

require("dotenv").config(); // IMPORTANT: load .env before db.js creates the pool

const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const scansRoutes = require("./routes/scans");
const approvalsRoutes = require("./routes/approvals");
const assignmentsRoutes = require("./routes/assignments");
const supervisorRoutes = require("./routes/supervisor");
const dayRoutes = require("./routes/day");
const adminRoutes = require("./routes/admin");
console.log("[MOUNT] adminRoutes loaded OK:", typeof adminRoutes);

// Optional background jobs folder exists, but do not fail if job module not present.
let startAutoCloseJob = null;
try {
  // if you have a job file, it can export a start(pool) function; otherwise ignored
  startAutoCloseJob = require("./jobs/autoCloseJob");
} catch (_) { /* ignore */ }

const app = express();
console.log("[BOOT] index.js loaded from:", __filename);

// monitoring route (for uptime monitors)
app.use("/api/v1/monitor", require("./routes/monitor"));

// middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// simple request log
app.use((req, _res, next) => {
  try {
    console.log(`[API] ${req.method} ${req.originalUrl}`);
  } catch (_) {}
  next();
});

// health
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));

// Project


console.log("[MOUNT] /api/v1/admin mounted");
dumpRoutes(app);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/projects", require("./routes/projects"));
app.use("/api/v1", require("./routes/work_items"));

// ✅ Phase 2.2 (Desktop-only) Work Item Control routes
// This will expose:
// POST /api/v1/work-items/:id/activate
// POST /api/v1/work-items/:id/deactivate
// POST /api/v1/work-items/:id/assign
// POST /api/v1/work-items/:id/unassign
// GET  /api/v1/work-items/:id/history
app.use("/api/v1/work-items", require("./routes/workItemsControl"));

// routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/scans", scansRoutes);
app.use("/api/v1/approvals", approvalsRoutes);
app.use("/api/v1/assignments", assignmentsRoutes);
app.use("/api/v1/supervisor", supervisorRoutes);
app.use("/api/v1/day", dayRoutes);
//app.use("/api/v1/admin", require("./routes/admin"));


// JSON 404 for API
app.use("/api/v1", (req, res) => {
  return res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
});

// JSON error handler (prevents HTML error pages that break the mobile JSON parser)
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err?.statusCode || err?.status || 500;
  return res.status(status).json({
    success: false,
    error: {
      code: err?.code || "INTERNAL_ERROR",
      message: err?.message || "Unexpected server error",
    },
  });
});


function dumpRoutes(app) {
  try {
    const router = app._router || app.router; // Express 4 vs Express 5
    const stack = router?.stack;

    if (!stack) {
      console.log("[ROUTE DUMP] No router stack found. app._router:", !!app._router, "app.router:", !!app.router);
      return;
    }

    console.log("===== ROUTE DUMP START =====");
    for (const layer of stack) {
      // mounted router
      if (layer?.name === "router" && layer?.handle?.stack) {
        const base = layer?.regexp?.toString?.() || "(base?)";
        for (const h of layer.handle.stack) {
          if (h?.route?.path) {
            const methods = Object.keys(h.route.methods || {}).join(",").toUpperCase();
            const line = `${methods} ${base} -> ${h.route.path}`;
            if (line.includes("admin") || line.includes("supervis")) console.log(line);
          }
        }
      }

      // direct route
      if (layer?.route?.path) {
        const methods = Object.keys(layer.route.methods || {}).join(",").toUpperCase();
        const line = `${methods} ${layer.route.path}`;
        if (line.includes("admin") || line.includes("supervis")) console.log(line);
      }
    }
    console.log("===== ROUTE DUMP END =====");
  } catch (e) {
    console.log("dumpRoutes failed:", e?.message || e);
  }
}


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);

  // start background job if provided
  try {
    if (typeof startAutoCloseJob === "function") {
      startAutoCloseJob();
    } else if (startAutoCloseJob && typeof startAutoCloseJob.start === "function") {
      startAutoCloseJob.start();
    }
  } catch (e) {
    console.warn("Auto-close job not started:", e?.message || e);
  }
});
console.log("BOOT OK:", __filename, "CWD:", process.cwd());

module.exports = app;
