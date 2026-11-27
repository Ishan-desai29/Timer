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
- **Just the click.** The only sound is the mechanical clack of the flaps, generated live with the Web Audio API (edge release, card slap, housing thunk) with a soft echo off concrete walls. At zero, the whole board clatters through two full revolutions and settles on 00. On Android the phone also vibrates.
  - **CLICK** fader on the front panel sets the click volume
  - **Echo** slider in Setup sets how much room echo there is
  - you can upload your own clack sound in Setup
- **Set it like a phone timer.** Tap the clock (or **SET TIME**) for scroll wheels for hours, minutes and seconds; each notch clicks as it rolls past. You can also slide any column of the clock up or down with your finger or mouse.
- **Wallpapers.** 8 built-in backgrounds (Bunker, Rust, Doom Haze, 90s Den, Dead Channel, Blood Moon, Vector, Cell Block), or upload your own image or paste an image URL. You can darken and blur any of them.
- **Two modes.** A normal timer (up to 99:59:59), or a countdown to a date and time (DDD:HH:MM:SS).
- **Glow colors.** Doom green, amber, blood red or ice.
- Click the label tape to rename it. Settings, wallpaper and a running timer are kept if you refresh the page. While the timer runs, the screen stays awake.

## Install it on your phone

It's an installable web app (PWA): once it's on your home screen it opens full screen with its own icon and works offline.

1. Host it with GitHub Pages: in the repo, **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick the branch and `/ (root)`, and save. After a minute it's live at `https://<your-username>.github.io/Timer/`.
2. Open that link on your phone:
   - **iPhone (Safari):** Share button → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Install app** (or **Add to Home screen**).

Notes:
- On iPhone, sound follows the silent switch. Newer iOS versions show a Setup option to play clicks even on silent.
- Phones pause web apps in the background, so the timer can't click or alert you while the app is closed. When you come back, it shows the correct time left.
- After you push changes, bump `VERSION` in `sw.js` so installed copies pick them up.

## Controls

| Key | Action |
| --- | --- |
| `Space` | Start / pause |
| `R` | Reset |
| `T` | Set time (wheels) |
| `↑` / `↓` | ±1 minute |
| `M` | Mute |
| `F` | Fullscreen |
| `S` | Setup panel |

You can also click ▲ / ▼ (hold to repeat), drag a column up or down, or scroll the mouse wheel over it.
