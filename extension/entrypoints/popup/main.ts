import type { GetStateMessage, AllowSshAccessMessage, SetStateMessage, StateResponse } from "../../utils/types";

const toggle = document.getElementById("active-toggle") as HTMLInputElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const connectionStatus = document.getElementById("connection-status") as HTMLParagraphElement;

const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const allowSsh = document.querySelector<HTMLButtonElement>("#allow-ssh")!;
const sshStatus = document.querySelector<HTMLParagraphElement>("#ssh-status")!;

function updateUI(state: StateResponse): void {
  stop.hidden = !state.isActive;
  allowSsh.hidden = state.sshApproved === true && state.isActive;
  allowSsh.textContent = state.sshApproved ? "Resume SSH access" : "Allow SSH access";
  const message = state.error ?? (state.sshApproved ? "This profile is approved for SSH." : "");
  if (message || !sshStatus.textContent) sshStatus.textContent = message;
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

allowSsh.addEventListener("click", async () => {
  allowSsh.disabled = true;
  sshStatus.textContent = "";
  try {
    const state = await chrome.runtime.sendMessage<AllowSshAccessMessage, StateResponse>({
      type: "allowSshAccess",
    });
    updateUI(state);
  } catch {
    sshStatus.textContent = "Could not reach the extension. Try again.";
  } finally {
    allowSsh.disabled = false;
  }
});
