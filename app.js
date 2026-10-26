(() => {
"use strict";
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/ErDzmxAv-/";
const GOOD = "Правильная осанка", BAD = "Плохая осанка", REQUIRED_BAD = 2;
const $ = id => document.getElementById(id);
const canvas = $("view"), ctx = canvas.getContext("2d");
let model = null, webcam = null, running = false, raf = null, badCount = 0, latest = null;
let alertSent = false, lastStretchAt = 0, stretchTimer = null;
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
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  try {
    new Notification(title, { body, tag, icon: "/favicon.svg", renotify: false });
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
  // Keep the model local until validation succeeds. A failed check must not
  // leave a partially initialized model that makes the next click behave differently.
  const loadedModel = await tmPose.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  const labels = loadedModel.getClassLabels ? loadedModel.getClassLabels() : null;
  if (labels && (!labels.some(label => normalizeLabel(label) === normalizeLabel(GOOD)) ||
                 !labels.some(label => normalizeLabel(label) === normalizeLabel(BAD)))) {
    throw new Error("Названия классов в модели не совпадают с ожидаемыми. Проверь классы в Teachable Machine.");
  }
  model = loadedModel;
  modelStatus("Модель загружена", "live");
}
async function start() {
  $("start").disabled = true; $("stop").disabled = true;
  status("Загружаем модель…"); result("neutral","Загрузка модели","Подожди немного.");
  try {
    await loadModel();
    status("Запрашиваем доступ к камере…");
    webcam = new tmPose.Webcam(400,400,false);
    await webcam.setup(); await webcam.play();
    running = true; canvas.hidden = false; $("placeholder").hidden = true; $("stop").disabled = false; $("liveLabel").hidden = false;
    badCount = 0; alertSent = false; lastStretchAt = Date.now();
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
    modelStatus("Ошибка","error"); result("neutral","Не удалось запустить",(e && e.message) ? e.message : "Проверь разрешение камеры и подключение к интернету.");
  }
}
function stop() {
  running = false; if (raf !== null) cancelAnimationFrame(raf); raf = null;
  if (stretchTimer) clearInterval(stretchTimer); stretchTimer = null; lastStretchAt = 0; alertSent = false;
  if (webcam) { try { webcam.stop(); } catch (_) {} }
  webcam = null; ctx.clearRect(0,0,canvas.width,canvas.height); canvas.hidden = true; $("placeholder").hidden = false; $("liveLabel").hidden = true;
  $("start").disabled = false; $("stop").disabled = true; $("warning").hidden = true; badCount = 0;
  status("Камера выключена."); modelStatus(model ? "Модель загружена" : "Не запущена");
  result("neutral","Ожидание запуска","Включи камеру, чтобы начать.");
}
async function loop() {
  if (!running || !webcam || !model) return;
  try {
    webcam.update();
    const {pose,posenetOutput} = await model.estimatePose(webcam.canvas);
    const predictions = await model.predict(posenetOutput);
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
  latest = predictions;
  const good = predictions.find(p => normalizeLabel(p.className) === normalizeLabel(GOOD));
  const bad = predictions.find(p => normalizeLabel(p.className) === normalizeLabel(BAD));
  if (!good || !bad) { badCount=0; result("neutral","Неизвестные классы","Названия классов модели должны быть «Правильная осанка» и «Плохая осанка»."); return; }
  $("goodText").textContent = Math.round(good.probability*100)+"%";
  $("badText").textContent = Math.round(bad.probability*100)+"%";
  $("goodBar").style.width = (good.probability*100)+"%";
  $("badBar").style.width = (bad.probability*100)+"%";
  const threshold = Number($("threshold").value)/100;
  const winner = good.probability >= bad.probability ? good : bad;
  if (winner.probability < threshold) {
    badCount=0; alertSent=false; $("warning").hidden=true;
    result("neutral","Не удаётся уверенно определить позу","Попробуй улучшить освещение и расположиться так, чтобы модель хорошо видела позу."); return;
  }
  if (normalizeLabel(winner.className) === normalizeLabel(GOOD)) {
    badCount=0; alertSent=false; $("warning").hidden=true; result("good",GOOD,"Модель уверенно определяет правильную осанку."); return;
  }
  badCount++;
  result("bad",BAD,`Уверенность модели: ${Math.round(winner.probability*100)}%. Последовательных определений: ${badCount}/${REQUIRED_BAD}.`);
  if (badCount >= REQUIRED_BAD) {
    $("warning").hidden=false;
    if (!alertSent) {
      sendNotification("Проверьте положение тела", "Модель несколько раз подряд определила класс «Плохая осанка». Возможно, стоит проверить позу.", "posture-alert");
      alertSent = true;
    }
  }
}
$("threshold").addEventListener("input",()=>{ $("thresholdText").textContent=$("threshold").value+"%"; if(latest) showPredictions(latest); });
$("start").addEventListener("click",start);
$("stop").addEventListener("click",stop);
$("enableNotifications").addEventListener("click",enableNotifications);
$("stretchToggle").addEventListener("change", () => {
  try { localStorage.setItem("posture-assistant-stretch-reminder", $("stretchToggle").checked ? "on" : "off"); } catch (_) {}
  if ($( "stretchToggle" ).checked && running && !lastStretchAt) lastStretchAt = Date.now();
});
try { $("stretchToggle").checked = localStorage.getItem("posture-assistant-stretch-reminder") !== "off"; } catch (_) {}
updateNotificationUI();
document.addEventListener("visibilitychange", () => {
  // If the browser throttled background timers, check elapsed time when the user returns.
  checkStretchReminder();
});
})();
