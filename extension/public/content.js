(() => {
  "use strict";
  const allowedOrigins = new Set([
    "https://posture-assistant.vercel.app",
    "https://posture-assistant-git-background-extension-nika-79d5.vercel.app"
  ]);
  if (!allowedOrigins.has(location.origin)) return;
  window.addEventListener("message", async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== "posture-page" || message.type !== "COMMAND") return;
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "PAGE_COMMAND", command: message.command, payload: message.payload || {}
      });
    } catch (error) {
      response = { ok: false, error: error?.message || "Расширение не отвечает." };
    }
    window.postMessage({
      source: "posture-extension", type: "RESPONSE",
      requestId: message.requestId, response
    }, location.origin);
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "PAGE_EVENT") {
      window.postMessage({ source: "posture-extension", type: "EVENT", event: message.event }, location.origin);
    }
  });
})();
