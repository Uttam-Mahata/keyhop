# Keyhop

Keyboard-driven browsing for Firefox: vim-style scrolling, link hints, tab control and a command bar.
Minimal permissions (`storage`, `sessions`, `search`) and no network access.

## Keys

| Keys | Action |
|---|---|
| `j` `k` `h` `l` | Scroll down / up / left / right (`5j` repeats) |
| `d` `u` | Half page down / up |
| `gg` `G` | Top / bottom |
| `f` | Link hints: click |
| `F` | Link hints: open in a new tab |
| `yf` | Link hints: copy link address |
| `yy` | Copy page URL |
| `gi` | Focus first text field |
| `J` `K` (or `gT` `gt`) | Previous / next tab |
| `t` | New tab |
| `x` `X` | Close tab / restore closed tab |
| `o` `O` | Open URL or search here / in a new tab |
| `H` `L` | Back / forward |
| `r` | Reload |
| `gu` `gU` | Up one path level / site root |
| `i` | Insert mode (all keys go to the page), `Esc` leaves |
| `?` | Help |
| `Esc` | Cancel hints / bar / pending keys, or blur a focused field |

Keys that are not mapped, and anything pressed with Ctrl/Alt/Meta, go straight to the page.
Keys are ignored while a text field is focused.

## Try it

1. Firefox -> `about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on...** -> pick `manifest.json`.
   (Lasts until Firefox restarts.)
2. Options: `about:addons` -> Keyhop -> Preferences (excluded sites, hint characters, focus new tabs).

## Install permanently

Release Firefox only runs signed add-ons. Either:
- sign it for yourself (free): upload the `.xpi` from `./build.sh` at
  <https://addons.mozilla.org/developers/> as **"On your own"** (unlisted), then install the signed file; or
- use Firefox Developer Edition / Nightly / ESR and set `xpinstall.signatures.required` to `false`.

## Tests

```
python3 -m venv .venv && .venv/bin/pip install selenium
.venv/bin/python tests/test_keyhop.py
```
Runs headless Firefox with the extension against `tests/site/` (selenium fetches geckodriver itself).

## Limits (v0.1)

- Top-level documents only: no hints inside iframes.
- Firefox does not run extensions on `about:` pages, `addons.mozilla.org`, or the built-in PDF viewer.
- No in-page find (`/`); use Ctrl+F.
