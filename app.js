// ============================================================================
// BlurFace AI — распознавание лиц (MediaPipe) + трекинг + замазывание + экспорт.
// Всё выполняется локально в браузере, видео никуда не отправляется.
// ============================================================================

// --- Глобальный перехват ошибок: любой сбой виден прямо в приложении ---
window.addEventListener('error', (e) => {
  showStatus('⚠ Ошибка в приложении: ' + (e.message || 'неизвестная ошибка') +
    (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''), 'error');
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  showStatus('⚠ Ошибка в приложении: ' + msg, 'error');
});

let FaceDetector, FilesetResolver;
let faceDetector = null;
let faceDetectorAvailable = true;

const els = {};
['statusBanner','dropZone','fileInput','uploadPanel','editPanel','settingsPanel','processPanel',
 'sourceVideo','previewCanvas','stage','faceCountBadge','excludeBadge','clearExcludeBtn',
 'intensitySlider','intensityVal','intensityLabel','confidenceSlider','confidenceVal',
 'persistSlider','persistVal','processBtn','cancelProcessBtn','progressWrap','progressFill','progressText',
 'resultBox','resultVideo','downloadLink','startOverBtn','batchResultBox','batchCount','batchDownloadLink',
 'batchStartOverBtn','batchToggle','emojiRow','colorRow','formatNote','scrubSlider','scrubVal'
].forEach(id => els[id] = document.getElementById(id));

const ctx = els.previewCanvas.getContext('2d', { willReadFrequently: true });

function showStatus(msg, kind){
  els.statusBanner.textContent = msg;
  els.statusBanner.className = 'status-banner show' + (kind === 'error' ? ' error' : '');
}
function hideStatus(){ els.statusBanner.className = 'status-banner'; }

// ---------------------------------------------------------------------------
// Настройки (состояние UI)
// ---------------------------------------------------------------------------

const settings = {
  style: 'pixelate',
  emoji: '😎',
  color: '#5fb8a8',
  area: 'face',
  intensity: 50,
  confidence: 0.3,
  persistMs: 500,
  quality: 'original',
  speed: 'quality',
  format: 'webm',
};

const COLOR_PRESETS = ['#5fb8a8','#c98a4b','#c65c4a','#8b5fb8','#e0a868','#4a90c6'];
COLOR_PRESETS.forEach(c => {
  const btn = document.createElement('div');
  btn.className = 'color-btn' + (c === settings.color ? ' active' : '');
  btn.style.background = c;
  btn.dataset.color = c;
  btn.addEventListener('click', () => {
    settings.color = c;
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (!isProcessing) renderStaticPreview();
  });
  els.colorRow.appendChild(btn);
});

document.querySelectorAll('.style-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.style = btn.dataset.style;
    els.emojiRow.style.display = settings.style === 'emoji' ? 'flex' : 'none';
    els.colorRow.style.display = settings.style === 'circle' ? 'flex' : 'none';
    if (!isProcessing) renderStaticPreview();
  });
});
document.querySelectorAll('.emoji-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.emoji = btn.dataset.emoji;
    if (!isProcessing) renderStaticPreview();
  });
});
document.querySelectorAll('.area-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.area-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.area = btn.dataset.area;
    if (!isProcessing) renderStaticPreview();
  });
});
document.getElementById('qualityRow').querySelectorAll('.select-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('qualityRow').querySelectorAll('.select-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.quality = btn.dataset.quality;
  });
});
document.getElementById('speedRow').querySelectorAll('.select-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('speedRow').querySelectorAll('.select-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.speed = btn.dataset.speed;
  });
});
document.getElementById('formatRow').querySelectorAll('.select-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('formatRow').querySelectorAll('.select-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.format = btn.dataset.format;
    updateFormatNote();
  });
});

const INTENSITY_LABELS = [[0,'Почти незаметно'],[20,'Лёгкое'],[45,'Стандарт'],[70,'Сильное'],[95,'Максимум']];
els.intensitySlider.addEventListener('input', () => {
  settings.intensity = parseInt(els.intensitySlider.value, 10);
  els.intensityVal.textContent = settings.intensity;
  let label = INTENSITY_LABELS[0][1];
  for (const [th, txt] of INTENSITY_LABELS) if (settings.intensity >= th) label = txt;
  els.intensityLabel.textContent = label;
  if (!isProcessing) renderStaticPreview();
});
els.confidenceSlider.addEventListener('input', () => {
  settings.confidence = parseInt(els.confidenceSlider.value, 10) / 100;
  els.confidenceVal.textContent = els.confidenceSlider.value + '%';
  if (!isProcessing) renderStaticPreview();
});
els.persistSlider.addEventListener('input', () => {
  settings.persistMs = parseInt(els.persistSlider.value, 10) * 100;
  els.persistVal.textContent = (settings.persistMs / 1000).toFixed(1) + 'с';
});

function updateFormatNote(){
  const supported = MediaRecorder.isTypeSupported ? getSupportedMime(settings.format) : null;
  els.formatNote.textContent = supported ? '' : `${settings.format.toUpperCase()} не поддерживается этим браузером — при экспорте автоматически подставится доступный формат.`;
}

// ---------------------------------------------------------------------------
// Загрузка модели распознавания лиц (не блокирует показ видео)
// ---------------------------------------------------------------------------

async function initFaceDetector(){
  try {
    if (!FaceDetector || !FilesetResolver){
      const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
      FaceDetector = mod.FaceDetector;
      FilesetResolver = mod.FilesetResolver;
    }
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        // ВАЖНО: пробовал full-range модель для лучшего распознавания профиля,
        // но она несовместима с этой версией библиотеки на уровне внутренней
        // конфигурации графа (ошибка "raw_box_tensor->shape().dims[1] ==
        // num_boxes_ (2304 vs. 896)") — файл модели существует, но графовый
        // пайплайн в @mediapipe/tasks-vision жёстко рассчитан на анкеры
        // short-range модели. Возврат на short-range.
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.15
    });
    faceDetectorAvailable = true;
    hideStatus();
    // ВАЖНО: раньше здесь стоял вызов renderStaticPreview(), который пытался
    // распознать лицо на ещё НЕ загруженном видео (нулевого размера кадр).
    // MediaPipe отвечал на это ошибкой "ROI width/height must be > 0" и, что
    // хуже, детектор после такой ошибки переставал находить лица вообще —
    // на любом видео, загруженном впоследствии. Именно это было корнем всех
    // жалоб "не находит лицо". Поэтому детекцию теперь не запускаем, пока
    // пользователь реально не выбрал видеофайл.
    if (els.sourceVideo.videoWidth > 0){
      renderStaticPreview();
    }
  } catch(e){
    faceDetectorAvailable = false;
    showStatus('⚠ Не удалось загрузить модель автоматического распознавания лиц (проверь интернет). Ручные функции недоступны в этой версии без детектора.', 'error');
  }
}
initFaceDetector(); // грузим сразу в фоне, не дожидаясь выбора файла

// ---------------------------------------------------------------------------
// Загрузка файла(ов)
// ---------------------------------------------------------------------------

let queuedFiles = [];

els.batchToggle.addEventListener('change', () => {
  els.fileInput.multiple = els.batchToggle.checked;
});

els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('dragover'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragover'));
els.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFileSelection(Array.from(e.dataTransfer.files));
});
els.fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFileSelection(Array.from(e.target.files));
});

function looksLikeVideo(file){
  return file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(file.name || '');
}

async function handleFileSelection(files){
  const videos = files.filter(looksLikeVideo);
  if (!videos.length){
    showStatus('Это не похоже на видеофайл(ы). Выбери mp4, mov, webm и т.п.', 'error');
    return;
  }
  hideStatus();

  if (els.batchToggle.checked && videos.length > 1){
    queuedFiles = videos;
    els.editPanel.style.display = 'none'; // в пакетном режиме поштучный предпросмотр/исключение не показываем
    els.settingsPanel.style.display = 'block';
    els.processPanel.style.display = 'block';
    els.processBtn.textContent = `▶ Обработать ${videos.length} видео`;
    showStatus(`Загружено ${videos.length} видео для пакетной обработки. Настрой стиль ниже и нажми «Обработать».`);
    return;
  }

  queuedFiles = [];
  await loadSingleVideoPreview(videos[0]);
}

async function loadSingleVideoPreview(file){
  resetTracking();
  const url = URL.createObjectURL(file);
  els.sourceVideo.src = url;
  const loaded = await new Promise((resolve) => {
    els.sourceVideo.onloadedmetadata = () => resolve(true);
    els.sourceVideo.onerror = () => resolve(false);
  });
  if (!loaded){
    showStatus('Не удалось прочитать видеофайл — возможно, формат не поддерживается этим браузером.', 'error');
    return;
  }
  els.previewCanvas.width = els.sourceVideo.videoWidth;
  els.previewCanvas.height = els.sourceVideo.videoHeight;

  els.editPanel.style.display = 'block';
  els.settingsPanel.style.display = 'block';
  els.processPanel.style.display = 'block';
  els.processBtn.textContent = '▶ Обработать';
  els.resultBox.classList.remove('show');
  els.batchResultBox.classList.remove('show');

  // Берём кадр не с самого начала, а чуть внутрь ролика — у многих видео
  // первая доля секунды это чёрный кадр или человек ещё не в кадре, и
  // превью тогда ложно показывает "лицо не найдено", хотя дальше по видео
  // оно прекрасно находится (сама обработка проверяет КАЖДЫЙ кадр, не только этот).
  els.sourceVideo.currentTime = Math.min(0.5, els.sourceVideo.duration * 0.1);
  await new Promise((resolve) => { els.sourceVideo.onseeked = resolve; });
  els.scrubSlider.value = 10;
  els.scrubVal.textContent = '10%';
  renderStaticPreview();
  updateFormatNote();
}

// ---------------------------------------------------------------------------
// Трекинг лиц (для «держать маску» и «не трогать этого человека»)
// ---------------------------------------------------------------------------

let trackedFaces = [];
let nextTrackId = 1;
let excludeAnchorPx = null; // {x,y} в пикселях канваса, задаётся кликом
let excludeConsumed = true; // true = нет активного поиска исключения на этот клип

function resetTracking(){
  trackedFaces = [];
  nextTrackId = 1;
  excludeAnchorPx = null;
  excludeConsumed = true;
  els.excludeBadge.style.display = 'none';
  els.clearExcludeBtn.style.display = 'none';
}

let lastDetectionError = null;
let isReinitializingDetector = false;

async function recoverDetectorAfterError(){
  // Внутренний граф MediaPipe иногда "залипает" в плохом состоянии после
  // ошибки (RET_CHECK/CalculatorGraph) и продолжает молча ничего не находить
  // на всех следующих кадрах. Пересоздаём детектор с нуля в фоне, чтобы
  // сессия не оставалась сломанной до перезагрузки страницы.
  if (isReinitializingDetector) return;
  isReinitializingDetector = true;
  faceDetectorAvailable = false;
  try {
    faceDetector = await FaceDetector.createFromOptions(await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    ), {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        delegate: "CPU"
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.15
    });
    faceDetectorAvailable = true;
    lastDetectionError = null;
  } catch(e){
    faceDetectorAvailable = false;
  }
  isReinitializingDetector = false;
}

const MAX_FACE_AREA_FRACTION = 0.35; // реальное лицо редко занимает больше трети кадра

function isPlausibleFaceSize(bbox, canvasW, canvasH){
  const frameArea = canvasW * canvasH;
  if (frameArea <= 0) return true;
  const boxArea = bbox.width * bbox.height;
  return (boxArea / frameArea) <= MAX_FACE_AREA_FRACTION;
}

function detectRawFaces(source){
  if (!faceDetector || !faceDetectorAvailable) return [];
  const srcW = source.videoWidth || source.width;
  const srcH = source.videoHeight || source.height;
  if (!srcW || !srcH) return []; // защита: пустой/незагруженный кадр ломает детектор
  let result;
  try {
    result = faceDetector.detectForVideo(source, performance.now());
    lastDetectionError = null;
  } catch(e){
    lastDetectionError = e.message || String(e);
    recoverDetectorAfterError();
    return [];
  }
  return (result.detections || [])
    .filter(d => (d.categories?.[0]?.score ?? 0) >= settings.confidence)
    .filter(d => isPlausibleFaceSize(d.boundingBox, els.previewCanvas.width, els.previewCanvas.height))
    .map(d => expandBoxForArea(d.boundingBox, settings.area));
}

function expandBoxForArea(bbox, area){
  // Множители относительно размера лица — приближение, не точная сегментация.
  const M = {
    face: { top:0.15, side:0.15, bottom:0.15 },
    hair: { top:0.8,  side:0.25, bottom:0.1  },
    head: { top:0.9,  side:0.4,  bottom:0.25 },
    neck: { top:0.9,  side:0.4,  bottom:0.9  },
  }[area] || { top:0.15, side:0.15, bottom:0.15 };

  let x = bbox.originX - bbox.width * M.side;
  let y = bbox.originY - bbox.height * M.top;
  let w = bbox.width * (1 + M.side * 2);
  let h = bbox.height * (1 + M.top + M.bottom);

  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(w, els.previewCanvas.width - x);
  h = Math.min(h, els.previewCanvas.height - y);
  return { x, y, w, h };
}

function updateTracks(rawBoxes, nowMs){
  const used = new Set();
  const seenThisFrame = [];
  rawBoxes.forEach(box => {
    const cx = box.x + box.w/2, cy = box.y + box.h/2;
    let bestIdx = -1, bestDist = Infinity;
    trackedFaces.forEach((t, idx) => {
      if (used.has(idx)) return;
      const tcx = t.x + t.w/2, tcy = t.y + t.h/2;
      const dist = Math.hypot(cx-tcx, cy-tcy);
      const threshold = Math.max(box.w, box.h) * 1.3;
      if (dist < threshold && dist < bestDist){ bestDist = dist; bestIdx = idx; }
    });
    let track;
    if (bestIdx >= 0){
      used.add(bestIdx);
      track = trackedFaces[bestIdx];
      track.x = box.x; track.y = box.y; track.w = box.w; track.h = box.h; track.lastSeen = nowMs;
    } else {
      track = { id: nextTrackId++, x:box.x, y:box.y, w:box.w, h:box.h, lastSeen: nowMs, excluded:false };
      trackedFaces.push(track);
    }
    seenThisFrame.push(track);
  });

  // применяем "исключение" по клику один раз, к ближайшему реально увиденному треку
  if (!excludeConsumed && excludeAnchorPx && seenThisFrame.length){
    let bestT = null, bestDist = Infinity;
    seenThisFrame.forEach(t => {
      const tcx = t.x + t.w/2, tcy = t.y + t.h/2;
      const dist = Math.hypot(tcx - excludeAnchorPx.x, tcy - excludeAnchorPx.y);
      if (dist < bestDist){ bestDist = dist; bestT = t; }
    });
    if (bestT){ bestT.excluded = true; excludeConsumed = true; }
  }

  // persistence: держим маску на месте, если лицо пропало, но недолго
  const persisted = trackedFaces.filter(t => !seenThisFrame.includes(t) && (nowMs - t.lastSeen) <= settings.persistMs);

  // сборка мусора: забываем треки, потерянные надолго (иначе список растёт бесконечно)
  trackedFaces = trackedFaces.filter(t => (nowMs - t.lastSeen) <= Math.max(settings.persistMs, 3000));

  return [...seenThisFrame, ...persisted];
}

// ---------------------------------------------------------------------------
// Статичный предпросмотр первого кадра + клик "не трогать"
// ---------------------------------------------------------------------------

function renderStaticPreview(){
  ctx.drawImage(els.sourceVideo, 0, 0, els.previewCanvas.width, els.previewCanvas.height);
  // ВАЖНО: распознаём по уже отрисованному canvas (els.previewCanvas), а не по
  // сырому <video>. У видео с телефона часто есть отдельные метаданные
  // поворота (снято боком) — плеер и canvas.drawImage() их правильно
  // учитывают при отображении, а прямая подача видео в детектор могла отдавать
  // координаты для НЕповёрнутого сырого кадра, из-за чего рамка оказывалась
  // совсем не там, где реальное лицо на экране.
  const raw = detectRawFaces(els.previewCanvas);
  const tracks = updateTracks(raw, performance.now());

  ctx.lineWidth = Math.max(2, els.previewCanvas.width * 0.004);
  tracks.forEach(t => {
    ctx.strokeStyle = t.excluded ? '#c98a4b' : '#5fb8a8';
    ctx.strokeRect(t.x, t.y, t.w, t.h);
  });

  els.faceCountBadge.textContent = raw.length > 0
    ? `найдено лиц на этом кадре: ${raw.length}`
    : 'на этом кадре превью лиц не видно — это нормально, обработка проверит каждый кадр видео отдельно';

  if (lastDetectionError){
    showStatus('⚠ Реальная ошибка при распознавании: ' + lastDetectionError, 'error');
  }
  const excluded = tracks.find(t => t.excluded);
  if (excluded){
    els.excludeBadge.style.display = 'inline-block';
    els.excludeBadge.textContent = '👤 1 человек не будет замазан';
    els.clearExcludeBtn.style.display = 'inline-block';
  } else {
    els.excludeBadge.style.display = 'none';
    els.clearExcludeBtn.style.display = 'none';
  }
}

els.previewCanvas.addEventListener('click', (e) => {
  const rect = els.previewCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * els.previewCanvas.width;
  const y = (e.clientY - rect.top) / rect.height * els.previewCanvas.height;
  excludeAnchorPx = { x, y };
  excludeConsumed = false;
  renderStaticPreview();
});

els.scrubSlider.addEventListener('input', async () => {
  const pct = parseInt(els.scrubSlider.value, 10);
  els.scrubVal.textContent = pct + '%';
  if (!els.sourceVideo.duration) return;
  els.sourceVideo.currentTime = (pct / 100) * els.sourceVideo.duration;
  await new Promise((resolve) => { els.sourceVideo.onseeked = resolve; });
  renderStaticPreview();
});

els.clearExcludeBtn.addEventListener('click', () => {
  trackedFaces.forEach(t => t.excluded = false);
  excludeAnchorPx = null;
  excludeConsumed = true;
  renderStaticPreview();
});

// ---------------------------------------------------------------------------
// Применение эффекта
// ---------------------------------------------------------------------------

function applyEffect(videoEl, track){
  const { x:x0, y:y0, w:w0, h:h0 } = track;
  const x = Math.max(0, Math.floor(x0)), y = Math.max(0, Math.floor(y0));
  const w = Math.min(Math.floor(w0), els.previewCanvas.width - x);
  const h = Math.min(Math.floor(h0), els.previewCanvas.height - y);
  if (w <= 0 || h <= 0) return;
  const intensity = settings.intensity;

  if (settings.style === 'black'){
    const alpha = 0.3 + (intensity/100) * 0.7;
    ctx.fillStyle = `rgba(10,10,10,${alpha})`;
    ctx.fillRect(x, y, w, h);

  } else if (settings.style === 'circle'){
    const alpha = 0.5 + (intensity/100) * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x + w/2, y + h/2, w/2, h/2, 0, 0, Math.PI*2);
    ctx.fillStyle = hexToRgba(settings.color, alpha);
    ctx.fill();
    ctx.restore();

  } else if (settings.style === 'emoji'){
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#12161b';
    ctx.fillRect(x, y, w, h);
    const size = Math.min(w, h) * (0.6 + (intensity/100)*0.5);
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(settings.emoji, x + w/2, y + h/2);
    ctx.restore();

  } else if (settings.style === 'pixelate'){
    const cellCount = Math.max(2, Math.round(24 - (intensity/100) * 20));
    const sw = Math.max(1, Math.floor(w / cellCount));
    const sh = Math.max(1, Math.floor(h / cellCount));
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.floor(w / sw));
    tmp.height = Math.max(1, Math.floor(h / sh));
    const tctx = tmp.getContext('2d');
    tctx.drawImage(videoEl, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    ctx.imageSmoothingEnabled = true;

  } else if (settings.style === 'blur'){
    // Тот же фикс: ctx.filter не работает в Safari, используем downscale/upscale.
    const scaleFactor = Math.max(0.02, 0.28 - (intensity/100) * 0.26); // сильнее на любом значении слайдера
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w * scaleFactor));
    tmp.height = Math.max(1, Math.round(h * scaleFactor));
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(videoEl, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
  }
}

function hexToRgba(hex, alpha){
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------------------
// Экспорт: качество / скорость / формат
// ---------------------------------------------------------------------------

const QUALITY_HEIGHTS = { original: null, '1080': 1080, '720': 720, '480': 480 };
const SPEED_PROFILES = {
  quality: { fps: 30, detectEveryNFrames: 1 },
  balance: { fps: 24, detectEveryNFrames: 2 },
  fast:    { fps: 20, detectEveryNFrames: 3 },
};

function getSupportedMime(preferred){
  const groups = {
    webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
    mp4:  ['video/mp4;codecs=avc1,mp4a', 'video/mp4']
  };
  const order = preferred === 'mp4' ? [...groups.mp4, ...groups.webm] : [...groups.webm, ...groups.mp4];
  return order.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || null;
}

function computeOutputDims(videoEl){
  const targetH = QUALITY_HEIGHTS[settings.quality];
  if (!targetH || videoEl.videoHeight <= targetH){
    return { w: videoEl.videoWidth, h: videoEl.videoHeight };
  }
  const scale = targetH / videoEl.videoHeight;
  return { w: Math.round(videoEl.videoWidth * scale), h: targetH };
}

let isProcessing = false;
let cancelRequested = false;

els.processBtn.addEventListener('click', () => {
  if (queuedFiles.length > 1) startBatchProcessing(); else startSingleProcessing();
});
els.cancelProcessBtn.addEventListener('click', () => { cancelRequested = true; });
els.startOverBtn.addEventListener('click', () => location.reload());
els.batchStartOverBtn.addEventListener('click', () => location.reload());

async function processOneVideo(videoEl, canvasEl, onProgress){
  const dims = computeOutputDims(videoEl);
  canvasEl.width = dims.w; canvasEl.height = dims.h;
  const outCtx = canvasEl.getContext('2d');
  const profile = SPEED_PROFILES[settings.speed];

  const mimeType = getSupportedMime(settings.format);
  if (!mimeType) throw new Error('Браузер не поддерживает запись видео (MediaRecorder).');

  const canvasStream = canvasEl.captureStream(profile.fps);
  let audioTracks = [];
  try {
    const audioSource = videoEl.captureStream ? videoEl.captureStream() : videoEl.mozCaptureStream();
    audioTracks = audioSource.getAudioTracks();
  } catch(e){ /* видео без звука или captureStream недоступен — продолжаем без аудио */ }
  const combined = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

  const chunks = [];
  const recorder = new MediaRecorder(combined, { mimeType });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  resetTracking();
  recorder.start();
  videoEl.currentTime = 0;
  await new Promise((resolve) => { videoEl.onseeked = resolve; });
  await videoEl.play();

  let frameIdx = 0;
  let lastTracks = [];
  let totalDetections = 0;
  let framesChecked = 0;

  function loop(){
    if (cancelRequested || videoEl.ended || videoEl.paused){
      if (recorder.state !== 'inactive') recorder.stop();
      return;
    }
    outCtx.drawImage(videoEl, 0, 0, dims.w, dims.h);

    if (frameIdx % profile.detectEveryNFrames === 0){
      // Так же, как в предпросмотре: распознаём по уже отрисованному canvas
      // (canvasEl), а не по сырому видео — устраняет рассинхронизацию
      // координат из-за поворота видео, снятого боком.
      const raw = detectRawFacesOnCanvas(canvasEl);
      framesChecked++;
      if (raw.length > 0) totalDetections++;
      lastTracks = updateTracks(raw, performance.now());
    }
    lastTracks.forEach(t => { if (!t.excluded) applyEffectScaled(outCtx, videoEl, t, dims); });

    frameIdx++;
    onProgress(videoEl.currentTime / videoEl.duration);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  await stopped;
  videoEl.pause();
  if (cancelRequested) return null;

  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  return { blob: new Blob(chunks, { type: mimeType.split(';')[0] }), ext, totalDetections, framesChecked };
}

// Распознаём прямо по уже отрисованному canvas (не по сырому видео) — так
// координаты гарантированно совпадают с тем, что реально видно на экране,
// независимо от поворота исходного видеофайла. Масштабирование видео-space
// больше не нужно: canvas уже в целевом разрешении (с учётом "Качества").
function detectRawFacesOnCanvas(canvasEl){
  if (!faceDetector || !faceDetectorAvailable) return [];
  if (!canvasEl.width || !canvasEl.height) return []; // защита от пустого кадра
  let result;
  try { result = faceDetector.detectForVideo(canvasEl, performance.now()); lastDetectionError = null; }
  catch(e){ lastDetectionError = e.message || String(e); recoverDetectorAfterError(); return []; }
  return (result.detections || [])
    .filter(d => (d.categories?.[0]?.score ?? 0) >= settings.confidence)
    .filter(d => isPlausibleFaceSize(d.boundingBox, canvasEl.width, canvasEl.height))
    .map(d => expandBoxForAreaDims(d.boundingBox, settings.area, {w: canvasEl.width, h: canvasEl.height}));
}
function expandBoxForAreaDims(bbox, area, dims){
  const M = {
    face: { top:0.15, side:0.15, bottom:0.15 },
    hair: { top:0.8,  side:0.25, bottom:0.1  },
    head: { top:0.9,  side:0.4,  bottom:0.25 },
    neck: { top:0.9,  side:0.4,  bottom:0.9  },
  }[area] || { top:0.15, side:0.15, bottom:0.15 };
  let x = bbox.originX - bbox.width * M.side;
  let y = bbox.originY - bbox.height * M.top;
  let w = bbox.width * (1 + M.side * 2);
  let h = bbox.height * (1 + M.top + M.bottom);
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(w, dims.w - x); h = Math.min(h, dims.h - y);
  return { x, y, w, h };
}
function applyEffectScaled(outCtx, videoEl, track, dims){
  applyEffectOnContext(outCtx, videoEl, track, dims);
}
function applyEffectOnContext(targetCtx, videoEl, track, dims){
  const { x:x0, y:y0, w:w0, h:h0 } = track;
  const x = Math.max(0, Math.floor(x0)), y = Math.max(0, Math.floor(y0));
  const w = Math.min(Math.floor(w0), dims.w - x);
  const h = Math.min(Math.floor(h0), dims.h - y);
  if (w <= 0 || h <= 0) return;
  const intensity = settings.intensity;
  // ВАЖНО: пикселизация/размытие теперь читают исходные пиксели из САМОГО
  // canvas (targetCtx.canvas), а не из сырого <video> — тот же кадр уже
  // отрисован туда правильной стороной на этом же шаге цикла. Раньше здесь
  // был пересчёт координат обратно в пространство видео (scaleX/scaleY) для
  // чтения из videoEl напрямую — при видео с поворотом (снято боком на
  // телефон) это давало те же смещения, что и раньше в самом распознавании.
  const sourceCanvas = targetCtx.canvas;

  if (settings.style === 'black'){
    const alpha = 0.3 + (intensity/100) * 0.7;
    targetCtx.fillStyle = `rgba(10,10,10,${alpha})`;
    targetCtx.fillRect(x, y, w, h);
  } else if (settings.style === 'circle'){
    const alpha = 0.5 + (intensity/100) * 0.5;
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.ellipse(x + w/2, y + h/2, w/2, h/2, 0, 0, Math.PI*2);
    targetCtx.fillStyle = hexToRgba(settings.color, alpha);
    targetCtx.fill();
    targetCtx.restore();
  } else if (settings.style === 'emoji'){
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.rect(x, y, w, h);
    targetCtx.clip();
    targetCtx.fillStyle = '#12161b';
    targetCtx.fillRect(x, y, w, h);
    const size = Math.min(w, h) * (0.6 + (intensity/100)*0.5);
    targetCtx.font = `${size}px sans-serif`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    targetCtx.fillText(settings.emoji, x + w/2, y + h/2);
    targetCtx.restore();
  } else if (settings.style === 'pixelate'){
    const cellCount = Math.max(2, Math.round(24 - (intensity/100) * 20));
    const sw = Math.max(1, Math.floor(w / cellCount));
    const sh = Math.max(1, Math.floor(h / cellCount));
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.floor(w / sw));
    tmp.height = Math.max(1, Math.floor(h / sh));
    const tctx = tmp.getContext('2d');
    // координаты уже в пространстве canvas — читаем прямо оттуда
    tctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    targetCtx.imageSmoothingEnabled = true;
  } else if (settings.style === 'blur'){
    // ВАЖНО: ctx.filter = 'blur()' физически НЕ поддерживается в Safari/WebKit
    // (подтверждено официальной документацией MDN и багтрекером WebKit) — код
    // не выдавал ошибку, но эффект молча не применялся. Настоящая причина
    // "лицо не замазывается" при выбранном стиле "Размытие" была именно в этом.
    // Заменено на уменьшение+увеличение картинки со сглаживанием — простой
    // приём, дающий эффект размытия средствами, которые поддерживают все браузеры.
    const scaleFactor = Math.max(0.02, 0.28 - (intensity/100) * 0.26); // сильнее на любом значении слайдера
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w * scaleFactor));
    tmp.height = Math.max(1, Math.round(h * scaleFactor));
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    targetCtx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
  }
}

// ---------------------------------------------------------------------------
// Одиночная обработка
// ---------------------------------------------------------------------------

async function startSingleProcessing(){
  if (!faceDetectorAvailable){
    showStatus('Автопоиск лиц недоступен (не загрузилась модель) — обработка без него ничего не замажет. Обнови страницу для повторной попытки.', 'error');
    return;
  }
  isProcessing = true;
  cancelRequested = false;
  els.processBtn.disabled = true;
  els.cancelProcessBtn.style.display = 'inline-block';
  els.progressWrap.classList.add('show');
  els.resultBox.classList.remove('show');

  try {
    const result = await processOneVideo(els.sourceVideo, els.previewCanvas, (frac) => {
      const pct = Math.min(100, Math.round(frac * 100));
      els.progressFill.style.width = pct + '%';
      els.progressText.textContent = pct + '%' + (cancelRequested ? ' (отмена…)' : '');
    });
    if (result){
      const url = URL.createObjectURL(result.blob);
      els.resultVideo.src = url;
      els.downloadLink.href = url;
      els.downloadLink.download = 'blurface-result.' + result.ext;
      els.resultBox.classList.add('show');
      els.progressText.textContent = `Готово · лицо находилось на ${result.totalDetections} из ${result.framesChecked} проверенных кадров`;
      if (result.totalDetections === 0){
        const errPart = lastDetectionError ? ` Техническая причина: ${lastDetectionError}` : '';
        showStatus(`⚠ Готово, но за все ${result.framesChecked} проверенных кадров ни разу не было найдено лицо — поэтому видео вышло без изменений.${errPart} Дело не в настройках стиля/силы.`, 'error');
      } else {
        showStatus(`ℹ Для диагностики: лицо было найдено на ${result.totalDetections} из ${result.framesChecked} кадров. Формат записи: ${result.ext}. Если в скачанном видео лицо всё равно не замазано при таких цифрах — пришли мне этот текст, это укажет на другую причину.`);
      }
    }
  } catch(e){
    showStatus('⚠ Ошибка обработки: ' + e.message, 'error');
  }

  isProcessing = false;
  els.processBtn.disabled = false;
  els.cancelProcessBtn.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Пакетная обработка
// ---------------------------------------------------------------------------

async function startBatchProcessing(){
  if (!faceDetectorAvailable){
    showStatus('Автопоиск лиц недоступен (не загрузилась модель) — пакетная обработка без него ничего не замажет. Обнови страницу для повторной попытки.', 'error');
    return;
  }
  isProcessing = true;
  cancelRequested = false;
  els.processBtn.disabled = true;
  els.cancelProcessBtn.style.display = 'inline-block';
  els.progressWrap.classList.add('show');
  els.batchResultBox.classList.remove('show');

  let JSZip;
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
    JSZip = mod.default;
  } catch(e){
    showStatus('⚠ Не удалось загрузить библиотеку архивации (проверь интернет). Пакетная обработка недоступна.', 'error');
    els.progressWrap.classList.remove('show');
    isProcessing = false; els.processBtn.disabled = false; els.cancelProcessBtn.style.display = 'none';
    return;
  }

  const zip = new JSZip();
  const tempVideo = document.createElement('video');
  tempVideo.playsInline = true; tempVideo.muted = true;
  const tempCanvas = document.createElement('canvas');

  for (let i = 0; i < queuedFiles.length; i++){
    if (cancelRequested) break;
    const file = queuedFiles[i];
    els.progressText.textContent = `Видео ${i+1} из ${queuedFiles.length}…`;

    const url = URL.createObjectURL(file);
    tempVideo.src = url;
    await new Promise((resolve) => { tempVideo.onloadedmetadata = resolve; tempVideo.onerror = resolve; });
    if (!tempVideo.videoWidth){ continue; } // пропускаем нечитаемый файл

    try {
      const result = await processOneVideo(tempVideo, tempCanvas, (frac) => {
        const overall = ((i + frac) / queuedFiles.length) * 100;
        els.progressFill.style.width = Math.min(100, Math.round(overall)) + '%';
        els.progressText.textContent = `Видео ${i+1} из ${queuedFiles.length} — ${Math.round(frac*100)}%`;
      });
      if (result){
        const baseName = (file.name || `video-${i+1}`).replace(/\.[^.]+$/, '');
        zip.file(`${baseName}-blurred.${result.ext}`, result.blob);
      }
    } catch(e){
      showStatus(`⚠ Ошибка при обработке файла ${file.name}: ${e.message} — пропускаю его и продолжаю.`, 'error');
    }
    URL.revokeObjectURL(url);
  }

  if (!cancelRequested){
    els.progressText.textContent = 'Собираю архив…';
    const archiveBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(archiveBlob);
    els.batchDownloadLink.href = url;
    els.batchDownloadLink.download = 'blurface-batch.zip';
    els.batchCount.textContent = `${queuedFiles.length} видео обработано`;
    els.batchResultBox.classList.add('show');
    els.progressText.textContent = 'Готово';
  }

  isProcessing = false;
  els.processBtn.disabled = false;
  els.cancelProcessBtn.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
