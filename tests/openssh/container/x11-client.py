#!/usr/bin/env python3
"""A minimal X client for the X11 forwarding test.

Connects to $DISPLAY as a real client would, presents the cookie xauth holds for
it, and prints what the X server answers. Run inside a session that asked for
X11 forwarding.
"""
import os
import socket
import struct
import subprocess
import sys

display = os.environ["DISPLAY"]
host, _, rest = display.rpartition(":")
number = int(rest.split(".")[0])
listing = subprocess.run(["xauth", "list", display], capture_output=True, text=True).stdout.split()
cookie = bytes.fromhex(listing[2])
name = b"MIT-MAGIC-COOKIE-1"


def pad(data):
    return data + b"\0" * (-len(data) % 4)


setup = struct.pack("<BxHHHHxx", 0x6C, 11, 0, len(name), len(cookie)) + pad(name) + pad(cookie)
with socket.create_connection((host or "localhost", 6000 + number), timeout=10) as sock:
    sock.sendall(setup + b"first-request")
    sock.settimeout(10)
    answer = sock.recv(64)
sys.stdout.write(answer.decode("latin1"))
