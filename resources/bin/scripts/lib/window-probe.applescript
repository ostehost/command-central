use framework "Foundation"
use framework "AppKit"
use scripting additions

on sanitizedReason(reasonText)
	set text item delimiters to {" ", tab, linefeed, return, "|"}
	set parts to text items of reasonText
	set text item delimiters to "_"
	set joinedText to parts as text
	set text item delimiters to ""
	return joinedText
end sanitizedReason

on runningPIDForBundle(bundleID)
	set runningApps to current application's NSRunningApplication's runningApplicationsWithBundleIdentifier:bundleID
	if ((runningApps's |count|()) as integer) is 0 then return missing value
	set runningApp to runningApps's objectAtIndex:0
	return (runningApp's processIdentifier()) as integer
end runningPIDForBundle

on run argv
	if (count of argv) is 0 then error "Usage: osascript window-probe.applescript <bundle-id>"
	set bundleID to item 1 of argv
	set appPID to my runningPIDForBundle(bundleID)
	if appPID is missing value then return "false|0|0|0||process_not_running"

	set windowCount to 0
	set onscreenCount to 0
	set focusableCount to 0
	set reasonText to "ok"

	try
		tell application "System Events"
			set matchedProcesses to every process whose unix id is appPID
			if (count of matchedProcesses) is 0 then return "true|0|0|0|" & appPID & "|ax_process_not_found"
			tell item 1 of matchedProcesses
				repeat with w in windows
					set windowCount to windowCount + 1
					set minimizedWindow to false
					try
						set minimizedWindow to value of attribute "AXMinimized" of w as boolean
					end try
					if minimizedWindow is false then
						set onscreenCount to onscreenCount + 1
						set focusableCount to focusableCount + 1
					end if
				end repeat
			end tell
		end tell
	on error errMsg
		return "true|0|0|0|" & appPID & "|ax_error_" & my sanitizedReason(errMsg)
	end try

	if windowCount is 0 then set reasonText to "no_ax_windows"
	if windowCount is greater than 0 and focusableCount is 0 then set reasonText to "no_focusable_windows"
	return "true|" & windowCount & "|" & onscreenCount & "|" & focusableCount & "|" & appPID & "|" & reasonText
end run
