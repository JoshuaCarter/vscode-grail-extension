param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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
    private const int REPLACEFILE_IGNORE_MERGE_ERRORS = 0x00000002;
    private const int REPLACEFILE_IGNORE_ACL_ERRORS = 0x00000004;

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

    [DllImport("Kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ReplaceFile(
        string lpReplacedFileName,
        string lpReplacementFileName,
        string lpBackupFileName,
        int dwReplaceFlags,
        IntPtr lpExclude,
        IntPtr lpReserved);

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

        var errors = new List<string>();

        if (TryReplaceFile(path, errors))
        {
            return;
        }

        if (TryDeleteOnClose(path, errors))
        {
            return;
        }

        if (TryRenameRotate(path, errors))
        {
            return;
        }

        throw new IOException(
            "Could not wipe log while another process holds it open. Tried: " +
            string.Join("; ", errors));
    }

    // ReplaceFile atomically swaps in an empty replacement while moving the old
    // file aside. This often succeeds when rename/delete-on-close fail on locked logs.
    private static bool TryReplaceFile(string path, List<string> errors)
    {
        string dir = Path.GetDirectoryName(path);
        string replacement = Path.Combine(dir, Path.GetRandomFileName());
        string backup = Path.Combine(dir, Path.GetFileName(path) + "." + DateTime.UtcNow.Ticks + ".wiped");

        try
        {
            File.WriteAllText(replacement, string.Empty);

            if (!ReplaceFile(
                    path,
                    replacement,
                    backup,
                    REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS,
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                errors.Add("ReplaceFile (Win32 " + Marshal.GetLastWin32Error() + ")");
                return false;
            }

            TryDeleteQuiet(backup);
            return File.Exists(path);
        }
        catch (Exception ex)
        {
            errors.Add("ReplaceFile (" + ex.Message + ")");
            return false;
        }
        finally
        {
            TryDeleteQuiet(replacement);
        }
    }

    private static bool TryDeleteOnClose(string path, List<string> errors)
    {
        uint[] shareModes = new uint[]
        {
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            FILE_SHARE_READ
        };

        foreach (uint shareMode in shareModes)
        {
            using (var handle = CreateFile(path, DELETE, shareMode, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
            {
                if (handle.IsInvalid)
                {
                    continue;
                }

                var info = new FILE_DISPOSITION_INFO { DeleteFile = true };
                if (!SetFileInformationByHandle(
                        handle,
                        FileDispositionInfo,
                        ref info,
                        Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))))
                {
                    errors.Add("delete-on-close SetFileInformationByHandle (Win32 " + Marshal.GetLastWin32Error() + ")");
                    return false;
                }
            }

            try
            {
                File.WriteAllText(path, string.Empty);
                return true;
            }
            catch (Exception ex)
            {
                errors.Add("delete-on-close recreate (" + ex.Message + ")");
                return false;
            }
        }

        errors.Add("delete-on-close open (Win32 32 sharing violation)");
        return false;
    }

    private static bool TryRenameRotate(string path, List<string> errors)
    {
        string dir = Path.GetDirectoryName(path);
        string backup = Path.Combine(dir, Path.GetFileName(path) + "." + DateTime.UtcNow.Ticks + ".wiped");

        try
        {
            File.Move(path, backup);
            File.WriteAllText(path, string.Empty);
            TryDeleteQuiet(backup);
            return true;
        }
        catch (Exception ex)
        {
            errors.Add("rename (" + ex.Message + ")");
            return false;
        }
    }

    private static void TryDeleteQuiet(string filePath)
    {
        try
        {
            if (filePath != null && File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch
        {
        }
    }
}
'@

[LogWiper]::Wipe($Path)
