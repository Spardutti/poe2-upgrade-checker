'use strict';

// Sends a single Ctrl+C keystroke to the foreground window (the game) on
// Windows. Uses one long-running PowerShell process so each press is fast,
// instead of starting PowerShell every time. No native modules needed.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PoeKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  const uint UP = 2;
  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  // Send with the hardware scan code and hold each key briefly: games read the
  // keyboard once per frame, so a press that is down and up within microseconds
  // can be missed (that's why every other hotkey press did nothing).
  static void Key(byte vk, bool up) { keybd_event(vk, (byte)MapVirtualKey(vk, 0), up ? UP : 0, UIntPtr.Zero); }
  public static void Copy(bool advanced) {
    if (Down(0x10)) Key(0x10, true);                // let go of Shift
    bool alt = Down(0x12);
    if (alt && !advanced) Key(0x12, true);          // let go of Alt (from an Alt+ hotkey)
    Key(0x11, false); System.Threading.Thread.Sleep(15);         // Ctrl down
    if (advanced && !alt) { Key(0x12, false); System.Threading.Thread.Sleep(15); }
    Key(0x43, false); System.Threading.Thread.Sleep(40);         // C down (held ~2 frames)
    Key(0x43, true);  System.Threading.Thread.Sleep(15);         // C up
    if (advanced && !alt) Key(0x12, true);
    Key(0x11, true);                                 // Ctrl up
  }
}
"@
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    [PoeKeys]::Copy($line -eq 'advanced')
    [Console]::Out.WriteLine('ok')
  } catch { [Console]::Out.WriteLine('err ' + $_.Exception.Message) }
}
`;

class KeySender {
  constructor(log, dir) {
    this.log = log || (() => {});
    this.dir = dir || os.tmpdir();
    this.proc = null;
    this.ready = false;
    this.waiters = [];
    this.supported = process.platform === 'win32';
  }

  start() {
    if (!this.supported || this.proc) return;
    const script = path.join(this.dir, 'poe2uc-keys.ps1');
    try {
      fs.writeFileSync(script, PS_SCRIPT);
      this.proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.log('keysender: could not start PowerShell: ' + err.message);
      this.proc = null;
      return;
    }
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line === 'ready') { this.ready = true; this.log('keysender: ready'); continue; }
        const w = this.waiters.shift();
        if (line.startsWith('err')) this.log('keysender: ' + line);
        if (w) w(line === 'ok');
      }
    });
    this.proc.stderr.on('data', (d) => this.log('keysender stderr: ' + d.toString().trim()));
    // PowerShell blocked (AppLocker, antivirus) or gone: log it instead of crashing, and start over next time
    this.proc.on('error', (err) => {
      this.log('keysender: ' + err.message);
      this.proc = null; this.ready = false;
      this.waiters.splice(0).forEach((w) => w(false));
    });
    this.proc.stdin.on('error', (err) => this.log('keysender: ' + err.message));
    this.proc.on('exit', (code) => {
      this.log('keysender exited ' + code);
      this.proc = null; this.ready = false;
      this.waiters.splice(0).forEach((w) => w(false));
    });
  }

  // Resolves true once the keystroke was sent.
  copy(advanced) {
    if (!this.supported) return Promise.resolve(false);
    if (!this.proc) this.start();
    if (!this.proc) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 1500);
      this.waiters.push((ok) => { clearTimeout(t); resolve(ok); });
      try { this.proc.stdin.write((advanced ? 'advanced' : 'copy') + '\n'); } catch (_) { clearTimeout(t); resolve(false); }
    });
  }

  stop() { if (this.proc) { try { this.proc.kill(); } catch (_) {} this.proc = null; } }
}

module.exports = { KeySender, PS_SCRIPT };
