const status = document.getElementById("status");
(async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach(track => track.stop());
    status.textContent = "Доступ разрешён. Запускаем фоновое отслеживание…";
    await chrome.runtime.sendMessage({ type: "CAMERA_PERMISSION_RESULT", granted: true });
  } catch (error) {
    status.textContent = "Доступ не предоставлен. Можно закрыть эту вкладку и попробовать снова.";
    try {
      await chrome.runtime.sendMessage({
        type: "CAMERA_PERMISSION_RESULT", granted: false,
        error: error?.message || "Доступ к камере не предоставлен."
      });
    } catch (_) {}
  }
})();
