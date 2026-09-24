// Small fetch helpers shared by every page. Every call includes cookies so
// the HttpOnly session cookie the auth functions set is sent along
// automatically, nothing to manage by hand on the page side.

async function apiRequest(path, options = {}) {
  const res = await fetch(path, { credentials: "include", ...options });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Some endpoints (file downloads) do not return JSON; callers that
    // expect that use apiDownloadUrl instead of this helper.
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

function apiGet(path) {
  return apiRequest(path, { method: "GET" });
}

function apiPostJson(path, body) {
  return apiRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiPostForm(path, formData) {
  return apiRequest(path, { method: "POST", body: formData });
}

function showMessage(el, text, kind) {
  el.textContent = text;
  el.className = "msg " + kind;
  el.style.display = text ? "block" : "none";
}

function formatCents(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function statusPillHtml(status) {
  return `<span class="pill status-${status}">${status.replace("_", " ")}</span>`;
}

// Path to the logo image. Leave empty to show the "GA" text mark instead.
// When the logo file arrives, drop it in public/img/ and set this, for
// example "/img/logo.svg".
const SITE_LOGO = "";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Renders the shared nav bar. `user` is the object from GET /api/auth/me
// (or null when signed out).
function renderNav(user) {
  const nav = document.getElementById("site-nav");
  if (!nav) return;
  const links = [];
  if (user) {
    const dashboardHref = user.role === "teacher" ? "/dashboard-teacher.html" : "/dashboard-grade-angel.html";
    links.push(`<a href="${dashboardHref}">Dashboard</a>`);
    links.push(`<span class="user-name">${escapeHtml(user.full_name)}</span>`);
    links.push(`<button class="link" id="logout-btn">Sign out</button>`);
  } else {
    links.push(`<a href="/login.html">Sign in</a>`);
    links.push(`<a href="/signup.html">Sign up</a>`);
  }
  nav.innerHTML = `
    <a class="brand" href="/">${
      SITE_LOGO
        ? `<img src="${SITE_LOGO}" alt="Grade Angels Network" />`
        : `<span class="mark" aria-hidden="true">GA</span>Grade Angels Network`
    }</a>
    <div class="links">${links.join("")}</div>
  `;
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await apiPostJson("/api/auth/logout", {}).catch(() => {});
      window.location.href = "/";
    });
  }
}

async function requireRole(role) {
  const { user } = await apiGet("/api/auth/me");
  if (!user) {
    window.location.href = "/login.html";
    return null;
  }
  if (user.role !== role) {
    window.location.href = user.role === "teacher" ? "/dashboard-teacher.html" : "/dashboard-grade-angel.html";
    return null;
  }
  renderNav(user);
  return user;
}

const TYPE_LABELS = { multiple_choice: "Multiple choice", combo: "Combination", essay: "Essay" };

function assignmentTypeLabel(type) {
  return TYPE_LABELS[type] || type;
}

// "Due in 1 day 4 hours" / "Overdue by 3 hours", from an ISO timestamp.
function formatDue(dueAt) {
  if (!dueAt) return "";
  const ms = new Date(dueAt).getTime() - Date.now();
  const hours = Math.round(Math.abs(ms) / 3600000);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const parts = [];
  if (days) parts.push(days + (days === 1 ? " day" : " days"));
  if (rest || !days) parts.push(rest + (rest === 1 ? " hour" : " hours"));
  return ms >= 0 ? "Due in " + parts.join(" ") : "Overdue by " + parts.join(" ");
}

function formatDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function pageImageUrl(assignmentId, pageIndex) {
  return `/api/assignments/page?assignment_id=${assignmentId}&page=${pageIndex}`;
}

// How a completed assignment's payout looks to the Grade Angel. Failed and
// in flight payouts read as "on the way" because the hourly retry job keeps
// working on them; only "held" needs the Grade Angel to do something.
function payoutPillHtml(a) {
  if (a.status !== "completed") return "";
  if (a.payout_status === "transferred") return '<span class="pill status-completed">Paid out</span>';
  if (a.payout_status === "held") return '<a class="pill status-cancelled" href="/grade-angel-setup.html">Payout on hold: finish Stripe setup</a>';
  return '<span class="pill status-accepted">Payout on the way</span>';
}
