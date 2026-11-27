# T-MINUS — split-flap countdown

An analog countdown timer built like an old split-flap board. Every card flips physically, with a mechanical clack you can hear on every tick, inside a rusted 90s hardware housing with an ominous, doomsday-style soundscape.

![screenshot](docs/screenshot.png)

## Run it

No build step and no dependencies. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## What it does

- **Real split-flap mechanics.** Each card sits on a drum and can only rotate forward, like the real hardware. When you set a new time, every card spins through the digits in between (click-click-click-click) until it lands.
- **Synthesized sound, no audio files.** All of it is generated live with the Web Audio API:
  - a flap clack per card (edge release, card slap, housing thunk, room echo)
  - a low "dread" drone with wind while the timer runs, which gets tenser under 60 s and again under 10 s
  - a deep impact every minute
  - a heartbeat for the final 10 seconds
  - a low brass and distortion blast at zero, with screen shake and flash, and the whole board cycles once before settling on 00
  - you can upload your own clack sound in **Setup**
- **Wallpapers.** 8 built-in backgrounds (Bunker, Rust, Doom Haze, 90s Den, Dead Channel, Blood Moon, Vector, Cell Block), or upload your own image or paste an image URL. You can darken and blur any of them.
- **Two modes.** A normal timer (up to 99:59:59), or a countdown to a date and time (DDD:HH:MM:SS).
- **Glow colors.** Doom green, amber, blood red or ice.
- Click the label tape to rename it. Settings, wallpaper and a running timer are kept if you refresh the page.

## Controls

| Key | Action |
| --- | --- |
| `Space` | Start / pause |
| `R` | Reset |
| `↑` / `↓` | ±1 minute |
| `M` | Mute |
| `F` | Fullscreen |
| `S` | Setup panel |

You can also click ▲ / ▼ (hold to repeat) or scroll the mouse wheel over a column to set it.
