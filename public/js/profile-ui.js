// Shared profile pieces: avatars, star ratings, the edit profile dialog
// (photo and bio), the leave a review dialog, and review lists. Used by both
// dashboards, the assignment page, and profile.html. Needs api.js first.

const ROLE_LABELS = { teacher: "Teacher", grade_angel: "Grade Angel" };

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// A round photo, or the person's initials on seafoam when they have none.
function avatarHtml(name, photoUrl, size = 48) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`;
  return photoUrl
    ? `<img class="avatar" src="${escapeHtml(photoUrl)}" alt="" style="${style}" />`
    : `<span class="avatar avatar-initials" aria-hidden="true" style="${style}">${escapeHtml(initials(name))}</span>`;
}

// Five stars filled to the rating (fractions included), with the number and
// review count next to them.
function starsHtml(rating, { showCount = true, size = "" } = {}) {
  const avg = rating && rating.average != null ? Number(rating.average) : null;
  const count = rating ? rating.count : 0;
  const pct = avg ? (avg / 5) * 100 : 0;
  const label = avg ? `${avg.toFixed(1)} out of 5 stars from ${count} review${count === 1 ? "" : "s"}` : "No reviews yet";
  return `
    <span class="stars ${size}" role="img" aria-label="${label}">
      <span class="stars-track" aria-hidden="true">★★★★★<span class="stars-fill" style="width:${pct}%">★★★★★</span></span>
      ${avg ? `<strong>${avg.toFixed(1)}</strong>` : ""}
      ${showCount ? `<span class="stars-count">${count ? `${count} review${count === 1 ? "" : "s"}` : "No reviews yet"}</span>` : ""}
    </span>`;
}

function starRowHtml(n) {
  return `<span class="stars small" aria-label="${n} out of 5 stars"><span class="stars-track" aria-hidden="true">★★★★★<span class="stars-fill" style="width:${n * 20}%">★★★★★</span></span></span>`;
}

function reviewsListHtml(reviews, emptyText) {
  if (!reviews || !reviews.length) {
    return `<div class="empty-state small"><div class="empty-icon">★</div><p>${emptyText}</p></div>`;
  }
  return `<ul class="review-list">${reviews.map((r) => `
    <li>
      <a class="review-author" href="/profile.html?id=${r.author.id}">${avatarHtml(r.author.name, r.author.photo_url, 36)}</a>
      <div>
        <div class="review-top">
          <a class="plain" href="/profile.html?id=${r.author.id}"><strong>${escapeHtml(r.author.name)}</strong></a>
          ${starRowHtml(r.rating)}
        </div>
        ${r.comment ? `<p>${escapeHtml(r.comment)}</p>` : ""}
        <span class="muted">${escapeHtml(r.assignment_subject || "")} · ${new Date(r.created_at).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span>
      </div>
    </li>`).join("")}</ul>`;
}

// Center crops a chosen image to a square and shrinks it to 400 pixels, so
// profile photos upload fast and always look right in a circle.
async function squarePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(400, side);
  canvas.getContext("2d").drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, canvas.width, canvas.height
  );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not read that photo"))), "image/jpeg", 0.85)
  );
}

function ensureDialog(id, html) {
  let dialog = document.getElementById(id);
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = id;
    dialog.className = "reason-dialog profile-dialog";
    document.body.appendChild(dialog);
  }
  dialog.innerHTML = html;
  return dialog;
}

// Opens the edit profile dialog. Resolves with the updated profile when
// saved, or null if closed without saving.
function openEditProfile(profile) {
  const isTeacher = profile.role === "teacher";
  const dialog = ensureDialog("edit-profile-dialog", `
    <form method="dialog" class="edit-profile">
      <h2>Edit your profile</h2>
      <div id="edit-profile-msg" class="msg" style="display:none"></div>
      <div class="photo-edit">
        <div id="photo-preview">${avatarHtml(profile.public_name, profile.photo_url, 96)}</div>
        <div>
          <label class="btn small secondary">Choose a photo
            <input type="file" accept="image/*" hidden id="photo-input" />
          </label>
          <button type="button" class="btn small ghost" id="photo-remove" ${profile.photo_url ? "" : "hidden"}>Remove</button>
          <p class="muted">A clear, friendly photo of your face works best.</p>
        </div>
      </div>
      ${isTeacher ? `
        <label for="edit-display-name">Name Grade Angels see</label>
        <input id="edit-display-name" maxlength="40" value="${escapeHtml(profile.display_name || "")}" placeholder="${escapeHtml(profile.public_name)}" />
        <p class="muted">Your full name stays private. Leave blank to show "${escapeHtml(profile.public_name)}".</p>` : ""}
      <label for="edit-bio">About me</label>
      <textarea id="edit-bio" maxlength="1000" rows="6" placeholder="${isTeacher
        ? "What you teach, your grade level, and what helps you most when your work comes back."
        : "Your teaching experience, favorite subjects, and how you approach feedback."}">${escapeHtml(profile.bio || "")}</textarea>
      <p class="muted"><span id="bio-count">0</span> of 1000 characters${isTeacher ? "" : ", at least 20"}.</p>
      <div class="row-actions">
        <button class="btn" type="button" id="edit-save">Save profile</button>
        <button class="btn ghost" type="button" id="edit-cancel">Cancel</button>
      </div>
    </form>`);

  const msg = dialog.querySelector("#edit-profile-msg");
  const bio = dialog.querySelector("#edit-bio");
  const count = dialog.querySelector("#bio-count");
  const updateCount = () => (count.textContent = bio.value.length);
  bio.addEventListener("input", updateCount);
  updateCount();

  let saved = null;
  let photoUrl = profile.photo_url;

  dialog.querySelector("#photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    showMessage(msg, "Uploading photo…", "success");
    try {
      const form = new FormData();
      form.set("file", await squarePhoto(file), "photo.jpg");
      ({ photo_url: photoUrl } = await apiPostForm("/api/profile/photo", form));
      dialog.querySelector("#photo-preview").innerHTML = avatarHtml(profile.public_name, photoUrl, 96);
      dialog.querySelector("#photo-remove").hidden = false;
      saved = { ...(saved || profile), photo_url: photoUrl };
      showMessage(msg, "Photo updated.", "success");
    } catch (err) {
      showMessage(msg, err.message, "error");
    }
  });

  dialog.querySelector("#photo-remove").addEventListener("click", async () => {
    try {
      await apiRequest("/api/profile/photo", { method: "DELETE" });
      photoUrl = null;
      dialog.querySelector("#photo-preview").innerHTML = avatarHtml(profile.public_name, null, 96);
      dialog.querySelector("#photo-remove").hidden = true;
      saved = { ...(saved || profile), photo_url: null };
    } catch (err) {
      showMessage(msg, err.message, "error");
    }
  });

  dialog.querySelector("#edit-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector("#edit-save").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const body = { bio: bio.value };
      if (isTeacher) body.display_name = dialog.querySelector("#edit-display-name").value;
      ({ profile: saved } = await apiPostJson("/api/profile", body));
      dialog.close();
    } catch (err) {
      showMessage(msg, err.message, "error");
    } finally {
      e.target.disabled = false;
    }
  });

  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(saved), { once: true }));
}

// Opens the leave a review dialog for one assignment. Resolves true once
// the review is saved.
function openReviewDialog({ assignmentId, subjectName, subjectRole }) {
  const dialog = ensureDialog("review-dialog", `
    <form method="dialog" class="review-form">
      <h2>Review ${escapeHtml(subjectName)}</h2>
      <p class="muted">${subjectRole === "grade_angel"
        ? "How was the grading? Accuracy, care, and turnaround all count."
        : "How was working with this teacher? Clear instructions and good pages all count."}
        Your review stays private until ${escapeHtml(subjectName)} reviews you too, or 14 days pass.</p>
      <div id="review-msg" class="msg" style="display:none"></div>
      <fieldset class="star-input" aria-label="Rating">
        ${[5, 4, 3, 2, 1].map((n) => `
          <input type="radio" name="rating" id="star-${n}" value="${n}" />
          <label for="star-${n}" title="${n} star${n === 1 ? "" : "s"}">★</label>`).join("")}
      </fieldset>
      <label for="review-comment">Comment (optional)</label>
      <textarea id="review-comment" maxlength="1000" rows="4"></textarea>
      <div class="row-actions">
        <button class="btn" type="button" id="review-save">Post review</button>
        <button class="btn ghost" type="button" id="review-cancel">Cancel</button>
      </div>
    </form>`);

  let done = false;
  const msg = dialog.querySelector("#review-msg");
  dialog.querySelector("#review-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector("#review-save").addEventListener("click", async (e) => {
    const picked = dialog.querySelector('input[name="rating"]:checked');
    if (!picked) return showMessage(msg, "Choose 1 to 5 stars.", "error");
    e.target.disabled = true;
    try {
      await apiPostJson("/api/reviews", {
        assignment_id: assignmentId,
        rating: Number(picked.value),
        comment: dialog.querySelector("#review-comment").value,
      });
      done = true;
      dialog.close();
    } catch (err) {
      showMessage(msg, err.message, "error");
      e.target.disabled = false;
    }
  });
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(done), { once: true }));
}

// The black banner at the top of each dashboard: photo, name, role, stars,
// and bio, with buttons to edit or view the public profile.
function renderProfileHero(el, profile, { onEdit } = {}) {
  const bio = profile.bio
    ? `<p class="hero-bio">${escapeHtml(profile.bio)}</p>`
    : `<p class="hero-bio empty">Add a photo and a short bio so ${profile.role === "teacher" ? "Grade Angels" : "teachers"} know who they are working with.</p>`;
  el.innerHTML = `
    <div class="inner">
      <button type="button" class="hero-avatar" id="hero-avatar" title="Change photo">
        ${avatarHtml(profile.public_name, profile.photo_url, 104)}
        <span class="hero-avatar-edit" aria-hidden="true">✎</span>
      </button>
      <div class="hero-main">
        <span class="role-badge">${ROLE_LABELS[profile.role] || ""}</span>
        <h1>${escapeHtml(profile.public_name)}</h1>
        ${starsHtml(profile.rating, { size: "large" })}
        ${bio}
        <div class="row-actions">
          <button type="button" class="btn small" id="hero-edit">Edit profile</button>
          <a class="btn small outline-light" href="/profile.html?id=${profile.id}">View my public profile</a>
        </div>
      </div>
    </div>`;
  const edit = async () => {
    const updated = await openEditProfile(profile);
    if (updated && onEdit) onEdit(updated);
  };
  el.querySelector("#hero-edit").addEventListener("click", edit);
  el.querySelector("#hero-avatar").addEventListener("click", edit);
}

// A stat tile with a small icon.
const STAT_ICONS = {
  clock: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>',
  money: '<path d="M12 2v20"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pages: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
};
function statTileHtml(icon, label, value, tone = "") {
  return `
    <div class="tile ${tone}">
      <span class="tile-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAT_ICONS[icon]}</svg></span>
      <span class="tile-value">${value}</span>
      <span class="tile-label">${label}</span>
    </div>`;
}

function emptyStateHtml(icon, title, text, action = "") {
  return `
    <div class="empty-state">
      <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAT_ICONS[icon]}</svg></div>
      <h3>${title}</h3>
      <p>${text}</p>
      ${action}
    </div>`;
}
