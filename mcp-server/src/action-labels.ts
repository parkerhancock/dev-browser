/**
 * Short descriptions of tool calls, drawn as labels on gif_creator frames.
 * Form values are left out; typed text is shown, since it's on screen anyway.
 */

import { basename } from "node:path";

const COMPUTER_VERBS: Record<string, string> = {
  left_click: "Click",
  right_click: "Right-click",
  double_click: "Double-click",
  triple_click: "Triple-click",
  hover: "Hover",
  left_click_drag: "Drag",
  scroll_to: "Scroll to",
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

export function describeAction(tool: string, args: Record<string, unknown>): string | undefined {
  switch (tool) {
    case "navigate": {
      const url = String(args.url ?? "");
      if (url === "back") return "Go back";
      if (url === "forward") return "Go forward";
      return `Go to ${url.replace(/^https?:\/\//, "")}`;
    }
    case "computer": {
      const action = String(args.action ?? "");
      if (action === "type") return `Type "${String(args.text ?? "")}"`;
      if (action === "key") {
        const times = typeof args.repeat === "number" && args.repeat > 1 ? ` x${args.repeat}` : "";
        return `Press ${String(args.text ?? "")}${times}`;
      }
      if (action === "scroll") return `Scroll ${String(args.scroll_direction ?? "down")}`;
      const verb = COMPUTER_VERBS[action];
      if (!verb) return undefined;
      const ref = str(args.ref);
      return ref ? `${verb} ${ref}` : verb === "Scroll to" ? "Scroll to element" : verb;
    }
    case "ref_action":
      return `${args.action === "fill" ? "Fill" : "Click"} ${String(args.ref ?? "")}`;
    case "form_input": {
      const ref = str(args.ref);
      if (ref) return `Set ${ref}`;
      const count = args.fields && typeof args.fields === "object" ? Object.keys(args.fields).length : 0;
      return `Fill ${count} field${count === 1 ? "" : "s"}`;
    }
    case "file_upload": {
      const files = Array.isArray(args.files) ? (args.files as unknown[]).map((f) => basename(String(f))) : [];
      return `Upload ${files.join(", ")}`;
    }
    case "upload_image":
      return `Upload ${str(args.filename) ?? basename(String(args.path ?? ""))}`;
    case "resize_window": {
      const parts: string[] = [];
      if (typeof args.width === "number" && typeof args.height === "number") parts.push(`${args.width}x${args.height}`);
      else if (str(args.preset)) parts.push(String(args.preset));
      if (str(args.color_scheme)) parts.push(`${String(args.color_scheme)} mode`);
      return `Resize to ${parts.join(", ")}`;
    }
    case "javascript":
      return "Run JavaScript";
    case "preview_start":
      return `Start ${str(args.name) ?? str(args.url) ?? "preview"}`;
    default:
      return undefined;
  }
}
