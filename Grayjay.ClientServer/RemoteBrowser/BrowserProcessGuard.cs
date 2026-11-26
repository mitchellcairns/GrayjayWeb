using Grayjay.Desktop.POC;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Grayjay.ClientServer.RemoteBrowser
{
    /// <summary>
    /// Makes sure browser processes do not outlive the server:
    /// on Windows every browser is put in a job object that kills its processes when the server process dies (even on a crash);
    /// on Linux/macOS browsers orphaned by a previous crashed server are found by their profile dir and killed on first use.
    /// </summary>
    internal static class BrowserProcessGuard
    {
        private static readonly object _lock = new object();
        private static IntPtr _job = IntPtr.Zero;
        private static bool _jobFailed = false;

        public static void Adopt(Process process)
        {
            if (!OperatingSystem.IsWindows())
                return;
            try
            {
                var job = GetJob();
                if (job != IntPtr.Zero && !AssignProcessToJobObject(job, process.Handle))
                    Logger.w(nameof(BrowserProcessGuard), "AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
            }
            catch (Exception ex)
            {
                Logger.w(nameof(BrowserProcessGuard), "Failed to assign browser to job object: " + ex.Message);
            }
        }

        private static IntPtr GetJob()
        {
            lock (_lock)
            {
                if (_job != IntPtr.Zero || _jobFailed)
                    return _job;
                var job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    _jobFailed = true;
                    return IntPtr.Zero;
                }
                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
                {
                    Logger.w(nameof(BrowserProcessGuard), "SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
                    _jobFailed = true;
                    return IntPtr.Zero;
                }
                //Intentionally never closed: the OS closes it when this process exits, which kills the browsers.
                _job = job;
                return _job;
            }
        }

        /// <summary>Kills browsers whose --user-data-dir is a remote browser profile under <paramref name="profileBaseDir"/> not in <paramref name="activeDirs"/>.</summary>
        public static void KillOrphans(string profileBaseDir, ISet<string> activeDirs)
        {
            if (OperatingSystem.IsWindows())
                return; //Covered by the job object.
            try
            {
                var marker = "--user-data-dir=" + Path.Combine(profileBaseDir, "rb-");
                foreach (var (pid, cmdline) in ListProcesses())
                {
                    if (pid == Environment.ProcessId)
                        continue;
                    var idx = cmdline.IndexOf(marker, StringComparison.Ordinal);
                    if (idx < 0)
                        continue;
                    var dir = cmdline.Substring(idx + "--user-data-dir=".Length).Split(' ', '\0')[0];
                    if (activeDirs.Contains(dir))
                        continue;
                    try
                    {
                        using var p = Process.GetProcessById(pid);
                        Logger.i(nameof(BrowserProcessGuard), $"Killing orphaned remote browser process {pid} ({dir}).");
                        p.Kill(entireProcessTree: true);
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                Logger.w(nameof(BrowserProcessGuard), "Failed to look for orphaned browser processes: " + ex.Message);
            }
        }

        private static IEnumerable<(int pid, string cmdline)> ListProcesses()
        {
            if (OperatingSystem.IsLinux() && Directory.Exists("/proc"))
            {
                foreach (var dir in Directory.EnumerateDirectories("/proc"))
                {
                    if (!int.TryParse(Path.GetFileName(dir), out var pid))
                        continue;
                    string cmdline;
                    try
                    {
                        cmdline = File.ReadAllText(Path.Combine(dir, "cmdline")).Replace('\0', ' ');
                    }
                    catch
                    {
                        continue;
                    }
                    yield return (pid, cmdline);
                }
                yield break;
            }

            //macOS / other unix
            var lines = new List<string>();
            try
            {
                using var ps = Process.Start(new ProcessStartInfo("ps", "-axww -o pid=,command=") { RedirectStandardOutput = true, UseShellExecute = false });
                if (ps == null)
                    yield break;
                string? line;
                while ((line = ps.StandardOutput.ReadLine()) != null)
                    lines.Add(line);
                ps.WaitForExit(5000);
            }
            catch
            {
                yield break;
            }
            foreach (var line in lines)
            {
                var trimmed = line.TrimStart();
                var space = trimmed.IndexOf(' ');
                if (space > 0 && int.TryParse(trimmed.Substring(0, space), out var pid))
                    yield return (pid, trimmed.Substring(space + 1));
            }
        }

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    }
}
