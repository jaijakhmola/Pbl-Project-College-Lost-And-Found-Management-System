
"use strict";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  items: [],
  filter: "ALL",
  query: "",
  sort: "newest",
  adminKey: "",
  loading: false
};

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

const urgencyRank = { High: 3, Medium: 2, Low: 1 };

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function toast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type === "success" ? "" : type}`;

  const heading = document.createElement("strong");
  heading.textContent = type === "error" ? "SYSTEM ALERT" :
    type === "warning" ? "VALIDATION NOTICE" : "SYSTEM MESSAGE";

  const body = document.createElement("p");
  body.textContent = message;

  node.append(heading, body);
  $("#toastRegion").append(node);

  window.setTimeout(() => {
    node.classList.add("leaving");
    window.setTimeout(() => node.remove(), 250);
  }, 3600);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (options.body) headers["Content-Type"] = "application/json";
  if (state.adminKey) headers["x-admin-key"] = state.adminKey;

  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers,
      cache: "no-store"
    });
  } catch {
    throw new Error("Cannot connect to CampusFind. Check the server.");
  }

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.success === false) {
    throw new Error(result.error || `Request failed (${response.status}).`);
  }

  return result;
}

function setSystemStatus(online) {
  $("#systemStatus").textContent = online ? "SYSTEM ONLINE" : "OFFLINE";
  $("#systemStatus").style.color = online ? "var(--green)" : "var(--pink)";
}

async function checkHealth() {
  try {
    await api("/api/health");
    setSystemStatus(true);
  } catch {
    setSystemStatus(false);
  }
}

async function loadStats() {
  try {
    const stats = await api("/api/stats");

    $("#totalCount").textContent = stats.total;
    $("#lostCount").textContent = stats.lost;
    $("#foundCount").textContent = stats.found;
    $("#resolvedCount").textContent = stats.resolved;
  } catch (error) {
    toast(error.message, "error");
  }
}

function setLoading(loading) {
  state.loading = loading;
  $("#loadingState").hidden = !loading;
  $("#reportGrid").hidden = loading;
  if (loading) $("#emptyState").hidden = true;
}

async function loadItems() {
  setLoading(true);

  try {
    const params = new URLSearchParams();

    if (state.filter !== "ALL") params.set("type", state.filter);
    if (state.query) params.set("q", state.query);

    const data = await api(`/api/items?${params.toString()}`);
    state.items = data.items;
    renderItems();
    setSystemStatus(true);
  } catch (error) {
    state.items = [];
    renderItems();
    setSystemStatus(false);
    toast(error.message, "error");
  } finally {
    setLoading(false);
  }
}

function sortedItems(items) {
  const result = [...items];

  if (state.sort === "oldest") {
    result.sort((a, b) => a.date.localeCompare(b.date) ||
      a.createdAt.localeCompare(b.createdAt));
  } else if (state.sort === "urgency") {
    result.sort((a, b) =>
      urgencyRank[b.urgency] - urgencyRank[a.urgency] ||
      b.createdAt.localeCompare(a.createdAt)
    );
  } else {
    result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return result;
}

function cardTemplate(item, index) {
  const isLost = item.type === "LOST";
  const image = item.image
    ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.title)}" loading="lazy">`
    : `<span class="card-placeholder" aria-hidden="true">${isLost ? "⌕" : "✦"}</span>`;

  const actions = state.adminKey
    ? `<div class="card-actions">
         <button class="btn btn-primary" data-action="resolve"
           data-id="${escapeHTML(item.id)}">RESOLVE</button>
         <button class="btn btn-secondary" data-action="delete"
           data-id="${escapeHTML(item.id)}">DELETE</button>
         <button class="btn btn-ghost" data-action="matches"
           data-id="${escapeHTML(item.id)}">MATCHES</button>
       </div>`
    : `<div class="card-actions">
         <button class="btn btn-ghost" data-action="matches"
           data-id="${escapeHTML(item.id)}">FIND MATCHES ↗</button>
       </div>`;

  return `
    <article class="report-card" style="animation-delay:${Math.min(index * 45, 300)}ms">
      <div class="card-image">${image}</div>
      <div class="card-content">
        <div class="card-badges">
          <span class="pill ${isLost ? "lost" : "found"}">${escapeHTML(item.type)}</span>
          <span class="pill ${escapeHTML(item.urgency.toLowerCase())}">
            ${escapeHTML(item.urgency.toUpperCase())} PRIORITY
          </span>
          <span class="pill">${escapeHTML(item.category)}</span>
        </div>
        <h3>${escapeHTML(item.title)}</h3>
        <p class="card-description">${escapeHTML(item.description)}</p>
        <div class="card-details">
          <span><b>⌖ LOCATION</b> &nbsp; ${escapeHTML(item.location)}</span>
          <span><b>◷ DATE</b> &nbsp; ${escapeHTML(item.date)}</span>
          <span><b>CONTACT</b> &nbsp; ${escapeHTML(item.contact)}</span>
        </div>
        ${actions}
        <div class="match-slot" id="matches-${escapeHTML(item.id)}"></div>
      </div>
    </article>`;
}

function renderItems() {
  const items = sortedItems(state.items);
  $("#reportGrid").innerHTML = items.map(cardTemplate).join("");
  $("#resultCount").textContent = `${items.length} ACTIVE REPORT${items.length === 1 ? "" : "S"}`;
  $("#emptyState").hidden = items.length > 0 || state.loading;
  $("#reportGrid").hidden = state.loading;
}

async function refresh() {
  await Promise.all([loadItems(), loadStats()]);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read selected image."));
    reader.readAsDataURL(file);
  });
}

// Browser validation improves feedback; the server remains authoritative.
async function validateImageFile(file) {
  if (!file) return null;

  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error("Choose a PNG, JPG, or WEBP image.");
  }

  if (file.size <= 0 || file.size >= MAX_IMAGE_BYTES) {
    throw new Error("Image must be smaller than 2 MB.");
  }

  const dataUrl = await readFileAsDataURL(file);

  // Validate the actual signature in the browser as well.
  const base64 = String(dataUrl).split(",")[1] || "";
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));

  const png = bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);

  const jpeg = bytes.length >= 3 &&
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;

  const webp = bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";

  const validSignature =
    (file.type === "image/png" && png) ||
    (file.type === "image/jpeg" && jpeg) ||
    (file.type === "image/webp" && webp);

  if (!validSignature) {
    throw new Error("The file content does not match its image format.");
  }

  return dataUrl;
}

function resetImagePreview() {
  $("#itemImage").value = "";
  $("#previewImage").removeAttribute("src");
  $("#previewName").textContent = "";
  $("#previewSize").textContent = "";
  $("#imagePreview").hidden = true;
}

$("#itemImage").addEventListener("change", async event => {
  const file = event.target.files[0];

  if (!file) return;

  try {
    const dataUrl = await validateImageFile(file);
    $("#previewImage").src = dataUrl;
    $("#previewName").textContent = file.name;
    $("#previewSize").textContent = `${(file.size / 1024).toFixed(1)} KB`;
    $("#imagePreview").hidden = false;
    toast("Image validated and ready to attach.");
  } catch (error) {
    resetImagePreview();
    toast(error.message, "warning");
  }
});

$("#removeImage").addEventListener("click", resetImagePreview);

$("#reportForm").addEventListener("submit", async event => {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("#submitButton");
  const status = $("#formStatus");

  if (!form.reportValidity()) return;

  const file = $("#itemImage").files[0];
  button.disabled = true;
  button.textContent = "TRANSMITTING...";
  status.textContent = "SCANNING INPUT AND TRANSMITTING REPORT...";

  try {
    const data = Object.fromEntries(new FormData(form).entries());
    data.type = form.querySelector('input[name="type"]:checked').value;
    data.image = await validateImageFile(file);

    const result = await api("/api/items", {
      method: "POST",
      body: JSON.stringify(data)
    });

    form.reset();
    resetImagePreview();
    $("#reportDate").value = new Date().toLocaleDateString("en-CA");
    status.textContent = "REPORT REGISTERED SUCCESSFULLY.";

    toast(result.message || "Report submitted successfully.");

    if (result.matches?.length) {
      toast(`${result.matches.length} possible opposite-type match(es) detected.`);
    }

    state.query = "";
    $("#searchInput").value = "";
    state.filter = "ALL";
    $$(".filter-btn").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.filter === "ALL")
    );

    await refresh();
    $("#reports").scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    status.textContent = error.message;
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "TRANSMIT REPORT ↗";
  }
});

let searchTimer;

$("#searchInput").addEventListener("input", event => {
  state.query = event.target.value.trim();
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(loadItems, 250);
});

$$(".filter-btn").forEach(button => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;

    $$(".filter-btn").forEach(btn =>
      btn.classList.toggle("active", btn === button)
    );

    loadItems();
  });
});

$("#sortSelect").addEventListener("change", event => {
  state.sort = event.target.value;
  renderItems();
});

async function showMatches(id) {
  const slot = document.getElementById(`matches-${id}`);
  if (!slot) return;

  slot.innerHTML = '<div class="match-list">SCANNING OPPOSITE-TYPE REPORTS...</div>';

  try {
    const data = await api(`/api/items/${encodeURIComponent(id)}/matches`);

    if (!data.matches.length) {
      slot.innerHTML = `
        <div class="match-list">
          <h4>NO STRONG MATCHES DETECTED</h4>
          <p>Try checking again when more reports are submitted.</p>
        </div>`;
      return;
    }

    slot.innerHTML = `
      <div class="match-list">
        <h4>✦ POSSIBLE MATCHES</h4>
        ${data.matches.map(match => `
          <p>
            <strong>${escapeHTML(match.title)}</strong><br>
            ${escapeHTML(match.type)} · ${escapeHTML(match.category)}<br>
            ${escapeHTML(match.location)} · ${escapeHTML(match.date)}<br>
            <small>SIMILARITY SCORE: ${match.score}%</small>
          </p>
        `).join("")}
        <p><small>Scores are suggestions, not proof that items match.</small></p>
      </div>`;
  } catch (error) {
    slot.textContent = error.message;
    toast(error.message, "error");
  }
}

// Delegation keeps actions working after the report grid is re-rendered.
$("#reportGrid").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const { action, id } = button.dataset;

  if (action === "matches") {
    await showMatches(id);
    return;
  }

  if (!state.adminKey) {
    toast("Authenticate in the Admin Terminal first.", "warning");
    return;
  }

  if (action === "delete" &&
      !window.confirm("Permanently delete this report? This cannot be undone.")) {
    return;
  }

  if (action === "resolve" &&
      !window.confirm("Mark this report as resolved?")) {
    return;
  }

  button.disabled = true;

  try {
    const result = await api(
      action === "resolve"
        ? `/api/items/${encodeURIComponent(id)}/resolve`
        : `/api/items/${encodeURIComponent(id)}`,
      { method: action === "resolve" ? "PATCH" : "DELETE" }
    );

    toast(result.message || "Administrator action completed.");
    await refresh();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#adminForm").addEventListener("submit", async event => {
  event.preventDefault();

  const suppliedKey = $("#adminKey").value;

  $("#adminLogin").disabled = true;
  $("#adminStatus").textContent = "AUTHENTICATING...";

  // Validate against a protected endpoint without modifying a record.
  try {
    const response = await fetch("/api/items", {
      headers: { "x-admin-key": suppliedKey },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Authentication failed. Check the administrator key.");
    }

    state.adminKey = suppliedKey;
    $("#adminKey").value = "";
    $("#adminKey").disabled = true;
    $("#adminLogin").hidden = true;
    $("#adminLogout").hidden = false;
    $("#adminStatus").textContent = "ACCESS GRANTED — ADMIN SESSION ACTIVE";

    toast("Administrator terminal unlocked.");
    renderItems();
  } catch (error) {
    state.adminKey = "";
    $("#adminStatus").textContent = "ACCESS DENIED — TERMINAL LOCKED";
    toast(error.message, "error");
  } finally {
    $("#adminLogin").disabled = false;
  }
});

$("#adminLogout").addEventListener("click", () => {
  state.adminKey = "";
  $("#adminKey").disabled = false;
  $("#adminKey").value = "";
  $("#adminLogin").hidden = false;
  $("#adminLogout").hidden = true;
  $("#adminStatus").textContent = "TERMINAL LOCKED — AUTHENTICATION REQUIRED";

  renderItems();
  toast("Administrator terminal locked.");
});

$("#reportDate").value = new Date().toLocaleDateString("en-CA");

checkHealth();
refresh();

// Keep the dashboard reasonably current when another user submits a report.
window.setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
