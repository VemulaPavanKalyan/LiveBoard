const $ = (s) => document.querySelector(s);
const C = { sea: "#5fd6bf", saffron: "#f4b942", rose: "#ef6f88", lilac: "#b9a2f2", dim: "#a698b8" };
const state = { projects: [], selected: null, tasks: [], filter: "all", flashId: null };
const socket = io();

const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function toast(msg, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast-i ${type === "danger" ? "err" : type}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

/* ---------- Charts ---------- */
Chart.defaults.color = C.dim;
Chart.defaults.font.family = "Figtree, sans-serif";
Chart.defaults.borderColor = "rgba(255,255,255,.07)";
const mk = (id, cfg) => new Chart($(id), { ...cfg, options: { responsive: true, maintainAspectRatio: false, ...cfg.options } });
const legend = { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, padding: 14 } };

const charts = {
  status: mk("#cStatus", { type: "doughnut",
    data: { labels: ["To do", "In progress", "Done"], datasets: [{ data: [0, 0, 0], backgroundColor: [C.lilac, C.saffron, C.sea], borderWidth: 0, spacing: 4, borderRadius: 6 }] },
    options: { cutout: "70%", plugins: { legend } } }),
  priority: mk("#cPriority", { type: "polarArea",
    data: { labels: ["Low", "Medium", "High"], datasets: [{ data: [0, 0, 0], backgroundColor: ["rgba(185,162,242,.7)", "rgba(244,185,66,.7)", "rgba(239,111,136,.7)"], borderWidth: 0 }] },
    options: { plugins: { legend }, scales: { r: { ticks: { display: false, stepSize: 1 }, grid: { color: "rgba(255,255,255,.07)" } } } } }),
  projects: mk("#cProjects", { type: "bar",
    data: { labels: [], datasets: [{ data: [], backgroundColor: C.sea, borderRadius: 8, barThickness: 14 }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.raw}% complete` } } },
      scales: { x: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } }, y: { grid: { display: false } } } } }),
  trend: mk("#cTrend", { type: "line",
    data: { labels: [], datasets: [
      { label: "Created", data: [], borderColor: C.lilac, backgroundColor: "rgba(185,162,242,.12)", fill: true, tension: .4, pointRadius: 0, pointHoverRadius: 5 },
      { label: "Finished", data: [], borderColor: C.sea, backgroundColor: "rgba(95,214,191,.16)", fill: true, tension: .4, pointRadius: 0, pointHoverRadius: 5 }] },
    options: { interaction: { mode: "index", intersect: false }, plugins: { legend: { ...legend, position: "top", align: "end" } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } } } })
};

function paintCharts(s) {
  const st = s.status, pr = s.priority;
  charts.status.data.datasets[0].data = [st.todo || 0, st.in_progress || 0, st.done || 0];
  charts.priority.data.datasets[0].data = [pr.low || 0, pr.medium || 0, pr.high || 0];
  charts.projects.data.labels = s.perProject.map((p) => p.name.length > 18 ? p.name.slice(0, 17) + "…" : p.name);
  charts.projects.data.datasets[0].data = s.perProject.map((p) => p.progress);
  charts.projects.data.datasets[0].backgroundColor = s.perProject.map((p) => p.progress >= 100 ? C.sea : p.progress >= 50 ? C.saffron : C.rose);
  charts.trend.data.labels = s.timeline.map((d) => new Date(d.date + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  charts.trend.data.datasets[0].data = s.timeline.map((d) => d.created);
  charts.trend.data.datasets[1].data = s.timeline.map((d) => d.completed);
  Object.values(charts).forEach((c) => c.update());
  $("#kTodo").textContent = st.todo || 0;
  $("#kProg").textContent = st.in_progress || 0;
  $("#kDone").textContent = st.done || 0;
  $("#kLate").textContent = s.overdue;
}

/* ---------- Render ---------- */
function renderProjects() {
  const list = $("#projectList");
  if (!state.projects.length) {
    list.innerHTML = '<p class="text-secondary small mb-0">No projects yet. Name your first one below.</p>';
    return;
  }
  list.innerHTML = state.projects.map((p) => `
    <button class="proj ${p.id === state.selected ? "active" : ""}" data-id="${p.id}" type="button">
      <span class="nm"><span>${esc(p.name)}</span><small class="text-secondary">${p.completed_count}/${p.task_count}</small></span>
      <span class="bar"><i style="width:${Number(p.progress)}%"></i></span>
    </button>`).join("");
}

function renderHero() {
  const p = state.projects.find((x) => x.id === state.selected);
  $("#heroTitle").textContent = p ? p.name : "Pick a project";
  $("#heroDesc").textContent = p ? (p.description || "No description yet.") : "Create a project on the left to start tracking tasks. Everything syncs live across open tabs.";
  $("#heroPct").textContent = (p ? p.progress : 0) + "%";
  $("#heroSub").textContent = p ? `${p.completed_count} of ${p.task_count} tasks complete` : "complete";
  $("#addTaskButton").disabled = !p;
}

function renderTasks() {
  const today = new Date().toISOString().slice(0, 10);
  const tasks = state.tasks.filter((t) => state.filter === "all" || t.status === state.filter);
  const empty = $("#emptyState");
  empty.classList.toggle("d-none", tasks.length > 0);
  if (!tasks.length) {
    empty.textContent = !state.selected ? "Select a project to see its tasks."
      : state.tasks.length ? "Nothing matches this filter." : "No tasks yet. Add the first one above.";
  }
  $("#taskList").innerHTML = tasks.map((t) => {
    const late = t.due_date && t.due_date < today && t.status !== "done";
    return `
    <div class="trow ${t.status === "done" ? "done-t" : ""} ${t.id === state.flashId ? "flash" : ""}">
      <button class="check ${t.status === "done" ? "done" : ""}" data-toggle="${t.id}" data-status="${t.status}" aria-label="Mark ${t.status === "done" ? "not done" : "done"}" type="button">✓</button>
      <div><div class="ttl">${esc(t.title)}</div>${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}</div>
      <span class="pill p-${esc(t.priority)} meta">${esc(t.priority)}</span>
      <span class="due ${late ? "late" : ""}">${t.due_date ? (late ? "Overdue · " : "") + esc(t.due_date) : "No date"}</span>
      <div class="d-flex gap-2 meta">
        <select class="form-select sel-s" data-task-id="${t.id}" aria-label="Task status">
          ${[["todo", "To do"], ["in_progress", "In progress"], ["done", "Done"]].map(([v, l]) => `<option value="${v}" ${t.status === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="btn btn-ghost btn-sm" data-del="${t.id}" aria-label="Delete task" type="button">Delete</button>
      </div>
    </div>`;
  }).join("");
  state.flashId = null;
}

async function load() {
  try {
    state.projects = await api("/api/projects");
    if (!state.projects.some((p) => p.id === state.selected)) state.selected = state.projects[0]?.id ?? null;
    const [tasks, stats] = await Promise.all([
      state.selected ? api(`/api/projects/${state.selected}/tasks`) : [],
      api("/api/stats" + (state.selected ? `?project_id=${state.selected}` : ""))
    ]);
    state.tasks = tasks;
    renderProjects(); renderHero(); renderTasks(); paintCharts(stats);
  } catch (e) { toast(e.message, "danger"); }
}

/* ---------- Events ---------- */
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, "danger"); } };

$("#projectForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: f.get("name"), description: f.get("description") }) });
  e.target.reset(); state.selected = p.id; toast("Project created."); await load();
}));

$("#projectList").addEventListener("click", (e) => {
  const b = e.target.closest(".proj"); if (!b) return;
  state.selected = Number(b.dataset.id); load();
});

$("#taskForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  if (!state.selected) return toast("Create or select a project first.", "danger");
  const f = new FormData(e.target);
  const t = await api(`/api/projects/${state.selected}/tasks`, { method: "POST",
    body: JSON.stringify({ title: f.get("title"), description: f.get("description"), priority: f.get("priority"), due_date: f.get("due_date") || null }) });
  e.target.reset(); state.flashId = t.id; toast("Task added."); await load();
}));

$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  state.filter = b.dataset.f;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b));
  renderTasks();
});

const setStatus = guard(async (id, status) => {
  await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  await load();
});

$("#taskList").addEventListener("change", (e) => {
  if (e.target.matches(".sel-s")) setStatus(e.target.dataset.taskId, e.target.value);
});

$("#taskList").addEventListener("click", guard(async (e) => {
  const tg = e.target.closest("[data-toggle]");
  if (tg) return setStatus(tg.dataset.toggle, tg.dataset.status === "done" ? "todo" : "done");
  const del = e.target.closest("[data-del]");
  if (!del || !confirm("Delete this task?")) return;
  await api(`/api/tasks/${del.dataset.del}`, { method: "DELETE" });
  toast("Task deleted."); await load();
}));

/* ---------- Real-time ---------- */
const live = $("#live"), liveText = $("#liveText");
let online = 1, timer;
const paintLive = (on) => { live.classList.toggle("on", on); liveText.textContent = on ? `Live · ${online} online` : "Reconnecting"; };
socket.on("connect", () => paintLive(true));
socket.on("disconnect", () => paintLive(false));
socket.on("presence", (p) => { online = p.online; paintLive(socket.connected); });
socket.on("dashboard:changed", () => { clearTimeout(timer); timer = setTimeout(load, 150); });

load();