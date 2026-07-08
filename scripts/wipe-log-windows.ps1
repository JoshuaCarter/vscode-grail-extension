param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LogWiper
{
    private const int FileDispositionInfo = 4;
    private const uint DELETE = 0x00010000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_DISPOSITION_INFO
    {
        [MarshalAs(UnmanagedType.U1)]
        public bool DeleteFile;
    }

    [DllImport("Kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("Kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle hFile,
        int FileInformationClass,
        ref FILE_DISPOSITION_INFO lpFileInformation,
        int dwBufferSize);

    public static void Wipe(string path)
    {
        if (!File.Exists(path))
        {
            File.WriteAllText(path, string.Empty);
            return;
        }

        using (var handle = CreateFile(
            path,
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            0,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new IOException(
                    "Could not open log for delete-on-close (Win32 " +
                    Marshal.GetLastWin32Error() + ")");
            }

            var info = new FILE_DISPOSITION_INFO { DeleteFile = true };
            if (!SetFileInformationByHandle(
                    handle,
                    FileDispositionInfo,
                    ref info,
                    Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))))
            {
                throw new IOException(
                    "SetFileInformationByHandle failed (Win32 " +
                    Marshal.GetLastWin32Error() + ")");
            }
        }

        File.WriteAllText(path, string.Empty);
    }
}
'@

[LogWiper]::Wipe($Path)
