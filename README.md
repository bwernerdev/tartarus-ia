# Tartarus AI

The **Lanterna** (the Tartarus overlay for Torchlight: Infinite) with a
stronger Tartarus AI that's also light on your PC.

Personal, **unofficial** project. Credits:

- **Lanterna** by **PlaayerBL**
  ([PlaayerBL/lanterna-releases](https://github.com/PlaayerBL/lanterna-releases)),
  shared here with the author's permission. Tartarus AI downloads the official
  release (the runtime and the data) from there and puts only our version of
  the app's files (`lanterna/`) on top.
- The Tartarus simulator and its AI by **CoffeeBns**
  ([blahdot3h/tartarus-simulator](https://github.com/blahdot3h/tartarus-simulator)).
  This repository doesn't hold their code: Tartarus AI downloads it straight
  from the author's GitHub and applies only the changes kept here
  (`patch/melhorias.diff`).

## What's different

- Advice from the Tartarus AI, with a deeper check of each move, retrained
  strategy weights, and profiles for instruments, pairs and run contracts.
- A fast engine for that check: the simulator's playouts compiled in C#
  (`server/TartarusMotor.exe`), about 14 times faster than in JavaScript,
  with the same results, so each move gets several times more playouts in
  less time. If the author's rules change, it steps aside and the
  JavaScript plays until it's updated.
- Light on the PC: the AI uses at most half the processor cores (4 at most),
  at below-normal priority, so the game always comes first.
- Nothing else to install: no .NET, no Node.js, no Git. It updates itself each
  time it opens.

## Install

1. Download **[TartarusAI.exe](https://github.com/bwernerdev/tartarus-ia/raw/main/TartarusAI.exe)**
   and open it. Windows may warn that it's from an unknown publisher: click
   **More info**, then **Run anyway**.
2. The first time it downloads the official Lanterna (about 120 MB, checked
   against the release's SHA-256), Node.js (about 30 MB, from nodejs.org,
   checked the same way) and the AI. This can take a few minutes.
3. It installs everything in `%LOCALAPPDATA%\TartarusAI`, puts a
   **Tartarus AI** shortcut on the desktop, and opens the Lanterna.

From then on, open **Tartarus AI** from the desktop. Its icon sits by the
clock while the Lanterna is open, and it closes when the Lanterna closes. In
the game, **F8** turns the Lanterna on and off.

## Uninstall

Right-click the Tartarus AI icon by the clock, then **Uninstall Tartarus AI**.
It removes its folder (the Lanterna included), its shortcut and itself.

## Files here

- `TartarusAI.exe`: the program (C#, source on the publisher's PC).
- `patch/version.json`: the versions (the AI, the official Lanterna with its
  SHA-256, Node.js with its SHA-256, the program) and the hashes of the files
  below.
- `patch/melhorias.diff`: the changes to the author's simulator.
- `server/`: the AI server the Lanterna talks to, with its C# playout
  engine (`TartarusMotor.exe`; the source stays on the publisher's PC).
- `lanterna/`: our version of the Lanterna's app files.
