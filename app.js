import { createExtensionBridge } from "./extension-bridge.js";

(() => {
"use strict";
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/ErDzmxAv-/";
const GOOD = "Правильная осанка";
const BAD = "Плохая осанка";
const REQUIRED_BAD = 3;
const REQUIRED_GOOD = 5;
const SMOOTHING_ALPHA = 0.25;
const $ = id => document.getElementById(id);
const canvas = $("view"), ctx = canvas.getContext("2d");
let model = null, webcam = null, running = false, raf = null;
let badCount = 0, goodCount = 0, smoothedGood = null, smoothedBad = null;
let alertSent = false, lastStretchAt = 0, stretchTimer = null;
let currentNotification = null;
let extensionAvailable = false;
const bridge = createExtensionBridge(handleExtensionEvent);
const STRETCH_MS = 40 * 60 * 1000;

function status(message, state="") {
  $("status").textContent = message;
  $("cameraBadge").textContent = state === "live" ? "Включена" : state === "error" ? "Ошибка" : "Выключена";
  $("cameraBadge").className = "badge " + state;
}
function modelStatus(message, state="") {
  $("modelBadge").textContent = message;
  $("modelBadge").className = "badge " + state;
}
function result(kind, title, message) {
  $("result").className = "result " + kind;
  $("resultTitle").textContent = title;
  $("resultText").textContent = message;
}
function updateNotificationUI() {
  const badge = $("notificationBadge");
  const statusText = $("notificationStatus");
  const button = $("enableNotifications");
  if (extensionAvailable) {
    badge.className = "badge live";
    badge.innerHTML = '<span class="badge-dot"></span>Через расширение';
    statusText.textContent = "Системные уведомления отправляет расширение Chrome. Разрешение запрашивается при его установке.";
    button.textContent = "Проверить уведомление";
    button.disabled = false;
    return;
  }
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
    statusText.textContent = "Системные уведомления сайта разрешены.";
    button.textContent = "Уведомления включены";
    button.disabled = true;
  } else if (permission === "denied") {
    badge.className = "badge error";
    badge.innerHTML = '<span class="badge-dot"></span>Запрещены';
    statusText.textContent = "Уведомления заблокированы в настройках браузера.";
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
    if (tag === "posture-alert" && currentNotification) currentNotification.close();
    const notification = new Notification(title, { body, tag, icon: "/favicon.svg", renotify: true });
    if (tag === "posture-alert") currentNotification = notification;
    return true;
  } catch (error) {
    console.warn("Не удалось показать системное уведомление:", error);
    return false;
  }
}
async function enableNotifications() {
  if (extensionAvailable) {
    const response = await bridge.request("TEST_NOTIFICATION");
    $("notificationStatus").textContent = response?.ok
      ? "Проверочное уведомление отправлено."
      : (response?.error || "Не удалось отправить уведомление. Проверьте настройки Chrome.");
    return;
  }
  if (!("Notification" in window)) return updateNotificationUI();
  try { await Notification.requestPermission(); }
  catch (error) { console.warn("Не удалось запросить разрешение уведомлений:", error); }
  updateNotificationUI();
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
  if (!window.tmPose) throw new Error("Не загрузилась библиотека модели. Проверь интернет и обнови страницу.");
  modelStatus("Загружаем модель");
  const loadedModel = await tmPose.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  const labels = loadedModel.getClassLabels ? loadedModel.getClassLabels() : null;
  if (labels && (!labels.some(label => normalizeLabel(label) === normalizeLabel(GOOD)) ||
                 !labels.some(label => normalizeLabel(label) === normalizeLabel(BAD)))) {
    throw new Error("Названия классов в модели не совпадают с ожидаемыми. Проверь классы в Teachable Machine.");
  }
  model = loadedModel;
  modelStatus("Модель загружена", "live");
}
function showPredictions(predictions) {
  const good = predictions.find(p => normalizeLabel(p.className) === normalizeLabel(GOOD));
  const bad = predictions.find(p => normalizeLabel(p.className) === normalizeLabel(BAD));
  if (!good || !bad) {
    badCount = 0; goodCount = 0; $("warning").hidden = true;
    result("neutral", "Неизвестные классы", "Названия классов модели должны быть «Правильная осанка» и «Плохая осанка».");
    return;
  }
  if (smoothedGood === null || smoothedBad === null) {
    smoothedGood = good.probability; smoothedBad = bad.probability;
  } else {
    smoothedGood = SMOOTHING_ALPHA * good.probability + (1 - SMOOTHING_ALPHA) * smoothedGood;
    smoothedBad = SMOOTHING_ALPHA * bad.probability + (1 - SMOOTHING_ALPHA) * smoothedBad;
  }
  $("goodText").textContent = Math.round(smoothedGood * 100) + "%";
  $("badText").textContent = Math.round(smoothedBad * 100) + "%";
  $("goodBar").style.width = (smoothedGood * 100) + "%";
  $("badBar").style.width = (smoothedBad * 100) + "%";
  const threshold = Number($("threshold").value) / 100;
  const winner = good.probability >= bad.probability ? good : bad;
  if (winner.probability < threshold) {
    badCount = 0; goodCount = 0; $("warning").hidden = true;
    result("neutral", "Не удаётся уверенно определить позу", "Попробуйте улучшить освещение и расположиться так, чтобы модель хорошо видела позу.");
    return;
  }
  if (normalizeLabel(winner.className) === normalizeLabel(GOOD)) {
    badCount = 0; goodCount = Math.min(goodCount + 1, REQUIRED_GOOD);
    if (alertSent && goodCount >= REQUIRED_GOOD) { alertSent = false; goodCount = 0; }
    $("warning").hidden = true;
    result("good", GOOD, alertSent
      ? "Модель определяет правильную осанку. Для сброса уведомления нужно ещё " + (REQUIRED_GOOD - goodCount) + " последовательных определений."
      : "Модель уверенно определяет правильную осанку.");
    return;
  }
  goodCount = 0; badCount++;
  result("bad", BAD, "Уверенность модели: " + Math.round(winner.probability * 100) + "%. Последовательных определений: " + badCount + "/" + REQUIRED_BAD + ".");
  if (badCount >= REQUIRED_BAD) {
    $("warning").hidden = false;
    if (!alertSent) {
      sendNotification("Проверьте положение тела", "Модель несколько раз подряд определила класс «Плохая осанка». Возможно, стоит проверить позу.", "posture-alert");
      alertSent = true;
    }
  }
}
async function startLocal() {
  $("start").disabled = true; $("stop").disabled = true;
  status("Загружаем модель…"); result("neutral", "Загрузка модели", "Подождите немного.");
  try {
    await loadModel();
    status("Запрашиваем доступ к камере…");
    webcam = new tmPose.Webcam(400, 300, false);
    await webcam.setup(); await webcam.play();
    running = true; canvas.hidden = false; $("placeholder").hidden = true;
    $("stop").disabled = false; $("liveLabel").hidden = false;
    badCount = 0; goodCount = 0; alertSent = false; smoothedGood = null; smoothedBad = null;
    lastStretchAt = Date.now();
    status("Камера работает. Анализируем позу.", "live");
    if (stretchTimer) clearInterval(stretchTimer);
    stretchTimer = setInterval(checkStretchReminder, 15000);
    loop();
  } catch (error) {
    console.error(error);
    if (webcam) { try { webcam.stop(); } catch (_) {} }
    webcam = null; running = false; $("start").disabled = false; $("stop").disabled = true;
    canvas.hidden = true; $("placeholder").hidden = false; $("liveLabel").hidden = true;
    if (stretchTimer) clearInterval(stretchTimer); stretchTimer = null;
    status(error.message || "Не удалось запустить камеру или модель.", "error");
    modelStatus("Ошибка", "error");
    result("neutral", "Не удалось запустить", error.message || "Проверьте разрешение камеры и подключение к интернету.");
  }
}
async function start() {
  await extensionReady;
  if (!extensionAvailable) return startLocal();
  $("start").disabled = true; $("stop").disabled = true;
  status("Подготавливаем фоновое отслеживание…");
  result("neutral", "Запуск расширения", "Если Chrome запросит доступ к камере, разрешите его во вкладке расширения.");
  const response = await bridge.request("START", {
    threshold: Number($("threshold").value),
    stretchEnabled: $("stretchToggle").checked
  });
  if (!response?.ok) {
    $("start").disabled = false;
    status(response?.error || "Не удалось запустить фоновое отслеживание.", "error");
    result("neutral", "Не удалось запустить", response?.error || "Проверьте настройки расширения и доступ к камере.");
    return;
  }
  if (response.status === "permission_required") {
    status("Открылось окно разрешения камеры. Подтвердите доступ, чтобы продолжить.");
    result("neutral", "Нужно разрешение камеры", "Chrome открыл отдельную вкладку расширения для запроса доступа к камере.");
  } else {
    status("Фоновое отслеживание запускается…");
    modelStatus("Загружаем модель");
  }
}
async function stopLocal() {
  running = false;
  if (raf !== null) cancelAnimationFrame(raf);
  raf = null;
  if (stretchTimer) clearInterval(stretchTimer);
  stretchTimer = null; lastStretchAt = 0; alertSent = false; smoothedGood = null; smoothedBad = null;
  if (webcam) { try { webcam.stop(); } catch (_) {} }
  webcam = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.hidden = true; $("placeholder").hidden = false; $("liveLabel").hidden = true;
  $("start").disabled = false; $("stop").disabled = true; $("warning").hidden = true;
  badCount = 0; goodCount = 0;
  status("Камера выключена."); modelStatus(model ? "Модель загружена" : "Не запущена");
  result("neutral", "Ожидание запуска", "Включите камеру, чтобы начать.");
}
async function stop() {
  await extensionReady;
  if (!extensionAvailable) return stopLocal();
  $("stop").disabled = true;
  const response = await bridge.request("STOP");
  if (!response?.ok) status(response?.error || "Не удалось остановить отслеживание.", "error");
}
async function loop() {
  if (!running || !webcam || !model) return;
  try {
    webcam.update();
    const { pose, posenetOutput } = await model.estimatePose(webcam.canvas);
    const predictions = await model.predict(posenetOutput);
    ctx.drawImage(webcam.canvas, 0, 0, canvas.width, canvas.height);
    if (pose) {
      tmPose.drawKeypoints(pose.keypoints, 0.5, ctx);
      tmPose.drawSkeleton(pose.keypoints, 0.5, ctx);
    }
    showPredictions(predictions);
  } catch (error) {
    console.error("Ошибка анализа кадра:", error);
    status("Ошибка анализа кадра: " + (error?.message || "подробности в консоли"), "error");
  }
  if (running) raf = requestAnimationFrame(loop);
}
function drawRemoteFrame(dataUrl) {
  const image = new Image();
  image.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  };
  image.src = dataUrl;
  canvas.hidden = false;
  $("placeholder").hidden = true;
  $("liveLabel").hidden = false;
}
function applyRemoteResult(data) {
  if (typeof data.good === "number") {
    $("goodText").textContent = Math.round(data.good * 100) + "%";
    $("badText").textContent = Math.round(data.bad * 100) + "%";
    $("goodBar").style.width = (data.good * 100) + "%";
    $("badBar").style.width = (data.bad * 100) + "%";
  }
  if (data.kind) result(data.kind, data.title || "", data.message || "");
  $("warning").hidden = !data.warning;
}
function applyExtensionState(state) {
  if (!state) return;
  if (state.tracking) {
    running = true;
    $("start").disabled = true; $("stop").disabled = false;
    status("Фоновое отслеживание активно.", "live");
    modelStatus("Модель работает", "live");
    $("placeholder").hidden = true; canvas.hidden = false; $("liveLabel").hidden = false;
    result("neutral", "Отслеживание активно", "Распознавание продолжится, даже если переключиться на другую вкладку.");
  } else if (extensionAvailable) {
    running = false;
    $("start").disabled = false; $("stop").disabled = true;
    status("Камера выключена.");
    modelStatus("Ожидает запуска");
    $("liveLabel").hidden = true;
  }
  if (typeof state.threshold === "number") {
    $("threshold").value = state.threshold;
    $("thresholdText").textContent = state.threshold + "%";
  }
  if (typeof state.stretchEnabled === "boolean") $("stretchToggle").checked = state.stretchEnabled;
}
function handleExtensionEvent(event) {
  if (!event) return;
  if (event.type === "STATE") applyExtensionState(event.state);
  if (event.type === "STATUS") {
    status(event.message || "Фоновое отслеживание работает.", event.state || "");
    if (event.model) modelStatus(event.model, event.state || "");
  }
  if (event.type === "RESULT") applyRemoteResult(event.result);
  if (event.type === "FRAME") drawRemoteFrame(event.dataUrl);
  if (event.type === "ERROR") {
    running = false; $("start").disabled = false; $("stop").disabled = true;
    status(event.message || "Ошибка фонового отслеживания.", "error");
    modelStatus("Ошибка", "error");
    result("neutral", "Не удалось продолжить отслеживание", event.message || "Проверьте разрешения Chrome.");
    $("placeholder").hidden = false; canvas.hidden = true; $("liveLabel").hidden = true;
  }
}
async function detectExtension() {
  const response = await bridge.request("CHECK", {}, 1100);
  extensionAvailable = Boolean(response?.ok && response.installed);
  if (extensionAvailable) {
    $("extensionPanel").classList.add("extension-installed");
    $("extensionBadge").textContent = "Расширение подключено";
    $("extensionBadge").className = "badge live";
    $("extensionStatus").textContent = "Фоновый режим доступен. Нажмите «Начать отслеживание» — при первом запуске Chrome отдельно запросит доступ к камере.";
    $("extensionDownload").textContent = "Инструкция по расширению";
    $("extensionDownload").href = "#extension-help";
    updateNotificationUI();
    applyExtensionState(response.state);
    if (response.state?.lastResult) applyRemoteResult(response.state.lastResult);
  } else {
    $("extensionBadge").textContent = "Не установлено";
    $("extensionStatus").textContent = "Чтобы распознавание продолжалось в других вкладках, установите расширение Chrome. Без него работает обычный режим вкладки.";
    updateNotificationUI();
  }
  return extensionAvailable;
}
const extensionReady = detectExtension();

$("threshold").addEventListener("input", () => {
  $("thresholdText").textContent = $("threshold").value + "%";
  if (extensionAvailable) bridge.request("SETTINGS", { threshold: Number($("threshold").value) });
});
$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
$("enableNotifications").addEventListener("click", enableNotifications);
$("stretchToggle").addEventListener("change", () => {
  try { localStorage.setItem("posture-assistant-stretch-reminder", $("stretchToggle").checked ? "on" : "off"); } catch (_) {}
  if (extensionAvailable) bridge.request("SETTINGS", { stretchEnabled: $("stretchToggle").checked });
  else if ($("stretchToggle").checked && running && !lastStretchAt) lastStretchAt = Date.now();
});
try { $("stretchToggle").checked = localStorage.getItem("posture-assistant-stretch-reminder") !== "off"; } catch (_) {}
$("thresholdText").textContent = $("threshold").value + "%";
updateNotificationUI();
document.addEventListener("visibilitychange", () => {
  if (!extensionAvailable) checkStretchReminder();
});
})();
