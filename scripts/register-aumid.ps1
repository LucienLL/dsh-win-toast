#Requires -Version 5.1
<#
  Registers (or removes) the Start Menu shortcut that gives DeepSeek Harness
  toasts their own sender identity.

  Windows resolves a toast's sender name and icon from the Start Menu shortcut
  that carries the same AppUserModelID. Without that shortcut an AUMID is still
  accepted by the API and then silently dropped, which is why dsh-desktop-toast
  defaults to the PowerShell AUMID unless this script has run.

  Usage:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File register-aumid.ps1 `
      -Aumid 'DeepSeek.Harness.Notify' `
      -TargetPath 'E:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' `
      -IconPath 'E:\Program Files\DeepSeek Harness\DeepSeek Harness.ico'

    powershell.exe ... -File register-aumid.ps1 -Aumid 'DeepSeek.Harness.Notify' -Unregister

  ASCII-only on purpose: Windows PowerShell 5.1 parses this file in the active
  ANSI code page, so non-ASCII source text can break the parser.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Aumid,
  [Parameter(Mandatory = $false)][string]$Name = 'DeepSeek Harness Notify',
  [Parameter(Mandatory = $false)][string]$TargetPath,
  [Parameter(Mandatory = $false)][string]$IconPath,
  [Parameter(Mandatory = $false)][switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $programs ($Name + '.lnk')

if ($Unregister) {
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    [pscustomobject]@{ ok = $true; action = 'removed'; shortcut = $shortcutPath } | ConvertTo-Json -Compress
  } else {
    [pscustomobject]@{ ok = $true; action = 'absent'; shortcut = $shortcutPath } | ConvertTo-Json -Compress
  }
  exit 0
}

if (-not $TargetPath -or -not (Test-Path -LiteralPath $TargetPath)) {
  [pscustomobject]@{ ok = $false; error = 'TargetPath is missing or does not exist: ' + $TargetPath } | ConvertTo-Json -Compress
  exit 1
}

# WScript.Shell creates the link; IPropertyStore is the only way to stamp
# System.AppUserModel.ID onto it, because no shell scripting object exposes it.
$interop = @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder file, int max, IntPtr data, uint flags);
    void GetIDList(out IntPtr pidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder name, int max);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder dir, int max);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder args, int max);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out ushort hotkey);
    void SetHotkey(ushort hotkey);
    void GetShowCmd(out int showCmd);
    void SetShowCmd(int showCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder icon, int max, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PropertyKey
{
    public Guid fmtid;
    public int pid;
    public PropertyKey(Guid f, int p) { fmtid = f; pid = p; }
}

[StructLayout(LayoutKind.Sequential)]
public struct PropVariant
{
    public ushort vt;
    public ushort r1;
    public ushort r2;
    public ushort r3;
    public IntPtr p;
    public int p2;
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore
{
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
}

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class ShellLinkCoClass { }

public static class LinkAumid
{
    private static readonly PropertyKey AumidKey = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

    public static void Stamp(string shortcutPath, string path, string iconPath, string aumid)
    {
        object instance = new ShellLinkCoClass();
        try
        {
            IShellLinkW link = (IShellLinkW)instance;
            link.SetPath(path);
            if (iconPath != null && iconPath.Length > 0) link.SetIconLocation(iconPath, 0);

            IPropertyStore store = (IPropertyStore)instance;
            PropVariant value = new PropVariant();
            value.vt = 31; // VT_LPWSTR
            value.p = Marshal.StringToCoTaskMemUni(aumid);
            try
            {
                PropertyKey key = AumidKey;
                store.SetValue(ref key, ref value);
                store.Commit();
            }
            finally
            {
                Marshal.FreeCoTaskMem(value.p);
            }

            System.Runtime.InteropServices.ComTypes.IPersistFile file =
                (System.Runtime.InteropServices.ComTypes.IPersistFile)instance;
            file.Save(shortcutPath, true);
        }
        finally
        {
            Marshal.ReleaseComObject(instance);
        }
    }
}
'@

Add-Type -TypeDefinition $interop -Language CSharp

$icon = if ($IconPath) { $IconPath } else { '' }
[LinkAumid]::Stamp($shortcutPath, $TargetPath, $icon, $Aumid)

# Read the value back through the shell so the result is proof, not intent.
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace($programs)
$item = $folder.ParseName(($Name + '.lnk'))
$readBack = if ($item) { $item.ExtendedProperty('System.AppUserModel.ID') } else { $null }

$ok = ($readBack -eq $Aumid)
[pscustomobject]@{
  ok = $ok
  action = 'registered'
  shortcut = $shortcutPath
  aumid = $Aumid
  readBack = $readBack
  error = if ($ok) { $null } else { 'AppUserModel.ID did not read back' }
} | ConvertTo-Json -Compress
if (-not $ok) { exit 1 }
