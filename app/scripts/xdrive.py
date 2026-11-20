#!/usr/bin/env python3
"""Drives the X display in $DISPLAY with fake input, using the system libXtst.

Usage: xdrive.py STEP...
Steps:
  move X Y        move the pointer
  click X Y       left-click
  dclick X Y      left double-click
  rclick X Y      right-click
  type TEXT       type text
  key NAME        press a key combo by X keysym names, like ctrl+Return or F7
  sleep SECONDS   wait
  shot FILE       screenshot the whole display with ImageMagick
"""

import ctypes
import subprocess
import sys
import time

x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
xtst = ctypes.cdll.LoadLibrary("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XkbKeycodeToKeysym.restype = ctypes.c_ulong
x11.XkbKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.c_int]
x11.XFlush.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

dpy = x11.XOpenDisplay(None)
if not dpy:
    sys.exit("Failed to open the X display")

CHAR_KEYSYMS = {
    " ": "space", "\n": "Return", "\t": "Tab", "-": "minus", "_": "underscore", ".": "period", ",": "comma",
    "/": "slash", ":": "colon", ";": "semicolon", "'": "apostrophe", '"': "quotedbl", "!": "exclam",
    "?": "question", "(": "parenleft", ")": "parenright", "=": "equal", "+": "plus", "#": "numbersign",
}


def keycode(name):
    sym = x11.XStringToKeysym(name.encode())
    code = x11.XKeysymToKeycode(dpy, sym) if sym else 0
    if not code:
        sys.exit(f"Failed to find a key for {name!r}")
    shifted = x11.XkbKeycodeToKeysym(dpy, code, 0, 0) != sym
    return code, shifted


def press(codes):
    for code in codes:
        xtst.XTestFakeKeyEvent(dpy, code, True, 0)
    for code in reversed(codes):
        xtst.XTestFakeKeyEvent(dpy, code, False, 0)
    x11.XFlush(dpy)
    time.sleep(0.02)


def combo(spec):
    names = [{"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L"}.get(n, n) for n in spec.split("+")]
    press([keycode(n)[0] for n in names])


def type_text(text):
    shift = keycode("Shift_L")[0]
    for ch in text:
        code, shifted = keycode(CHAR_KEYSYMS.get(ch, ch))
        press([shift, code] if shifted else [code])


def click(x, y, button=1, count=1):
    xtst.XTestFakeMotionEvent(dpy, -1, x, y, 0)
    x11.XFlush(dpy)
    time.sleep(0.05)
    for _ in range(count):
        xtst.XTestFakeButtonEvent(dpy, button, True, 0)
        xtst.XTestFakeButtonEvent(dpy, button, False, 0)
        x11.XFlush(dpy)
        time.sleep(0.05)


args = sys.argv[1:]
while args:
    step, args = args[0], args[1:]
    if step in ("move", "click", "dclick", "rclick"):
        x, y, args = int(args[0]), int(args[1]), args[2:]
        if step == "move":
            xtst.XTestFakeMotionEvent(dpy, -1, x, y, 0)
            x11.XFlush(dpy)
        else:
            click(x, y, 3 if step == "rclick" else 1, 2 if step == "dclick" else 1)
    elif step == "type":
        type_text(args[0])
        args = args[1:]
    elif step == "key":
        combo(args[0])
        args = args[1:]
    elif step == "sleep":
        time.sleep(float(args[0]))
        args = args[1:]
    elif step == "shot":
        subprocess.run(["import", "-window", "root", args[0]], check=True)
        args = args[1:]
    else:
        sys.exit(f"Failed to parse step {step!r}")
