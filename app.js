/* Приёмка КИЗ — непрерывное сканирование DataMatrix камерой телефона.
 * Сканы отправляются в Google Таблицу через веб-приложение Apps Script
 * (ScanApi.gs). Если нет связи, сканы копятся в очереди и уходят позже. */
(() => {
  'use strict';

  const API_URL = String((window.KIZ_CONFIG && window.KIZ_CONFIG.API_URL) || '').trim();
  const ZXING_URLS = [
    'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/dist/es/reader/index.js',
    'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.3/reader/+esm',
    'https://unpkg.com/zxing-wasm@3.1.3/dist/es/reader/index.js'
  ];
  const STORE = {
    key: 'kiz.key',
    name: 'kiz.name',
    typedName: 'kiz.typedName',
    queue: 'kiz.queue',
    history: 'kiz.history',
    mode: 'kiz.mode',
    camera: 'kiz.camera'
  };
  const SCAN_INTERVAL = 140;     // мс между попытками распознать кадр
  const SAME_CODE_PAUSE = 2500;  // мс: тот же код в кадре не обрабатывается повторно
  const HISTORY_LIMIT = 60;

  const $ = id => document.getElementById(id);
  const el = {
    gate: $('gate'), gateText: $('gateText'), gateInput: $('gateInput'),
    gateButton: $('gateButton'), gateError: $('gateError'),
    app: $('app'), who: $('who'), net: $('net'),
    camera: $('camera'), video: $('video'), startOverlay: $('startOverlay'),
    startButton: $('startButton'), torchButton: $('torchButton'), pauseButton: $('pauseButton'),
    result: $('result'), resultTitle: $('resultTitle'), resultText: $('resultText'),
    cAdded: $('cAdded'), cDup: $('cDup'), cBad: $('cBad'), cQueue: $('cQueue'),
    nameRow: $('nameRow'), nameInput: $('nameInput'),
    manualInput: $('manualInput'), manualButton: $('manualButton'),
    history: $('history'),
    modeCamera: $('modeCamera'), modeScanner: $('modeScanner'),
    logoutButton: $('logoutButton'),
    switchButton: $('switchButton'), zoomButton: $('zoomButton'),
    photoButton: $('photoButton')
  };

  const state = {
    cameras: [],
    zoomLevels: [],
    zoomIndex: 0,
    key: '',
    personal: true,
    stream: null,
    track: null,
    detector: null,
    scanning: false,
    paused: false,
    torch: false,
    busy: false,
    sending: false,
    lastCode: '',
    lastCodeAt: 0,
    seen: new Set(),
    counts: {added: 0, dup: 0, bad: 0},
    wakeLock: null,
    audio: null
  };


  /* ---------- Хранилище (может быть недоступно) ---------- */

  function load(name, fallback) {
    try {
      const value = localStorage.getItem(name);
      return value == null ? fallback : JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }

  function save(name, value) {
    try { localStorage.setItem(name, JSON.stringify(value)); } catch (e) { /* без хранения */ }
  }

  let queue = load(STORE.queue, []);
  let recent = load(STORE.history, []);


  /* ---------- Запуск ---------- */

  function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Ключ из ссылки ?k=… сохраняем и убираем из адресной строки.
    const params = new URLSearchParams(location.search);
    const linkKey = params.get('k') || params.get('scan');
    if (linkKey) {
      save(STORE.key, linkKey);
      history_replace();
    }

    state.key = load(STORE.key, '');

    el.gateButton.addEventListener('click', onGateSubmit);
    el.gateInput.addEventListener('keydown', e => { if (e.key === 'Enter') onGateSubmit(); });
    el.startButton.addEventListener('click', startScanning);
    el.pauseButton.addEventListener('click', togglePause);
    el.torchButton.addEventListener('click', toggleTorch);
    el.switchButton.addEventListener('click', switchCamera);
    el.zoomButton.addEventListener('click', cycleZoom);
    el.photoButton.addEventListener('click', takePhotoScan);
    el.video.addEventListener('click', focusAt);
    el.manualButton.addEventListener('click', submitManual);
    el.manualInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        submitManual();
      }
    });
    el.logoutButton.addEventListener('click', onLogoutClick);
    el.modeCamera.addEventListener('click', () => setMode('camera'));
    el.modeScanner.addEventListener('click', () => setMode('scanner'));
    el.manualInput.addEventListener('blur', keepScannerFocus);
    // Сканеры без Enter: полный КИЗ длинный, отправляем после короткой паузы.
    let idleTimer = null;
    el.manualInput.addEventListener('input', () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (el.manualInput.value.replace(/\s/g, '').length >= 60) submitManual();
      }, 500);
    });
    document.addEventListener('click', event => {
      if (state.mode === 'scanner' && !event.target.closest('input, button')) {
        el.manualInput.focus();
      }
    });
    el.nameInput.value = load(STORE.typedName, '');
    el.nameInput.addEventListener('change', () => save(STORE.typedName, el.nameInput.value.trim()));

    window.addEventListener('online', () => { setNet(true); pump(); });
    window.addEventListener('offline', () => setNet(false));
    document.addEventListener('visibilitychange', onVisibility);

    if (!API_URL || /ВСТАВЬТЕ/.test(API_URL)) {
      showGate('Приложение не настроено: в файле config.js не указан адрес скрипта.');
      el.gateInput.hidden = true;
      el.gateButton.hidden = true;
      return;
    }

    if (!state.key) {
      showGate();
      return;
    }

    openApp();
  }

  // На компьютере (мышь, без сенсорного экрана) по умолчанию — ручной сканер.
  function defaultMode() {
    const desktop = !('ontouchstart' in window) &&
      window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    return desktop ? 'scanner' : 'camera';
  }

  function setMode(mode) {
    state.mode = mode === 'scanner' ? 'scanner' : 'camera';
    save(STORE.mode, state.mode);
    document.body.classList.toggle('scanner', state.mode === 'scanner');
    el.modeCamera.setAttribute('aria-pressed', String(state.mode === 'camera'));
    el.modeScanner.setAttribute('aria-pressed', String(state.mode === 'scanner'));

    if (state.mode === 'scanner') {
      stopCamera();
      el.startOverlay.hidden = false;
      el.pauseButton.hidden = true;
      el.torchButton.hidden = true;
      el.camera.classList.add('paused');
      showResult('', 'Режим ручного сканера', 'Сканируйте коды подряд — каждый сохраняется сам.');
      unlockAudio();
      el.manualInput.focus();
    } else {
      showResult('', 'Готово к сканированию', 'Нажмите «Начать сканирование».');
    }
  }

  function keepScannerFocus() {
    if (state.mode !== 'scanner') return;
    setTimeout(() => {
      const active = document.activeElement;
      if (state.mode === 'scanner' && (!active || !active.matches('input, button'))) {
        el.manualInput.focus();
      }
    }, 150);
  }

  function history_replace() {
    try { window.history.replaceState(null, '', location.pathname); } catch (e) {}
  }

  function showGate(text, error) {
    el.app.hidden = true;
    el.gate.hidden = false;
    if (text) el.gateText.textContent = text;
    el.gateError.textContent = error || '';
  }

  /* ---------- Выход ---------- */

  function onLogoutClick() {
    const pending = queue.length;
    const question = pending
      ? 'Не отправлено сканов: ' + pending + '. При выходе они будут удалены. Всё равно выйти?'
      : 'Выйти? Для входа понадобится ссылка от руководителя.';

    if (window.confirm(question)) {
      logout('Вы вышли. Вставьте ссылку, чтобы войти снова.');
    }
  }

  // Полный выход: ключ, имя, очередь и история этого сотрудника стираются,
  // чтобы его сканы не ушли под чужим именем.
  function logout(message) {
    state.scanning = false;
    stopCamera();
    state.key = '';
    state.seen.clear();
    state.counts = {added: 0, dup: 0, bad: 0};
    queue = [];
    recent = [];
    save(STORE.key, '');
    save(STORE.name, null);
    save(STORE.queue, queue);
    save(STORE.history, recent);
    el.startOverlay.hidden = false;
    el.gateInput.value = '';
    el.gateInput.hidden = false;
    el.gateButton.hidden = false;
    showGate(message, '');
  }

  function onGateSubmit() {
    const value = el.gateInput.value.trim();
    const match = value.match(/[?&](?:k|scan)=([A-Za-z0-9]+)/);
    const key = match ? match[1] : (/^[A-Za-z0-9]{16,}$/.test(value) ? value : '');

    if (!key) {
      el.gateError.textContent = 'В ссылке не найден ключ. Проверьте, что скопировали её целиком.';
      return;
    }

    state.key = key;
    save(STORE.key, key);
    openApp();
  }

  async function openApp() {
    el.gate.hidden = true;
    el.app.hidden = false;
    renderCounts();
    renderHistory();
    setNet(navigator.onLine);

    const cached = load(STORE.name, null);
    applyIdentity(cached);
    setMode(load(STORE.mode, '') || defaultMode());

    try {
      const answer = await api({api: 'hello'});
      if (!answer.ok) {
        if (answer.denied) {
          logout('Ваша ссылка отключена или неверна. Попросите у руководителя новую и вставьте её сюда.');
        } else {
          showResult('bad', 'Ошибка', answer.error || 'Не удалось проверить доступ.');
        }
        return;
      }
      const identity = {personal: answer.personal, name: answer.name};
      save(STORE.name, identity);
      applyIdentity(identity);
      pump();
    } catch (e) {
      // Нет связи: работаем по сохранённым данным, сканы уйдут позже.
      setNet(false);
    }
  }

  function applyIdentity(identity) {
    if (!identity) {
      el.who.textContent = 'Проверка доступа…';
      return;
    }
    state.personal = identity.personal !== false;
    el.who.textContent = state.personal ? identity.name : 'Общая ссылка';
    el.nameRow.hidden = state.personal;
  }


  /* ---------- Камера ---------- */

  async function startScanning() {
    unlockAudio();

    if (!state.personal && !el.nameInput.value.trim()) {
      showResult('bad', 'Укажите имя', 'Введите своё имя под счётчиками и нажмите «Начать» ещё раз.');
      el.nameInput.focus();
      return;
    }

    el.startButton.disabled = true;
    el.startButton.textContent = 'Включаю камеру…';

    try {
      if (!state.detector) {
        try {
          state.detector = await createDetector();
        } catch (error) {
          el.startOverlay.hidden = false;
          showResult('bad', 'Распознавание недоступно', error.message ||
            'Можно вводить коды ручным сканером в поле ниже.');
          return;
        }
      }
      await startCamera();
      el.startOverlay.hidden = true;
      el.pauseButton.hidden = false;
      state.paused = false;
      el.camera.classList.remove('paused');
      const settings = state.track && state.track.getSettings ? state.track.getSettings() : {};
      showResult('', 'Сканируйте', 'Держите код в рамке 15–25 см. Не читается — ' +
        'коснитесь экрана для фокуса или нажмите 📸. Распознавание: ' + state.detector.name +
        (settings.width ? ', камера ' + settings.width + '×' + settings.height : '') + '.');
      requestWakeLock();
      if (!state.scanning) {
        state.scanning = true;
        scanLoop();
      }
    } catch (error) {
      el.startOverlay.hidden = false;
      showResult('bad', 'Камера недоступна', cameraErrorText(error));
    } finally {
      el.startButton.disabled = false;
      el.startButton.textContent = 'Начать сканирование';
    }
  }

  function cameraErrorText(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError') {
      return 'Разрешите доступ к камере: значок замка в адресной строке → Разрешения → Камера.';
    }
    if (name === 'NotFoundError') return 'Камера не найдена.';
    return (error && error.message) || String(error);
  }

  /* Выбор камеры. У телефонов с несколькими задними камерами (Samsung S10 и др.)
   * браузер может открыть широкоугольную камеру без автофокуса — мелкий
   * DataMatrix она не видит. Ищем заднюю камеру с автофокусом и запоминаем. */

  function openStream(deviceId) {
    const video = {width: {ideal: 1920}, height: {ideal: 1080}};
    if (deviceId) video.deviceId = {exact: deviceId};
    else video.facingMode = {ideal: 'environment'};
    return navigator.mediaDevices.getUserMedia({audio: false, video});
  }

  function attachStream(stream) {
    state.stream = stream;
    state.track = stream.getVideoTracks()[0];
    el.video.srcObject = stream;
  }

  function currentDeviceId() {
    try { return state.track.getSettings().deviceId || ''; } catch (e) { return ''; }
  }

  function trackCaps() {
    try { return state.track && state.track.getCapabilities ? state.track.getCapabilities() : {}; }
    catch (e) { return {}; }
  }

  function hasAutofocus() {
    const caps = trackCaps();
    return Boolean(caps.focusMode && caps.focusMode.includes('continuous'));
  }

  async function listBackCameras() {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter(device => device.kind === 'videoinput');
    const back = devices.filter(device => /back|rear|environment|задн/i.test(device.label));
    const list = back.length ? back : devices;
    // Android: «camera2 0, facing back» — основная камера, бо́льшие номера — доп. объективы.
    const number = device => {
      const match = device.label.match(/(\d+)\s*,/) || device.label.match(/(\d+)/);
      return match ? Number(match[1]) : 99;
    };
    return list.slice().sort((x, y) => number(x) - number(y));
  }

  async function startCamera(forcedId) {
    stopCamera();
    const savedId = forcedId || load(STORE.camera, '');

    try {
      attachStream(await openStream(savedId));
    } catch (error) {
      if (!savedId) throw error;
      save(STORE.camera, '');            // сохранённая камера пропала — берём обычную
      attachStream(await openStream(''));
    }

    try { state.cameras = await listBackCameras(); } catch (e) { state.cameras = []; }

    // Первый запуск: перебираем задние камеры, пока не найдём с автофокусом.
    if (!savedId && state.cameras.length > 1 && !hasAutofocus()) {
      for (const camera of state.cameras) {
        if (camera.deviceId === currentDeviceId()) continue;
        stopCamera();
        try {
          attachStream(await openStream(camera.deviceId));
          if (hasAutofocus()) break;
        } catch (e) { /* следующая */ }
      }
      if (!state.stream) attachStream(await openStream(''));
    }

    save(STORE.camera, currentDeviceId());
    await el.video.play();
    await applyCameraFeatures();
  }

  async function applyCameraFeatures() {
    const caps = trackCaps();
    try {
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        await state.track.applyConstraints({advanced: [{focusMode: 'continuous'}]});
      }
    } catch (e) { /* не критично */ }

    el.torchButton.hidden = !caps.torch;
    el.photoButton.hidden = false;
    el.switchButton.hidden = !(state.cameras && state.cameras.length > 1);

    state.zoomLevels = [];
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      const min = caps.zoom.min || 1;
      state.zoomLevels = [1, 1.5, 2, 3]
        .map(k => Math.round(min * k * 10) / 10)
        .filter(z => z <= caps.zoom.max);
    }
    state.zoomIndex = 0;
    el.zoomButton.hidden = state.zoomLevels.length < 2;
    el.zoomButton.textContent = '1×';
  }

  async function switchCamera() {
    if (!state.cameras || state.cameras.length < 2) return;
    const index = state.cameras.findIndex(camera => camera.deviceId === currentDeviceId());
    const next = state.cameras[(index + 1) % state.cameras.length];
    try {
      await startCamera(next.deviceId);
      const position = state.cameras.findIndex(camera => camera.deviceId === currentDeviceId()) + 1;
      showResult('', 'Камера ' + position + ' из ' + state.cameras.length,
        (hasAutofocus() ? 'С автофокусом. ' : 'Без автофокуса — лучше выбрать другую. ') +
        'Выбор запомнится.');
    } catch (error) {
      showResult('bad', 'Камера недоступна', cameraErrorText(error));
    }
  }

  async function cycleZoom() {
    if (!state.track || state.zoomLevels.length < 2) return;
    state.zoomIndex = (state.zoomIndex + 1) % state.zoomLevels.length;
    const zoom = state.zoomLevels[state.zoomIndex];
    try {
      await state.track.applyConstraints({advanced: [{zoom}]});
      el.zoomButton.textContent = (zoom / state.zoomLevels[0]).toFixed(1).replace('.0', '') + '×';
    } catch (e) { /* зум не поддерживается */ }
  }

  // Нажатие на изображение — навести фокус в эту точку.
  async function focusAt(event) {
    if (!state.track) return;
    const caps = trackCaps();
    const rect = el.video.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height
    };
    try {
      const constraints = {pointsOfInterest: [point]};
      if (caps.focusMode && caps.focusMode.includes('single-shot')) {
        constraints.focusMode = 'single-shot';
      }
      await state.track.applyConstraints({advanced: [constraints]});
      setTimeout(() => {
        if (state.track && caps.focusMode && caps.focusMode.includes('continuous')) {
          state.track.applyConstraints({advanced: [{focusMode: 'continuous'}]}).catch(() => {});
        }
      }, 1500);
    } catch (e) { /* фокус по точке не поддерживается */ }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(track => track.stop());
    }
    state.stream = null;
    state.track = null;
    state.torch = false;
    el.torchButton.classList.remove('on');
  }

  function togglePause() {
    state.paused = !state.paused;
    el.pauseButton.textContent = state.paused ? '▶' : '⏸';
    el.camera.classList.toggle('paused', state.paused);
    showResult('', state.paused ? 'Пауза' : 'Сканируйте',
      state.paused ? 'Нажмите ▶, чтобы продолжить.' : 'Держите код в рамке.');
  }

  async function toggleTorch() {
    if (!state.track) return;
    state.torch = !state.torch;
    try {
      await state.track.applyConstraints({advanced: [{torch: state.torch}]});
      el.torchButton.classList.toggle('on', state.torch);
    } catch (e) {
      state.torch = false;
    }
  }

  function onVisibility() {
    if (document.hidden) {
      stopCamera();
      el.camera.classList.add('paused');
      el.startOverlay.hidden = false;
      el.pauseButton.hidden = true;
      el.torchButton.hidden = true;
      el.switchButton.hidden = true;
      el.zoomButton.hidden = true;
      el.photoButton.hidden = true;
    } else {
      if (state.wakeLock === null && state.scanning) requestWakeLock();
      pump();
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } catch (e) { /* экран может гаснуть */ }
  }


  /* ---------- Распознавание ---------- */

  // Форматы, которые распознаём. Честный знак — только DataMatrix, остальные
  // распознаём лишь для подсказки «это не тот код».
  const NATIVE_FORMATS = ['data_matrix', 'qr_code', 'ean_13', 'ean_8', 'code_128', 'upc_a'];

  async function loadZxing() {
    for (const url of ZXING_URLS) {
      try {
        const module = await import(url);
        const read = module.readBarcodes || module.readBarcodesFromImageData;
        if (read) return read;
      } catch (e) { /* следующий адрес */ }
    }
    return null;
  }

  /* Два распознавателя сразу: встроенный в телефон (быстрый) и ZXing (лучше
   * читает плотные DataMatrix Честного знака). Оба получают центральную часть
   * кадра в полном разрешении — так мелкий код не теряется при уменьшении. */
  async function createDetector() {
    let native = null;
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        if (supported.includes('data_matrix')) {
          native = new window.BarcodeDetector({
            formats: NATIVE_FORMATS.filter(format => supported.includes(format))
          });
        }
      } catch (e) { native = null; }
    }

    let zxRead = null;
    const zxReady = loadZxing().then(read => { zxRead = read; });
    if (!native) {
      await zxReady;
      if (!zxRead) {
        throw new Error('Не удалось загрузить распознавание кодов. Проверьте интернет и откройте приложение снова.');
      }
    }

    const crop = document.createElement('canvas');
    const cropContext = crop.getContext('2d', {willReadFrequently: true});
    const work = document.createElement('canvas');
    const workContext = work.getContext('2d', {willReadFrequently: true});
    let tick = 0;

    // Центральная часть изображения в исходном разрешении (без уменьшения).
    function cropCenter(source, width, height, fraction, maxSize) {
      const side = Math.round(Math.min(width, height) * fraction);
      const size = Math.min(side, maxSize);
      crop.width = size;
      crop.height = size;
      cropContext.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
      return crop;
    }

    const fromNative = codes => codes.map(code => ({
      text: code.rawValue,
      matrix: code.format === 'data_matrix',
      format: code.format
    }));

    async function zxDecode(canvas, maxSize) {
      let target = canvas;
      if (canvas.width > maxSize) {
        const k = maxSize / canvas.width;
        work.width = Math.round(canvas.width * k);
        work.height = Math.round(canvas.height * k);
        workContext.drawImage(canvas, 0, 0, work.width, work.height);
        target = work;
      }
      const context = target === work ? workContext : cropContext;
      const image = context.getImageData(0, 0, target.width, target.height);
      const results = await zxRead(image, {tryHarder: true, maxNumberOfSymbols: 1});
      return results
        .filter(r => r.isValid !== false && r.text)
        .map(r => ({
          text: r.text,
          matrix: /data\s*matrix/i.test(String(r.format || '')),
          format: String(r.format || '')
        }));
    }

    async function detectIn(source, width, height, full) {
      if (native) {
        const found = fromNative(await native.detect(cropCenter(source, width, height, 0.6, 1600)));
        if (found.length) return found;
        if (full) {
          const whole = fromNative(await native.detect(source));
          if (whole.length) return whole;
        }
      }
      if (zxRead) {
        const found = await zxDecode(cropCenter(source, width, height, 0.6, 1600), 1100);
        if (found.length || !full) return found;
        return zxDecode(cropCenter(source, width, height, 0.9, 2400), 1400);
      }
      return [];
    }

    return {
      get name() {
        return [native && 'встроенное', zxRead && 'ZXing'].filter(Boolean).join(' + ');
      },

      // Поток с камеры: каждый кадр — встроенное по центру, через кадр — ZXing.
      detect: async video => {
        tick++;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return [];

        if (native) {
          const found = fromNative(await native.detect(cropCenter(video, width, height, 0.6, 1600)));
          if (found.length) return found;
          if (tick % 5 === 0) {
            const whole = fromNative(await native.detect(video));
            if (whole.length) return whole;
          }
        }
        if (zxRead && (!native || tick % 2 === 0)) {
          return zxDecode(cropCenter(video, width, height, 0.6, 1600), 1100);
        }
        return [];
      },

      // Снимок в полном разрешении камеры (кнопка 📸).
      detectImage: (image, width, height) => detectIn(image, width, height, true)
    };
  }

  // Кнопка 📸: фото в полном разрешении камеры — как в обычном приложении «Камера».
  async function takePhotoScan() {
    if (!state.track || !state.detector) return;
    el.photoButton.disabled = true;
    showResult('', 'Снимаю…', 'Держите телефон неподвижно.');
    try {
      let image;
      let width;
      let height;
      if ('ImageCapture' in window) {
        const blob = await new window.ImageCapture(state.track).takePhoto();
        image = await createImageBitmap(blob);
        width = image.width;
        height = image.height;
      } else {
        image = el.video;
        width = el.video.videoWidth;
        height = el.video.videoHeight;
      }
      const codes = await state.detector.detectImage(image, width, height);
      if (codes.length) {
        state.lastCode = '';
        onDetected(codes[0]);
      } else {
        showResult('bad', 'На фото код не найден',
          'Поднесите код в рамку на 15–25 см, коснитесь экрана для фокуса и снимите ещё раз.');
        feedback('dup', true);
      }
    } catch (error) {
      showResult('bad', 'Не удалось сделать снимок', (error && error.message) || String(error));
    } finally {
      el.photoButton.disabled = false;
    }
  }

  async function scanLoop() {
    while (state.scanning) {
      if (!state.paused && state.stream && el.video.readyState >= 2 && !document.hidden) {
        try {
          const codes = await state.detector.detect(el.video);
          codes.forEach(onDetected);
        } catch (e) { /* пропускаем кадр */ }
      }
      await sleep(SCAN_INTERVAL);
    }
  }

  const FORMAT_NAMES = {
    qr_code: 'QR-код', ean_13: 'штрихкод EAN-13', ean_8: 'штрихкод EAN-8',
    code_128: 'штрихкод Code 128', upc_a: 'штрихкод UPC'
  };
  let lastWrongAt = 0;

  function onDetected(code) {
    if (code.matrix) {
      onCode(code.text);
      return;
    }
    // Камера работает, но в кадре не DataMatrix — подсказываем, не отправляем.
    const now = Date.now();
    if (now - lastWrongAt < 2500) return;
    lastWrongAt = now;
    const name = FORMAT_NAMES[code.format] || (/qr/i.test(code.format) ? 'QR-код' : 'штрихкод');
    feedback('dup', true);
    showResult('warn', 'Это ' + name, 'Камера видит код, но для Честного знака нужен квадратный DataMatrix.');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  /* ---------- Обработка кода ---------- */

  function cleanCode(raw) {
    return String(raw || '')
      .replace(/^\]d2/, '')
      .replace(/^è/, '')
      .replace(/[\r\n]/g, '')
      .trim();
  }

  function codeIdentity(code) {
    // Для сравнения повторов: без разделителей GS и криптохвоста.
    const plain = code.replace(/\u001d/g, '');
    const match = plain.match(/^01(\d{14})21(.+?)91.{4}92/);
    return match ? match[1] + '|' + match[2] : plain;
  }

  function onCode(raw, fromKeyboard) {
    const code = cleanCode(raw);
    if (!code) return;

    const id = codeIdentity(code);
    const now = Date.now();

    // Камера видит один и тот же код много раз в секунду — пропускаем.
    if (!fromKeyboard && id === state.lastCode && now - state.lastCodeAt < SAME_CODE_PAUSE) {
      state.lastCodeAt = now;
      return;
    }
    state.lastCode = id;
    state.lastCodeAt = now;

    if (state.seen.has(id)) {
      feedback('dup', true);
      showResult('warn', 'Уже отсканирован', 'Этот код уже был в этой смене. ' + tail(code));
      return;
    }

    state.seen.add(id);

    if (!/^01\d{14}21/.test(code.replace(/\u001d/g, ''))) {
      feedback('bad');
      count('bad');
      showResult('bad', 'Не код Честного знака', 'Наведите на квадратный DataMatrix, а не на штрихкод.');
      addHistory({code, tone: 'bad', msg: 'Не код Честного знака'});
      state.seen.delete(id);
      return;
    }

    const item = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      code,
      t: new Date().toLocaleString('ru-RU')
    };
    queue.push(item);
    save(STORE.queue, queue);
    addHistory({id: item.id, code, tone: 'wait', msg: 'Отправка…'});
    feedback('read');
    showResult('', 'Считано', 'Отправляю… ' + tail(code));
    renderCounts();
    pump();
  }

  function submitManual() {
    const value = el.manualInput.value;
    el.manualInput.value = '';
    if (value.trim()) {
      unlockAudio();
      onCode(value, true);
    }
    el.manualInput.focus();
  }

  function tail(code) {
    const plain = code.replace(/\u001d/g, '');
    const match = plain.match(/^01(\d{14})21(.+?)91/);
    return match ? '…' + match[1].slice(-6) + ' / ' + match[2] : plain.slice(0, 32);
  }


  /* ---------- Отправка ---------- */

  async function pump() {
    if (state.sending || !queue.length || !state.key) return;
    state.sending = true;

    try {
      while (queue.length) {
        const item = queue[0];
        let answer;

        try {
          answer = await api({
            api: 'scan',
            code: item.code,
            t: item.t,
            name: state.personal ? '' : el.nameInput.value.trim()
          });
          setNet(true);
        } catch (e) {
          setNet(false);
          renderCounts();
          setTimeout(pump, 5000);
          return;
        }

        if (!answer.ok && answer.retry) {
          await sleep(2000);
          continue;
        }

        if (!answer.ok && answer.denied) {
          const lost = queue.length;
          logout('Ваша ссылка отключена руководителем.' +
            (lost ? ' Не отправлено сканов: ' + lost + ' — они не сохранены.' : '') +
            ' Попросите новую ссылку и вставьте её сюда.');
          return;
        }

        queue.shift();
        save(STORE.queue, queue);
        handleAnswer(item, answer);
        renderCounts();
      }
    } finally {
      state.sending = false;
    }
  }

  function handleAnswer(item, answer) {
    if (!answer.ok) {
      count('bad');
      feedback('bad');
      showResult('bad', 'Ошибка', answer.error || 'Не удалось сохранить.');
      updateHistory(item.id, 'bad', answer.error || 'Ошибка');
      return;
    }

    const tone = {
      added: 'ok',
      added_unknown: 'warn',
      duplicate: 'warn'
    }[answer.status] || 'bad';

    if (answer.status === 'added' || answer.status === 'added_unknown') count('added');
    else if (answer.status === 'duplicate') count('dup');
    else count('bad');

    feedback(answer.status === 'duplicate' ? 'dup' : tone);
    showResult(tone, answer.title || answer.status, (answer.message || '') + ' ' + tail(item.code));
    updateHistory(item.id, tone, answer.title + (answer.row ? ' · стр. ' + answer.row : ''));
  }

  function api(params) {
    const query = new URLSearchParams(Object.assign({k: state.key}, params));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    return fetch(API_URL + '?' + query.toString(), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal
    })
      .then(response => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .finally(() => clearTimeout(timer));
  }


  /* ---------- Интерфейс ---------- */

  function showResult(tone, title, text) {
    el.result.className = 'result' + (tone ? ' ' + tone : '');
    el.resultTitle.textContent = title;
    el.resultText.textContent = text || '';

    el.camera.classList.remove('ok', 'warn', 'bad', 'pulse');
    if (tone) {
      void el.camera.offsetWidth;
      el.camera.classList.add(tone, 'pulse');
      setTimeout(() => el.camera.classList.remove('pulse'), 60);
    }
  }

  function count(kind) {
    state.counts[kind]++;
    renderCounts();
  }

  function renderCounts() {
    el.cAdded.textContent = state.counts.added;
    el.cDup.textContent = state.counts.dup;
    el.cBad.textContent = state.counts.bad;
    el.cQueue.textContent = queue.length;
  }

  function setNet(online) {
    el.net.classList.toggle('off', !online);
    el.net.textContent = online ? 'онлайн' : 'нет связи';
  }

  function addHistory(entry) {
    recent.unshift({
      id: entry.id || '',
      time: new Date().toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'}),
      code: tail(entry.code),
      tone: entry.tone,
      msg: entry.msg
    });
    recent = recent.slice(0, HISTORY_LIMIT);
    save(STORE.history, recent);
    renderHistory();
  }

  function updateHistory(id, tone, msg) {
    const entry = recent.find(item => item.id === id);
    if (entry) {
      entry.tone = tone;
      entry.msg = msg;
      save(STORE.history, recent);
      renderHistory();
    }
  }

  function renderHistory() {
    el.history.textContent = '';
    recent.forEach(entry => {
      const li = document.createElement('li');
      li.className = entry.tone;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = entry.time;
      const body = document.createElement('span');
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = entry.msg;
      const code = document.createElement('div');
      code.className = 'code';
      code.textContent = entry.code;
      body.append(msg, code);
      li.append(time, body);
      el.history.appendChild(li);
    });
  }


  /* ---------- Звук и вибрация ---------- */

  function unlockAudio() {
    try {
      state.audio = state.audio || new (window.AudioContext || window.webkitAudioContext)();
      if (state.audio.state === 'suspended') state.audio.resume();
    } catch (e) { /* без звука */ }
  }

  function tone(freq, ms, delay) {
    if (!state.audio) return;
    try {
      const start = state.audio.currentTime + (delay || 0) / 1000;
      const osc = state.audio.createOscillator();
      const gain = state.audio.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.18;
      osc.connect(gain);
      gain.connect(state.audio.destination);
      osc.start(start);
      osc.stop(start + ms / 1000);
    } catch (e) { /* без звука */ }
  }

  function vibrate(pattern) {
    try { navigator.vibrate && navigator.vibrate(pattern); } catch (e) {}
  }

  function feedback(kind, quiet) {
    if (kind === 'read') { tone(1200, 40); return; }
    if (kind === 'ok') { tone(880, 90); vibrate(60); return; }
    if (kind === 'warn') { tone(660, 160); vibrate([60, 60, 60]); return; }
    if (kind === 'dup') {
      if (quiet) { tone(440, 60); return; }
      tone(440, 120); tone(440, 120, 180); vibrate([80, 80, 80]); return;
    }
    tone(220, 450); vibrate(400);
  }


  // Для проверки без камеры: window.kizTestScan('<код>') в консоли.
  window.kizTestScan = raw => onCode(raw, true);

  init();
})();
