# ensure-postiz-up.ps1
# Simple one-shot launcher - run by the scheduled task as a health check.
# Delegates to the watchdog for the full launch sequence.
# The watchdog is already running from the Startup folder, so this is
# just a safety net in case the watchdog's PowerShell process died.
& 'C:\dev\Schedular\watchdog-postiz.ps1' *>> 'C:\dev\Schedular\logs\ensure-up.log'
