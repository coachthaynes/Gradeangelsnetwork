// Turns a teacher's phone photos, scans, or PDFs into a clean, ordered set
// of page images, then uploads them one page per request.
//
// Every page is re-encoded in the browser as a JPEG no larger than
// MAX_EDGE pixels on its long side. A phone photo drops from several MB to
// a few hundred KB, which keeps uploads quick on school Wi-Fi and storage
// costs low, while staying sharp enough to read handwriting.

const MAX_EDGE = 1700;
const JPEG_QUALITY = 0.72;
const UPLOAD_CONCURRENCY = 3;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("/vendor/pdfjs/pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process image"))), "image/jpeg", JPEG_QUALITY)
  );
}

// Draws a source (image bitmap or canvas) scaled to fit MAX_EDGE, turned by
// `rotation` degrees (0, 90, 180, 270), on a white background.
async function renderPage(source, width, height, rotation = 0) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const sideways = rotation === 90 || rotation === 270;
  const canvas = document.createElement("canvas");
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  return { blob: await canvasToJpeg(canvas), width: canvas.width, height: canvas.height };
}

async function imageFileToPage(file) {
  let bitmap;
  try {
    // Browsers apply the photo's EXIF orientation here, so phone photos
    // come out upright.
    bitmap = await createImageBitmap(file);
  } catch {
    const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
    throw new Error(
      heic
        ? `${file.name} is an iPhone HEIC photo this browser cannot open. Upload it from Safari, or set the iPhone camera to Most Compatible.`
        : `${file.name} could not be opened as an image.`
    );
  }
  const page = await renderPage(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return page;
}

async function pdfFileToPages(file, onPage) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, MAX_EDGE / Math.max(base.width, base.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    onPage(await renderPage(canvas, canvas.width, canvas.height));
    page.cleanup();
  }
  await pdf.destroy();
}

class PageUploader {
  constructor(root, { onChange } = {}) {
    this.root = root;
    this.onChange = onChange || (() => {});
    this.pages = []; // { id, blob, width, height, rotation, url }
    this.busy = 0;
    this.nextId = 1;
    this.render();
  }

  get count() {
    return this.pages.length;
  }

  get isBusy() {
    return this.busy > 0;
  }

  async addFiles(fileList) {
    const files = [...fileList];
    const errors = [];
    this.busy++;
    this.renderStatus(`Preparing ${files.length} file${files.length === 1 ? "" : "s"}…`);
    try {
      for (const file of files) {
        try {
          if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
            await pdfFileToPages(file, (page) => this.push(page));
          } else {
            this.push(await imageFileToPage(file));
          }
        } catch (err) {
          errors.push(err.message || `${file.name} could not be read.`);
        }
      }
    } finally {
      this.busy--;
      this.renderStatus(errors.join(" "), errors.length ? "error" : "");
      this.onChange();
    }
  }

  push(page) {
    this.pages.push({ ...page, id: this.nextId++, rotation: 0, url: URL.createObjectURL(page.blob) });
    this.renderGrid();
    this.onChange();
  }

  clear() {
    this.pages.forEach((p) => URL.revokeObjectURL(p.url));
    this.pages = [];
    this.renderGrid();
    this.renderStatus("");
    this.onChange();
  }

  act(id, action) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i === -1) return;
    const page = this.pages[i];
    if (action === "left") page.rotation = (page.rotation + 270) % 360;
    if (action === "right") page.rotation = (page.rotation + 90) % 360;
    if (action === "earlier" && i > 0) [this.pages[i - 1], this.pages[i]] = [page, this.pages[i - 1]];
    if (action === "later" && i < this.pages.length - 1) [this.pages[i + 1], this.pages[i]] = [page, this.pages[i + 1]];
    if (action === "remove") {
      URL.revokeObjectURL(page.url);
      this.pages.splice(i, 1);
    }
    this.renderGrid();
    this.onChange();
  }

  // Applies any rotation the teacher chose, then uploads every page with a
  // few running at once. Each page is retried twice before giving up.
  async upload(assignmentId, onProgress) {
    let done = 0;
    const queue = this.pages.map((page, index) => ({ page, index }));
    const worker = async () => {
      while (queue.length) {
        const { page, index } = queue.shift();
        let final = page;
        if (page.rotation) {
          const bitmap = await createImageBitmap(page.blob);
          final = await renderPage(bitmap, bitmap.width, bitmap.height, page.rotation);
          bitmap.close();
        }
        for (let attempt = 0; ; attempt++) {
          try {
            const form = new FormData();
            form.set("assignment_id", String(assignmentId));
            form.set("page_index", String(index));
            form.set("width", String(final.width));
            form.set("height", String(final.height));
            form.set("file", final.blob, `page-${index + 1}.jpg`);
            await apiPostForm("/api/assignments/pages/upload", form);
            break;
          } catch (err) {
            if (attempt >= 2) throw new Error(`Page ${index + 1} did not upload: ${err.message}`);
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        done++;
        onProgress(done, this.pages.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
  }

  render() {
    this.root.classList.add("uploader");
    this.root.innerHTML = `
      <div class="uploader-drop">
        <p><strong>Add the pages to grade</strong></p>
        <p class="muted">Take a photo of each page, or upload scans or a PDF. Lay pages flat in good light and fill the frame.</p>
        <div class="row-actions">
          <label class="btn small">Take or choose photos
            <input type="file" accept="image/*" multiple hidden data-kind="images" />
          </label>
          <label class="btn small secondary">Upload a PDF or scan
            <input type="file" accept="application/pdf,image/*" multiple hidden data-kind="files" />
          </label>
        </div>
      </div>
      <p class="uploader-status muted" aria-live="polite"></p>
      <div class="page-grid"></div>
    `;
    this.root.querySelectorAll('input[type="file"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.files.length) this.addFiles(input.files);
        input.value = "";
      });
    });
    const drop = this.root.querySelector(".uploader-drop");
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      if (e.dataTransfer.files.length) this.addFiles(e.dataTransfer.files);
    });
    this.root.querySelector(".page-grid").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (btn) this.act(Number(btn.dataset.id), btn.dataset.action);
    });
  }

  renderStatus(text, kind = "") {
    const el = this.root.querySelector(".uploader-status");
    el.textContent = text;
    el.className = "uploader-status " + (kind === "error" ? "msg error" : "muted");
  }

  renderGrid() {
    const grid = this.root.querySelector(".page-grid");
    grid.innerHTML = this.pages
      .map(
        (p, i) => `
        <figure class="page-thumb">
          <div class="page-frame"><img src="${p.url}" alt="Page ${i + 1}" style="transform: rotate(${p.rotation}deg)" /></div>
          <figcaption>Page ${i + 1}</figcaption>
          <div class="page-tools">
            <button type="button" data-id="${p.id}" data-action="earlier" title="Move earlier" aria-label="Move page ${i + 1} earlier" ${i === 0 ? "disabled" : ""}>&#8592;</button>
            <button type="button" data-id="${p.id}" data-action="left" title="Rotate left" aria-label="Rotate page ${i + 1} left">&#8634;</button>
            <button type="button" data-id="${p.id}" data-action="right" title="Rotate right" aria-label="Rotate page ${i + 1} right">&#8635;</button>
            <button type="button" data-id="${p.id}" data-action="later" title="Move later" aria-label="Move page ${i + 1} later" ${i === this.pages.length - 1 ? "disabled" : ""}>&#8594;</button>
            <button type="button" data-id="${p.id}" data-action="remove" title="Remove" aria-label="Remove page ${i + 1}" class="danger">&#10005;</button>
          </div>
        </figure>`
      )
      .join("");
  }
}

// Builds one PDF from an assignment's stored pages, for downloading or
// printing. Needs /vendor/pdf-lib/pdf-lib.min.js on the page.
async function downloadPagesAsPdf(assignmentId, pageCount, filename, onProgress) {
  const pdf = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const res = await fetch(pageImageUrl(assignmentId, i), { credentials: "include" });
    if (!res.ok) throw new Error(`Could not load page ${i + 1}`);
    const bytes = await res.arrayBuffer();
    const type = res.headers.get("content-type") || "";
    const image = type.includes("png") ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    if (onProgress) onProgress(i + 1, pageCount);
  }
  const blob = new Blob([await pdf.save()], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
