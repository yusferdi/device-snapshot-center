---
name: Device Snapshot Center
version: 1.1
tokens:
  color:
    canvas: "#f6f7f9"
    surface: "#ffffff"
    border: "#e1e5ea"
    text: "#18212c"
    muted: "#667180"
    live: "#0f6b78"
    attention: "#a66a13"
    optional: "#59469b"
    danger: "#b42318"
  radius:
    control: 6px
    panel: 8px
  spacing:
    compact: 8px
    standard: 14px
    section: 18px
  shadow:
    panel: "0 1px 2px rgb(24 33 44 / 5%)"
  breakpoint:
    mobile: 680px
    tablet: 820px
---

# Device Snapshot Center Design Contract

## Product Feel

Device Snapshot Center should feel like a compact remote-operations console: calm, fast, precise, and deliberate. The first screen is the working dashboard, not a marketing page.

## Visual System

- Use a balanced triadic palette: teal for primary/live, amber for attention, violet for optional modes, red only for remote-control danger states.
- Avoid native-looking controls. Keep semantic HTML, then style switches, selects, segmented controls, and buttons with custom CSS.
- Use dense but readable dashboard spacing. Cards are only for real panels and repeated records.
- Prefer one framed work surface with internal dividers over many nested cards.
- Live screen is the product center. It should feel stable, framed, and operational on desktop and mobile.
- Keep the live stage tall enough to inspect the remote screen, but not so tall that workspace tabs fall completely out of the first desktop viewport.
- Group toolbar actions into visible clusters such as device, speed, access, and view. Avoid a long undifferentiated row of buttons.
- On desktop, place session controls in a restrained side rail beside the screen. On tablet and mobile, place the screen first and controls below it.
- Use icon-only buttons with accessible labels and hover tooltips for compact view actions such as refresh frame, grid, fullscreen, and stop.
- Use progressive disclosure for secondary workflows. Address book, file transfer, assist tools, history, and audit should live behind clear workspace tabs instead of competing with the live screen.

## Interaction System

- Remote control must be explicitly toggled on.
- Keyboard input must be a second explicit toggle after control mode.
- Stop and Escape are panic-off controls.
- Fullscreen should preserve the control dock and accurate pointer mapping.
- Pointer control uses an ordered down/move/up/cancel state machine. Move packets may be coalesced, but boundary events must never be reordered or silently discarded.
- Held pointer gestures send a keepalive, and pointer coordinates target the agent control-screen dimensions rather than assuming screenshot pixels match the OS DPI coordinate space.
- Wheel input and stateful keyboard down/up events share the same input-priority lane ahead of screen capture commands.
- Screen capture and session recording run as background agent jobs so HTTP polling remains available for input while a frame is captured and uploaded.
- A transport failure must release active mouse buttons automatically.
- A transport failure, browser blur, or panic-off must release active keyboard keys automatically.
- Animation should be short, functional, and disabled through `prefers-reduced-motion`.

## Transport System

- Keep control-plane authentication and permissions in PHP/MySQL.
- Select transports per capability instead of treating the whole session as one connection.
- Prefer the lowest-latency available transport, retain a warm fallback, and upgrade again after recovery without restarting the agent.
- Current baseline is adaptive HTTP long-poll with short-poll circuit-breaker fallback. Future WSS and WebRTC transports must preserve the same pointer sequence and epoch contract.
- High-frequency pointer move commands are ephemeral and must not flood audit history or persist after successful execution.

## Mobile Rules

- Controls collapse into a single-column dock below 680px.
- On tablet and mobile, show the remote screen before the control dock so the product still feels like a remote desktop, not a settings form.
- Table data becomes stacked records.
- Touch targets stay at least 42px tall.
- No text should overflow buttons, chips, or table cells.

## Feature Direction

1. File transfer with a two-pane file manager and upload/download queue.
2. Clipboard send-text support, implemented as explicit typed text rather than silent clipboard sync.
3. Session recording as server-side artifact history, with retention controls.
4. Device groups, favorites, and searchable address book.
5. Permission profiles per device: view-only, mouse, keyboard, file transfer.
