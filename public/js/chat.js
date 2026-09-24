// The chat between a teacher and their Grade Angel on the assignment page.
// Netlify functions cannot hold a connection open, so the chat checks for
// new messages every few seconds while it is on screen, and much less often
// when the tab is in the background. Needs api.js and profile-ui.js.

const CHAT_POLL_VISIBLE_MS = 4000;
const CHAT_POLL_HIDDEN_MS = 30000;

const CHAT_CLOSED_TEXT = {
  paid_out: "This chat closed when the Grade Angel was paid. The conversation stays here for your records.",
  cancelled: "This assignment was cancelled, so the chat is closed.",
  not_started: "The chat opens once a Grade Angel accepts this assignment.",
  not_participant: "You are viewing this conversation as an admin.",
};

function mountChat(root, assignmentId, myRole) {
  let lastId = 0;
  let timer = null;
  let people = {};
  let open = false;
  let stopped = false;

  root.innerHTML = `
    <div class="chat">
      <div class="chat-head">
        <h2>Chat</h2>
        <span class="chat-state" id="chat-state"></span>
      </div>
      <div class="chat-log" id="chat-log" aria-live="polite">
        <p class="muted chat-empty">Loading messages…</p>
      </div>
      <p class="chat-closed" id="chat-closed" hidden></p>
      <form class="chat-compose" id="chat-compose" hidden>
        <textarea id="chat-input" rows="2" maxlength="2000" placeholder="Write a message. Press Enter to send, Shift and Enter for a new line." aria-label="Message"></textarea>
        <button class="btn small" type="submit">Send</button>
      </form>
      <p class="chat-note" id="chat-note" hidden>Phone numbers and email addresses are removed automatically. Keep everything about the assignment here.</p>
      <div id="chat-msg" class="msg" style="display:none"></div>
    </div>`;

  const log = root.querySelector("#chat-log");
  const input = root.querySelector("#chat-input");
  const form = root.querySelector("#chat-compose");
  const msg = root.querySelector("#chat-msg");

  function timeLabel(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function append(messages) {
    if (!messages.length) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.querySelector(".chat-empty")?.remove();
    for (const m of messages) {
      if (m.id <= lastId) continue;
      lastId = m.id;
      const who = people[m.sender_id] || { name: "", photo_url: null };
      const el = document.createElement("div");
      el.className = "bubble-row" + (m.mine ? " mine" : "");
      el.innerHTML = `
        ${m.mine ? "" : avatarHtml(who.name, who.photo_url, 32)}
        <div class="bubble">
          ${m.mine ? "" : `<span class="bubble-name">${escapeHtml(who.name)}</span>`}
          <p>${escapeHtml(m.body)}</p>
          <span class="bubble-time">${timeLabel(m.created_at)}${m.redacted ? " · contact info removed" : ""}</span>
        </div>`;
      log.appendChild(el);
    }
    if (nearBottom || messages.some((m) => m.mine)) log.scrollTop = log.scrollHeight;
  }

  function applyState(chat) {
    people = chat.people || people;
    open = chat.open;
    const other = Object.values(people).find((p) => p.role !== myRole);
    root.querySelector("h2").textContent = other && myRole !== "admin" ? `Chat with ${other.name}` : "Chat";
    const state = root.querySelector("#chat-state");
    state.textContent = open ? "Open" : "Closed";
    state.className = "chat-state " + (open ? "open" : "closed");
    form.hidden = !open;
    root.querySelector("#chat-note").hidden = !open;
    const closed = root.querySelector("#chat-closed");
    closed.hidden = open;
    closed.textContent = open ? "" : CHAT_CLOSED_TEXT[chat.closed_reason] || "This chat is closed.";
  }

  async function poll() {
    if (stopped) return;
    try {
      const data = await apiGet(`/api/messages?assignment_id=${assignmentId}&after_id=${lastId}`);
      applyState(data.chat);
      if (!lastId && !data.messages.length) {
        log.innerHTML = `<p class="muted chat-empty">${open ? "No messages yet. Say hello, or ask a question about the assignment." : "No messages were sent."}</p>`;
      }
      append(data.messages);
      // A closed chat never changes again, so stop checking.
      if (!open) return;
    } catch (err) {
      if (/not available/i.test(err.message)) {
        root.hidden = true;
        return;
      }
    }
    timer = setTimeout(poll, document.hidden ? CHAT_POLL_HIDDEN_MS : CHAT_POLL_VISIBLE_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && open && !stopped) {
      clearTimeout(timer);
      poll();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const btn = form.querySelector("button");
    btn.disabled = true;
    showMessage(msg, "", "");
    try {
      const data = await apiPostJson(`/api/messages?after_id=${lastId}`, { assignment_id: assignmentId, body: text });
      input.value = "";
      applyState(data.chat);
      append(data.messages);
    } catch (err) {
      showMessage(msg, err.message, "error");
    } finally {
      btn.disabled = false;
      input.focus();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  poll();
  return { stop: () => ((stopped = true), clearTimeout(timer)) };
}
