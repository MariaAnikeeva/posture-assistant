const status = document.getElementById("status");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "EXTENSION_COMMAND", command: "CHECK" });
  status.textContent = state?.tracking ? "Фоновое отслеживание активно." : "Отслеживание остановлено.";
  startButton.disabled = Boolean(state?.tracking);
  stopButton.disabled = !state?.tracking;
}
startButton.addEventListener("click", async () => {
  startButton.disabled = true; status.textContent = "Запускаем…";
  const response = await chrome.runtime.sendMessage({
    type: "EXTENSION_COMMAND", command: "START",
    payload: { threshold: 70, stretchEnabled: true }
  });
  status.textContent = response?.status === "permission_required"
    ? "Открылось окно разрешения камеры."
    : response?.ok ? "Фоновый запуск начат." : (response?.error || "Не удалось запустить.");
  await refresh();
});
stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "EXTENSION_COMMAND", command: "STOP" });
  await refresh();
});
refresh().catch(() => { status.textContent = "Не удалось получить состояние расширения."; });
