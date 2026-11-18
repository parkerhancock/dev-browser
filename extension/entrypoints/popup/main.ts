import type { GetStateMessage, PairProfileMessage, SetStateMessage, StateResponse } from "../../utils/types";

const toggle = document.getElementById("active-toggle") as HTMLInputElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const connectionStatus = document.getElementById("connection-status") as HTMLParagraphElement;

const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const pairing = document.querySelector<HTMLFormElement>("#pairing")!;
const code = document.querySelector<HTMLInputElement>("#pairing-code")!;
const pairingStatus = document.querySelector<HTMLParagraphElement>("#pairing-status")!;

function updateUI(state: StateResponse): void {
  stop.hidden = !state.isActive;
  toggle.checked = state.isActive;
  statusText.textContent = state.isActive ? "Active" : "Inactive";

  if (state.isActive) {
    connectionStatus.textContent = state.isConnected ? "Connected to relay" : "Connecting...";
    connectionStatus.className = state.isConnected
      ? "connection-status connected"
      : "connection-status connecting";
  } else {
    connectionStatus.textContent = "";
    connectionStatus.className = "connection-status";
  }
}

function refreshState(): void {
  chrome.runtime.sendMessage<GetStateMessage, StateResponse>({ type: "getState" }, (response) => {
    if (response) {
      updateUI(response);
    }
  });
}

// Load initial state
refreshState();

// Poll for state updates while popup is open
const pollInterval = setInterval(refreshState, 1000);

// Clean up on popup close
window.addEventListener("unload", () => {
  clearInterval(pollInterval);
});

// Handle toggle changes
toggle.addEventListener("change", () => {
  setActive(toggle.checked);
});
stop.addEventListener("click", () => setActive(false));

function setActive(isActive: boolean): void {
  chrome.runtime.sendMessage<SetStateMessage, StateResponse>(
    { type: "setState", isActive },
    (response) => {
      if (response) {
        updateUI(response);
      }
    }
  );
}

pairing.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pairingCode = code.value.trim();
  code.value = "";
  const button = pairing.querySelector("button")!;
  button.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage<PairProfileMessage, StateResponse>({
      type: "pairProfile", code: pairingCode,
    });
    updateUI(state);
    pairingStatus.textContent = state.error ?? "Paired. This profile is approved.";
  } catch {
    pairingStatus.textContent = "Could not reach the extension. Try again.";
  } finally {
    button.disabled = false;
  }
});
