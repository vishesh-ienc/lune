using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Threading;

class HideHookHelper {
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const int SW_HIDE = 0;

    static void Main(string[] args) {
        if (args.Length < 1) {
            Console.WriteLine("Usage: hide-hook-helper.exe <parent_pid> [timeout_ms] [poll_ms]");
            return;
        }

        int targetPid = int.Parse(args[0]);
        int timeoutMs = args.Length > 1 ? int.Parse(args[1]) : 15000;
        int pollMs = args.Length > 2 ? int.Parse(args[2]) : 15;

        Stopwatch sw = Stopwatch.StartNew();
        HashSet<uint> targetPids = new HashSet<uint>();
        targetPids.Add((uint)targetPid);

        DateTime lastPidRefresh = DateTime.MinValue;

        while (sw.ElapsedMilliseconds < timeoutMs) {
            // Periodically refresh child PIDs (every 80ms)
            if ((DateTime.Now - lastPidRefresh).TotalMilliseconds > 80) {
                RefreshTargetPids(targetPid, targetPids);
                lastPidRefresh = DateTime.Now;
            }

            IntPtr foundHwnd = IntPtr.Zero;
            uint foundPid = 0;
            string foundTitle = "";
            string foundClass = "";

            EnumWindows((hwnd, lParam) => {
                if (!IsWindowVisible(hwnd)) return true;

                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);

                if (targetPids.Contains(pid)) {
                    System.Text.StringBuilder sbClass = new System.Text.StringBuilder(256);
                    GetClassName(hwnd, sbClass, 256);
                    string cls = sbClass.ToString();

                    foundHwnd = hwnd;
                    foundPid = pid;
                    foundClass = cls;

                    System.Text.StringBuilder sbTitle = new System.Text.StringBuilder(256);
                    GetWindowText(hwnd, sbTitle, 256);
                    foundTitle = sbTitle.ToString();

                    return false; // Found! Stop enumeration
                }
                return true;
            }, IntPtr.Zero);

            if (foundHwnd != IntPtr.Zero) {
                long detectedMs = sw.ElapsedMilliseconds;
                string detectIso = DateTime.UtcNow.ToString("o");

                bool hideSuccess = ShowWindow(foundHwnd, SW_HIDE);
                long hideMs = sw.ElapsedMilliseconds;
                string hideIso = DateTime.UtcNow.ToString("o");

                Console.WriteLine(string.Format("RESULT|SUCCESS|0x{0:X}|{1}|{2}|{3}|{4}|{5}|{6}|{7}",
                    foundHwnd.ToInt64(), foundPid, detectIso, detectedMs, hideIso, hideMs, foundClass, foundTitle));
                return;
            }

            Thread.Sleep(pollMs);
        }

        Console.WriteLine(string.Format("RESULT|TIMEOUT|0|0||{0}||||No HWND detected for PID {1} within {2}ms",
            sw.ElapsedMilliseconds, targetPid, timeoutMs));
    }

    static void RefreshTargetPids(int parentPid, HashSet<uint> pids) {
        try {
            string query = string.Format("SELECT ProcessId FROM Win32_Process WHERE ParentProcessId = {0}", parentPid);
            using (var searcher = new ManagementObjectSearcher(query)) {
                foreach (ManagementObject obj in searcher.Get()) {
                    uint childPid = (uint)obj["ProcessId"];
                    pids.Add(childPid);
                }
            }
        } catch {
            // Ignore temporary management exceptions during process spawn
        }
    }
}
