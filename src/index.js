// C:\MARCO-Workforce-App\backend\src\index.js
// Express bootstrap for MARCO Workforce backend

require("dotenv").config(); // IMPORTANT: load .env before db.js creates the pool

const express = require("express");
const cors = require("cors");

const app = express();

// ----- Routes -----
const authRoutes = require("./routes/auth");
const scansRoutes = require("./routes/scans");
const approvalsRoutes = require("./routes/approvals");
const assignmentsRoutes = require("./routes/assignments");
const supervisorRoutes = require("./routes/supervisor");
const dayRoutes = require("./routes/day");
const adminRoutes = require("./routes/admin");
const taskReleasesRoutes = require("./routes/taskReleases");
const seRoutes = require("./routes/se");

const monthlyCostRoutes = require("./routes/monthlyCost");

const oraclePpmSyncRoutes = require("./routes/oraclePpmSync");
const { startOracleSyncJob } = require("./jobs/oraclePpmSyncJob");
// Optional background jobs folder exists, but do not fail if job module not present.
let startAutoCloseJob = null;
try {
  // if you have a job file, it can export a start(pool) function; otherwise ignored
  startAutoCloseJob = require("./jobs/autoCloseJob");
} catch (_) {
  /* ignore */
}

console.log("[MOUNT] adminRoutes loaded OK:", typeof adminRoutes);
console.log("[BOOT] index.js loaded from:", __filename);

// ----- CORS -----
// For development:
// - allow Flutter Web from localhost / 127.0.0.1 any port
// - allow requests with no origin (desktop/mobile tools, curl, Postman, server-to-server)
// - allow ngrok-hosted frontends if you later run web through ngrok
const corsOptions = {
  origin(origin, callback) {
    try {
      if (!origin) {
        return callback(null, true);
      }

      if (
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:") ||
        origin.includes(".ngrok-free.dev") ||
        origin.includes(".ngrok.app")
      ) {
        return callback(null, true);
      }

      return callback(null, true); // dev-open; tighten later for production
    } catch (err) {
      return callback(err);
    }
  },
  credentials: true,
};

// IMPORTANT: CORS must be before routes
app.use(cors(corsOptions));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
// INTEGRATION 
app.use("/api/v1/oracle", oraclePpmSyncRoutes);

// New cost proccess (monthly Cost)
app.use("/api/v1/monthly-cost", monthlyCostRoutes);

startOracleSyncJob();
// ----- Core middleware -----


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
app.use("/api/v1/daily-cost", require("./routes/dailyCost"));
// new requirement routes
app.use("/api/v1/workforce-structure", require("./routes/workforceStructure"));
app.use("/api/v1/cost-control", require("./routes/costControl"));
app.use("/api/v1/day-adjustments", require("./routes/dayAdjustments"));


// SE routes
console.log(
  "[SE ROUTES] registered:",
  seRoutes?.stack
    ?.filter((layer) => layer?.route?.path)
    .map((layer) => ({
      methods: Object.keys(layer.route.methods || {})
        .join(",")
        .toUpperCase(),
      path: layer.route.path,
    })) || []
);
app.use("/api/v1/se", seRoutes);

// monitoring route
app.use("/api/v1/monitor", require("./routes/monitor"));

// Project / admin / work item routes
console.log("[MOUNT] /api/v1/admin mounted");
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/projects", require("./routes/projects"));
app.use("/api/v1", require("./routes/work_items"));

// Phase 2.2 (Desktop/Web Admin) Work Item Control routes
app.use("/api/v1/work-items", require("./routes/workItemsControl"));

// core routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/scans", scansRoutes);
app.use("/api/v1/approvals", approvalsRoutes);
app.use("/api/v1/assignments", assignmentsRoutes);
app.use("/api/v1/supervisor", supervisorRoutes);
app.use("/api/v1/day", dayRoutes);

// Phase 3.0 – Task Release Governance
app.use("/api/v1/task-releases", taskReleasesRoutes);

// dump selected routes after mounts
dumpRoutes(app);

// JSON 404 for API
app.use("/api/v1", (req, res) => {
  return res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
});

// JSON error handler
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

function dumpRoutes(appInstance) {
  try {
    const router = appInstance._router || appInstance.router; // Express 4 vs Express 5
    const stack = router?.stack;

    if (!stack) {
      console.log(
        "[ROUTE DUMP] No router stack found. app._router:",
        !!appInstance._router,
        "app.router:",
        !!appInstance.router
      );
      return;
    }

    console.log("===== ROUTE DUMP START =====");
    for (const layer of stack) {
      // mounted router
      if (layer?.name === "router" && layer?.handle?.stack) {
        const base = layer?.regexp?.toString?.() || "(base?)";
        for (const h of layer.handle.stack) {
          if (h?.route?.path) {
            const methods = Object.keys(h.route.methods || {})
              .join(",")
              .toUpperCase();
            const line = `${methods} ${base} -> ${h.route.path}`;
            if (
              line.includes("admin") ||
              line.includes("supervis") ||
              line.includes("task-releases") ||
              line.includes("workforce-structure") ||
              line.includes("cost-control") ||
              line.includes("day-adjustments")
            ) {
              console.log(line);
            }
          }
        }
      }

      // direct route
      if (layer?.route?.path) {
        const methods = Object.keys(layer.route.methods || {})
          .join(",")
          .toUpperCase();
        const line = `${methods} ${layer.route.path}`;
        if (
          line.includes("admin") ||
          line.includes("supervis") ||
          line.includes("task-releases") ||
          line.includes("workforce-structure") ||
          line.includes("cost-control") ||
          line.includes("day-adjustments")
        ) {
          console.log(line);
        }
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

  try {
    if (typeof startAutoCloseJob === "function") {
      startAutoCloseJob();
    } else if (
      startAutoCloseJob &&
      typeof startAutoCloseJob.start === "function"
    ) {
      startAutoCloseJob.start();
    }
  } catch (e) {
    console.warn("Auto-close job not started:", e?.message || e);
  }
});

console.log("BOOT OK:", __filename, "CWD:", process.cwd());

module.exports = app;