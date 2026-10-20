# Tartarus AI

The **Tartarus Overlay** (the advice card for Tartarus in Torchlight: Infinite)
with a stronger AI that's also light on your PC.

Personal, **unofficial** project. The simulator and the Tartarus Overlay are by
**CoffeeBns**: [blahdot3h/tartarus-simulator](https://github.com/blahdot3h/tartarus-simulator).
This repository doesn't hold their code: Tartarus AI downloads the simulator
straight from the author's GitHub and applies only the changes kept here
(`patch/melhorias.diff`) on top.

## What's different

- A deeper check of each move (several times the playouts of the live site),
  retrained strategy weights, and profiles for instruments, pairs and run
  contracts.
- Light on the PC: the check uses at most half the processor cores (4 at most)
  for at most 1.5 seconds per board, and the overlay runs at below-normal
  priority, so the game always comes first.
- Nothing else to install: no Node.js, no Git. It updates itself each time it
  opens (and every 30 minutes while it runs; the overlay reloads when the run
  ends).

## Install

1. Install the official **Tartarus Overlay** first, from the author's
   [releases page](https://github.com/blahdot3h/tartarus-simulator/releases/latest),
   and set it up once (agree to the screenshot terms).
2. Download **[TartarusAI.exe](https://github.com/bwernerdev/tartarus-ia/raw/main/TartarusAI.exe)**
   and open it. Windows may warn that it's from an unknown publisher: click
   **More info**, then **Run anyway**.
3. It installs itself in `%LOCALAPPDATA%\TartarusAI`, puts a **Tartarus AI**
   shortcut on the desktop, and opens the overlay.

From then on, open **Tartarus AI** from the desktop instead of the Tartarus
Overlay. Its icon sits by the clock while the overlay is open, and it closes
when the overlay closes.

## Uninstall

Right-click the Tartarus AI icon by the clock, then **Uninstall Tartarus AI**.
It removes its folder, its shortcut and itself. The official Tartarus Overlay
stays; remove it in Windows Settings > Apps if you want.

## Files here

- `TartarusAI.exe`: the program (C#, source in the publisher's PC).
- `patch/version.json`: the version, the author's commit it's built on, and
  the program's version.
- `patch/melhorias.diff`: the changes to the author's site.
