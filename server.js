const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DB_PATH =
  process.env.DB_PATH || path.join(__dirname, "data", "dashboard.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo'
      CHECK (status IN ('todo', 'in_progress', 'done')),
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK (priority IN ('low', 'medium', 'high')),
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`);

// Lightweight migration: track when a task was completed (powers the trend chart).
const cols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!cols.includes("completed_at")) {
  db.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT");
  db.exec("UPDATE tasks SET completed_at = updated_at WHERE status = 'done'");
}
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status)"
);

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const projectQuery = db.prepare(`
  SELECT
    p.id, p.name, p.description, p.created_at,
    COUNT(t.id) AS task_count,
    COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0)
      AS completed_count,
    CASE
      WHEN COUNT(t.id) = 0 THEN 0
      ELSE CAST(
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0)
        * 100.0 / COUNT(t.id) AS INTEGER)
    END AS progress
  FROM projects p
  LEFT JOIN tasks t ON t.project_id = p.id
  GROUP BY p.id
  ORDER BY p.created_at DESC, p.id DESC
`);

function broadcastChange(type) {
  io.emit("dashboard:changed", { type, at: Date.now() });
}

io.on("connection", (socket) => {
  io.emit("presence", { online: io.engine.clientsCount });
  socket.on("disconnect", () =>
    io.emit("presence", { online: io.engine.clientsCount }));
});

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

const validateEnum = (value, allowed) =>
  typeof value === "string" && allowed.includes(value);

const getTask = (id) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
const getProject = (id) =>
  db.prepare("SELECT * FROM projects WHERE id = ?").get(id);

// ---- Projects -------------------------------------------------------------

app.get("/api/projects", (req, res) => res.json(projectQuery.all()));

app.post("/api/projects", (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const description =
    typeof req.body.description === "string" ? req.body.description.trim() : "";

  if (!name || name.length > 100) {
    return res.status(400).json({
      error: "Project name is required and must be 100 characters or fewer."
    });
  }
  if (description.length > 1000) {
    return res.status(400).json({
      error: "Project description must be 1000 characters or fewer."
    });
  }

  const result = db
    .prepare("INSERT INTO projects (name, description) VALUES (?, ?)")
    .run(name, description);

  broadcastChange("project.created");
  res.status(201).json({ id: Number(result.lastInsertRowid), name, description });
});

app.delete("/api/projects/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !getProject(id)) {
    return res.status(404).json({ error: "Project not found." });
  }
  db.prepare("DELETE FROM projects WHERE id = ?").run(id); // tasks cascade
  broadcastChange("project.deleted");
  res.status(204).end();
});

// ---- Tasks ----------------------------------------------------------------

app.get("/api/projects/:id/tasks", (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || !getProject(projectId)) {
    return res.status(404).json({ error: "Project not found." });
  }

  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE project_id = ?
    ORDER BY
      CASE status WHEN 'done' THEN 1 ELSE 0 END,
      CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at DESC, id DESC
  `).all(projectId);

  res.json(tasks);
});

app.post("/api/projects/:id/tasks", (req, res) => {
  const projectId = Number(req.params.id);
  const project = Number.isInteger(projectId) && getProject(projectId);
  if (!project) return res.status(404).json({ error: "Project not found." });

  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const description =
    typeof req.body.description === "string" ? req.body.description.trim() : "";
  const priority = req.body.priority || "medium";
  const dueDate = req.body.due_date || null;

  if (!title || title.length > 200) {
    return res.status(400).json({
      error: "Task title is required and must be 200 characters or fewer."
    });
  }
  if (description.length > 1000) {
    return res.status(400).json({
      error: "Task description must be 1000 characters or fewer."
    });
  }
  if (!validateEnum(priority, ["low", "medium", "high"])) {
    return res.status(400).json({ error: "Invalid task priority." });
  }
  if (dueDate !== null && !isValidDate(dueDate)) {
    return res.status(400).json({ error: "Due date must use YYYY-MM-DD." });
  }

  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, description, priority, due_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(projectId, title, description, priority, dueDate);

  broadcastChange("task.created");
  res.status(201).json(getTask(Number(result.lastInsertRowid)));
});

app.patch("/api/tasks/:id", (req, res) => {
  const taskId = Number(req.params.id);
  const task = Number.isInteger(taskId) && getTask(taskId);
  if (!task) return res.status(404).json({ error: "Task not found." });

  const updates = [];
  const values = [];
  const body = req.body;

  if (Object.hasOwn(body, "title")) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) {
      return res.status(400).json({ error: "Invalid task title." });
    }
    updates.push("title = ?");
    values.push(title);
  }

  if (Object.hasOwn(body, "description")) {
    const description =
      typeof body.description === "string" ? body.description.trim() : "";
    if (description.length > 1000) {
      return res.status(400).json({ error: "Invalid task description." });
    }
    updates.push("description = ?");
    values.push(description);
  }

  if (Object.hasOwn(body, "status")) {
    if (!validateEnum(body.status, ["todo", "in_progress", "done"])) {
      return res.status(400).json({ error: "Invalid task status." });
    }
    updates.push("status = ?");
    values.push(body.status);
    updates.push(
      body.status === "done"
        ? "completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)"
        : "completed_at = NULL"
    );
  }

  if (Object.hasOwn(body, "priority")) {
    if (!validateEnum(body.priority, ["low", "medium", "high"])) {
      return res.status(400).json({ error: "Invalid task priority." });
    }
    updates.push("priority = ?");
    values.push(body.priority);
  }

  if (Object.hasOwn(body, "due_date")) {
    const dueDate = body.due_date === "" ? null : body.due_date;
    if (dueDate !== null && !isValidDate(dueDate)) {
      return res.status(400).json({ error: "Due date must use YYYY-MM-DD." });
    }
    updates.push("due_date = ?");
    values.push(dueDate);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(taskId);

  db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  broadcastChange("task.updated");
  res.json(getTask(taskId));
});

app.delete("/api/tasks/:id", (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId) || !getTask(taskId)) {
    return res.status(404).json({ error: "Task not found." });
  }
  db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  broadcastChange("task.deleted");
  res.status(204).end();
});

// ---- Analytics ------------------------------------------------------------
// Optional ?project_id= narrows every chart to a single project.

app.get("/api/stats", (req, res) => {
  const pid = req.query.project_id ? Number(req.query.project_id) : null;
  if (pid !== null && !Number.isInteger(pid)) {
    return res.status(400).json({ error: "Invalid project id." });
  }

  const group = (col) =>
    Object.fromEntries(
      db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM tasks
                  WHERE (? IS NULL OR project_id = ?) GROUP BY ${col}`)
        .all(pid, pid)
        .map((r) => [r.k, r.n])
    );

  const perDay = (col) =>
    Object.fromEntries(
      db.prepare(`SELECT date(${col}) AS d, COUNT(*) AS n FROM tasks
                  WHERE ${col} IS NOT NULL
                    AND date(${col}) >= date('now', '-13 days')
                    AND (? IS NULL OR project_id = ?)
                  GROUP BY d`)
        .all(pid, pid)
        .map((r) => [r.d, r.n])
    );

  const created = perDay("created_at");
  const completed = perDay("completed_at");
  const timeline = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    timeline.push({ date: d, created: created[d] || 0, completed: completed[d] || 0 });
  }

  const overdue = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE status != 'done' AND due_date IS NOT NULL AND due_date < date('now')
      AND (? IS NULL OR project_id = ?)
  `).get(pid, pid).n;

  res.json({
    status: group("status"),
    priority: group("priority"),
    timeline,
    overdue,
    perProject: projectQuery.all().map((p) => ({
      name: p.name, progress: p.progress, tasks: p.task_count
    }))
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

server.listen(PORT, () => {
  console.log(`Task dashboard running at http://localhost:${PORT}`);
});