(() => {
"use strict";
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/ErDzmxAv-/";
const GOOD = "Правильная осанка";
const BAD = "Плохая осанка";

const REQUIRED_BAD = 3;   // Сколько раз подряд нужна плохая осанка
const REQUIRED_GOOD = 5;  // Сколько раз подряд нужна хорошая для сброса уведомления
const SMOOTHING_ALPHA = 0.25;
const MIN_CLASS_MARGIN = 0.10; // Минимальная разница между сглаженными оценками классов
const $ = id => document.getElementById(id);
const canvas = $("view"), ctx = canvas.getContext("2d");
let model = null, webcam = null, running = false, raf = null;
let badCount = 0, goodCount = 0;
let smoothedGood = null, smoothedBad = null;
let alertSent = false, notificationSent = false;
let lastStretchAt = 0, stretchTimer = null;
let currentNotification = null;
const STRETCH_MS = 40 * 60 * 1000;

function status(message, state="") {
  $("status").textContent = message;
  $("cameraBadge").textContent = state === "live" ? "Включена" : state === "error" ? "Ошибка" : "Выключена";
  $("cameraBadge").className = "badge " + state;
}
function modelStatus(message, state="") {
  $("modelBadge").textContent = message; $("modelBadge").className = "badge " + state;
}
function result(kind, title, text) {
  $("result").className = "result " + kind;
  $("resultTitle").textContent = title;
  $("resultText").textContent = text;
  $("resultMark").textContent = kind === "good" ? "✓" : kind === "bad" ? "!" : "✳";
}
function updateNotificationUI() {
  const badge = $("notificationBadge");
  const statusText = $("notificationStatus");
  const button = $("enableNotifications");
  if (!("Notification" in window)) {
    badge.className = "badge error";
    badge.innerHTML = '<span class="badge-dot"></span>Недоступны';
    statusText.textContent = "Этот браузер не поддерживает системные уведомления. Подсказки останутся на странице.";
    button.disabled = true;
    button.textContent = "Уведомления недоступны";
    return;
  }
  const permission = Notification.permission;
  if (permission === "granted") {
    badge.className = "badge live";
    badge.innerHTML = '<span class="badge-dot"></span>Разрешены';
    statusText.textContent = "Системные уведомления разрешены.";
    button.textContent = "Уведомления включены";
    button.disabled = true;
  } else if (permission === "denied") {
    badge.className = "badge error";
    badge.innerHTML = '<span class="badge-dot"></span>Запрещены';
    statusText.textContent = "Уведомления заблокированы в настройках браузера. Разрешите их для этого сайта, чтобы получать системные подсказки.";
    button.textContent = "Проверьте настройки браузера";
    button.disabled = true;
  } else {
    badge.className = "badge";
    badge.innerHTML = '<span class="badge-dot"></span>Не настроены';
    statusText.textContent = "Разрешение на системные уведомления ещё не запрошено.";
    button.textContent = "Включить уведомления";
    button.disabled = false;
  }
}
function sendNotification(title, body, tag) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return false;
  }

  try {
    // Закрываем предыдущее уведомление о плохой осанке,
    // если оно ещё открыто.
    if (tag === "posture-alert" && currentNotification) {
      currentNotification.close();
      currentNotification = null;
    }

    const notification = new Notification(title, {
      body,
      tag,
      icon: "/favicon.svg",
      renotify: true
    });

    // Сохраняем ссылку только на уведомление о плохой осанке.
    if (tag === "posture-alert") {
      currentNotification = notification;
    }

    return true;
  } catch (e) {
    console.warn("Не удалось показать системное уведомление:", e);
    return false;
  }
}
async function enableNotifications() {
  if (!("Notification" in window)) return updateNotificationUI();
  try {
    await Notification.requestPermission();
  } catch (e) {
    console.warn("Не удалось запросить разрешение уведомлений:", e);
  }
  updateNotificationUI();

  // Если предупреждение уже появилось, но разрешения ещё не было,
  // отправляем уведомление после того, как пользователь его включил.
  if (running && alertSent && !notificationSent &&
      badCount >= REQUIRED_BAD && Notification.permission === "granted") {
    notificationSent = sendNotification(
      "Проверьте положение тела",
      "Модель несколько раз подряд определила класс «Плохая осанка». Возможно, стоит проверить позу.",
      "posture-alert"
    );
  }
}
function checkStretchReminder() {
  if (!running || !$("stretchToggle").checked || !lastStretchAt) return;
  if (Date.now() - lastStretchAt >= STRETCH_MS) {
    sendNotification("Пора немного размяться", "Сделайте небольшую паузу, смените положение и мягко разомнитесь.", "posture-stretch-reminder");
    lastStretchAt = Date.now();
  }
}
function normalizeLabel(label) {
  return String(label ?? "").trim().toLocaleLowerCase("ru-RU");
}
async function loadModel() {
  if (model) return;
  if (!window.tmPose) throw new Error("Не загрузилась библиотека модели. Проверьте подключение к интернету и обновите страницу.");
  modelStatus("Загружаем модель");
  // Keep the model local until validation succeeds. A failed check must not
  // leave a partially initialized model that makes the next click behave differently.
  const loadedModel = await tmPose.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  const labels = loadedModel.getClassLabels ? loadedModel.getClassLabels() : null;
  if (labels && (!labels.some(label => normalizeLabel(label) === normalizeLabel(GOOD)) ||
                 !labels.some(label => normalizeLabel(label) === normalizeLabel(BAD)))) {
    throw new Error("Названия классов в модели не совпадают с ожидаемыми. Проверьте классы в Teachable Machine.");
  }
  model = loadedModel;
  modelStatus("Модель загружена", "live");
}
async function start() {
  $("start").disabled = true; $("stop").disabled = true;
  status("Загружаем модель…"); result("neutral","Загрузка модели","Подождите немного.");
  try {
    await loadModel();
    status("Запрашиваем доступ к камере…");
    webcam = new tmPose.Webcam(400,400,false);
    await webcam.setup(); await webcam.play();
    running = true; canvas.hidden = false; $("placeholder").hidden = true; $("stop").disabled = false; $("liveLabel").hidden = false;
    badCount = 0;
    goodCount = 0;
    alertSent = false;
    notificationSent = false;
    smoothedGood = null;
    smoothedBad = null;
    lastStretchAt = $("stretchToggle").checked ? Date.now() : 0;
    status("Камера работает. Анализируем позу.","live");
    if (stretchTimer) clearInterval(stretchTimer);
    stretchTimer = setInterval(checkStretchReminder, 15000);
    loop();
  } catch (e) {
    console.error(e);
    if (webcam) { try { webcam.stop(); } catch (_) {} }
    webcam = null; running = false; $("start").disabled = false; $("stop").disabled = true;
    canvas.hidden = true; $("placeholder").hidden = false; $("liveLabel").hidden = true;
    if (stretchTimer) clearInterval(stretchTimer); stretchTimer = null;
    status(e.message || "Не удалось запустить камеру или модель.","error");
    modelStatus("Ошибка","error"); result("neutral","Не удалось запустить",(e && e.message) ? e.message : "Проверьте разрешение камеры и подключение к интернету.");
  }
}
function stop() {
  running = false; if (raf !== null) cancelAnimationFrame(raf); raf = null;
  if (stretchTimer) clearInterval(stretchTimer);
  stretchTimer = null;
  lastStretchAt = 0;
  alertSent = false;
  notificationSent = false;
  smoothedGood = null;
  smoothedBad = null;
  if (webcam) { try { webcam.stop(); } catch (_) {} }
  webcam = null; ctx.clearRect(0,0,canvas.width,canvas.height); canvas.hidden = true; $("placeholder").hidden = false; $("liveLabel").hidden = true;
  $("start").disabled = false;
  $("stop").disabled = true;
  $("warning").hidden = true;
  badCount = 0;
  goodCount = 0;
  status("Камера выключена."); modelStatus(model ? "Модель загружена" : "Не запущена");
  result("neutral","Ожидание запуска","Включите камеру, чтобы начать.");
}
async function loop() {
  if (!running || !webcam || !model) return;
  try {
    webcam.update();
    const {pose,posenetOutput} = await model.estimatePose(webcam.canvas);
    const predictions = await model.predict(posenetOutput);
    if (!running) return;

    if ($("cameraBadge").classList.contains("error")) {
      status("Камера работает. Анализируем позу.","live");
    }
    ctx.drawImage(webcam.canvas,0,0,canvas.width,canvas.height);
    if (pose) {
      tmPose.drawKeypoints(pose.keypoints,0.5,ctx);
      tmPose.drawSkeleton(pose.keypoints,0.5,ctx);
    }
    showPredictions(predictions);
  } catch (e) {
    console.error("Ошибка анализа кадра:", e); status("Ошибка анализа кадра: " + (e && e.message ? e.message : "подробности в консоли"),"error");
  }
  if (running) raf = requestAnimationFrame(loop);
}

function showPredictions(predictions) {
  const good = predictions.find(
    p => normalizeLabel(p.className) === normalizeLabel(GOOD)
  );
  const bad = predictions.find(
    p => normalizeLabel(p.className) === normalizeLabel(BAD)
  );

  if (!good || !bad) {
    badCount = 0;
    goodCount = 0;
    $("warning").hidden = true;
    result(
      "neutral",
      "Неизвестные классы",
      "Названия классов модели должны быть «Правильная осанка» и «Плохая осанка»."
    );
    return;
  }

  // Сглаживание вероятностей для отображения.
  if (smoothedGood === null || smoothedBad === null) {
    smoothedGood = good.probability;
    smoothedBad = bad.probability;
  } else {
    smoothedGood =
      SMOOTHING_ALPHA * good.probability +
      (1 - SMOOTHING_ALPHA) * smoothedGood;

    smoothedBad =
      SMOOTHING_ALPHA * bad.probability +
      (1 - SMOOTHING_ALPHA) * smoothedBad;
  }

  $("goodText").textContent = Math.round(smoothedGood * 100) + "%";
  $("badText").textContent = Math.round(smoothedBad * 100) + "%";
  $("goodBar").style.width = (smoothedGood * 100) + "%";
  $("badBar").style.width = (smoothedBad * 100) + "%";

  const threshold = Number($("threshold").value) / 100;
  const isGoodWinner = smoothedGood >= smoothedBad;
  const winnerProbability = Math.max(smoothedGood, smoothedBad);
  const classMargin = Math.abs(smoothedGood - smoothedBad);

  // Решение принимается по сглаженным оценкам, а не по скачущим значениям одного кадра.
  // При близких оценках модель считается неуверенной.
  if (winnerProbability < threshold || classMargin < MIN_CLASS_MARGIN) {
    badCount = 0;
    goodCount = 0;
    $("warning").hidden = true;

    result(
      "neutral",
      "Не удаётся уверенно определить позу",
      "Попробуйте улучшить освещение и расположиться так, чтобы модель хорошо видела позу."
    );
    return;
  }

  // Модель определила правильную осанку.
  if (isGoodWinner) {
    badCount = 0;
    goodCount = Math.min(goodCount + 1, REQUIRED_GOOD);

    // Повторно разрешаем уведомление только после пяти
    // последовательных уверенных определений хорошей осанки.
    if (alertSent && goodCount >= REQUIRED_GOOD) {
      alertSent = false;
      notificationSent = false;
      goodCount = 0;
    }

    $("warning").hidden = true;

    result(
      "good",
      GOOD,
      alertSent
        ? `Модель определяет правильную осанку. Для сброса уведомления нужно ещё ${REQUIRED_GOOD - goodCount} последовательных определений.`
        : "Модель уверенно определяет правильную осанку."
    );

    return;
  }

  // Модель определила плохую осанку.
  goodCount = 0;
  badCount++;

  result(
    "bad",
    BAD,
    `Уверенность модели: ${Math.round(winnerProbability * 100)}%. Последовательных определений: ${badCount}/${REQUIRED_BAD}.`
  );

  if (badCount >= REQUIRED_BAD) {
    $("warning").hidden = false;

    if (!alertSent) {
      alertSent = true;
      notificationSent = sendNotification(
        "Проверьте положение тела",
        "Модель несколько раз подряд определила класс «Плохая осанка». Возможно, стоит проверить позу.",
        "posture-alert"
      );
    }
  }
}

$("threshold").addEventListener("input", () => {
  $("thresholdText").textContent = $("threshold").value + "%";
});
$("start").addEventListener("click",start);
$("stop").addEventListener("click",stop);
$("enableNotifications").addEventListener("click",enableNotifications);
$("stretchToggle").addEventListener("change", () => {
  try { localStorage.setItem("posture-assistant-stretch-reminder", $("stretchToggle").checked ? "on" : "off"); } catch (_) {}
  if (running) lastStretchAt = $("stretchToggle").checked ? Date.now() : 0;
});
try { $("stretchToggle").checked = localStorage.getItem("posture-assistant-stretch-reminder") !== "off"; } catch (_) {}
updateNotificationUI();
document.addEventListener("visibilitychange", () => {
  // If the browser throttled background timers, check elapsed time when the user returns.
  checkStretchReminder();
});
})();
