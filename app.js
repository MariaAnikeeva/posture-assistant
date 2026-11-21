(() => {
"use strict";

const MODEL_URL = "https://teachablemachine.withgoogle.com/models/ErDzmxAv-/";
const GOOD = "Правильная осанка";
const BAD = "Плохая осанка";
const STRETCH_MS = 40 * 60 * 1000;
const $ = id => document.getElementById(id);
const canvas = $("view");
const ctx = canvas.getContext("2d");

let model = null;
let webcam = null;
let running = false;
let frameRequest = null;
let stretchTimer = null;
let lastStretchAt = 0;
let alertSent = false;
let lastResultIsBad = false;

function normalizeLabel(label) {
  return String(label ?? "").trim().toLocaleLowerCase("ru-RU");
}

function status(message, state = "") {
  $("status").textContent = message;
  $("cameraBadge").textContent = state === "live" ? "Включена" : state === "error" ? "Ошибка" : "Выключена";
  $("cameraBadge").className = "badge " + state;
}

function modelStatus(message, state = "") {
  $("modelBadge").textContent = message;
  $("modelBadge").className = "badge " + state;
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

  if (Notification.permission === "granted") {
    badge.className = "badge live";
    badge.innerHTML = '<span class="badge-dot"></span>Разрешены';
    statusText.textContent = "Системные уведомления разрешены.";
    button.textContent = "Уведомления включены";
    button.disabled = true;
  } else if (Notification.permission === "denied") {
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
  if (!("Notification" in window) || Notification.permission !== "granted") return false;

  try {
    new Notification(title, { body, tag, icon: "/favicon.svg" });
    return true;
  } catch (error) {
    console.warn("Не удалось показать системное уведомление:", error);
    return false;
  }
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    updateNotificationUI();
    return;
  }

  try {
    await Notification.requestPermission();
  } catch (error) {
    console.warn("Не удалось запросить разрешение уведомлений:", error);
  }

  updateNotificationUI();

  if (running && lastResultIsBad && !alertSent && Notification.permission === "granted") {
    alertSent = sendNotification(
      "Проверьте положение тела",
      "Модель определила класс «Плохая осанка». Возможно, стоит проверить позу.",
      "posture-alert"
    );
  }
}

function checkStretchReminder() {
  if (!running || !$("stretchToggle").checked || !lastStretchAt) return;

  if (Date.now() - lastStretchAt >= STRETCH_MS) {
    sendNotification(
      "Пора немного размяться",
      "Сделайте небольшую паузу, смените положение и мягко разомнитесь.",
      "posture-stretch-reminder"
    );
    lastStretchAt = Date.now();
  }
}

async function loadModel() {
  if (model) return;
  if (!window.tmPose) throw new Error("Не загрузилась библиотека модели. Проверьте подключение к интернету и обновите страницу.");

  modelStatus("Загружаем модель");
  const loadedModel = await tmPose.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  const labels = loadedModel.getClassLabels ? loadedModel.getClassLabels() : null;

  if (labels && (
    !labels.some(label => normalizeLabel(label) === normalizeLabel(GOOD)) ||
    !labels.some(label => normalizeLabel(label) === normalizeLabel(BAD))
  )) {
    throw new Error("Названия классов модели не совпадают с ожидаемыми. Проверьте классы в Teachable Machine.");
  }

  model = loadedModel;
  modelStatus("Модель загружена", "live");
}

async function start() {
  $("start").disabled = true;
  $("stop").disabled = true;
  status("Загружаем модель…");
  result("neutral", "Загрузка модели", "Подождите немного.");

  try {
    await loadModel();
    status("Запрашиваем доступ к камере…");
    webcam = new tmPose.Webcam(400, 400, false);
    await webcam.setup();
    await webcam.play();

    running = true;
    alertSent = false;
    lastResultIsBad = false;
    lastStretchAt = $("stretchToggle").checked ? Date.now() : 0;

    canvas.hidden = false;
    $("placeholder").hidden = true;
    $("stop").disabled = false;
    $("liveLabel").hidden = false;
    status("Камера работает. Анализируем позу.", "live");

    if (stretchTimer) clearInterval(stretchTimer);
    stretchTimer = setInterval(checkStretchReminder, 15000);
    loop();
  } catch (error) {
    console.error(error);
    if (webcam) {
      try { webcam.stop(); } catch (_) {}
    }

    webcam = null;
    running = false;
    $("start").disabled = false;
    $("stop").disabled = true;
    canvas.hidden = true;
    $("placeholder").hidden = false;
    $("liveLabel").hidden = true;

    if (stretchTimer) clearInterval(stretchTimer);
    stretchTimer = null;

    status(error.message || "Не удалось запустить камеру или модель.", "error");
    modelStatus("Ошибка", "error");
    result("neutral", "Не удалось запустить", error.message || "Проверьте разрешение камеры и подключение к интернету.");
  }
}

function stop() {
  running = false;
  if (frameRequest !== null) cancelAnimationFrame(frameRequest);
  frameRequest = null;

  if (stretchTimer) clearInterval(stretchTimer);
  stretchTimer = null;
  lastStretchAt = 0;
  alertSent = false;
  lastResultIsBad = false;

  if (webcam) {
    try { webcam.stop(); } catch (_) {}
  }
  webcam = null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = true;
  $("placeholder").hidden = false;
  $("liveLabel").hidden = true;
  $("start").disabled = false;
  $("stop").disabled = true;
  $("warning").hidden = true;

  status("Камера выключена.");
  modelStatus(model ? "Модель загружена" : "Не запущена");
  result("neutral", "Ожидание запуска", "Включите камеру, чтобы начать.");
}

async function loop() {
  if (!running || !webcam || !model) return;

  try {
    webcam.update();
    const { pose, posenetOutput } = await model.estimatePose(webcam.canvas);
    const predictions = await model.predict(posenetOutput);

    if (!running) return;

    ctx.drawImage(webcam.canvas, 0, 0, canvas.width, canvas.height);
    if (pose) {
      tmPose.drawKeypoints(pose.keypoints, 0.5, ctx);
      tmPose.drawSkeleton(pose.keypoints, 0.5, ctx);
    }
    showPredictions(predictions);
  } catch (error) {
    console.error("Ошибка анализа кадра:", error);
    status("Ошибка анализа кадра: " + (error.message || "подробности в консоли"), "error");
  }

  if (running) frameRequest = requestAnimationFrame(loop);
}

function showPredictions(predictions) {
  const good = predictions.find(
    prediction => normalizeLabel(prediction.className) === normalizeLabel(GOOD)
  );
  const bad = predictions.find(
    prediction => normalizeLabel(prediction.className) === normalizeLabel(BAD)
  );

  if (!good || !bad) {
    lastResultIsBad = false;
    $("warning").hidden = true;
    result("neutral", "Неизвестные классы", "Названия классов модели должны быть «Правильная осанка» и «Плохая осанка».");
    return;
  }

  // Показываем вероятности модели без сглаживания и дополнительных порогов.
  $("goodText").textContent = Math.round(good.probability * 100) + "%";
  $("badText").textContent = Math.round(bad.probability * 100) + "%";
  $("goodBar").style.width = (good.probability * 100) + "%";
  $("badBar").style.width = (bad.probability * 100) + "%";

  // Побеждает класс с большей вероятностью, как его выбрала модель.
  const winner = good.probability >= bad.probability ? good : bad;
  const isBad = normalizeLabel(winner.className) === normalizeLabel(BAD);

  lastResultIsBad = isBad;
  $("warning").hidden = !isBad;

  if (isBad) {
    result("bad", BAD, "Вероятность модели: " + Math.round(winner.probability * 100) + "%.");

    // Не повторяем одно и то же системное уведомление каждый кадр.
    // За один запуск камеры отправляется не более одного такого уведомления.
    if (!alertSent) {
      alertSent = sendNotification(
        "Проверьте положение тела",
        "Модель определила класс «Плохая осанка». Возможно, стоит проверить позу.",
        "posture-alert"
      );
    }
  } else {
    result("good", GOOD, "Вероятность модели: " + Math.round(winner.probability * 100) + "%.");
  }
}

$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
$("enableNotifications").addEventListener("click", enableNotifications);

$("stretchToggle").addEventListener("change", () => {
  try {
    localStorage.setItem(
      "posture-assistant-stretch-reminder",
      $("stretchToggle").checked ? "on" : "off"
    );
  } catch (_) {}

  if (running) lastStretchAt = $("stretchToggle").checked ? Date.now() : 0;
});

try {
  $("stretchToggle").checked =
    localStorage.getItem("posture-assistant-stretch-reminder") !== "off";
} catch (_) {}

updateNotificationUI();
document.addEventListener("visibilitychange", checkStretchReminder);
})();