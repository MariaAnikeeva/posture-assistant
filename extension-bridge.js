export function createExtensionBridge(onEvent) {
  const pending = new Map();
  let sequence = 0;

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== "posture-extension") return;
    if (message.type === "RESPONSE" && pending.has(message.requestId)) {
      const entry = pending.get(message.requestId);
      clearTimeout(entry.timer);
      pending.delete(message.requestId);
      entry.resolve(message.response);
    } else if (message.type === "EVENT" && typeof onEvent === "function") {
      onEvent(message.event);
    }
  });

  function request(command, payload = {}, timeoutMs = 1800) {
    const requestId = "page-" + (++sequence);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      window.postMessage({
        source: "posture-page",
        type: "COMMAND",
        requestId,
        command,
        payload
      }, window.location.origin);
    });
  }

  return { request };
}
