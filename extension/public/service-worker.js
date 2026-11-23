const PAGE_URLS = [
  "https://posture-assistant.vercel.app/*",
  "https://posture-assistant-git-background-extension-nika-79d5.vercel.app/*"
];
const PAGE_ORIGINS = [
  "https://posture-assistant.vercel.app",
  "https://posture-assistant-git-background-extension-nika-79d5.vercel.app"
];
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const PERMISSION_URL = chrome.runtime.getURL("permission.html");
const STRETCH_ALARM = "posture-stretch-reminder";
let iconUrlCache = null;

async function getIconUrl() {
  if (iconUrlCache) return iconUrlCache;
  const canvas = new OffscreenCanvas(128, 128);
  const context = canvas.getContext("2d");
  context.fillStyle = "#386f68";
  context.beginPath(); context.roundRect(0, 0, 128, 128, 28); context.fill();
  context.strokeStyle = "#f8f5ed"; context.lineWidth = 9; context.lineCap = "round";
  context.beginPath();
  context.moveTo(64, 24); context.bezierCurveTo(42, 24, 38, 43, 46, 57);
  context.lineTo(46, 82); context.bezierCurveTo(46, 103, 82, 103, 82, 82);
  context.lineTo(82, 57); context.bezierCurveTo(90, 43, 86, 24, 64, 24); context.stroke();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  iconUrlCache = "data:image/png;base64," + btoa(binary);
  return iconUrlCache;
}
async function getState() {
  const data = await chrome.storage.local.get(["tracking", "cameraGranted", "threshold", "stretchEnabled", "lastResult"]);
  let notificationPermission = "denied";
  try { notificationPermission = await chrome.notifications.getPermissionLevel(); } catch (_) {}
  return {
    installed: true, tracking: Boolean(data.tracking), cameraGranted: Boolean(data.cameraGranted),
    threshold: data.threshold ?? 70, stretchEnabled: data.stretchEnabled ?? true,
    lastResult: data.lastResult || null, notificationPermission
  };
}
async function notify(id, title, message) {
  try {
    if (await chrome.notifications.getPermissionLevel() !== "granted") return false;
    await chrome.notifications.create(id, {
      type: "basic", iconUrl: await getIconUrl(), title, message, priority: 1
    });
    return true;
  } catch (error) {
    console.warn("Не удалось показать системное уведомление:", error);
    return false;
  }
}
async function broadcast(event) {
  const tabs = await chrome.tabs.query({ url: PAGE_URLS });
  await Promise.all(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: "PAGE_EVENT", event }).catch(() => undefined)
  ));
}
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["USER_MEDIA"],
    justification: "Получать видео с камеры и выполнять распознавание позы, пока пользователь работает в другой вкладке."
  });
}
async function openCameraPermission(pending) {
  await chrome.storage.local.set({ pendingStart: pending || null });
  await chrome.tabs.create({ url: PERMISSION_URL, active: true });
}
async function activateTracking(tabId, settings = {}) {
  const previous = await chrome.storage.local.get(["threshold", "stretchEnabled"]);
  const next = {
    threshold: settings.threshold ?? previous.threshold ?? 70,
    stretchEnabled: settings.stretchEnabled ?? previous.stretchEnabled ?? true
  };
  await chrome.storage.local.set(next);
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "START", settings: next });
    if (!response?.ok) throw new Error(response?.error || "Фоновый документ не смог запуститься.");
    await chrome.storage.local.set({ tracking: true, activeTabId: tabId ?? null });
    if (next.stretchEnabled) await chrome.alarms.create(STRETCH_ALARM, { delayInMinutes: 40, periodInMinutes: 40 });
    else await chrome.alarms.clear(STRETCH_ALARM);
    await broadcast({ type: "STATE", state: await getState() });
    return { ok: true, status: "starting" };
  } catch (error) {
    const message = error?.message || "Не удалось получить доступ к камере.";
    if (/permission|denied|notallowed|not allowed/i.test(message)) {
      await chrome.storage.local.set({ cameraGranted: false, tracking: false });
      await openCameraPermission({ tabId, settings: next });
      return { ok: true, status: "permission_required" };
    }
    await chrome.storage.local.set({ tracking: false });
    await broadcast({ type: "ERROR", message });
    return { ok: false, error: message };
  }
}
async function startTracking(tabId, settings) {
  const stored = await chrome.storage.local.get(["cameraGranted"]);
  if (!stored.cameraGranted) {
    await openCameraPermission({ tabId, settings });
    return { ok: true, status: "permission_required" };
  }
  return activateTracking(tabId, settings);
}
async function stopTracking() {
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP" });
  } catch (_) {}
  await chrome.alarms.clear(STRETCH_ALARM);
  await chrome.storage.local.set({ tracking: false, activeTabId: null, lastResult: null });
  await chrome.notifications.clear("posture-alert");
  await broadcast({ type: "STATE", state: await getState() });
  return { ok: true, status: "stopped" };
}
async function handleCommand(command, payload = {}, tabId = null) {
  if (command === "CHECK") return { ok: true, ...(await getState()) };
  if (command === "START") return startTracking(tabId, payload);
  if (command === "STOP") return stopTracking();
  if (command === "SETTINGS") {
    const stored = await chrome.storage.local.get(["tracking", "threshold", "stretchEnabled"]);
    const next = {
      threshold: payload.threshold ?? stored.threshold ?? 70,
      stretchEnabled: payload.stretchEnabled ?? stored.stretchEnabled ?? true
    };
    await chrome.storage.local.set(next);
    if (stored.tracking) {
      try { await chrome.runtime.sendMessage({ target: "offscreen", type: "SETTINGS", settings: next }); } catch (_) {}
      if (next.stretchEnabled) await chrome.alarms.create(STRETCH_ALARM, { delayInMinutes: 40, periodInMinutes: 40 });
      else await chrome.alarms.clear(STRETCH_ALARM);
    }
    await broadcast({ type: "STATE", state: await getState() });
    return { ok: true };
  }
  if (command === "TEST_NOTIFICATION") {
    const ok = await notify("posture-test", "Ассистент осанки", "Системные уведомления расширения работают.");
    return { ok, error: ok ? undefined : "Уведомления расширения отключены в настройках Chrome." };
  }
  return { ok: false, error: "Неизвестная команда." };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PAGE_COMMAND" && sender.tab) {
    let origin = "";
    try { origin = new URL(sender.tab.url).origin; } catch (_) {}
    if (!PAGE_ORIGINS.includes(origin)) {
      sendResponse({ ok: false, error: "Источник команды не разрешён." });
      return false;
    }
    handleCommand(message.command, message.payload, sender.tab.id)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || "Ошибка расширения." }));
    return true;
  }
  if (message?.type === "EXTENSION_COMMAND" && sender.id === chrome.runtime.id) {
    handleCommand(message.command, message.payload || {}, null)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || "Ошибка расширения." }));
    return true;
  }
  if (message?.type === "CAMERA_PERMISSION_RESULT" && sender.url === PERMISSION_URL) {
    (async () => {
      const pending = await chrome.storage.local.get(["pendingStart"]);
      await chrome.storage.local.set({ cameraGranted: Boolean(message.granted), pendingStart: null });
      if (Number.isInteger(sender.tab?.id)) {
        try { await chrome.tabs.remove(sender.tab.id); } catch (_) {}
      }
      if (message.granted && pending.pendingStart) {
        await activateTracking(pending.pendingStart.tabId ?? null, pending.pendingStart.settings || {});
      } else if (!message.granted) {
        await broadcast({ type: "ERROR", message: message.error || "Доступ к камере не предоставлен. Разрешите камеру для расширения и попробуйте снова." });
      }
    })().then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error?.message }));
    return true;
  }
  if (sender.url === OFFSCREEN_URL && message?.type === "OFFSCREEN_EVENT") {
    (async () => {
      const event = message.event || {};
      if (event.type === "RESULT") {
        await chrome.storage.local.set({ lastResult: event.result });
        if (event.result?.alertTriggered) {
          await notify("posture-alert", "Проверьте положение тела", "Модель несколько раз подряд определила класс «Плохая осанка». Возможно, стоит проверить позу.");
        }
        if (event.result?.alertReset) await chrome.notifications.clear("posture-alert");
        await broadcast({ type: "RESULT", result: event.result });
      } else if (event.type === "FRAME") {
        await broadcast({ type: "FRAME", dataUrl: event.dataUrl });
      } else if (event.type === "STATUS") {
        await broadcast({ type: "STATUS", message: event.message, state: event.state, model: event.model });
      } else if (event.type === "ERROR") {
        await chrome.storage.local.set({ tracking: false, cameraGranted: false });
        await chrome.alarms.clear(STRETCH_ALARM);
        await broadcast({ type: "ERROR", message: event.message });
      } else if (event.type === "STOPPED") {
        await chrome.storage.local.set({ tracking: false });
        await broadcast({ type: "STATE", state: await getState() });
      }
    })().then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error?.message }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== STRETCH_ALARM) return;
  const state = await getState();
  if (state.tracking && state.stretchEnabled) {
    await notify("posture-stretch-reminder", "Пора немного размяться", "Сделайте небольшую паузу, смените положение и мягко разомнитесь.");
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ tracking: false, activeTabId: null, pendingStart: null });
  await chrome.alarms.clear(STRETCH_ALARM);
});
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["threshold", "stretchEnabled"]);
  await chrome.storage.local.set({
    threshold: current.threshold ?? 70,
    stretchEnabled: current.stretchEnabled ?? true,
    tracking: false
  });
});
