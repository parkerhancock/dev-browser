import type { PopupMessage, StateResponse } from "../../utils/types";

const local = document.querySelector<HTMLInputElement>("#active-toggle")!;
const ssh = document.querySelector<HTMLInputElement>("#ssh-toggle")!;
const connection = document.querySelector<HTMLParagraphElement>("#connection-status")!;
const sshDetail = document.querySelector<HTMLSpanElement>("#ssh-detail")!;
const error = document.querySelector<HTMLParagraphElement>("#action-error")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const stopRow = document.querySelector<HTMLElement>("#stop-row")!;

let revision = 0;
let pending = false;

function render(state: StateResponse): void {
  local.checked = state.isActive;
  ssh.checked = state.sshEnabled === true;
  stopRow.hidden = !state.isActive;
  connection.dataset.state = state.isConnected ? "connected" : state.isActive ? "connecting" : "off";
  connection.textContent = state.isConnected ? "Relay connected" : state.isActive ? "Connecting to relay" : "Relay off";

  if (state.sshConnected) {
    sshDetail.textContent = "Available to approved SSH routes.";
  } else if (state.sshEnabled) {
    sshDetail.textContent = "Waiting for the relay to enable SSH access.";
  } else if (state.sshApproved) {
    sshDetail.textContent = "Approval saved for this Chrome profile.";
  } else {
    sshDetail.textContent = state.isActive
      ? "Approve this Chrome profile for remote sessions."
      : "Approve this profile and start the relay connection.";
  }
}

async function refresh(): Promise<void> {
  const current = revision;
  try {
    const state = await chrome.runtime.sendMessage<PopupMessage, StateResponse>({ type: "getState" });
    if (state && current === revision && !pending) render(state);
  } catch {
    if (current === revision && !pending) connection.textContent = "Extension unavailable";
  }
}

async function change(message: PopupMessage): Promise<void> {
  const current = ++revision;
  pending = true;
  local.disabled = true;
  ssh.disabled = true;
  error.hidden = true;
  try {
    const state = await chrome.runtime.sendMessage<PopupMessage, StateResponse>(message);
    if (current !== revision) return;
    render(state);
    error.textContent = state.error ?? "";
    error.hidden = !state.error;
  } catch {
    if (current !== revision) return;
    error.textContent = "Could not update access. Try again.";
    error.hidden = false;
  } finally {
    if (current === revision) {
      pending = false;
      local.disabled = false;
      ssh.disabled = false;
      void refresh();
    }
  }
}

local.addEventListener("change", () => void change({ type: "setState", isActive: local.checked }));
ssh.addEventListener("change", () => void change({ type: "setSshAccess", enabled: ssh.checked }));
stop.addEventListener("click", () => void change({ type: "setState", isActive: false }));
void refresh();
const poll = setInterval(() => void refresh(), 1000);
window.addEventListener("unload", () => clearInterval(poll));
