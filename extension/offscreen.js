import * as tf from "@tensorflow/tfjs";
import * as tmPose from "@teachablemachine/pose";

const MODEL_URL = "https://teachablemachine.withgoogle.com/models/ErDzmxAv-/";
const GOOD = "Правильная осанка";
const BAD = "Плохая осанка";
const REQUIRED_BAD = 3;
const REQUIRED_GOOD = 5;
const SMOOTHING_ALPHA = 0.25;
const video = document.getElementById("camera");
const canvas = document.getElementById("frame");
const ctx = canvas.getContext("2d");
let model = null, stream = null, running = false, threshold = 0.70;
let badCount = 0, goodCount = 0, alertSent = false;
let smoothedGood = null, smoothedBad = null, lastFrameAt = 0;
const normalize = value => String(value ?? "").trim().toLocaleLowerCase("ru-RU");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function emit(event) {
  try { await chrome.runtime.sendMessage({ type: "OFFSCREEN_EVENT", event }); }
  catch (error) { console.warn("Не удалось передать событие:", error); }
}
async function loadModel() {
  if (model) return;
  await tf.ready();
  model = await tmPose.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  const labels = model.getClassLabels ? model.getClassLabels() : null;
  if (labels && (!labels.some(label => normalize(label) === normalize(GOOD)) ||
                 !labels.some(label => normalize(label) === normalize(BAD)))) {
    throw new Error("Названия классов модели не совпадают с ожидаемыми.");
  }
}
function drawPose(pose) {
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (pose) {
    tmPose.drawKeypoints(pose.keypoints, 0.5, ctx);
    tmPose.drawSkeleton(pose.keypoints, 0.5, ctx);
  }
}
function buildResult(predictions) {
  const good = predictions.find(item => normalize(item.className) === normalize(GOOD));
  const bad = predictions.find(item => normalize(item.className) === normalize(BAD));
  if (!good || !bad) {
    badCount = 0; goodCount = 0;
    return { kind: "neutral", title: "Неизвестные классы", message: "Проверьте названия классов в модели Teachable Machine.", warning: false };
  }
  if (smoothedGood === null || smoothedBad === null) {
    smoothedGood = good.probability; smoothedBad = bad.probability;
  } else {
    smoothedGood = SMOOTHING_ALPHA * good.probability + (1 - SMOOTHING_ALPHA) * smoothedGood;
    smoothedBad = SMOOTHING_ALPHA * bad.probability + (1 - SMOOTHING_ALPHA) * smoothedBad;
  }
  const winner = good.probability >= bad.probability ? good : bad;
  if (winner.probability < threshold) {
    badCount = 0; goodCount = 0;
    return {
      good: smoothedGood, bad: smoothedBad, kind: "neutral",
      title: "Не удаётся уверенно определить позу",
      message: "Попробуйте улучшить освещение и расположиться так, чтобы модель хорошо видела позу.",
      warning: false
    };
  }
  if (normalize(winner.className) === normalize(GOOD)) {
    badCount = 0; goodCount = Math.min(goodCount + 1, REQUIRED_GOOD);
    const alertReset = alertSent && goodCount >= REQUIRED_GOOD;
    if (alertReset) { alertSent = false; goodCount = 0; }
    return {
      good: smoothedGood, bad: smoothedBad, kind: "good", title: GOOD,
      message: "Модель уверенно определяет правильную осанку.",
      warning: false, alertReset
    };
  }
  goodCount = 0; badCount++;
  const alertTriggered = badCount >= REQUIRED_BAD && !alertSent;
  if (alertTriggered) alertSent = true;
  return {
    good: smoothedGood, bad: smoothedBad, kind: "bad", title: BAD,
    message: "Уверенность модели: " + Math.round(winner.probability * 100) + "%. Последовательных определений: " + badCount + "/" + REQUIRED_BAD + ".",
    warning: badCount >= REQUIRED_BAD, alertTriggered
  };
}
async function stop() {
  running = false;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null; video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  badCount = 0; goodCount = 0; alertSent = false; smoothedGood = null; smoothedBad = null;
  await emit({ type: "STOPPED" });
}
async function runLoop() {
  while (running) {
    try {
      if (video.readyState >= 2 && model) {
        const estimate = await model.estimatePose(video);
        const predictions = await model.predict(estimate.posenetOutput);
        drawPose(estimate.pose);
        await emit({ type: "RESULT", result: buildResult(predictions) });
        if (Date.now() - lastFrameAt >= 500) {
          lastFrameAt = Date.now();
          await emit({ type: "FRAME", dataUrl: canvas.toDataURL("image/jpeg", 0.68) });
        }
      }
    } catch (error) {
      console.error("Ошибка фонового распознавания:", error);
      running = false;
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = null; video.srcObject = null;
      await emit({ type: "ERROR", message: error?.message || "Ошибка при анализе изображения с камеры." });
      return;
    }
    await wait(250);
  }
}
async function start(settings = {}) {
  if (running) await stop();
  threshold = (settings.threshold ?? 70) / 100;
  await emit({ type: "STATUS", message: "Загружаем модель в фоновом режиме…", state: "", model: "Загружаем модель" });
  await loadModel();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
  });
  video.srcObject = stream;
  await video.play();
  running = true;
  badCount = 0; goodCount = 0; alertSent = false; smoothedGood = null; smoothedBad = null; lastFrameAt = 0;
  await emit({ type: "STATUS", message: "Фоновое отслеживание активно.", state: "live", model: "Модель работает" });
  runLoop();
  return { ok: true };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  if (message.type === "START") {
    start(message.settings || {}).then(sendResponse).catch(async error => {
      await emit({ type: "ERROR", message: error?.message || "Не удалось запустить камеру." });
      sendResponse({ ok: false, error: error?.message || "Не удалось запустить камеру." });
    });
    return true;
  }
  if (message.type === "STOP") {
    stop().then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error?.message }));
    return true;
  }
  if (message.type === "SETTINGS") {
    threshold = (message.settings?.threshold ?? threshold * 100) / 100;
    sendResponse({ ok: true });
  }
  return false;
});
