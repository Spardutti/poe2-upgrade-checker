// pobhost.exe: a tiny host that runs a Lua script with Path of Building's own LuaJIT (lua51.dll).
// Usage: pobhost.exe <script.lua>   (run with Path of Building's "src" folder as the working directory)
// The script talks over stdin/stdout itself. Built on the user's PC / CI with the C# compiler that
// ships with Windows (.NET Framework), so the app doesn't need a C toolchain or native npm modules.
using System;
using System.IO;
using System.Runtime.InteropServices;

static class PobHost {
  const string L = "lua51.dll";
  [DllImport(L, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr luaL_newstate();
  [DllImport(L, CallingConvention = CallingConvention.Cdecl)] static extern void luaL_openlibs(IntPtr s);
  [DllImport(L, CallingConvention = CallingConvention.Cdecl)] static extern int luaL_loadfile(IntPtr s, [MarshalAs(UnmanagedType.LPStr)] string f);
  [DllImport(L, CallingConvention = CallingConvention.Cdecl)] static extern int lua_pcall(IntPtr s, int nargs, int nres, int errfunc);
  [DllImport(L, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr lua_tolstring(IntPtr s, int idx, out UIntPtr len);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetDllDirectory(string path);

  static int Main(string[] args) {
    if (args.Length < 1) { Console.Error.WriteLine("usage: pobhost <script.lua>"); return 2; }
    // lua51.dll / lua-utf8.dll sit next to this exe
    string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    SetDllDirectory(dir);
    IntPtr s = luaL_newstate();
    if (s == IntPtr.Zero) { Console.Error.WriteLine("could not start Lua"); return 3; }
    luaL_openlibs(s);
    int rc = luaL_loadfile(s, args[0]);
    if (rc == 0) rc = lua_pcall(s, 0, 0, 0);
    if (rc != 0) {
      UIntPtr len;
      IntPtr p = lua_tolstring(s, -1, out len);
      Console.Error.WriteLine("Lua error: " + (p == IntPtr.Zero ? "?" : Marshal.PtrToStringAnsi(p)));
      return 1;
    }
    return 0;
  }
}
