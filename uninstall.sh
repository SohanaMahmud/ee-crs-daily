#!/bin/bash
# Removes the daily schedule. Leaves the folder and config.json in place.
LABEL="ca.ee-crs-daily"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Daily schedule removed."
