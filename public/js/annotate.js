// Drawing marks on assignment pages, shared by the grading screen and the
// "Download marked PDF" button. A page's marks are a list of items with
// positions stored as fractions of the page (0 to 1), so they line up at
// any size:
//   { t: "pen" | "hl", c: "#D92D20", w: 0.004, p: [[x, y], ...] }
//   { t: "stamp", k: "check" | "x" | "circle" | "star" | "q", c, x, y, s }
//   { t: "text", c, x, y, s, text }
// plus a page score { e: earned, p: possible }.

const MARK_COLORS = { red: "#D92D20", green: "#12A150", blue: "#1D5FD1", black: "#111111", yellow: "#F5C400" };

// Draws one item. W and H are the page's size in canvas units.
function drawMarkItem(ctx, it, W, H) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = it.c || MARK_COLORS.red;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (it.t === "pen" || it.t === "hl") {
    if (it.t === "hl") ctx.globalAlpha *= 0.32;
    ctx.lineWidth = Math.max(1, it.w * W);
    ctx.beginPath();
    it.p.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    if (it.p.length === 1) ctx.lineTo(it.p[0][0] * W + 0.1, it.p[0][1] * H);
    ctx.stroke();
  } else if (it.t === "stamp") {
    drawStamp(ctx, it.k, it.x * W, it.y * H, it.s * W);
  } else if (it.t === "text") {
    const size = it.s * W;
    ctx.font = `600 ${size}px "Work Sans", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    String(it.text).split("\n").forEach((line, i) => {
      ctx.strokeText(line, it.x * W, it.y * H + i * size * 1.2);
      ctx.fillText(line, it.x * W, it.y * H + i * size * 1.2);
    });
  }
  ctx.restore();
}

// A stamp centered on (cx, cy), `size` wide.
function drawStamp(ctx, kind, cx, cy, size) {
  const r = size / 2;
  ctx.lineWidth = Math.max(2, size * 0.11);
  ctx.beginPath();
  if (kind === "check") {
    ctx.moveTo(cx - r * 0.8, cy);
    ctx.lineTo(cx - r * 0.2, cy + r * 0.6);
    ctx.lineTo(cx + r * 0.9, cy - r * 0.7);
    ctx.stroke();
  } else if (kind === "x") {
    ctx.moveTo(cx - r * 0.7, cy - r * 0.7);
    ctx.lineTo(cx + r * 0.7, cy + r * 0.7);
    ctx.moveTo(cx + r * 0.7, cy - r * 0.7);
    ctx.lineTo(cx - r * 0.7, cy + r * 0.7);
    ctx.stroke();
  } else if (kind === "circle") {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "star") {
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r * 0.42 : r;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  } else if (kind === "q") {
    ctx.font = `700 ${size * 1.1}px "Work Sans", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", cx, cy);
  }
}

function drawMarks(ctx, data, W, H, alpha = 1) {
  if (!data || !Array.isArray(data.items)) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  data.items.forEach((it) => drawMarkItem(ctx, it, W, H));
  ctx.restore();
}

// The score badge in the top right corner of an exported page.
function drawScoreBadge(ctx, score, W) {
  if (!score || score.e === null || score.e === undefined) return;
  const text = score.p !== null && score.p !== undefined ? `${score.e}/${score.p}` : `${score.e}`;
  const size = W * 0.035;
  ctx.save();
  ctx.font = `700 ${size}px "Work Sans", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + size;
  const x = W - w - W * 0.03, y = W * 0.03;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.strokeStyle = MARK_COLORS.red;
  ctx.lineWidth = Math.max(2, size * 0.12);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, size * 1.6, size * 0.8) : ctx.rect(x, y, w, size * 1.6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = MARK_COLORS.red;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + size / 2, y + size * 0.8);
  ctx.restore();
}

function loadPageImage(assignmentId, pageIndex) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Page ${pageIndex + 1} could not be loaded`));
    img.src = `/api/assignments/page?assignment_id=${assignmentId}&page=${pageIndex}`;
  });
}

// Which score counts for a page: the teacher's if they set one.
function effectiveScore(gradeAngelData, teacherData) {
  const t = teacherData && teacherData.score;
  if (t && t.e !== null && t.e !== undefined) return t;
  return (gradeAngelData && gradeAngelData.score) || null;
}

let pdfLibPromise = null;
function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = new Promise((resolve, reject) => {
      if (window.PDFLib) return resolve(window.PDFLib);
      const s = document.createElement("script");
      s.src = "/vendor/pdf-lib/pdf-lib.min.js";
      s.onload = () => resolve(window.PDFLib);
      s.onerror = () => reject(new Error("Could not load the PDF tools"));
      document.head.appendChild(s);
    });
  }
  return pdfLibPromise;
}

// Builds one PDF of every page with both layers of marks and the score, and
// downloads it. `marks` is the list from GET /api/grading.
async function exportMarkedPdf({ assignmentId, title, pages, marks, onProgress }) {
  const PDFLib = await loadPdfLib();
  const doc = await PDFLib.PDFDocument.create();
  const layer = (i, name) => (marks.find((m) => m.page_index === i && m.layer === name) || {}).data;
  for (let n = 0; n < pages.length; n++) {
    const i = pages[n].page_index;
    if (onProgress) onProgress(n + 1, pages.length);
    const img = await loadPageImage(assignmentId, i);
    const W = img.naturalWidth, H = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0);
    drawMarks(ctx, layer(i, "grade_angel"), W, H);
    drawMarks(ctx, layer(i, "teacher"), W, H);
    drawScoreBadge(ctx, effectiveScore(layer(i, "grade_angel"), layer(i, "teacher")), W);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    const jpg = await doc.embedJpg(await blob.arrayBuffer());
    // Letter width, keeping the page's shape.
    const pw = 612, ph = (612 * H) / W;
    doc.addPage([pw, ph]).drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
  }
  const bytes = await doc.save();
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${String(title || "graded").replace(/[^\w ]+/g, "").trim().replace(/\s+/g, "_") || "graded"}_graded.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
